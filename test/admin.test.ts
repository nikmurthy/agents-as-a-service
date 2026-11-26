// Admin web app API: sign-in, who can see and change what, and the web path for approving replies.
// Needs a throwaway Postgres in TEST_DATABASE_URL: it is wiped at the start.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { SignJWT } from "jose";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://platform_dev:platform_dev@localhost:5432/platform_test";
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.SIGNING_SECRET = "test-signing-secret";
process.env.AGENT_MODE = "mock";
process.env.WA_APP_SECRET = "test-app-secret";
process.env.WA_VERIFY_TOKEN = "verify-me";
process.env.PLATFORM_WA_PHONE_NUMBER_ID = "PLATFORM";
process.env.PLATFORM_WA_TOKEN = "platform-token";
process.env.GOOGLE_CLIENT_ID = "gid";
process.env.GOOGLE_CLIENT_SECRET = "gsecret";
process.env.PUBLIC_BASE_URL = "https://platform.example";
process.env.SUPABASE_JWT_SECRET = "test-jwt-secret-test-jwt-secret-test";

const { getPool, closePool, withTenant, withAdmin, one, many } = await import("../src/db.js");
const { migrate } = await import("../src/cli/migrate.js");
const { syncAgents } = await import("../src/cli/agents-sync.js");
const { clients } = await import("../src/integrations/index.js");
const { createTenant, connectWhatsApp, setTenantStatus } = await import("../src/onboarding.js");
const { app } = await import("../src/app.js");
const { taskList } = await import("../src/jobs/tasks.js");
const { releaseQueue } = await import("../src/jobs/queue.js");
const { tenantSettingsSchema } = await import("../src/settings-schema.js");
const { sendWeeklySummaries, weeklyText } = await import("../src/workflows/weekly-summary.js");
const { runOnce, Logger } = await import("graphile-worker");
const { fakeGoogle, fakeWhatsApp } = await import("./fakes.js");

const google = fakeGoogle();
const wa = fakeWhatsApp();
clients.google = google.client;
clients.whatsapp = wa.client;

const logger = new Logger(() => () => {});
const drain = async () => { for (let i = 0; i < 4; i++) await runOnce({ pgPool: getPool(), taskList, logger }); };

const key = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
const USERS = {
  ownerA: { sub: "00000000-0000-4000-8000-0000000000a1", email: "mark@a.example" },
  staffA: { sub: "00000000-0000-4000-8000-0000000000a2", email: "sam@a.example" },
  ownerB: { sub: "00000000-0000-4000-8000-0000000000b1", email: "olu@b.example" },
  admin: { sub: "00000000-0000-4000-8000-0000000000c1", email: "nik@platform.example" },
  stranger: { sub: "00000000-0000-4000-8000-0000000000d1", email: "nobody@example.com" },
};
async function token(u: { sub: string; email: string }, aal = "aal1", expiresIn = "1h") {
  return new SignJWT({ email: u.email, aal }).setProtectedHeader({ alg: "HS256" }).setSubject(u.sub)
    .setAudience("authenticated").setIssuedAt().setExpirationTime(expiresIn).sign(key);
}
async function api(who: keyof typeof USERS | null, method: string, path: string, body?: unknown, aal = "aal1") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who) headers.authorization = `Bearer ${await token(USERS[who], aal)}`;
  const res = await app.request(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

let A: string;
let B: string;
let memberA: string;

async function makeDraft(tenantId: string, body = "Hi Jo, thanks for getting in touch.") {
  return withTenant(tenantId, async (db) => {
    const ct = await one<{ id: string }>(db, "insert into contacts (tenant_id, name) values (app_current_tenant(), 'Jo Bloggs') returning id");
    const cv = await one<{ id: string }>(db, "insert into conversations (tenant_id, contact_id, last_inbound_at) values (app_current_tenant(), $1, now()) returning id", [ct!.id]);
    await db.query("insert into messages (tenant_id, conversation_id, direction, channel, body, from_name) values (app_current_tenant(), $1, 'in', 'whatsapp', 'Can you quote for a kitchen floor?', 'Jo Bloggs')", [cv!.id]);
    const d = await one<{ id: string }>(db,
      "insert into drafts (tenant_id, conversation_id, reply_route, body, original_body) values (app_current_tenant(), $1, 'whatsapp', $2, $2) returning id", [cv!.id, body]);
    const m = await one<{ id: string }>(db, "select id from tenant_members where role = 'owner' limit 1");
    await db.query("insert into approval_requests (tenant_id, draft_id, member_id) values (app_current_tenant(), $1, $2)", [d!.id, m!.id]);
    return { draftId: d!.id, conversationId: cv!.id };
  });
}

before(async () => {
  await getPool().query("drop schema if exists graphile_worker cascade; drop schema if exists public cascade; create schema public;");
  await migrate(() => {});
  await syncAgents(() => {});
  A = (await createTenant({ slug: "marks-flooring", name: "Mark's Flooring", pack: "flooring", owner: { name: "Mark", whatsapp: "07700 900001", email: USERS.ownerA.email } })).id;
  B = (await createTenant({ slug: "other-biz", name: "Other Business", pack: "trades", owner: { name: "Olu", whatsapp: "07700 900002", email: USERS.ownerB.email } })).id;
  await connectWhatsApp(A, "TENANT_WA", "tenant-wa-token");
  await setTenantStatus(A, "active");
  await setTenantStatus(B, "active");
  memberA = (await withTenant(A, (db) => one<{ id: string }>(db,
    "insert into tenant_members (tenant_id, name, email, role, is_approver) values (app_current_tenant(), 'Sam', $1, 'staff', false) returning id", [USERS.staffA.email])))!.id;
  await withAdmin((db) => db.query("insert into platform_admins (user_id, email) values ($1, $2)", [USERS.admin.sub, USERS.admin.email]));
});

after(async () => { await releaseQueue(); await closePool(); });

test("the API needs a valid sign-in", async () => {
  assert.equal((await api(null, "GET", "/me")).status, 401);
  const bad = await app.request("/api/me", { headers: { authorization: "Bearer not-a-token" } });
  assert.equal(bad.status, 401);
  const expired = await new SignJWT({ email: USERS.ownerA.email }).setProtectedHeader({ alg: "HS256" }).setSubject(USERS.ownerA.sub)
    .setAudience("authenticated").setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(Math.floor(Date.now() / 1000) - 3600).sign(key);
  assert.equal((await app.request("/api/me", { headers: { authorization: `Bearer ${expired}` } })).status, 401);
  const wrongKey = await new SignJWT({ email: USERS.ownerA.email }).setProtectedHeader({ alg: "HS256" }).setSubject(USERS.ownerA.sub)
    .setAudience("authenticated").setExpirationTime("1h").sign(new TextEncoder().encode("another-secret-another-secret-another"));
  assert.equal((await app.request("/api/me", { headers: { authorization: `Bearer ${wrongKey}` } })).status, 401);
});

test("signing in links a person to their business by email and shows only their own", async () => {
  const me = await api("ownerA", "GET", "/me");
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.businesses.map((b: any) => [b.slug, b.role]), [["marks-flooring", "owner"]]);
  assert.equal(me.json.isAdmin, false);
  assert.equal((await api("stranger", "GET", "/me")).json.businesses.length, 0);
  assert.equal((await api("ownerA", "GET", "/businesses")).json.businesses.length, 1);
  assert.equal((await api("ownerA", "POST", "/businesses", { slug: "new-one", name: "New", pack: "trades", owner: { name: "X", whatsapp: "07700900003" } })).status, 403);
});

