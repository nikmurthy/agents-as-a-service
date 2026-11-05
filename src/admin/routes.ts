import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { env } from "../env.js";
import { many, one, withAdmin, withTenant } from "../db.js";
import { audit } from "../audit.js";
import { addWebhook, connectWhatsApp, createTenant, packTemplate, setTenantStatus } from "../onboarding.js";
import { googleConnectLink } from "../connections.js";
import { decideDraft, type Decision, type DecisionActor } from "../decisions.js";
import { loadCaller, type Caller } from "./auth.js";
import { formatIssues, settingsSchema } from "./settings-schema.js";

// The admin web app's API. Every route authenticates the caller, then checks they may act on that business.
// Business-scoped routes only ever use withTenant (row-level security stays the backstop); the few platform-wide
// routes are admin-only. Secrets are write-only: nothing here returns a token.

type Vars = { Variables: { caller: Caller } };
export const adminApi = new Hono<Vars>();

adminApi.use("*", cors({
  origin: (origin) => (env.adminOrigin && origin === env.adminOrigin ? origin : null),
  allowHeaders: ["authorization", "content-type"],
  allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
  maxAge: 600,
}));

adminApi.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const token = c.req.header("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  const caller = token ? await loadCaller(token) : undefined;
  if (!caller) return c.json({ error: "unauthorised" }, 401);
  c.set("caller", caller);
  await next();
});

// ---------------------------------------------------------------- access checks
/** view: see the business. approve: also decide drafts. manage: change settings and connections (owners and admins). */
type Level = "view" | "approve" | "manage";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Granted = { ok: true; tenantId: string; actor: DecisionActor; manage: boolean } | { ok: false; res: Response };

function mfaRequired(c: Context) { return c.json({ error: "mfa_required", message: "Platform admins must sign in with a second factor." }, 403); }

function guard(c: Context<Vars>, tenantId: string, level: Level): Granted {
  const caller = c.get("caller");
  const notFound = { ok: false as const, res: c.json({ error: "not_found" }, 404) };
  if (!UUID.test(tenantId)) return notFound;
  const m = caller.memberships.find((x) => x.tenantId === tenantId);
  if (caller.isPlatformAdmin) {
    if (!caller.mfa) return { ok: false, res: mfaRequired(c) };
    return { ok: true, tenantId, manage: true, actor: { memberId: m?.memberId ?? null, label: `admin:${caller.email ?? caller.userId}`, via: "web" } };
  }
  if (!m) return notFound; // someone else's business looks the same as one that doesn't exist
  if (level === "manage" && m.role !== "owner") return { ok: false, res: c.json({ error: "forbidden", message: "Only the owner can change this." }, 403) };
  return { ok: true, tenantId, manage: m.role === "owner", actor: { memberId: m.memberId, label: `member:${m.memberId}`, via: "web" } };
}

function guardAdmin(c: Context<Vars>): { ok: true; label: string } | { ok: false; res: Response } {
  const caller = c.get("caller");
  if (!caller.isPlatformAdmin) return { ok: false, res: c.json({ error: "forbidden" }, 403) };
  if (!caller.mfa) return { ok: false, res: mfaRequired(c) };
  return { ok: true, label: `admin:${caller.email ?? caller.userId}` };
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  const raw = await c.req.json().catch(() => undefined);
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, res: c.json({ error: "invalid", issues: formatIssues(r.error) }, 422) };
}

// ---------------------------------------------------------------- who am I
adminApi.get("/me", (c) => {
  const k = c.get("caller");
  return c.json({ userId: k.userId, email: k.email, isPlatformAdmin: k.isPlatformAdmin, mfa: k.mfa, businesses: k.memberships });
});

// ---------------------------------------------------------------- businesses (platform admin)
adminApi.get("/businesses", async (c) => {
  const a = guardAdmin(c);
  if (!a.ok) return a.res;
  const rows = await withAdmin((db) => many(db,
    `select t.id, t.slug, t.name, t.pack, t.status, t.created_at as "createdAt",
       (select max(m.received_at) from messages m where m.tenant_id = t.id and m.direction = 'in') as "lastMessageAt",
       (select count(*)::int from drafts d where d.tenant_id = t.id and d.status = 'pending_approval') as "draftsWaiting",
       (select count(*)::int from channel_connections k where k.tenant_id = t.id and k.status = 'error') as "connectionProblems"
     from tenants t where t.status <> 'closed' order by t.name`));
  return c.json({ businesses: rows });
});

