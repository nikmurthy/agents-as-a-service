import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z, ZodError, type ZodTypeAny } from "zod";
import { many, one, withAdmin, withTenant } from "../db.js";
import { audit } from "../audit.js";
import { env } from "../env.js";
import { requireUser, requireAdmin, tenantAccess, type Access } from "./auth.js";
import { newBusinessSchema, tenantSettingsSchema, USE_CASES } from "../settings-schema.js";
import { addWebhook, connectWhatsApp, createTenant, setTenantStatus } from "../onboarding.js";
import { googleConnectLink } from "../google-link.js";
import { approveDraft, editAndApproveDraft, rejectDraft, type DecisionResult } from "../decisions.js";
import { releaseHold } from "../calendar.js";
import { exportPerson, erasePerson, suppress } from "../data-rights.js";
import { normaliseEmail, normalisePhone } from "../channels/parse.js";

// Admin web app API. Every route checks who is signed in and whether they may use the business in the URL.
// Business-scoped routes only touch data through withTenant, so row-level security is the backstop.
// Secrets are write-only: nothing here ever returns a stored token.

export const admin = new Hono<{ Variables: { access: Access } }>();

admin.onError((e, c) => {
  if (e instanceof ZodError) {
    const issue = e.issues[0];
    return c.json({ error: issue.message, field: issue.path.join("."), issues: e.issues.map((i) => ({ field: i.path.join("."), message: i.message })) }, 400);
  }
  if (e instanceof HTTPException) return c.json({ error: e.message }, e.status);
  console.error("admin api error", e instanceof Error ? e.message : e);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});

admin.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
admin.use("*", requireUser);

async function parse<S extends ZodTypeAny>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new HTTPException(400, { message: "Send a JSON body" }); }
  return schema.parse(raw);
}
const notFound = () => new HTTPException(404, { message: "Not found" });
const uuid = (s: string) => { if (!/^[0-9a-f-]{36}$/.test(s)) throw notFound(); return s; };
const limitOf = (c: Context, def = 50, max = 200) => Math.min(Math.max(Number(c.req.query("limit")) || def, 1), max);

// ---------------------------------------------------------------- who am I
admin.get("/me", (c) => {
  const a = c.get("access");
  return c.json({
    email: a.email, isAdmin: a.isAdmin, adminNeedsTwoFactor: a.adminPendingMfa,
    businesses: a.memberships.map((m) => ({ id: m.tenantId, name: m.name, slug: m.slug, status: m.status, role: m.role })),
  });
});

// ---------------------------------------------------------------- businesses (platform admin)
admin.get("/businesses", async (c) => {
  const a = c.get("access");
  if (a.isAdmin) {
    const rows = await withAdmin((db) => many(db,
      `select t.id, t.slug, t.name, t.pack, t.status, t.created_at,
         (select max(received_at) from messages m where m.tenant_id = t.id and m.direction = 'in') as last_message_at,
         (select count(*)::int from drafts d where d.tenant_id = t.id and d.status = 'pending_approval') as drafts_waiting,
         (select count(*)::int from channel_connections k where k.tenant_id = t.id and k.status = 'error') as connection_problems
       from tenants t order by t.created_at desc`));
    return c.json({ businesses: rows });
  }
  return c.json({ businesses: a.memberships.map((m) => ({ id: m.tenantId, slug: m.slug, name: m.name, status: m.status, role: m.role })) });
});

admin.post("/businesses", async (c) => {
  const a = requireAdmin(c);
  const input = await parse(c, newBusinessSchema);
  try {
    const r = await createTenant({ ...input, by: `admin:${a.email}` });
    return c.json({ id: r.id, googleLink: r.googleLink }, 201);
  } catch (e: any) {
    if (e?.code === "23505") throw new HTTPException(409, { message: "That web address (slug) is already used by another business" });
    throw e;
  }
});