test("one business can't see or change another", async () => {
  for (const [m, p] of [["GET", `/businesses/${B}`], ["GET", `/businesses/${B}/settings`], ["GET", `/businesses/${B}/conversations`],
    ["GET", `/businesses/${B}/members`], ["GET", `/businesses/${B}/connections`], ["GET", `/businesses/${B}/audit`]] as const) {
    assert.equal((await api("ownerA", m, p)).status, 404, `${m} ${p}`);
  }
  assert.equal((await api("ownerA", "PUT", `/businesses/${B}/status`, { status: "paused" })).status, 404);
  assert.equal((await api("stranger", "GET", `/businesses/${A}`)).status, 404);
  const { draftId } = await makeDraft(B);
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/drafts/${draftId}/approve`)).status, 404, "a draft id from another business must not work under my business");
  assert.equal((await api("ownerA", "POST", `/businesses/${B}/drafts/${draftId}/approve`)).status, 404);
  assert.equal((await withTenant(B, (db) => one<{ status: string }>(db, "select status from drafts where id = $1", [draftId])))!.status, "pending_approval");
});

test("connecting a number by ID: Meta is asked first, so a wrong ID is refused with a reason", async () => {
  const bad = await api("ownerA", "POST", `/businesses/${A}/connections/whatsapp`, { phoneNumberId: "999111222333", wabaId: "200000000000001", accessToken: "tokentokentoken" });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error ?? bad.json.message ?? JSON.stringify(bad.json), /Phone number ID/);
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/connections/whatsapp`, { phoneNumberId: "+1 555 123 4567", wabaId: "200000000000001", accessToken: "tokentokentoken" })).status, 400, "a phone number isn't an ID");
  const noSub = await api("ownerA", "POST", `/businesses/${A}/connections/whatsapp`, { phoneNumberId: "106540352242922", wabaId: "999000000000001", accessToken: "tokentokentoken" });
  assert.equal(noSub.status, 400, "refused if Meta won't subscribe the account: messages would never arrive");
  assert.match(JSON.stringify(noSub.json), /Business Account ID/);
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/connections/whatsapp`, { phoneNumberId: "106540352242922", accessToken: "tokentokentoken" })).status, 400, "account ID is needed");
  const ok = await api("ownerA", "POST", `/businesses/${A}/connections/whatsapp`, { phoneNumberId: "106540352242922", wabaId: "200000000000001", accessToken: "tokentokentoken" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.display, "+44 7700 900777");
  assert.ok(wa.signup.includes("subscribe:200000000000001:tokentokentoken"), "the account is subscribed to the app");
  const conn = await withTenant(A, (db) => one(db, "select label from channel_connections where external_id = '106540352242922'"));
  assert.equal(conn?.label, "+44 7700 900777");
});

test("staff can look and decide on replies but not change settings or people", async () => {
  assert.equal((await api("staffA", "GET", `/businesses/${A}/settings`)).json.canEdit, false);
  const s = (await api("ownerA", "GET", `/businesses/${A}/settings`)).json.settings;
  assert.equal((await api("staffA", "PUT", `/businesses/${A}/settings`, { settings: s })).status, 403);
  assert.equal((await api("staffA", "POST", `/businesses/${A}/members`, { name: "X", role: "owner", isApprover: false })).status, 403);
  assert.equal((await api("staffA", "POST", `/businesses/${A}/connections/whatsapp`, { phoneNumberId: "12345678", wabaId: "12345678", accessToken: "tokentokentoken" })).status, 403);
  assert.equal((await api("staffA", "PUT", `/businesses/${A}/status`, { status: "paused" })).status, 403);
  const hooks = (await api("staffA", "GET", `/businesses/${A}/connections`)).json.connections;
  assert.ok(hooks.every((c: any) => c.url === undefined), "staff don't get webhook URLs");
  const { draftId } = await makeDraft(A);
  assert.equal((await api("staffA", "POST", `/businesses/${A}/drafts/${draftId}/reject`)).status, 200);
});

test("owner edits settings; invalid settings are refused with a clear reason; unmanaged keys survive", async () => {
  await withTenant(A, (db) => db.query("update tenants set settings = settings || '{\"agentVersions\": {\"triage\": \"1\"}}'"));
  const cur = (await api("ownerA", "GET", `/businesses/${A}/settings`)).json;
  const settings = { ...cur.settings };
  delete settings.agentVersions;

  const bad = await api("ownerA", "PUT", `/businesses/${A}/settings`, { settings: { ...settings, workingHours: { days: [1, 2], start: "17:00", end: "09:00" } } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /end after they start/);
  assert.match(bad.json.field, /workingHours/);
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/settings`, { settings: { ...settings, timezone: "Mars/Olympus" } })).status, 400);
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/settings`, { settings: { ...settings, surprise: 1 } })).status, 400);

  const ok = await api("ownerA", "PUT", `/businesses/${A}/settings`, { name: "Mark's Floors", settings: { ...settings, signOff: "Mark and team" } });
  assert.equal(ok.status, 200);
  const after = await withTenant(A, (db) => one<any>(db, "select name, settings from tenants where id = app_current_tenant()"));
  assert.equal(after.name, "Mark's Floors");
  assert.equal(after.settings.signOff, "Mark and team");
  assert.deepEqual(after.settings.agentVersions, { triage: "1" }, "settings the form doesn't manage are kept");
  const log = await withTenant(A, (db) => one<any>(db, "select actor, detail from audit_log where action = 'settings.updated' order by id desc limit 1"));
  assert.match(log.actor, /^member:/);
  assert.equal(log.detail.previous.signOff, cur.settings.signOff, "the previous version is kept in the audit log");
});

test("web approval behaves like WhatsApp approval, and a second tap does nothing", async () => {
  const { draftId } = await makeDraft(A);
  const first = await api("ownerA", "POST", `/businesses/${A}/drafts/${draftId}/approve`);
  assert.equal(first.status, 200);
  const second = await api("ownerA", "POST", `/businesses/${A}/drafts/${draftId}/approve`);
  assert.equal(second.status, 409);
  assert.match(second.json.error, /already/);
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/drafts/${draftId}/reject`)).status, 409);
  await drain();
  const sends = await withTenant(A, (db) => many(db, "select * from outbox where draft_id = $1", [draftId]));
  assert.equal(sends.length, 1, "one approval, one send");
  const log = await withTenant(A, (db) => many<any>(db, "select actor from audit_log where action = 'draft.approved' and entity_id = $1", [draftId]));
  assert.equal(log.length, 1);
  assert.match(log[0].actor, /^member:/);
  assert.equal((await withTenant(A, (db) => one<any>(db, "select state from approval_requests where draft_id = $1", [draftId])))!.state, "done");
});

