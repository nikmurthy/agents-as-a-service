import { Hono } from "hono";
import { z } from "zod";
import { many, one, withAdmin, withTenant } from "../db.js";
import { audit } from "../audit.js";
import { releaseHold } from "../calendar.js";
import { normaliseEmail, normalisePhone } from "../channels/parse.js";
import { erasePerson, exportPerson, suppress } from "../data-rights.js";
import { body, guard, guardAdmin, UUID, type Vars } from "./access.js";

// People, conversations, bookings, activity, data requests and agents. Same rules as routes.ts:
// every route checks access first and business data only goes through withTenant.
export const moreApi = new Hono<Vars>();

const notFound = (c: { json: (b: unknown, s: 404) => Response }) => c.json({ error: "not_found" }, 404);
const issue = (path: string, message: string) => ({ error: "invalid", issues: [{ path, message }] });

function pageParams(c: { req: { query: (k: string) => string | undefined } }) {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const before = c.req.query("before");
  return { limit, before: before && /^[0-9TZ:.+-]+$/.test(before) ? before : undefined };
}

// ---------------------------------------------------------------- people
const phone = z.string().trim().min(6, "Enter a mobile number").max(20).transform((s) => normalisePhone(s)!);
const personFields = {
  name: z.string().trim().min(1, "Name is required").max(100),
  role: z.enum(["owner", "staff"]),
  email: z.string().trim().email("Not a valid email address").max(200).transform((s) => normaliseEmail(s)!).optional(),
  whatsapp: phone.optional(),
  isApprover: z.boolean(),
};

moreApi.get("/businesses/:id/people", async (c) => {
  const g = guard(c, c.req.param("id"), "view");
  if (!g.ok) return g.res;
  const people = await withTenant(g.tenantId, (db) => many(db,
    `select id, name, role, email, whatsapp_phone as "whatsapp", is_approver as "isApprover", (user_id is not null) as "hasLogin", created_at as "createdAt"
     from tenant_members order by role, created_at`));
  return c.json({ people, canEdit: g.manage });
});

moreApi.post("/businesses/:id/people", async (c) => {
  const g = guard(c, c.req.param("id"), "manage");
  if (!g.ok) return g.res;
  const b = await body(c, z.object(personFields).partial({ role: true, isApprover: true }).strict());
  if (!b.ok) return b.res;
  const p = { role: "staff" as const, isApprover: false, ...b.data };
  if (p.isApprover && !p.whatsapp) return c.json(issue("whatsapp", "Approvers need a WhatsApp number"), 422);
  try {
    const id = await withTenant(g.tenantId, async (db) => {
      const row = await one<{ id: string }>(db,
        "insert into tenant_members (tenant_id, name, role, email, whatsapp_phone, is_approver) values (app_current_tenant(), $1, $2, $3, $4, $5) returning id",
        [p.name, p.role, p.email ?? null, p.whatsapp ?? null, p.isApprover]);
      await audit(db, { tenantId: g.tenantId, actor: g.actor.label, action: "member.added", entity: "member", entityId: row!.id, detail: { role: p.role, approver: p.isApprover } });
      return row!.id;
    });
    return c.json({ id }, 201);
  } catch (e: any) {
    if (e?.code === "23505") return c.json(issue("email", "Someone with that email is already on this business"), 409);
    throw e;
  }
});