// ---------------------------------------------------------------- overview and status
admin.get("/businesses/:id", async (c) => {
  const { tenantId } = tenantAccess(c, c.req.param("id"));
  return c.json(await withTenant(tenantId, async (db) => {
    const t = await one(db, "select id, slug, name, pack, status, created_at from tenants where id = app_current_tenant()");
    if (!t) throw notFound();
    const numbers = await one(db,
      `select
         (select count(*)::int from messages where direction = 'in' and received_at > now() - interval '24 hours') as messages_today,
         (select count(*)::int from drafts where status = 'pending_approval') as drafts_waiting,
         (select count(*)::int from drafts where status = 'sent' and decided_at > now() - interval '24 hours') as replies_sent_today,
         (select count(*)::int from holds where status = 'held') as times_held,
         (select count(*)::int from holds where status = 'confirmed' and start_at > now()) as upcoming_bookings`);
    const attention = {
      failedSends: await many(db, "select id, conversation_id, created_at from drafts where status = 'failed' order by created_at desc limit 20"),
      flaggedDrafts: await many(db, "select id, conversation_id, attention_reason, created_at from drafts where status = 'pending_approval' and needs_attention order by created_at desc limit 20"),
      brokenConnections: await many(db, "select id, kind, label, last_error from channel_connections where status = 'error'"),
      failedRuns: await many(db, "select id, error, created_at from runs where status = 'failed' and created_at > now() - interval '7 days' order by created_at desc limit 20"),
    };
    return { business: t, numbers, attention };
  }));
});

admin.put("/businesses/:id/status", async (c) => {
  const { tenantId, role, actor } = tenantAccess(c, c.req.param("id"), "manage");
  const { status } = await parse(c, z.object({ status: z.enum(["active", "paused", "closed"]) }));
  const current = await withTenant(tenantId, (db) => one<{ status: string }>(db, "select status from tenants where id = app_current_tenant()"));
  if (!current) throw notFound();
  if (role !== "admin") {
    if (status === "closed" || !["active", "paused"].includes(current.status)) {
      throw new HTTPException(403, { message: "Ask the platform team to change this" });
    }
  }
  await setTenantStatus(tenantId, status as "active" | "paused");
  if (status === "closed") await withAdmin((db) => db.query("update tenants set status = 'closed' where id = $1", [tenantId]));
  await withTenant(tenantId, (db) => audit(db, { tenantId, actor: actor.audit, action: "tenant.status_changed", entity: "tenant", entityId: tenantId, detail: { from: current.status, to: status } }));
  return c.json({ status });
});

// ---------------------------------------------------------------- settings
admin.get("/businesses/:id/settings", async (c) => {
  const { tenantId, role } = tenantAccess(c, c.req.param("id"));
  const t = await withTenant(tenantId, (db) => one(db, "select name, pack, status, settings from tenants where id = app_current_tenant()"));
  if (!t) throw notFound();
  return c.json({ name: t.name, pack: t.pack, status: t.status, settings: t.settings, canEdit: role === "admin" || role === "owner" });
});