test("editing on the web sends the edited wording", async () => {
  const { draftId, conversationId } = await makeDraft(A);
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/drafts/${draftId}/edit`, { body: "   " })).status, 400);
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/drafts/${draftId}/edit`, { body: "Hi Jo, Thursday works." })).status, 200);
  await drain();
  const d = await withTenant(A, (db) => one<any>(db, "select body, original_body from drafts where id = $1", [draftId]));
  assert.equal(d.body, "Hi Jo, Thursday works.");
  assert.equal(d.original_body, "Hi Jo, thanks for getting in touch.");
  const detail = await api("ownerA", "GET", `/businesses/${A}/conversations/${conversationId}`);
  assert.equal(detail.json.drafts[0].edited, true);
  assert.equal(detail.json.messages.length, 1);
  const list = await api("ownerA", "GET", `/businesses/${A}/conversations`);
  assert.ok(list.json.conversations.some((c: any) => c.id === conversationId));
});

test("Checkatrade lead: the owner adds the customer's details on the web; another business can't", async () => {
  const { conversationId } = await makeDraft(A);
  await withTenant(A, async (db) => {
    const m = await one<{ id: string }>(db, "select id from messages where conversation_id = $1", [conversationId]);
    await db.query("insert into checkatrade_leads (tenant_id, conversation_id, message_id, job_url, suggestion, decision) values (app_current_tenant(), $1, $2, 'https://membersapp.checkatrade.com/jobs/x', 'interested', 'interested')", [conversationId, m!.id]);
  });
  const view = await api("staffA", "GET", `/businesses/${A}/conversations/${conversationId}`);
  assert.equal(view.json.lead.decision, "interested");
  assert.equal(view.json.lead.job_url, "https://membersapp.checkatrade.com/jobs/x");

  assert.equal((await api("ownerA", "POST", `/businesses/${A}/conversations/${conversationId}/contact-details`, {})).status, 400, "needs a phone or email");
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/conversations/${conversationId}/contact-details`, { email: "not-an-email" })).status, 400);
  assert.equal((await api("ownerB", "POST", `/businesses/${A}/conversations/${conversationId}/contact-details`, { phone: "07700 900971" })).status, 404);
  assert.equal((await api("ownerB", "POST", `/businesses/${B}/conversations/${conversationId}/contact-details`, { phone: "07700 900971" })).status, 404);

  const ok = await api("staffA", "POST", `/businesses/${A}/conversations/${conversationId}/contact-details`, { phone: "07700 900971", email: "Jo.Lead@Example.com" });
  assert.equal(ok.status, 200);
  const after = await api("ownerA", "GET", `/businesses/${A}/conversations/${conversationId}`);
  assert.deepEqual(after.json.contact, { email: "jo.lead@example.com", phone: "+447700900971" });
  assert.ok(after.json.lead.details_added_at);
  assert.equal((await withTenant(B, (db) => one<{ n: number }>(db, "select count(*)::int as n from checkatrade_leads")))!.n, 0, "business B sees none of A's leads");

  const { conversationId: other } = await makeDraft(A);
  const clash = await api("ownerA", "POST", `/businesses/${A}/conversations/${other}/contact-details`, { phone: "07700 900971" });
  assert.equal(clash.status, 400, "a number that belongs to another customer isn't moved");
});

test("a platform admin sees every business, but only after two-factor", async () => {
  const noMfa = await api("admin", "GET", "/me", undefined, "aal1");
  assert.equal(noMfa.json.isAdmin, false);
  assert.equal(noMfa.json.adminNeedsTwoFactor, true);
  assert.equal((await api("admin", "GET", "/businesses", undefined, "aal1")).json.businesses.length, 0);
  assert.equal((await api("admin", "GET", `/businesses/${A}`, undefined, "aal1")).status, 404);
  assert.equal((await api("admin", "GET", "/agents", undefined, "aal1")).status, 403);

  const full = await api("admin", "GET", "/businesses", undefined, "aal2");
  assert.equal(full.json.businesses.length, 2);
  assert.equal((await api("admin", "GET", `/businesses/${B}`, undefined, "aal2")).status, 200);
  assert.equal((await api("admin", "GET", "/agents", undefined, "aal2")).status, 200);

  const made = await api("admin", "POST", "/businesses", { slug: "fresh-biz", name: "Fresh", pack: "practitioner", owner: { name: "Pat", whatsapp: "07700 900009" } }, "aal2");
  assert.equal(made.status, 201);
  assert.equal((await api("admin", "POST", "/businesses", { slug: "fresh-biz", name: "Fresh", pack: "practitioner", owner: { name: "Pat", whatsapp: "07700 900009" } }, "aal2")).status, 409);
  assert.equal((await api("admin", "POST", "/businesses", { slug: "x", name: "Bad", pack: "nope", owner: { name: "P", whatsapp: "1" } }, "aal2")).status, 400);
  const audited = await withAdmin((db) => one<any>(db, "select actor from audit_log where action = 'tenant.created' and tenant_id = $1", [made.json.id]));
  assert.equal(audited.actor, `admin:${USERS.admin.email}`);
});

test("the agents page explains every agent with its instructions and running cost", async () => {
  const r = await api("admin", "GET", "/agents", undefined, "aal2");
  const ids = r.json.agents.map((a: any) => a.id).sort();
  assert.deepEqual(ids, ["booking", "drafting", "reviewer", "triage"]);
  for (const a of r.json.agents) {
    assert.ok(a.instructions.length > 50 && a.model && a.version, a.id);
    assert.ok("perRunUsd" in a.usage);
  }
  assert.equal((await api("ownerA", "GET", "/agents")).status, 403);
});

test("platform keys: admins see only whether each is set, and can test them; values never leave the server", async () => {
  assert.equal((await api("ownerA", "GET", "/platform/status")).status, 403);
  assert.equal((await api("admin", "GET", "/platform/status", undefined, "aal1")).status, 403);
  assert.equal((await api("ownerA", "POST", "/platform/test/google")).status, 403);
  const s = await api("admin", "GET", "/platform/status", undefined, "aal2");
  const text = JSON.stringify(s.json);
  for (const secret of ["gsecret", "platform-token", "test-app-secret", "verify-me"]) assert.ok(!text.includes(secret), secret);
  const claude = s.json.services.find((x: any) => x.id === "claude");
  assert.equal(claude.ready, false, "no Claude key in tests");
  assert.equal(s.json.services.find((x: any) => x.id === "google").ready, true);

  const g = await api("admin", "POST", "/platform/test/google", undefined, "aal2");
  assert.equal(g.json.ok, true);
  const c = await api("admin", "POST", "/platform/test/claude", undefined, "aal2");
  assert.equal(c.json.ok, false);
  assert.match(c.json.detail, /ANTHROPIC_API_KEY/);
  assert.equal((await api("admin", "POST", "/platform/test/nope", undefined, "aal2")).status, 400);
  const logged = await withAdmin((db) => one<any>(db, "select detail from audit_log where action = 'platform.key_tested' and entity_id = 'google' order by id desc limit 1"));
  assert.deepEqual(logged.detail, { ok: true });
});

test("the live map is for platform admins and shows counts only", async () => {
  assert.equal((await api("ownerA", "GET", "/map")).status, 403);
  assert.equal((await api("admin", "GET", "/map", undefined, "aal1")).status, 403);
  const r = await api("admin", "GET", "/map", undefined, "aal2");
  assert.equal(r.status, 200);
  assert.ok(r.json.counts.tenants && typeof r.json.counts.audit7d === "number");
  assert.equal(r.json.keys.google, true);
  const text = JSON.stringify(r.json);
  for (const leak of ["gsecret", "platform-token", "mark@a.example", "Jo Bloggs", "kitchen floor"]) assert.ok(!text.includes(leak), leak);
});

test("the setup checklist shows what a business still needs, scoped to that business", async () => {
  const r = await api("ownerA", "GET", `/businesses/${A}/setup`);
  assert.equal(r.status, 200);
  const step = (k: string) => r.json.steps.find((x: any) => x.key === k);
  assert.equal(step("claude").done, false);
  assert.equal(step("approver").done, true);
  assert.equal(r.json.complete, false);
  // A task list: switching on can't start until the required steps are done; optional ones don't block it.
  assert.equal(step("claude").status, "todo");
  assert.equal(step("approver").status, "done");
  assert.equal(step("active").status, step("active").done ? "done" : "blocked");
  assert.equal(step("reply").optional, true);
  assert.ok(r.json.needs.includes("A reply or two you've sent"), "what you'll need, from the steps still to do");
  assert.equal((await api("ownerA", "GET", `/businesses/${B}/setup`)).status, 404);
});

test("a replaced WhatsApp token is stored encrypted and never returned", async () => {
  const r = await api("ownerA", "POST", `/businesses/${A}/connections/whatsapp`, { phoneNumberId: "99887766", wabaId: "200000000000002", accessToken: "brand-new-secret-token" });
  assert.equal(r.status, 200);
  const row = await withTenant(A, (db) => one<any>(db, "select secret_ciphertext from channel_connections where external_id = '99887766'"));
  assert.ok(row.secret_ciphertext && !row.secret_ciphertext.includes("brand-new-secret-token"));
  for (const path of [`/businesses/${A}/connections`, `/businesses/${A}`, `/businesses/${A}/settings`, `/businesses/${A}/audit`]) {
    const res = await app.request(`/api${path}`, { headers: { authorization: `Bearer ${await token(USERS.ownerA)}` } });
    const text = await res.text();
    assert.ok(!text.includes("brand-new-secret-token") && !text.includes("secret_ciphertext") && !text.includes(row.secret_ciphertext), path);
  }
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/connections/whatsapp`, { phoneNumberId: "abc", accessToken: "x" })).status, 400);
  assert.equal((await api("ownerB", "POST", `/businesses/${B}/connections/whatsapp`, { phoneNumberId: "99887766", wabaId: "200000000000003", accessToken: "stolen-number-token" })).status, 409);
});