const newBusiness = z.object({
  slug: z.string().trim().regex(/^[a-z0-9-]{3,40}$/, "Use 3–40 lowercase letters, numbers or hyphens"),
  name: z.string().trim().min(1, "Name is required").max(100),
  pack: z.string().trim().regex(/^[a-z0-9-]+$/),
  owner: z.object({
    name: z.string().trim().min(1, "Owner name is required").max(100),
    whatsapp: z.string().trim().min(6, "Owner WhatsApp number is required").max(20),
    email: z.string().trim().email().optional(),
  }),
}).strict();

adminApi.post("/businesses", async (c) => {
  const a = guardAdmin(c);
  if (!a.ok) return a.res;
  const b = await body(c, newBusiness);
  if (!b.ok) return b.res;
  try { packTemplate(b.data.pack); } catch { return c.json({ error: "invalid", issues: [{ path: "pack", message: "Unknown sector pack" }] }, 422); }
  try {
    const t = await createTenant(b.data, a.label);
    return c.json({ id: t.id, googleLink: t.googleLink }, 201);
  } catch (e: any) {
    if (e?.code === "23505") return c.json({ error: "invalid", issues: [{ path: "slug", message: "That short name is already taken" }] }, 409);
    if (/WhatsApp/.test(e?.message ?? "")) return c.json({ error: "invalid", issues: [{ path: "owner.whatsapp", message: "Enter a valid mobile number" }] }, 422);
    throw e;
  }
});

adminApi.post("/businesses/:id/status", async (c) => {
  const a = guardAdmin(c);
  if (!a.ok) return a.res;
  const g = guard(c, c.req.param("id"), "manage");
  if (!g.ok) return g.res;
  const b = await body(c, z.object({ status: z.enum(["active", "paused"]) }).strict());
  if (!b.ok) return b.res;
  const current = await withTenant(g.tenantId, (db) => one<{ status: string }>(db, "select status from tenants where id = app_current_tenant()"));
  if (!current || current.status === "closed") return c.json({ error: "not_found" }, 404);
  await setTenantStatus(g.tenantId, b.data.status);
  await withTenant(g.tenantId, (db) => audit(db, {
    tenantId: g.tenantId, actor: a.label, action: "tenant.status_changed", detail: { from: current.status, to: b.data.status },
  }));
  return c.json({ status: b.data.status });
});

// ---------------------------------------------------------------- overview
adminApi.get("/businesses/:id", async (c) => {
  const g = guard(c, c.req.param("id"), "view");
  if (!g.ok) return g.res;
  const out = await withTenant(g.tenantId, async (db) => {
    const t = await one(db, "select id, slug, name, pack, status, settings->>'timezone' as timezone from tenants where id = app_current_tenant()");
    if (!t) return undefined;
    const tz = t.timezone || "Europe/London";
    const [counts, problems, useCases] = await Promise.all([
      one(db,
        `with since as (select (date_trunc('day', timezone($1::text, now())) at time zone $1::text) as start_at)
         select
           (select count(*)::int from messages m, since where m.direction = 'in' and m.received_at >= since.start_at) as "messagesToday",
           (select count(*)::int from outbox o, since where o.status = 'sent' and o.sent_at >= since.start_at) as "repliesSentToday",
           (select count(*)::int from drafts where status = 'pending_approval') as "draftsWaiting",
           (select count(*)::int from drafts where status = 'pending_approval' and needs_attention) as "needAttention",
           (select count(*)::int from outbox where status = 'failed' and created_at > now() - interval '7 days') as "failedSends"`, [tz]),
      many(db, `select id, kind, label, status, last_error as "lastError" from channel_connections where status = 'error' order by created_at`),
      many(db, "select use_case as \"useCase\", enabled from tenant_use_cases order by use_case"),
    ]);
    return { business: { id: t.id, slug: t.slug, name: t.name, pack: t.pack, status: t.status }, counts, connectionProblems: problems, useCases };
  });
  return out ? c.json(out) : c.json({ error: "not_found" }, 404);
});