admin.put("/businesses/:id/settings", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"), "manage");
  const body = await parse(c, z.object({ name: z.string().trim().min(1).max(120).optional(), settings: tenantSettingsSchema }));
  const known = Object.keys(tenantSettingsSchema.shape);
  await withTenant(tenantId, async (db) => {
    const old = await one<{ name: string; settings: Record<string, unknown> }>(db, "select name, settings from tenants where id = app_current_tenant() for update");
    if (!old) throw notFound();
    // Keep settings the form doesn't manage (e.g. pinned agent versions); everything the form does manage is replaced.
    const kept = Object.fromEntries(Object.entries(old.settings).filter(([k]) => !known.includes(k)));
    const next = { ...kept, ...body.settings };
    await db.query("update tenants set settings = $1, name = $2 where id = app_current_tenant()", [next, body.name ?? old.name]);
    await audit(db, { tenantId, actor: actor.audit, action: "settings.updated", entity: "tenant", entityId: tenantId, detail: { previous: old.settings, previousName: old.name } });
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- use cases
admin.get("/businesses/:id/use-cases", async (c) => {
  const { tenantId } = tenantAccess(c, c.req.param("id"));
  const rows = await withTenant(tenantId, (db) => many<{ use_case: string; enabled: boolean }>(db, "select use_case, enabled from tenant_use_cases"));
  return c.json({ useCases: USE_CASES.map((k) => ({ key: k, enabled: !!rows.find((r) => r.use_case === k)?.enabled })) });
});

admin.put("/businesses/:id/use-cases/:key", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"), "manage");
  const key = z.enum(USE_CASES).parse(c.req.param("key"));
  const { enabled } = await parse(c, z.object({ enabled: z.boolean() }));
  await withTenant(tenantId, async (db) => {
    await db.query(
      "insert into tenant_use_cases (tenant_id, use_case, enabled) values (app_current_tenant(), $1, $2) on conflict (tenant_id, use_case) do update set enabled = excluded.enabled",
      [key, enabled]);
    await audit(db, { tenantId, actor: actor.audit, action: "use_case.changed", entity: "use_case", entityId: key, detail: { enabled } });
  });
  return c.json({ key, enabled });
});

// ---------------------------------------------------------------- connections (secrets are write-only)
admin.get("/businesses/:id/connections", async (c) => {
  const { tenantId, role } = tenantAccess(c, c.req.param("id"));
  const rows = await withTenant(tenantId, (db) => many(db,
    "select id, kind, external_id, label, status, last_error, config->>'grant' as account, created_at from channel_connections order by kind, created_at"));
  const connections = rows.map((r) => {
    const isHook = r.kind === "web_form" || r.kind === "checkatrade_webhook";
    const { external_id, ...rest } = r;
    return {
      ...rest,
      // The webhook token is the URL, so it is only shown to people who can manage the business.
      url: isHook && role !== "staff" ? `${env.publicBaseUrl}/webhooks/${r.kind === "web_form" ? "forms" : "checkatrade"}/${external_id}` : undefined,
      connectedAs: isHook ? undefined : external_id,
    };
  });
  return c.json({ connections });
});

admin.get("/businesses/:id/connections/google-link", (c) => {
  const { tenantId } = tenantAccess(c, c.req.param("id"), "manage");
  return c.json({ url: googleConnectLink(tenantId) });
});

admin.post("/businesses/:id/connections/whatsapp", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"), "manage");
  const { phoneNumberId, accessToken } = await parse(c, z.object({
    phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, "The phone number ID is a long number from Meta"),
    accessToken: z.string().trim().min(10).max(2000),
  }));
  try {
    await connectWhatsApp(tenantId, phoneNumberId, accessToken, actor.audit);
  } catch (e: any) {
    if (/row-level security|duplicate key/.test(String(e?.message))) throw new HTTPException(409, { message: "That number is already connected to a business" });
    throw e;
  }
  return c.json({ ok: true });
});

admin.post("/businesses/:id/connections/webhook", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"), "manage");
  const { kind, label } = await parse(c, z.object({ kind: z.enum(["web_form", "checkatrade_webhook"]), label: z.string().trim().max(100).optional() }));
  const url = await addWebhook(tenantId, kind, label, actor.audit);
  return c.json({ url }, 201);
});

admin.post("/businesses/:id/connections/:connId/disable", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"), "manage");
  const id = uuid(c.req.param("connId"));
  const row = await withTenant(tenantId, async (db) => {
    const r = await one<{ kind: string }>(db, "update channel_connections set status = 'disconnected' where id = $1 returning kind", [id]);
    if (r) await audit(db, { tenantId, actor: actor.audit, action: "connection.disabled", entity: "connection", entityId: id, detail: { kind: r.kind } });
    return r;
  });
  if (!row) throw notFound();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- people
const memberFields = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().optional(),
  role: z.enum(["owner", "staff"]),
  whatsapp: z.string().trim().min(6).max(30).optional(),
  isApprover: z.boolean().default(true),
});

admin.get("/businesses/:id/members", async (c) => {
  const { tenantId } = tenantAccess(c, c.req.param("id"));
  const members = await withTenant(tenantId, (db) => many(db,
    `select id, name, email, role, whatsapp_phone as whatsapp, is_approver as "isApprover", (user_id is not null) as "hasLoggedIn"
     from tenant_members order by created_at`));
  return c.json({ members });
});