test("webhook links are created and shown to owners", async () => {
  const made = await api("ownerA", "POST", `/businesses/${A}/connections/webhook`, { kind: "web_form", label: "Website" });
  assert.equal(made.status, 201);
  const list = (await api("ownerA", "GET", `/businesses/${A}/connections`)).json.connections;
  assert.ok(list.some((c: any) => c.kind === "web_form" && c.url === made.json.url));
  const conn = list.find((c: any) => c.kind === "web_form");
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/connections/${conn.id}/disable`)).status, 200);
  const hit = await app.request(new URL(made.json.url).pathname, { method: "POST", body: JSON.stringify({ message: "hi" }), headers: { "content-type": "application/json" } });
  assert.equal(hit.status, 404, "a disabled form link stops working");
});

test("flows: owners set each step's choices and automation; staff can look; other businesses can't", async () => {
  const flows = (await api("staffA", "GET", `/businesses/${A}/flows`)).json;
  assert.equal(flows.canManage, false);
  assert.equal(flows.learnAfter, 5, "default: offer after 5 unchanged approvals");
  assert.deepEqual(flows.kinds.map((k: any) => k.key), ["answer_question", "offer_times", "confirm_booking", "quote_followup", "feedback_request"]);
  assert.equal((await api("staffA", "PUT", `/businesses/${A}/flows/ask_feedback`, { enabled: true })).status, 403);

  const fb = await api("ownerA", "PUT", `/businesses/${A}/flows/ask_feedback`, { enabled: true, config: { afterDays: 2, reviewLink: "https://g.page/r/abc/review" } });
  assert.equal(fb.status, 200);
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/flows/ask_feedback`, { config: { reviewLink: "http://not-secure.example" } })).status, 400);
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/flows/answer_enquiries`, { config: { learnAfter: 3 } })).status, 200);
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/flows/answer_enquiries`, { config: { autoSendEverything: true } })).status, 400, "unknown settings refused");
  const after = (await api("ownerA", "GET", `/businesses/${A}/flows`)).json;
  assert.deepEqual(after.useCases.ask_feedback, { enabled: true, config: { afterDays: 2, reviewLink: "https://g.page/r/abc/review" } });
  assert.equal(after.learnAfter, 3);
  assert.match(after.feedbackPreview, /https:\/\/g\.page\/r\/abc\/review/);

  // Clearing the review link removes it.
  await api("ownerA", "PUT", `/businesses/${A}/flows/ask_feedback`, { config: { reviewLink: "" } });
  assert.deepEqual((await api("ownerA", "GET", `/businesses/${A}/flows`)).json.useCases.ask_feedback.config, { afterDays: 2 });

  // Booking through their own system (e.g. Halaxy): needs a secure link.
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/flows/book_appointments`, { enabled: false, config: { mode: "link" } })).status, 400, "no link yet");
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/flows/book_appointments`, { enabled: false, config: { mode: "link", system: "halaxy", link: "http://insecure.example/book" } })).status, 400);
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/flows/book_appointments`, { enabled: false, config: { mode: "link", system: "halaxy", link: "https://www.halaxy.com/book/x/1" } })).status, 200);
  assert.deepEqual((await api("ownerA", "GET", `/businesses/${A}/flows`)).json.useCases.book_appointments, { enabled: false, config: { mode: "link", system: "halaxy", link: "https://www.halaxy.com/book/x/1" } });
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/flows/book_appointments`, { enabled: true })).status, 200);

  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/automations/answer_question`, { on: true })).status, 200);
  assert.equal((await api("ownerA", "GET", `/businesses/${A}/flows`)).json.kinds[0].state, "on");
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/automations/anything_goes`, { on: true })).status, 400);
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/automations/answer_question`, { on: false })).status, 200);

  assert.equal((await api("ownerB", "GET", `/businesses/${A}/flows`)).status, 404);
  assert.equal((await api("ownerB", "PUT", `/businesses/${A}/automations/answer_question`, { on: true })).status, 404);
});

test("reply style: owners pick a tone and paste examples; contact details are removed; the Settings form keeps it", async () => {
  const body = { tone: "Warm, friendly and personal.", style: { preset: "friendly", greeting: "hi", length: "short", emoji: "never", spelling: "british", avoid: "cheap",
    examples: ["Hi Jo, lovely to hear from you! Ring me on 07700 900123 or email mark.b@example.com and we'll sort it. Mark", "  "] } };
  assert.equal((await api("staffA", "PUT", `/businesses/${A}/reply-style`, body)).status, 403);
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/reply-style`, { ...body, style: { ...body.style, examples: ["a", "b", "c", "d"] } })).status, 400, "up to three");
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/reply-style`, { ...body, style: { ...body.style, greeting: "yo" } })).status, 400);
  const r = await api("ownerA", "PUT", `/businesses/${A}/reply-style`, body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.style.examples, ["Hi Jo, lovely to hear from you! Ring me on [phone] or email [email] and we'll sort it. Mark"], "blank examples dropped, details removed");

  const reply = (await api("ownerA", "GET", `/businesses/${A}/flows`)).json.reply;
  assert.equal(reply.tone, "Warm, friendly and personal.");
  assert.equal(reply.style.greeting, "hi");

  // Saving the Settings form doesn't wipe it.
  const current = (await api("ownerA", "GET", `/businesses/${A}/settings`)).json;
  const formSettings = Object.fromEntries(Object.entries(current.settings).filter(([k]) => k in tenantSettingsSchema.shape)); // what the form sends
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/settings`, { settings: formSettings })).status, 200);
  assert.equal((await api("ownerA", "GET", `/businesses/${A}/flows`)).json.reply.style.preset, "friendly");

  const logged = await withTenant(A, (db) => many(db, "select detail::text as d from audit_log where action in ('reply_style.updated', 'settings.updated')"));
  assert.ok(logged.length >= 2);
  assert.ok(logged.every((l) => !l.d.includes("lovely to hear from you")), "example text stays out of the audit log");
  assert.equal((await api("ownerB", "PUT", `/businesses/${A}/reply-style`, body)).status, 404);
});