moreApi.put("/businesses/:id/people/:memberId", async (c) => {
  const g = guard(c, c.req.param("id"), "manage");
  if (!g.ok) return g.res;
  const memberId = c.req.param("memberId");
  if (!UUID.test(memberId)) return notFound(c);
  const b = await body(c, z.object({ ...personFields, email: personFields.email.nullable(), whatsapp: phone.nullable() }).partial().strict());
  if (!b.ok) return b.res;
  try {
    const result = await withTenant(g.tenantId, async (db) => {
      const m = await one(db, "select * from tenant_members where id = $1 for update", [memberId]);
      if (!m) return "not_found" as const;
      const next = {
        name: b.data.name ?? m.name, role: b.data.role ?? m.role,
        email: b.data.email === undefined ? m.email : b.data.email,
        whatsapp: b.data.whatsapp === undefined ? m.whatsapp_phone : b.data.whatsapp,
        isApprover: b.data.isApprover ?? m.is_approver,
      };
      if (next.isApprover && !next.whatsapp) return "no_number" as const;
      if (m.role === "owner" && next.role !== "owner") {
        const owners = await one(db, "select count(*)::int as n from tenant_members where role = 'owner'");
        if (owners!.n <= 1) return "last_owner" as const;
      }
      await db.query("update tenant_members set name = $2, role = $3, email = $4, whatsapp_phone = $5, is_approver = $6 where id = $1",
        [memberId, next.name, next.role, next.email, next.whatsapp, next.isApprover]);
      await audit(db, { tenantId: g.tenantId, actor: g.actor.label, action: "member.updated", entity: "member", entityId: memberId,
        detail: { fields: Object.keys(b.data), role: next.role, approver: next.isApprover } });
      return "ok" as const;
    });
    if (result === "not_found") return notFound(c);
    if (result === "no_number") return c.json(issue("whatsapp", "Approvers need a WhatsApp number"), 422);
    if (result === "last_owner") return c.json(issue("role", "There must be at least one owner"), 409);
    return c.json({ ok: true });
  } catch (e: any) {
    if (e?.code === "23505") return c.json(issue("email", "Someone with that email is already on this business"), 409);
    throw e;
  }
});