admin.post("/businesses/:id/members", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"), "manage");
  const m = await parse(c, memberFields);
  const phone = m.whatsapp ? normalisePhone(m.whatsapp) : undefined;
  if (m.isApprover && !phone) throw new HTTPException(400, { message: "Approvers need a WhatsApp number" });
  const email = normaliseEmail(m.email);
  const id = await withTenant(tenantId, async (db) => {
    if (email && await one(db, "select 1 from tenant_members where lower(email) = $1", [email])) throw new HTTPException(409, { message: "Someone with that email is already in this business" });
    const row = await one<{ id: string }>(db,
      "insert into tenant_members (tenant_id, name, email, role, whatsapp_phone, is_approver) values (app_current_tenant(), $1, $2, $3, $4, $5) returning id",
      [m.name, email ?? null, m.role, phone ?? null, m.isApprover]);
    await audit(db, { tenantId, actor: actor.audit, action: "member.added", entity: "member", entityId: row!.id, detail: { role: m.role } });
    return row!.id;
  });
  return c.json({ id }, 201);
});

admin.put("/businesses/:id/members/:memberId", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"), "manage");
  const memberId = uuid(c.req.param("memberId"));
  const m = await parse(c, memberFields);
  const phone = m.whatsapp ? normalisePhone(m.whatsapp) : undefined;
  if (m.isApprover && !phone) throw new HTTPException(400, { message: "Approvers need a WhatsApp number" });
  await withTenant(tenantId, async (db) => {
    const cur = await one<{ role: string }>(db, "select role from tenant_members where id = $1 for update", [memberId]);
    if (!cur) throw notFound();
    if (cur.role === "owner" && m.role !== "owner") await assertAnotherOwner(db, memberId);
    await db.query("update tenant_members set name = $2, email = $3, role = $4, whatsapp_phone = $5, is_approver = $6 where id = $1",
      [memberId, m.name, normaliseEmail(m.email) ?? null, m.role, phone ?? null, m.isApprover]);
    await audit(db, { tenantId, actor: actor.audit, action: "member.updated", entity: "member", entityId: memberId, detail: { role: m.role } });
  });
  return c.json({ ok: true });
});

admin.delete("/businesses/:id/members/:memberId", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"), "manage");
  const memberId = uuid(c.req.param("memberId"));
  await withTenant(tenantId, async (db) => {
    const cur = await one<{ role: string }>(db, "select role from tenant_members where id = $1 for update", [memberId]);
    if (!cur) throw notFound();
    if (cur.role === "owner") await assertAnotherOwner(db, memberId);
    await db.query("delete from tenant_members where id = $1", [memberId]);
    await audit(db, { tenantId, actor: actor.audit, action: "member.removed", entity: "member", entityId: memberId });
  });
  return c.json({ ok: true });
});

async function assertAnotherOwner(db: Parameters<Parameters<typeof withTenant>[1]>[0], exceptId: string) {
  if (!await one(db, "select 1 from tenant_members where role = 'owner' and id <> $1", [exceptId])) {
    throw new HTTPException(409, { message: "A business needs at least one owner" });
  }
}

// ---------------------------------------------------------------- inbox
admin.get("/businesses/:id/conversations", async (c) => {
  const { tenantId } = tenantAccess(c, c.req.param("id"));
  const waiting = c.req.query("waiting") === "1";
  const rows = await withTenant(tenantId, (db) => many(db,
    `select v.id, v.status, ct.name, greatest(v.last_inbound_at, v.created_at) as last_activity_at,
       (select left(m.body, 140) from messages m where m.conversation_id = v.id order by m.received_at desc limit 1) as preview,
       (select count(*)::int from drafts d where d.conversation_id = v.id and d.status = 'pending_approval') as drafts_waiting,
       exists (select 1 from drafts d where d.conversation_id = v.id and d.status = 'pending_approval' and d.needs_attention) as needs_attention
     from conversations v join contacts ct on ct.id = v.contact_id
     where ($1::boolean is false or exists (select 1 from drafts d where d.conversation_id = v.id and d.status = 'pending_approval'))
     order by greatest(v.last_inbound_at, v.created_at) desc limit $2`, [waiting, limitOf(c, 50, 100)]));
  return c.json({ conversations: rows });
});