test("replies waiting, one at a time: each with what the customer said, for this business only", async () => {
  const { draftId } = await makeDraft(A, "Hi Jo, happy to quote. Could you send a photo?");
  const w = await api("staffA", "GET", `/businesses/${A}/waiting`);
  assert.equal(w.status, 200);
  const d = w.json.waiting.find((x: any) => x.id === draftId);
  assert.ok(d, "the new reply is waiting");
  assert.equal(d.name, "Jo Bloggs");
  assert.equal(d.said.body, "Can you quote for a kitchen floor?");
  assert.equal(d.review_pass, true);
  assert.equal((await api("ownerB", "GET", `/businesses/${A}/waiting`)).status, 404);
  assert.ok(!(await api("ownerB", "GET", `/businesses/${B}/waiting`)).json.waiting.some((x: any) => x.id === draftId));
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/drafts/${draftId}/approve`)).status, 200);
  assert.ok(!(await api("ownerA", "GET", `/businesses/${A}/waiting`)).json.waiting.some((x: any) => x.id === draftId), "decided replies leave the queue");
});

test("what happened: plain sentences saying who did what and why, with no message text", async () => {
  const feed = await api("staffA", "GET", `/businesses/${A}/feed`);
  assert.equal(feed.status, 200);
  assert.ok(feed.json.items.some((e: any) => /^Mark approved the reply to Jo\.$/.test(e.text) && e.who === "you"), "a decision, by name");
  assert.ok(!JSON.stringify(feed.json).includes("Can you quote"), "never the customer's words");
  assert.equal((await api("ownerB", "GET", `/businesses/${A}/feed`)).status, 404);

  // An automatic send says why, and offers to switch that kind back to asking.
  const { draftId } = await makeDraft(A, "Hi Jo, yes we cover your area.");
  await withTenant(A, async (db) => {
    await db.query("update drafts set status = 'sent', auto_sent = true, category = 'answer_question', decided_at = now() where id = $1", [draftId]);
    await db.query("insert into automations (tenant_id, category, state) values (app_current_tenant(), 'answer_question', 'on') on conflict (tenant_id, category) do update set state = 'on'");
    await db.query("insert into audit_log (tenant_id, actor, action, entity, entity_id) values (app_current_tenant(), 'system', 'reply.sent', 'draft', $1)", [draftId]);
  });
  const auto = (await api("ownerA", "GET", `/businesses/${A}/feed`)).json.items.find((e: any) => e.automatic);
  assert.match(auto.text, /^Sent the reply to Jo automatically by WhatsApp\.$/);
  assert.match(auto.why, /You said yes to sending "Answering questions" replies automatically/);
  assert.equal(auto.automatic, "answer_question");
  await api("ownerA", "PUT", `/businesses/${A}/automations/answer_question`, { on: false });
  assert.ok(!(await api("ownerA", "GET", `/businesses/${A}/feed`)).json.items.some((e: any) => e.automatic), "no switch once it's back to asking");
});

test("try it: a pretend message goes through the flow and nothing is saved, held or sent", async () => {
  const count = () => withTenant(A, (db) => one<any>(db,
    "select (select count(*) from drafts) d, (select count(*) from runs) r, (select count(*) from holds) h, (select count(*) from messages) m, (select count(*) from outbox) o, (select count(*) from contacts) c"));
  const before = await count();
  const sentBefore = wa.sent.length;
  const r = await api("ownerA", "POST", `/businesses/${A}/flows/try`, { message: "Hi, could you quote for laminate in our lounge?", channel: "email" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.steps.map((s: any) => s.key), ["triage", "booking", "reply", "approve"]);
  assert.ok(r.json.reply.length > 10, "the reply the customer would get");
  assert.deepEqual(await count(), before, "nothing written");
  assert.equal(wa.sent.length, sentBefore, "nothing sent");
  const complaint = await api("ownerA", "POST", `/businesses/${A}/flows/try`, { message: "I'm not happy, there are gaps opening in the floor." });
  assert.equal(complaint.json.steps.find((s: any) => s.key === "approve").flag, true, "complaints always come to you");
  assert.equal((await api("staffA", "POST", `/businesses/${A}/flows/try`, { message: "Hello there" })).status, 403);
  assert.equal((await api("ownerB", "POST", `/businesses/${A}/flows/try`, { message: "Hello there" })).status, 404);
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/flows/try`, { message: "" })).status, 400);
});