moreApi.delete("/businesses/:id/people/:memberId", async (c) => {
  const g = guard(c, c.req.param("id"), "manage");
  if (!g.ok) return g.res;
  const memberId = c.req.param("memberId");
  if (!UUID.test(memberId)) return notFound(c);
  const result = await withTenant(g.tenantId, async (db) => {
    const m = await one(db, "select role from tenant_members where id = $1 for update", [memberId]);
    if (!m) return "not_found" as const;
    if (m.role === "owner" && (await one(db, "select count(*)::int as n from tenant_members where role = 'owner'"))!.n <= 1) return "last_owner" as const;
    await db.query("delete from tenant_members where id = $1", [memberId]);
    await audit(db, { tenantId: g.tenantId, actor: g.actor.label, action: "member.removed", entity: "member", entityId: memberId, detail: { role: m.role } });
    return "ok" as const;
  });
  if (result === "not_found") return notFound(c);
  if (result === "last_owner") return c.json(issue("role", "There must be at least one owner"), 409);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- conversations (the inbox)
moreApi.get("/businesses/:id/conversations", async (c) => {
  const g = guard(c, c.req.param("id"), "view");
  if (!g.ok) return g.res;
  const { limit, before } = pageParams(c);
  const conversations = await withTenant(g.tenantId, (db) => many(db,
    `select cv.id, cv.status, cv.last_inbound_at as "lastInboundAt", coalesce(ct.name, case when ct.erased_at is not null then 'Erased' else 'Unknown' end) as customer,
       (select m.channel from messages m where m.conversation_id = cv.id order by m.received_at desc limit 1) as channel,
       (select count(*)::int from drafts d where d.conversation_id = cv.id and d.status = 'pending_approval') as "draftsWaiting"
     from conversations cv join contacts ct on ct.id = cv.contact_id
     where ($2::timestamptz is null or cv.last_inbound_at < $2::timestamptz)
     order by cv.last_inbound_at desc nulls last limit $1`, [limit, before ?? null]));
  return c.json({ conversations });
});

moreApi.get("/businesses/:id/conversations/:convId", async (c) => {
  const g = guard(c, c.req.param("id"), "view");
  if (!g.ok) return g.res;
  const convId = c.req.param("convId");
  if (!UUID.test(convId)) return notFound(c);
  const out = await withTenant(g.tenantId, async (db) => {
    const cv = await one(db,
      `select cv.id, cv.status, coalesce(ct.name, case when ct.erased_at is not null then 'Erased' else 'Unknown' end) as customer
       from conversations cv join contacts ct on ct.id = cv.contact_id where cv.id = $1`, [convId]);
    if (!cv) return undefined;
    return {
      conversation: cv,
      messages: await many(db,
        `select id, direction, channel, subject, body, from_name as "fromName", received_at as "at" from messages where conversation_id = $1 order by received_at, created_at`, [convId]),
      drafts: await many(db,
        `select id, status, body, original_body as "originalBody", reply_route as "replyRoute", review, needs_attention as "needsAttention",
                attention_reason as "attentionReason", created_at as "createdAt", decided_at as "decidedAt", (body <> original_body) as edited
         from drafts where conversation_id = $1 order by created_at`, [convId]),
      bookings: await many(db, `select id, service, status, start_at as "start", end_at as "end" from holds where conversation_id = $1 order by start_at`, [convId]),
    };
  });
  return out ? c.json(out) : notFound(c);
});

// ---------------------------------------------------------------- bookings
const HOLD_STATUSES = ["held", "confirmed", "released", "expired", "cancelled"] as const;

moreApi.get("/businesses/:id/bookings", async (c) => {
  const g = guard(c, c.req.param("id"), "view");
  if (!g.ok) return g.res;
  const asked = c.req.query("status");
  const status = asked ? z.enum(HOLD_STATUSES).safeParse(asked) : undefined;
  if (status && !status.success) return c.json(issue("status", "Unknown status"), 422);
  const bookings = await withTenant(g.tenantId, (db) => many(db,
    `select h.id, h.service, h.status, h.start_at as "start", h.end_at as "end", h.expires_at as "expiresAt", h.conversation_id as "conversationId",
            coalesce(ct.name, 'Unknown') as customer
     from holds h left join contacts ct on ct.id = h.contact_id
     where ($1::text is null and h.status in ('held', 'confirmed') and h.end_at > now() - interval '1 day') or h.status = $1
     order by h.start_at ${status ? "desc" : "asc"} limit 200`, [status?.data ?? null]));
  return c.json({ bookings });
});

moreApi.post("/businesses/:id/bookings/:holdId/cancel", async (c) => {
  const g = guard(c, c.req.param("id"), "approve");
  if (!g.ok) return g.res;
  const holdId = c.req.param("holdId");
  if (!UUID.test(holdId)) return notFound(c);
  const result = await withTenant(g.tenantId, async (db) => {
    const h = await one<{ status: string }>(db, "select status from holds where id = $1 for update", [holdId]);
    if (!h) return "not_found" as const;
    if (!["held", "confirmed"].includes(h.status)) return h.status;
    const to = h.status === "confirmed" ? "cancelled" : "released";
    await releaseHold(db, holdId, to);
    await audit(db, { tenantId: g.tenantId, actor: g.actor.label, action: h.status === "confirmed" ? "booking.cancelled" : "hold.released", entity: "hold", entityId: holdId, detail: { via: "web" } });
    return "ok" as const;
  });
  if (result === "not_found") return notFound(c);
  if (result !== "ok") return c.json({ error: "already_closed", status: result }, 409);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- activity
moreApi.get("/businesses/:id/runs", async (c) => {
  const g = guard(c, c.req.param("id"), "view");
  if (!g.ok) return g.res;
  const { limit, before } = pageParams(c);
  const runs = await withTenant(g.tenantId, (db) => many(db,
    `select r.id, r.use_case as "useCase", r.status, r.outcome, r.outcome_reason as "outcomeReason", r.error, r.created_at as "createdAt", r.finished_at as "finishedAt",
       coalesce((select sum(e.input_tokens) from run_events e where e.run_id = r.id), 0)::int as "inputTokens",
       coalesce((select sum(e.output_tokens) from run_events e where e.run_id = r.id), 0)::int as "outputTokens",
       coalesce((select array_agg(distinct e.agent || '@' || e.agent_version) from run_events e where e.run_id = r.id and e.agent is not null and e.agent_version is not null), '{}') as agents
     from runs r where ($2::timestamptz is null or r.created_at < $2::timestamptz) order by r.created_at desc limit $1`, [limit, before ?? null]));
  return c.json({ runs });
});

moreApi.get("/businesses/:id/runs/:runId", async (c) => {
  const g = guard(c, c.req.param("id"), "view");
  if (!g.ok) return g.res;
  const runId = c.req.param("runId");
  if (!UUID.test(runId)) return notFound(c);
  const out = await withTenant(g.tenantId, async (db) => {
    const run = await one(db,
      `select id, use_case as "useCase", status, outcome, outcome_reason as "outcomeReason", error, triage, booking, created_at as "createdAt", finished_at as "finishedAt" from runs where id = $1`, [runId]);
    if (!run) return undefined;
    return {
      run,
      events: await many(db,
        `select id, at, step, agent, agent_version as "agentVersion", model, input_tokens as "inputTokens", output_tokens as "outputTokens", ms, detail from run_events where run_id = $1 order by id`, [runId]),
    };
  });
  return out ? c.json(out) : notFound(c);
});

moreApi.get("/businesses/:id/audit", async (c) => {
  const g = guard(c, c.req.param("id"), "view");
  if (!g.ok) return g.res;
  const { limit, before } = pageParams(c);
  const action = c.req.query("action");
  if (action && !/^[a-z_.]{1,60}$/.test(action)) return c.json(issue("action", "Unknown filter"), 422);
  const entries = await withTenant(g.tenantId, (db) => many(db,
    `select id, at, actor, action, entity, entity_id as "entityId", detail from audit_log
     where ($2::text is null or action = $2 or action like $2 || '.%') and ($3::timestamptz is null or at < $3::timestamptz)
     order by at desc, id desc limit $1`, [limit, action ?? null, before ?? null]));
  return c.json({ entries });
});

// ---------------------------------------------------------------- data requests (export, erase, suppress)
const person = z.object({
  email: z.string().trim().email().max(200).optional(),
  phone: z.string().trim().min(6).max(20).optional(),
  confirm: z.string().trim().max(200).optional(),
  reason: z.string().trim().max(200).optional(),
}).strict().refine((p) => !!p.email !== !!p.phone, { message: "Give either an email address or a phone number", path: ["email"] });

/** Erase and suppress need the identifier typed again, so a stray click can't remove someone. */
const typed = (p: z.infer<typeof person>) => (p.confirm ?? "").replace(/\s+/g, "").toLowerCase() === (p.email ?? p.phone ?? "").replace(/\s+/g, "").toLowerCase();

async function dataAction(c: any, kind: "export" | "erase" | "suppress") {
  const g = guard(c, c.req.param("id"), "manage");
  if (!g.ok) return g.res;
  const b = await body(c, person);
  if (!b.ok) return b.res;
  const who = { email: b.data.email, phone: b.data.phone };
  if (who.phone && !normalisePhone(who.phone)) return c.json(issue("phone", "Enter a valid phone number"), 422);
  if (kind !== "export" && !typed(b.data)) return c.json(issue("confirm", "Type the email address or number again to confirm"), 422);
  if (kind === "export") {
    const data = await exportPerson(g.tenantId, who, g.actor.label);
    return data ? c.json({ data }) : notFound(c);
  }
  if (kind === "erase") return (await erasePerson(g.tenantId, who, g.actor.label)) ? c.json({ ok: true }) : notFound(c);
  await suppress(g.tenantId, who, b.data.reason || "opted out", g.actor.label);
  return c.json({ ok: true });
}
moreApi.post("/businesses/:id/data/export", (c) => dataAction(c, "export"));
moreApi.post("/businesses/:id/data/erase", (c) => dataAction(c, "erase"));
moreApi.post("/businesses/:id/data/suppress", (c) => dataAction(c, "suppress"));

moreApi.get("/businesses/:id/data/requests", async (c) => {
  const g = guard(c, c.req.param("id"), "manage");
  if (!g.ok) return g.res;
  const requests = await withTenant(g.tenantId, (db) => many(db,
    `select id, kind, requested_by as "requestedBy", status, created_at as "createdAt" from data_requests order by created_at desc limit 100`));
  return c.json({ requests });
});

// ---------------------------------------------------------------- agents (platform admin, read-only)
moreApi.get("/agents", async (c) => {
  const a = guardAdmin(c);
  if (!a.ok) return a.res;
  const out = await withAdmin(async (db) => {
    const defs = await many(db,
      `select agent_key as "key", version, definition->>'model' as model, definition->>'description' as description, created_at as "createdAt"
       from agent_definitions order by agent_key, created_at`);
    const pins = await many(db, `select id, name, slug, settings->'agentVersions' as pins from tenants where status <> 'closed' order by name`);
    return { defs, pins };
  });
  const agents: Record<string, { key: string; versions: unknown[] }> = {};
  for (const d of out.defs) (agents[d.key] ??= { key: d.key, versions: [] }).versions.push({ version: d.version, model: d.model, description: d.description, createdAt: d.createdAt });
  return c.json({ agents: Object.values(agents), businesses: out.pins.map((t) => ({ id: t.id, name: t.name, slug: t.slug, pinned: t.pins ?? {} })) });
});