admin.get("/businesses/:id/conversations/:convId", async (c) => {
  const { tenantId } = tenantAccess(c, c.req.param("id"));
  const convId = uuid(c.req.param("convId"));
  const out = await withTenant(tenantId, async (db) => {
    const conv = await one(db, "select v.id, v.status, ct.name from conversations v join contacts ct on ct.id = v.contact_id where v.id = $1", [convId]);
    if (!conv) return undefined;
    return {
      conversation: conv,
      messages: await many(db, "select id, direction, channel, subject, body, from_name, data_tags, received_at from messages where conversation_id = $1 order by received_at", [convId]),
      drafts: await many(db,
        `select id, reply_route, body, original_body, (body <> original_body) as edited, review, needs_attention, attention_reason, status, created_at, decided_at
         from drafts where conversation_id = $1 order by created_at`, [convId]),
    };
  });
  if (!out) throw notFound();
  return c.json(out);
});

function decisionResponse(c: Context, r: DecisionResult) {
  if (r.ok) return c.json({ ok: true });
  if (r.reason === "not_found") throw notFound();
  return c.json({ ok: false, error: `This reply is already ${(r.status ?? "dealt with").replace("_", " ")}.`, status: r.status }, 409);
}

admin.post("/businesses/:id/drafts/:draftId/approve", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"));
  return decisionResponse(c, await approveDraft(tenantId, actor, uuid(c.req.param("draftId"))));
});
admin.post("/businesses/:id/drafts/:draftId/reject", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"));
  return decisionResponse(c, await rejectDraft(tenantId, actor, uuid(c.req.param("draftId"))));
});
admin.post("/businesses/:id/drafts/:draftId/edit", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"));
  const { body } = await parse(c, z.object({ body: z.string().trim().min(1, "The reply can't be empty").max(4000) }));
  return decisionResponse(c, await editAndApproveDraft(tenantId, actor, uuid(c.req.param("draftId")), body));
});

// ---------------------------------------------------------------- bookings
admin.get("/businesses/:id/bookings", async (c) => {
  const { tenantId } = tenantAccess(c, c.req.param("id"));
  const rows = await withTenant(tenantId, (db) => many(db,
    `select h.id, h.service, h.start_at, h.end_at, h.status, h.expires_at, h.conversation_id, ct.name as customer
     from holds h left join contacts ct on ct.id = h.contact_id
     where h.status in ('held', 'confirmed') or h.start_at > now() - interval '30 days'
     order by h.start_at desc limit 200`));
  return c.json({ bookings: rows });
});