test("this week: counts on Overview, and a Friday WhatsApp summary only for owners who ask", async () => {
  const o = (await api("staffA", "GET", `/businesses/${A}`)).json;
  assert.equal(typeof o.week.repliesSent, "number");
  assert.equal(o.weeklySummary, false);
  assert.equal(weeklyText("X", { messagesIn: 0, repliesSent: 0, avgMinutesToReply: null, booked: 0, quotesChased: 0, feedbackAsked: 0, sentAutomatically: 0 }), undefined, "no empty summaries");
  assert.equal((await api("staffA", "PUT", `/businesses/${A}/weekly-summary`, { on: true })).status, 403);

  let i = wa.sent.length;
  await sendWeeklySummaries();
  assert.ok(!wa.sent.slice(i).some((m) => /your week/.test(m.text ?? "")), "off by default");

  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/weekly-summary`, { on: true })).status, 200);
  assert.equal((await api("ownerA", "GET", `/businesses/${A}`)).json.weeklySummary, true);
  i = wa.sent.length;
  await sendWeeklySummaries();
  const msg = wa.sent.slice(i).find((m) => /your week/.test(m.text ?? ""));
  assert.ok(msg, "sent to the owner");
  assert.equal(msg!.to, "+447700900001");
  assert.match(msg!.text!, /repl(y|ies) sent/);
  assert.ok(!wa.sent.slice(i).some((m) => m.to === "+447700900002"), "not to another business");
  await api("ownerA", "PUT", `/businesses/${A}/weekly-summary`, { on: false });
});

test("people: the last owner can't be removed or demoted; approvers need a WhatsApp number", async () => {
  const members = (await api("ownerA", "GET", `/businesses/${A}/members`)).json.members;
  const owner = members.find((m: any) => m.role === "owner");
  assert.equal((await api("ownerA", "DELETE", `/businesses/${A}/members/${owner.id}`)).status, 409);
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/members/${owner.id}`, { name: "Mark", email: USERS.ownerA.email, role: "staff", whatsapp: "07700 900001", isApprover: true })).status, 409);
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/members`, { name: "Kim", role: "staff", isApprover: true })).status, 400);
  const added = await api("ownerA", "POST", `/businesses/${A}/members`, { name: "Kim", email: "kim@a.example", role: "owner", whatsapp: "07700 900044", isApprover: true });
  assert.equal(added.status, 201);
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/members`, { name: "Kim 2", email: "KIM@a.example", role: "staff", isApprover: false })).status, 409);
  assert.equal((await api("ownerA", "DELETE", `/businesses/${A}/members/${added.json.id}`)).status, 200);
  assert.equal((await api("ownerA", "DELETE", `/businesses/${A}/members/${memberA}`)).status, 200);
});

