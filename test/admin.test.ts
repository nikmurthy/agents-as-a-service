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

test("staff can look and decide on replies but not change settings or people", async () => {
  assert.equal((await api("staffA", "GET", `/businesses/${A}/settings`)).json.canEdit, false);
  const s = (await api("ownerA", "GET", `/businesses/${A}/settings`)).json.settings;
  assert.equal((await api("staffA", "PUT", `/businesses/${A}/settings`, { settings: s })).status, 403);
  assert.equal((await api("staffA", "POST", `/businesses/${A}/members`, { name: "X", role: "owner", isApprover: false })).status, 403);
  assert.equal((await api("staffA", "POST", `/businesses/${A}/connections/whatsapp`, { phoneNumberId: "12345678", accessToken: "tokentokentoken" })).status, 403);
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

test("a replaced WhatsApp token is stored encrypted and never returned", async () => {
  const r = await api("ownerA", "POST", `/businesses/${A}/connections/whatsapp`, { phoneNumberId: "99887766", accessToken: "brand-new-secret-token" });
  assert.equal(r.status, 200);
  const row = await withTenant(A, (db) => one<any>(db, "select secret_ciphertext from channel_connections where external_id = '99887766'"));
  assert.ok(row.secret_ciphertext && !row.secret_ciphertext.includes("brand-new-secret-token"));
  for (const path of [`/businesses/${A}/connections`, `/businesses/${A}`, `/businesses/${A}/settings`, `/businesses/${A}/audit`]) {
    const res = await app.request(`/api${path}`, { headers: { authorization: `Bearer ${await token(USERS.ownerA)}` } });
    const text = await res.text();
    assert.ok(!text.includes("brand-new-secret-token") && !text.includes("secret_ciphertext") && !text.includes(row.secret_ciphertext), path);
  }
  assert.equal((await api("ownerA", "POST", `/businesses/${A}/connections/whatsapp`, { phoneNumberId: "abc", accessToken: "x" })).status, 400);
  assert.equal((await api("ownerB", "POST", `/businesses/${B}/connections/whatsapp`, { phoneNumberId: "99887766", accessToken: "stolen-number-token" })).status, 409);
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