admin.post("/businesses/:id/bookings/:holdId/cancel", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"));
  const holdId = uuid(c.req.param("holdId"));
  const result = await withTenant(tenantId, async (db) => {
    const h = await one<{ status: string }>(db, "select status from holds where id = $1 for update", [holdId]);
    if (!h) return "missing" as const;
    if (!["held", "confirmed"].includes(h.status)) return "done" as const;
    await releaseHold(db, holdId, h.status === "held" ? "released" : "cancelled");
    await audit(db, { tenantId, actor: actor.audit, action: "booking.cancelled", entity: "hold", entityId: holdId, detail: { was: h.status } });
    return "ok" as const;
  });
  if (result === "missing") throw notFound();
  if (result === "done") throw new HTTPException(409, { message: "That time is already released" });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- activity
admin.get("/businesses/:id/runs", async (c) => {
  const { tenantId } = tenantAccess(c, c.req.param("id"));
  const rows = await withTenant(tenantId, (db) => many(db,
    `select r.id, r.use_case, r.status, r.outcome, r.outcome_reason, r.error, r.created_at, r.finished_at,
       coalesce(sum(e.input_tokens), 0)::int as input_tokens, coalesce(sum(e.output_tokens), 0)::int as output_tokens,
       coalesce(array_agg(distinct e.agent || ' ' || e.agent_version) filter (where e.agent is not null), '{}') as agents
     from runs r left join run_events e on e.run_id = r.id
     group by r.id order by r.created_at desc limit $1 offset $2`, [limitOf(c), Math.max(Number(c.req.query("offset")) || 0, 0)]));
  return c.json({ runs: rows });
});

admin.get("/businesses/:id/runs/:runId", async (c) => {
  const { tenantId } = tenantAccess(c, c.req.param("id"));
  const runId = uuid(c.req.param("runId"));
  const out = await withTenant(tenantId, async (db) => {
    const run = await one(db, "select id, use_case, status, triage, booking, outcome, outcome_reason, error, created_at, finished_at from runs where id = $1", [runId]);
    if (!run) return undefined;
    return { run, events: await many(db, "select at, step, agent, agent_version, model, input_tokens, output_tokens, ms, detail from run_events where run_id = $1 order by id", [runId]) };
  });
  if (!out) throw notFound();
  return c.json(out);
});

admin.get("/businesses/:id/audit", async (c) => {
  const { tenantId } = tenantAccess(c, c.req.param("id"));
  const prefix = (c.req.query("action") ?? "").replace(/[%_\\]/g, "");
  const before = Number(c.req.query("before")) || null;
  const rows = await withTenant(tenantId, (db) => many(db,
    `select id, at, actor, action, entity, entity_id, detail from audit_log
     where ($1 = '' or action like $1 || '%') and ($2::bigint is null or id < $2) order by id desc limit $3`, [prefix, before, limitOf(c, 100, 500)]));
  return c.json({ entries: rows });
});

// ---------------------------------------------------------------- data requests
const person = z.object({
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(6).optional(),
  confirm: z.string(),
}).refine((p) => !!p.email !== !!p.phone, { message: "Give either an email address or a phone number" });

async function confirmedPerson(c: Context, tenantId: string) {
  const p = await parse(c, person);
  const t = await withTenant(tenantId, (db) => one<{ slug: string }>(db, "select slug from tenants where id = app_current_tenant()"));
  if (!t || p.confirm !== t.slug) throw new HTTPException(400, { message: `Type the business's web address (${t?.slug}) to confirm` });
  return p;
}

admin.get("/businesses/:id/data-requests", async (c) => {
  const { tenantId } = tenantAccess(c, c.req.param("id"), "manage");
  const rows = await withTenant(tenantId, (db) => many(db, "select id, kind, requested_by, status, created_at from data_requests order by created_at desc limit 100"));
  return c.json({ requests: rows });
});

admin.post("/businesses/:id/data/export", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"), "manage");
  const p = await confirmedPerson(c, tenantId);
  const data = await exportPerson(tenantId, p, actor.audit);
  if (!data) throw new HTTPException(404, { message: "Nobody found with those details" });
  return c.json(data);
});

admin.post("/businesses/:id/data/erase", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"), "manage");
  const p = await confirmedPerson(c, tenantId);
  if (!await erasePerson(tenantId, p, actor.audit)) throw new HTTPException(404, { message: "Nobody found with those details" });
  return c.json({ ok: true });
});

admin.post("/businesses/:id/data/suppress", async (c) => {
  const { tenantId, actor } = tenantAccess(c, c.req.param("id"), "manage");
  const p = await confirmedPerson(c, tenantId);
  const reason = z.string().trim().max(200).default("opted out").parse((await c.req.json().catch(() => ({}))).reason);
  await suppress(tenantId, p, reason, actor.audit);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- agents (platform admin, read-only)
admin.get("/agents", async (c) => {
  requireAdmin(c);
  return c.json(await withAdmin(async (db) => ({
    versions: await many(db, "select agent_key, version, created_at, definition->>'model' as model, definition->>'description' as description from agent_definitions order by agent_key, created_at desc"),
    pinned: await many(db, "select id, slug, name, settings->'agentVersions' as pinned from tenants order by name"),
  })));
});