test("use cases can be switched and are limited to the business", async () => {
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/use-cases/book_appointments`, { enabled: false })).status, 200);
  const list = (await api("ownerA", "GET", `/businesses/${A}/use-cases`)).json.useCases;
  assert.equal(list.find((u: any) => u.key === "book_appointments").enabled, false);
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/use-cases/find_customers`, { enabled: true })).status, 400);
});

test("pausing: an owner can pause and resume their business but not close it", async () => {
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/status`, { status: "paused" })).status, 200);
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/status`, { status: "active" })).status, 200);
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/status`, { status: "closed" })).status, 403);
  assert.equal((await api("ownerA", "PUT", `/businesses/${A}/status`, { status: "bogus" })).status, 400);
});

test("data requests need the web address typed to confirm", async () => {
  const { conversationId } = await makeDraft(A);
  await withTenant(A, (db) => db.query("insert into contact_identities (tenant_id, contact_id, kind, value) select app_current_tenant(), c.contact_id, 'email', 'jo@example.com' from conversations c where c.id = $1", [conversationId]));
  const no = await api("ownerA", "POST", `/businesses/${A}/data/export`, { email: "jo@example.com", confirm: "yes" });
  assert.equal(no.status, 400);
  const exp = await api("ownerA", "POST", `/businesses/${A}/data/export`, { email: "jo@example.com", confirm: "marks-flooring" });
  assert.equal(exp.status, 200);
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/data/export`, { email: "ghost@example.com", confirm: "marks-flooring" })).status, 404);
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/data/export`, { confirm: "marks-flooring" })).status, 400);
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/data/erase`, { email: "jo@example.com", confirm: "marks-flooring" })).status, 200);
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/data/suppress`, { email: "jo@example.com", confirm: "marks-flooring" })).status, 200);
  assert.equal((await api("staffA", "POST", `/businesses/${A}/data/export`, { email: "jo@example.com", confirm: "marks-flooring" })).status, 404, "staff was removed above, so is no longer a member");
  const reqs = (await api("ownerA", "GET", `/businesses/${A}/data-requests`)).json.requests;
  assert.ok(reqs.length >= 2);
});

test("activity and audit are readable by owners and scoped to their business", async () => {
  assert.equal((await api("ownerA", "GET", `/businesses/${A}/runs`)).status, 200);
  assert.equal((await api("ownerA", "GET", `/businesses/${A}/runs/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`)).status, 404);
  assert.equal((await api("ownerA", "GET", `/businesses/${A}/runs/not-a-uuid`)).status, 404);
  const audit = (await api("ownerA", "GET", `/businesses/${A}/audit?action=draft.`)).json.entries;
  assert.ok(audit.length > 0 && audit.every((e: any) => e.action.startsWith("draft.")));
  const all = (await api("ownerA", "GET", `/businesses/${A}/audit`)).json.entries;
  assert.ok(all.every((e: any) => e.tenant_id === undefined));
  const theirs = await withTenant(B, (db) => many<any>(db, "select tenant_id from audit_log"));
  assert.ok(theirs.every((r) => r.tenant_id === B));
});

test("the sector pack templates are valid settings", () => {
  const dir = new URL("../config/packs/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".template.json"));
  assert.ok(files.length >= 3);
  for (const f of files) {
    const t = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    const res = tenantSettingsSchema.safeParse(t.settings);
    assert.ok(res.success, `${f}: ${res.success ? "" : JSON.stringify(res.error.issues)}`);
  }
});

test("the admin app is served with security headers and exposes only public sign-in settings", async () => {
  const cfg = await app.request("/admin/config.json");
  assert.equal(cfg.status, 200);
  assert.deepEqual(Object.keys(await cfg.json()).sort(), ["supabaseAnonKey", "supabaseUrl"]);
  assert.match(cfg.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(cfg.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await app.request("/admin")).status, 302);
});