// ---------------------------------------------------------------- settings
/** JSON with sorted keys, so Postgres's key order doesn't count as a change. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const putSettings = z.object({ name: z.string().trim().min(1, "Name is required").max(100).optional(), settings: settingsSchema }).strict();

adminApi.get("/businesses/:id/settings", async (c) => {
  const g = guard(c, c.req.param("id"), "view");
  if (!g.ok) return g.res;
  const t = await withTenant(g.tenantId, (db) => one(db, "select name, settings from tenants where id = app_current_tenant()"));
  return t ? c.json({ name: t.name, settings: t.settings, canEdit: g.manage }) : c.json({ error: "not_found" }, 404);
});

adminApi.put("/businesses/:id/settings", async (c) => {
  const g = guard(c, c.req.param("id"), "manage");
  if (!g.ok) return g.res;
  const b = await body(c, putSettings);
  if (!b.ok) return b.res;
  const saved = await withTenant(g.tenantId, async (db) => {
    const before = await one(db, "select name, settings from tenants where id = app_current_tenant() for update");
    if (!before) return false;
    const name = b.data.name ?? before.name;
    await db.query("update tenants set name = $1, settings = $2 where id = app_current_tenant()", [name, b.data.settings]);
    // The old version goes in the audit log so any change can be undone. Settings hold no customer message text.
    const changed = Object.keys(b.data.settings).filter((k) => canon((before.settings as any)?.[k]) !== canon((b.data.settings as any)[k]));
    await audit(db, {
      tenantId: g.tenantId, actor: g.actor.label, action: "settings.updated", entity: "tenant", entityId: g.tenantId,
      detail: { changed, previousName: before.name === name ? undefined : before.name, previous: before.settings },
    });
    return true;
  });
  return saved ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// ---------------------------------------------------------------- use cases
const LIVE_USE_CASES = ["answer_enquiries", "book_appointments"] as const;

adminApi.put("/businesses/:id/use-cases/:useCase", async (c) => {
  const g = guard(c, c.req.param("id"), "manage");
  if (!g.ok) return g.res;
  const useCase = z.enum(LIVE_USE_CASES).safeParse(c.req.param("useCase"));
  if (!useCase.success) return c.json({ error: "not_found" }, 404);
  const b = await body(c, z.object({ enabled: z.boolean() }).strict());
  if (!b.ok) return b.res;
  await withTenant(g.tenantId, async (db) => {
    await db.query(
      `insert into tenant_use_cases (tenant_id, use_case, enabled) values (app_current_tenant(), $1, $2)
       on conflict (tenant_id, use_case) do update set enabled = excluded.enabled`, [useCase.data, b.data.enabled]);
    await audit(db, { tenantId: g.tenantId, actor: g.actor.label, action: b.data.enabled ? "use_case.enabled" : "use_case.disabled", detail: { useCase: useCase.data } });
  });
  return c.json({ useCase: useCase.data, enabled: b.data.enabled });
});

// ---------------------------------------------------------------- drafts (the inbox)
const DRAFT_STATUSES = ["pending_approval", "approved", "rejected", "sent", "manual", "failed", "expired"] as const;

adminApi.get("/businesses/:id/drafts", async (c) => {
  const g = guard(c, c.req.param("id"), "view");
  if (!g.ok) return g.res;
  const status = z.enum(DRAFT_STATUSES).default("pending_approval").safeParse(c.req.query("status") || undefined);
  if (!status.success) return c.json({ error: "invalid", issues: [{ path: "status", message: "Unknown status" }] }, 422);
  const drafts = await withTenant(g.tenantId, (db) => many(db,
    `select d.id, d.status, d.body, d.original_body as "originalBody", d.reply_route as "replyRoute",
            d.needs_attention as "needsAttention", d.attention_reason as "attentionReason", d.review,
            d.created_at as "createdAt", d.decided_at as "decidedAt", d.conversation_id as "conversationId",
            coalesce(ct.name, 'Unknown') as customer, m.channel, m.body as inbound
     from drafts d
     join conversations cv on cv.id = d.conversation_id join contacts ct on ct.id = cv.contact_id
     left join runs r on r.id = d.run_id left join messages m on m.id = r.message_id
     where d.status = $1 order by d.created_at desc limit 50`, [status.data]));
  return c.json({ drafts });
});

async function decide(c: Context<Vars>, decision: (raw: unknown) => Decision | undefined) {
  const g = guard(c, c.req.param("id")!, "approve");
  if (!g.ok) return g.res;
  const draftId = c.req.param("draftId")!;
  if (!UUID.test(draftId)) return c.json({ error: "not_found" }, 404);
  const raw = await c.req.json().catch(() => ({}));
  const d = decision(raw);
  if (!d) return c.json({ error: "invalid", issues: [{ path: "body", message: "Write the reply you want sent" }] }, 422);
  const r = await decideDraft(g.tenantId, g.actor, draftId, d);
  if (r.outcome === "not_found") return c.json({ error: "not_found" }, 404);
  if (r.outcome === "already_decided") return c.json({ error: "already_decided", status: r.status }, 409);
  return c.json({ outcome: r.outcome });
}

adminApi.post("/businesses/:id/drafts/:draftId/approve", (c) => decide(c, () => ({ action: "approve" })));
adminApi.post("/businesses/:id/drafts/:draftId/reject", (c) => decide(c, () => ({ action: "reject" })));
adminApi.post("/businesses/:id/drafts/:draftId/edit", (c) => decide(c, (raw) => {
  const text = typeof (raw as any)?.body === "string" ? (raw as any).body.trim() : "";
  return text && text.length <= 4000 ? { action: "edit", body: text } : undefined;
}));

// ---------------------------------------------------------------- connections (secrets are write-only)
adminApi.get("/businesses/:id/connections", async (c) => {
  const g = guard(c, c.req.param("id"), "view");
  if (!g.ok) return g.res;
  const rows = await withTenant(g.tenantId, (db) => many(db,
    `select id, kind, external_id, label, status, last_error as "lastError", created_at as "createdAt", config->>'grant' as grant
     from channel_connections order by created_at`));
  const connections = rows.map((r) => {
    const webhook = r.kind === "web_form" || r.kind === "checkatrade_webhook";
    return {
      id: r.id, kind: r.kind, label: r.label, status: r.status, lastError: r.lastError, createdAt: r.createdAt,
      connectedAs: webhook ? null : r.grant ?? r.external_id,
      // A webhook's address is its password, so only people who can manage the business see it.
      url: webhook && g.manage ? `${env.publicBaseUrl}/webhooks/${r.kind === "web_form" ? "forms" : "checkatrade"}/${r.external_id}` : undefined,
    };
  });
  return c.json({ connections });
});

adminApi.get("/businesses/:id/google-link", (c) => {
  const g = guard(c, c.req.param("id"), "manage");
  if (!g.ok) return g.res;
  return c.json({ url: googleConnectLink(g.tenantId) });
});

adminApi.post("/businesses/:id/connections/whatsapp", async (c) => {
  const g = guard(c, c.req.param("id"), "manage");
  if (!g.ok) return g.res;
  const b = await body(c, z.object({
    phoneNumberId: z.string().trim().regex(/^\d{5,20}$/, "The phone number ID is digits only"),
    accessToken: z.string().trim().min(20, "That token looks too short").max(2000),
  }).strict());
  if (!b.ok) return b.res;
  try {
    await connectWhatsApp(g.tenantId, b.data.phoneNumberId, b.data.accessToken, g.actor.label);
  } catch (e: any) {
    if (e?.code === "23505" || /row-level security/.test(e?.message ?? "")) {
      return c.json({ error: "invalid", issues: [{ path: "phoneNumberId", message: "That number is already connected to a business" }] }, 409);
    }
    throw e;
  }
  return c.json({ ok: true });
});

adminApi.post("/businesses/:id/connections/webhook", async (c) => {
  const g = guard(c, c.req.param("id"), "manage");
  if (!g.ok) return g.res;
  const b = await body(c, z.object({ kind: z.enum(["web_form", "checkatrade_webhook"]), label: z.string().trim().max(100).optional() }).strict());
  if (!b.ok) return b.res;
  const url = await addWebhook(g.tenantId, b.data.kind, b.data.label, g.actor.label);
  return c.json({ url }, 201);
});

adminApi.post("/businesses/:id/connections/:connId/disable", async (c) => {
  const g = guard(c, c.req.param("id"), "manage");
  if (!g.ok) return g.res;
  const connId = c.req.param("connId");
  if (!UUID.test(connId)) return c.json({ error: "not_found" }, 404);
  const row = await withTenant(g.tenantId, async (db) => {
    const r = await one<{ kind: string }>(db, "update channel_connections set status = 'disconnected' where id = $1 returning kind", [connId]);
    if (r) await audit(db, { tenantId: g.tenantId, actor: g.actor.label, action: "connection.disabled", entity: "connection", entityId: connId, detail: { kind: r.kind } });
    return r;
  });
  return row ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});
