// Tests for the admin API: who can see and change what, settings validation, and that approving on the web
// behaves exactly like approving on WhatsApp. Needs a real Postgres (TEST_DATABASE_URL); it is wiped at the start.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
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
process.env.SUPABASE_JWT_SECRET = "test-supabase-jwt-secret-at-least-32-bytes-long";
process.env.ADMIN_ORIGIN = "https://admin.example";

const { getPool, closePool, withTenant, withAdmin, one, many } = await import("../src/db.js");
const { migrate } = await import("../src/cli/migrate.js");
const { syncAgents } = await import("../src/cli/agents-sync.js");
const { clients } = await import("../src/integrations/index.js");
const { createTenant, connectWhatsApp, setTenantStatus } = await import("../src/onboarding.js");
const { app } = await import("../src/app.js");
const { taskList } = await import("../src/jobs/tasks.js");
const { releaseQueue } = await import("../src/jobs/queue.js");
const { runOnce, Logger } = await import("graphile-worker");
const { fakeGoogle, fakeWhatsApp, waWebhook } = await import("./fakes.js");

const google = fakeGoogle();
const wa = fakeWhatsApp();
clients.google = google.client;
clients.whatsapp = wa.client;

const jobErrors: string[] = [];
const logger = new Logger(() => (level, message) => { if (level === "error") jobErrors.push(message); });
async function drain() {
  for (let i = 0; i < 6; i++) await runOnce({ pgPool: getPool(), taskList, logger });
  assert.deepEqual(jobErrors, [], "jobs should not fail");
}
async function postWhatsApp(body: unknown) {
  const raw = JSON.stringify(body);
  const sig = "sha256=" + createHmac("sha256", process.env.WA_APP_SECRET!).update(raw).digest("hex");
  return app.request("/webhooks/whatsapp", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-hub-signature-256": sig } });
}

const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
async function token(userId: string, opts: { aal?: "aal1" | "aal2"; email?: string; verified?: boolean; role?: string; expired?: boolean; key?: Uint8Array } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: opts.role ?? "authenticated", aal: opts.aal ?? "aal1", email: opts.email ?? `${userId}@example.com`, user_metadata: { email_verified: opts.verified ?? false } })
    .setProtectedHeader({ alg: "HS256" }).setSubject(userId).setAudience("authenticated")
    .setIssuedAt(now - 100).setExpirationTime(opts.expired ? now - 10 : now + 3600).sign(opts.key ?? secret);
}
async function api(method: string, path: string, tok?: string, json?: unknown) {
  const headers: Record<string, string> = {};
  if (tok) headers.authorization = `Bearer ${tok}`;
  if (json !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(`/api${path}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, raw: text };
}

let A: string, B: string;
const ownerA = randomUUID(), staffA = randomUUID(), ownerB = randomUUID(), admin = randomUUID(), stranger = randomUUID();
let tOwnerA: string, tStaffA: string, tOwnerB: string, tAdminMfa: string, tAdminNoMfa: string, tStranger: string;
let settingsA: any;

before(async () => {
  await getPool().query("drop schema if exists graphile_worker cascade; drop schema if exists public cascade; create schema public;");
  await migrate(() => {});
  await syncAgents(() => {});
  A = (await createTenant({ slug: "marks-flooring", name: "Mark's Flooring", pack: "flooring", owner: { name: "Mark", whatsapp: "07700 900001" } })).id;
  B = (await createTenant({ slug: "other-biz", name: "Other Business", pack: "trades", owner: { name: "Olu", whatsapp: "07700 900002" } })).id;
  await connectWhatsApp(A, "TENANT_WA", "tenant-wa-token-0123456789");
  await setTenantStatus(A, "active");
  await setTenantStatus(B, "active");
  await withAdmin(async (db) => {
    await db.query("update tenant_members set user_id = $1 where tenant_id = $2 and role = 'owner'", [ownerA, A]);
    await db.query("update tenant_members set user_id = $1 where tenant_id = $2 and role = 'owner'", [ownerB, B]);
    await db.query("insert into tenant_members (tenant_id, user_id, name, role, whatsapp_phone, is_approver) values ($1, $2, 'Sue', 'staff', '+447700900003', false)", [A, staffA]);
    await db.query("insert into platform_admins (user_id, email) values ($1, 'nik@example.com')", [admin]);
  });
  settingsA = (await withTenant(A, (db) => one(db, "select settings from tenants where id = app_current_tenant()"))).settings;
  [tOwnerA, tStaffA, tOwnerB, tStranger] = await Promise.all([token(ownerA), token(staffA), token(ownerB), token(stranger)]);
  tAdminMfa = await token(admin, { aal: "aal2", email: "nik@example.com" });
  tAdminNoMfa = await token(admin, { aal: "aal1" });
});

after(async () => { await releaseQueue(); await closePool(); });

test("API needs a valid Supabase token", async () => {
  assert.equal((await api("GET", "/me")).status, 401);
  assert.equal((await api("GET", "/me", "not-a-jwt")).status, 401);
  assert.equal((await api("GET", "/me", await token(ownerA, { expired: true }))).status, 401);
  assert.equal((await api("GET", "/me", await token(ownerA, { key: new TextEncoder().encode("a-different-secret-that-is-32-bytes!!") }))).status, 401);
  assert.equal((await api("GET", "/me", await token(ownerA, { role: "anon" }))).status, 401);
  assert.equal((await api("GET", `/businesses/${A}`)).status, 401);
});

test("CORS only allows the admin app's origin", async () => {
  const ok = await app.request("/api/me", { method: "OPTIONS", headers: { origin: "https://admin.example", "access-control-request-method": "GET" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://admin.example");
  const bad = await app.request("/api/me", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
  assert.notEqual(bad.headers.get("access-control-allow-origin"), "https://evil.example");
});

test("/me lists only the caller's own businesses", async () => {
  const me = await api("GET", "/me", tOwnerA);
  assert.equal(me.status, 200);
  assert.equal(me.body.isPlatformAdmin, false);
  assert.deepEqual(me.body.businesses.map((b: any) => b.tenantId), [A]);
  assert.deepEqual((await api("GET", "/me", tStranger)).body.businesses, []);
});

test("businesses are isolated: another business's id looks like it doesn't exist", async () => {
  for (const [method, path] of [
    ["GET", `/businesses/${B}`], ["GET", `/businesses/${B}/settings`], ["GET", `/businesses/${B}/drafts`],
    ["GET", `/businesses/${B}/connections`], ["GET", `/businesses/${B}/google-link`],
  ] as const) {
    assert.equal((await api(method, path, tOwnerA)).status, 404, `${method} ${path}`);
  }
  assert.equal((await api("PUT", `/businesses/${B}/settings`, tOwnerA, { settings: settingsA })).status, 404);
  assert.equal((await api("GET", `/businesses/${A}`, tStranger)).status, 404);
  assert.equal((await api("GET", "/businesses/not-a-uuid", tOwnerA)).status, 404);
  assert.equal((await api("GET", `/businesses/${A}`, tOwnerA)).status, 200);
});

test("only platform admins can list or create businesses, and they need a second factor", async () => {
  assert.equal((await api("GET", "/businesses", tOwnerA)).status, 403);
  assert.equal((await api("POST", "/businesses", tOwnerA, { slug: "new-biz", name: "New", pack: "trades", owner: { name: "N", whatsapp: "07700 900010" } })).status, 403);
  const noMfa = await api("GET", "/businesses", tAdminNoMfa);
  assert.equal(noMfa.status, 403);
  assert.equal(noMfa.body.error, "mfa_required");
  assert.equal((await api("GET", `/businesses/${A}`, tAdminNoMfa)).body.error, "mfa_required");
  const list = await api("GET", "/businesses", tAdminMfa);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.businesses.map((b: any) => b.slug).sort(), ["marks-flooring", "other-biz"]);
  assert.equal((await api("GET", `/businesses/${B}`, tAdminMfa)).status, 200, "admins can open any business");
});

test("creating a business: validation, duplicate names, and audit", async () => {
  const bad = await api("POST", "/businesses", tAdminMfa, { slug: "X", name: "", pack: "nope", owner: { name: "", whatsapp: "1" } });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.issues.length >= 3);
  const unknownPack = await api("POST", "/businesses", tAdminMfa, { slug: "new-biz", name: "New Biz", pack: "nonexistent", owner: { name: "N", whatsapp: "07700 900010" } });
  assert.equal(unknownPack.status, 422);
  const made = await api("POST", "/businesses", tAdminMfa, { slug: "new-biz", name: "New Biz", pack: "trades", owner: { name: "Nina", whatsapp: "07700 900010" } });
  assert.equal(made.status, 201);
  assert.match(made.body.googleLink, /^https:\/\/platform\.example\//);
  const dupe = await api("POST", "/businesses", tAdminMfa, { slug: "new-biz", name: "Again", pack: "trades", owner: { name: "N", whatsapp: "07700 900011" } });
  assert.equal(dupe.status, 409);
  const entry = await withTenant(made.body.id, (db) => one(db, "select actor from audit_log where action = 'tenant.created'"));
  assert.equal(entry.actor, "admin:nik@example.com");
});

test("pausing and resuming a business is admin-only and audited", async () => {
  assert.equal((await api("POST", `/businesses/${A}/status`, tOwnerA, { status: "paused" })).status, 403);
  assert.equal((await api("POST", `/businesses/${A}/status`, tAdminMfa, { status: "closed" })).status, 422);
  assert.equal((await api("POST", `/businesses/${A}/status`, tAdminMfa, { status: "paused" })).status, 200);
  assert.equal((await withTenant(A, (db) => one(db, "select status from tenants where id = app_current_tenant()"))).status, "paused");
  assert.equal((await api("POST", `/businesses/${A}/status`, tAdminMfa, { status: "active" })).status, 200);
  const logged = await withTenant(A, (db) => one(db, "select count(*)::int as n from audit_log where action = 'tenant.status_changed'"));
  assert.equal(logged.n, 2);
});

test("settings: owners can edit, staff can only read, invalid values are explained", async () => {
  const read = await api("GET", `/businesses/${A}/settings`, tStaffA);
  assert.equal(read.status, 200);
  assert.equal(read.body.canEdit, false);
  assert.equal((await api("GET", `/businesses/${A}/settings`, tOwnerA)).body.canEdit, true);
  assert.equal((await api("PUT", `/businesses/${A}/settings`, tStaffA, { settings: settingsA })).status, 403);

  const edited = { ...settingsA, tone: "Warm and brief", signOff: "Mark & team" };
  const ok = await api("PUT", `/businesses/${A}/settings`, tOwnerA, { name: "Mark's Floors", settings: edited });
  assert.equal(ok.status, 200);
  const saved = await withTenant(A, (db) => one(db, "select name, settings from tenants where id = app_current_tenant()"));
  assert.equal(saved.name, "Mark's Floors");
  assert.equal(saved.settings.signOff, "Mark & team");

  const entry = await withTenant(A, (db) => one(db, "select actor, detail from audit_log where action = 'settings.updated' order by id desc limit 1"));
  assert.match(entry.actor, /^member:/);
  assert.deepEqual([...entry.detail.changed].sort(), ["signOff", "tone"]);
  assert.equal(entry.detail.previous.signOff, settingsA.signOff, "old settings kept so the change can be undone");
});

test("settings validation rejects bad input with field-level messages", async () => {
  const cases: [string, any, RegExp][] = [
    ["timezone", { timezone: "Mars/Olympus" }, /timezone/i],
    ["workingHours.end", { workingHours: { days: [1, 2], start: "17:00", end: "08:00" } }, /after the starting time/],
    ["workingHours.start", { workingHours: { days: [1, 2], start: "8am", end: "17:00" } }, /24-hour/],
    ["workingHours.days", { workingHours: { days: [], start: "08:00", end: "17:00" } }, /working day/],
    ["services.0.durationMinutes", { services: [{ name: "Measure", durationMinutes: 0 }] }, /at least 5/],
    ["reviewerPassScore", { reviewerPassScore: 9 }, /1 to 5/],
    ["replyVia.email", { replyVia: { email: [] } }, /at least one/],
    ["serviceArea.0", { serviceArea: ["not a postcode"] }, /postcode/],
    ["retentionDays", { retentionDays: 3 }, /at least 30/],
  ];
  for (const [path, patch, message] of cases) {
    const r = await api("PUT", `/businesses/${A}/settings`, tOwnerA, { settings: { ...settingsA, ...patch } });
    assert.equal(r.status, 422, path);
    assert.ok(r.body.issues.some((i: any) => i.path.endsWith(path) && message.test(i.message)), `${path}: ${r.raw}`);
  }
  const unknown = await api("PUT", `/businesses/${A}/settings`, tOwnerA, { settings: { ...settingsA, backdoor: true } });
  assert.equal(unknown.status, 422);
  const noBody = await api("PUT", `/businesses/${A}/settings`, tOwnerA, { settings: {} });
  assert.equal(noBody.status, 422);
  const unchanged = await withTenant(A, (db) => one(db, "select settings from tenants where id = app_current_tenant()"));
  assert.equal(unchanged.settings.timezone, settingsA.timezone, "nothing was saved");
});

test("the database only lets a business edit its own name and settings", async () => {
  await assert.rejects(withTenant(A, (db) => db.query("update tenants set status = 'closed' where id = app_current_tenant()")), /permission denied/);
  await assert.rejects(withTenant(A, (db) => db.query("update tenants set slug = 'hijack' where id = app_current_tenant()")), /permission denied/);
  const other = await withTenant(A, (db) => db.query("update tenants set name = 'x' where id = $1", [B]));
  assert.equal(other.rowCount, 0, "can't touch another business");
});

test("use cases can be switched, but only known ones, and only by owners", async () => {
  assert.equal((await api("PUT", `/businesses/${A}/use-cases/book_appointments`, tStaffA, { enabled: false })).status, 403);
  assert.equal((await api("PUT", `/businesses/${A}/use-cases/not_real`, tOwnerA, { enabled: false })).status, 404);
  assert.equal((await api("PUT", `/businesses/${A}/use-cases/book_appointments`, tOwnerA, { enabled: "no" })).status, 422);
  assert.equal((await api("PUT", `/businesses/${A}/use-cases/book_appointments`, tOwnerA, { enabled: false })).status, 200);
  const uc = await withTenant(A, (db) => one(db, "select enabled from tenant_use_cases where use_case = 'book_appointments'"));
  assert.equal(uc.enabled, false);
  assert.equal((await api("PUT", `/businesses/${A}/use-cases/book_appointments`, tOwnerA, { enabled: true })).status, 200);
});

test("connections: secrets are write-only; webhook URLs are shown to owners only", async () => {
  const w = await api("POST", `/businesses/${A}/connections/webhook`, tOwnerA, { kind: "web_form", label: "Website" });
  assert.equal(w.status, 201);
  assert.match(w.body.url, /^https:\/\/platform\.example\/webhooks\/forms\//);
  assert.equal((await api("POST", `/businesses/${A}/connections/webhook`, tStaffA, { kind: "web_form" })).status, 403);

  const owner = await api("GET", `/businesses/${A}/connections`, tOwnerA);
  assert.equal(owner.status, 200);
  assert.ok(owner.body.connections.some((c: any) => c.url === w.body.url));
  assert.ok(!owner.raw.includes("tenant-wa-token"), "no token in the response");
  assert.ok(!/secret|ciphertext|accessToken/i.test(owner.raw), "no secret fields in the response");
  const wa1 = owner.body.connections.find((c: any) => c.kind === "whatsapp");
  assert.equal(wa1.connectedAs, "TENANT_WA");

  const staff = await api("GET", `/businesses/${A}/connections`, tStaffA);
  assert.ok(staff.body.connections.every((c: any) => c.url === undefined), "staff don't see webhook addresses");

  const bad = await api("POST", `/businesses/${A}/connections/whatsapp`, tOwnerA, { phoneNumberId: "abc", accessToken: "x" });
  assert.equal(bad.status, 422);
  const fresh = await api("POST", `/businesses/${A}/connections/whatsapp`, tOwnerA, { phoneNumberId: "99887766", accessToken: "EAAB-new-token-0123456789" });
  assert.equal(fresh.status, 200);
  assert.ok(!fresh.raw.includes("EAAB"));
  const taken = await api("POST", `/businesses/${B}/connections/whatsapp`, tOwnerB, { phoneNumberId: "99887766", accessToken: "EAAB-other-token-0123456789" });
  assert.equal(taken.status, 409, "a number can only belong to one business");

  const audited = await withTenant(A, (db) => many(db, "select detail::text as d from audit_log where action like '%connected%' or action like '%added%'"));
  assert.ok(audited.every((r) => !String(r.d).includes("EAAB")), "tokens never reach the audit log");

  const row = await withTenant(A, (db) => one(db, "select id from channel_connections where external_id = '99887766'"));
  assert.equal((await api("POST", `/businesses/${A}/connections/${row.id}/disable`, tOwnerA)).status, 200);
  assert.equal((await withTenant(A, (db) => one(db, "select status from channel_connections where id = $1", [row.id]))).status, "disconnected");
  assert.equal((await api("POST", `/businesses/${B}/connections/${row.id}/disable`, tOwnerB)).status, 404, "can't disable another business's connection");

  const link = await api("GET", `/businesses/${A}/google-link`, tOwnerA);
  assert.match(link.body.url, /^https:\/\/platform\.example\//);
  assert.equal((await api("GET", `/businesses/${A}/google-link`, tStaffA)).status, 403);
});

async function newDraft(phone: string, text: string) {
  await postWhatsApp(waWebhook("TENANT_WA", phone, { type: "text", text: { body: text } }, "Test Customer"));
  await drain();
  const d = await withTenant(A, (db) => one(db,
    `select d.id from drafts d join conversations c on c.id = d.conversation_id
     join contact_identities i on i.contact_id = c.contact_id where i.value = $1 and d.status = 'pending_approval' order by d.created_at desc limit 1`, [phone]));
  assert.ok(d, "a draft is waiting");
  return d.id as string;
}

test("approving on the web sends the reply, just like pressing Approve on WhatsApp", async () => {
  const phone = "+447700900701";
  const id = await newDraft(phone, "Do you fit carpet on stairs?");
  const list = await api("GET", `/businesses/${A}/drafts`, tStaffA);
  assert.equal(list.status, 200);
  const item = list.body.drafts.find((d: any) => d.id === id);
  assert.ok(item, "staff can see waiting drafts");
  assert.match(item.inbound, /carpet on stairs/);

  assert.equal((await api("POST", `/businesses/${B}/drafts/${id}/approve`, tOwnerB)).status, 404, "another business can't approve it");
  assert.equal((await api("POST", `/businesses/${A}/drafts/${id}/approve`, tStranger)).status, 404);

  const res = await api("POST", `/businesses/${A}/drafts/${id}/approve`, tStaffA);
  assert.equal(res.status, 200);
  assert.equal(res.body.outcome, "approved");
  await drain();
  assert.equal(wa.last(phone)!.from, "TENANT_WA", "sent from the business's own number");
  assert.equal((await withTenant(A, (db) => one(db, "select status from drafts where id = $1", [id]))).status, "sent");

  const entry = await withTenant(A, (db) => one(db, "select actor, detail from audit_log where action = 'draft.approved' and entity_id = $1", [id]));
  assert.match(entry.actor, /^member:/);
  assert.equal(entry.detail.via, "web");

  const again = await api("POST", `/businesses/${A}/drafts/${id}/approve`, tOwnerA);
  assert.equal(again.status, 409);
  assert.equal(again.body.status, "sent");
  await drain();
  assert.equal(wa.sent.filter((s) => s.to === phone).length, 1, "approving twice sends once");
});

test("editing on the web sends the owner's wording; empty edits are refused", async () => {
  const phone = "+447700900702";
  const id = await newDraft(phone, "Can you quote for oak flooring?");
  assert.equal((await api("POST", `/businesses/${A}/drafts/${id}/edit`, tOwnerA, { body: "   " })).status, 422);
  assert.equal((await api("POST", `/businesses/${A}/drafts/${id}/edit`, tOwnerA, {})).status, 422);
  const res = await api("POST", `/businesses/${A}/drafts/${id}/edit`, tOwnerA, { body: "Yes, happy to. Mark" });
  assert.equal(res.body.outcome, "edited");
  await drain();
  assert.equal(wa.last(phone)!.text, "Yes, happy to. Mark");
  const entry = await withTenant(A, (db) => one(db, "select detail from audit_log where action = 'draft.edited_and_approved' and entity_id = $1", [id]));
  assert.equal(entry.detail.via, "web");
  assert.ok(!JSON.stringify(entry.detail).includes("happy to"), "the audit log holds no message text");
});

test("rejecting on the web sends nothing", async () => {
  const phone = "+447700900703";
  const id = await newDraft(phone, "Do you do commercial floors?");
  const before = wa.sent.filter((s) => s.to === phone).length;
  const res = await api("POST", `/businesses/${A}/drafts/${id}/reject`, tOwnerA);
  assert.equal(res.body.outcome, "rejected");
  await drain();
  assert.equal(wa.sent.filter((s) => s.to === phone).length, before);
  assert.equal((await withTenant(A, (db) => one(db, "select status from drafts where id = $1", [id]))).status, "rejected");
  assert.equal((await api("POST", `/businesses/${A}/drafts/${randomUUID()}/reject`, tOwnerA)).status, 404);
  assert.equal((await api("POST", `/businesses/${A}/drafts/nope/reject`, tOwnerA)).status, 404);
});

test("an approval made on WhatsApp is seen as already decided on the web", async () => {
  const phone = "+447700900704";
  const id = await newDraft(phone, "Do you fit underfloor heating?");
  const buttons = [...wa.sent].reverse().find((s) => s.buttons)!.buttons!;
  await postWhatsApp(waWebhook("PLATFORM", "+447700900001", { type: "interactive", interactive: { type: "button_reply", button_reply: { id: buttons[0], title: "Approve" } } }, "Mark"));
  await drain();
  const res = await api("POST", `/businesses/${A}/drafts/${id}/approve`, tOwnerA);
  assert.equal(res.status, 409);
  assert.equal((await withTenant(A, (db) => one(db, "select detail->>'via' as via from audit_log where action = 'draft.approved' and entity_id = $1", [id]))).via, "whatsapp");
});

test("overview counts what the business needs to know about", async () => {
  const o = await api("GET", `/businesses/${A}`, tOwnerA);
  assert.equal(o.status, 200);
  assert.equal(o.body.business.slug, "marks-flooring");
  assert.ok(o.body.counts.messagesToday >= 4);
  assert.equal(o.body.counts.draftsWaiting, 0);
  assert.ok(Array.isArray(o.body.connectionProblems));
  assert.ok(o.body.useCases.length > 0);
  const closed = await withTenant(B, (db) => one(db, "select count(*)::int as n from messages"));
  assert.equal(closed.n, 0, "none of A's traffic shows up for B");
});

// ---------------------------------------------------------------- people
test("people: owners manage the team, staff can only look, and the last owner can't be removed", async () => {
  assert.equal((await api("GET", `/businesses/${A}/people`, tStaffA)).body.canEdit, false);
  assert.equal((await api("POST", `/businesses/${A}/people`, tStaffA, { name: "X" })).status, 403);
  assert.equal((await api("GET", `/businesses/${A}/people`, tOwnerB)).status, 404);

  assert.equal((await api("POST", `/businesses/${A}/people`, tOwnerA, { name: "", role: "staff" })).status, 422);
  const noNumber = await api("POST", `/businesses/${A}/people`, tOwnerA, { name: "Tom", isApprover: true });
  assert.equal(noNumber.status, 422);
  assert.equal(noNumber.body.issues[0].path, "whatsapp");

  const add = await api("POST", `/businesses/${A}/people`, tOwnerA, { name: "Tom", email: "Tom@Example.com", whatsapp: "07700 900044", isApprover: true });
  assert.equal(add.status, 201);
  const dup = await api("POST", `/businesses/${A}/people`, tOwnerA, { name: "Tom again", email: "tom@example.com" });
  assert.equal(dup.status, 409);

  const list = await api("GET", `/businesses/${A}/people`, tOwnerA);
  const tom = list.body.people.find((p: any) => p.id === add.body.id);
  assert.equal(tom.email, "tom@example.com");
  assert.equal(tom.whatsapp, "+447700900044");
  assert.equal(tom.hasLogin, false);

  assert.equal((await api("PUT", `/businesses/${A}/people/${add.body.id}`, tOwnerA, { whatsapp: null })).status, 422, "an approver keeps a number");
  assert.equal((await api("PUT", `/businesses/${A}/people/${add.body.id}`, tOwnerA, { isApprover: false, whatsapp: null, name: "Tom B" })).status, 200);
  assert.equal((await api("PUT", `/businesses/${A}/people/${randomUUID()}`, tOwnerA, { name: "Nobody" })).status, 404);
  assert.equal((await api("PUT", `/businesses/${B}/people/${add.body.id}`, tOwnerB, { name: "Hijack" })).status, 404, "can't reach another business's people");

  const ownerId = list.body.people.find((p: any) => p.role === "owner").id;
  assert.equal((await api("PUT", `/businesses/${A}/people/${ownerId}`, tOwnerA, { role: "staff" })).status, 409);
  assert.equal((await api("DELETE", `/businesses/${A}/people/${ownerId}`, tOwnerA)).status, 409);

  assert.equal((await api("DELETE", `/businesses/${A}/people/${add.body.id}`, tOwnerA)).status, 200);
  assert.equal((await api("DELETE", `/businesses/${A}/people/${add.body.id}`, tOwnerA)).status, 404);
  const actions = await withTenant(A, (db) => many(db, "select action, detail from audit_log where action like 'member.%'"));
  assert.deepEqual([...new Set(actions.map((a: any) => a.action))].sort(), ["member.added", "member.removed", "member.updated"]);
  assert.ok(!JSON.stringify(actions).includes("900044") && !JSON.stringify(actions).includes("tom@"), "no contact details in the audit log");
});

test("an invited person is linked to their login only when their email address is verified", async () => {
  const add = await api("POST", `/businesses/${A}/people`, tOwnerA, { name: "Priya", email: "priya@example.com" });
  assert.equal(add.status, 201);
  const priya = randomUUID();
  const unverified = await api("GET", "/me", await token(priya, { email: "priya@example.com", verified: false }));
  assert.deepEqual(unverified.body.businesses, [], "an unverified address proves nothing");
  const verified = await api("GET", "/me", await token(priya, { email: "Priya@Example.com", verified: true }));
  assert.deepEqual(verified.body.businesses.map((b: any) => b.tenantId), [A]);
  assert.equal(verified.body.businesses[0].role, "staff");
  const other = randomUUID();
  const thief = await api("GET", "/me", await token(other, { email: "priya@example.com", verified: true }));
  assert.deepEqual(thief.body.businesses, [], "once linked, a second login can't take the place");
  assert.equal((await api("GET", `/businesses/${A}/people`, await token(priya, { email: "priya@example.com", verified: true }))).body.people.find((p: any) => p.name === "Priya").hasLogin, true);
});

test("settings saves keep the platform's agent version pins, and the pins aren't shown to owners", async () => {
  await withAdmin((db) => db.query("update tenants set settings = settings || '{\"agentVersions\": {\"drafting\": \"1.0.0\"}}'::jsonb where id = $1", [A]));
  const read = await api("GET", `/businesses/${A}/settings`, tOwnerA);
  assert.equal(read.body.settings.agentVersions, undefined);
  assert.equal((await api("PUT", `/businesses/${A}/settings`, tOwnerA, { settings: { ...read.body.settings, signOff: "Cheers, Mark" } })).status, 200);
  assert.equal((await api("PUT", `/businesses/${A}/settings`, tOwnerA, { settings: { ...read.body.settings, agentVersions: { drafting: "9.9.9" } } })).status, 422, "owners can't set pins");
  const stored = await withTenant(A, (db) => one(db, "select settings from tenants where id = app_current_tenant()"));
  assert.deepEqual(stored.settings.agentVersions, { drafting: "1.0.0" });
  assert.equal(stored.settings.signOff, "Cheers, Mark");
  await withAdmin((db) => db.query("update tenants set settings = settings - 'agentVersions' where id = $1", [A]));
});

// ---------------------------------------------------------------- inbox, bookings, activity
test("conversations: list and detail show messages, drafts (original vs edited) and bookings, per business", async () => {
  const list = await api("GET", `/businesses/${A}/conversations`, tStaffA);
  assert.equal(list.status, 200);
  assert.ok(list.body.conversations.length >= 4);
  assert.equal((await api("GET", `/businesses/${B}/conversations`, tOwnerB)).body.conversations.length, 0);
  assert.equal((await api("GET", `/businesses/${A}/conversations`, tOwnerB)).status, 404);
  assert.equal((await api("GET", `/businesses/${A}/conversations?limit=2`, tStaffA)).body.conversations.length, 2);

  const edited = await withTenant(A, (db) => one(db, "select conversation_id from drafts where body <> original_body limit 1"));
  const detail = await api("GET", `/businesses/${A}/conversations/${edited.conversation_id}`, tStaffA);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.messages.some((m: any) => m.direction === "in"));
  const d = detail.body.drafts.find((x: any) => x.edited);
  assert.ok(d && d.originalBody !== d.body, "shows what the agent wrote and what was sent");
  assert.equal((await api("GET", `/businesses/${B}/conversations/${edited.conversation_id}`, tOwnerB)).status, 404);
  assert.equal((await api("GET", `/businesses/${A}/conversations/nope`, tOwnerA)).status, 404);
});

test("bookings: staff can see and cancel; closed ones can't be cancelled again", async () => {
  const conv = await withTenant(A, (db) => one(db, "select id, contact_id from conversations limit 1"));
  const mk = (status: string, hours: number) => withTenant(A, async (db) => (await one(db,
    "insert into holds (tenant_id, conversation_id, contact_id, service, start_at, end_at, status) values (app_current_tenant(), $1, $2, 'Survey', now() + $3 * interval '1 hour', now() + ($3 + 1) * interval '1 hour', $4) returning id",
    [conv.id, conv.contact_id, hours, status]))!.id);
  const held = await mk("held", 24), confirmed = await mk("confirmed", 48), released = await mk("released", 72);
  const list = await api("GET", `/businesses/${A}/bookings`, tStaffA);
  const ids = list.body.bookings.map((b: any) => b.id);
  assert.ok(ids.includes(held) && ids.includes(confirmed) && !ids.includes(released), "by default only live bookings");
  assert.ok((await api("GET", `/businesses/${A}/bookings?status=released`, tStaffA)).body.bookings.some((b: any) => b.id === released));
  assert.equal((await api("GET", `/businesses/${A}/bookings?status=bogus`, tStaffA)).status, 422);
  assert.equal((await api("GET", `/businesses/${B}/bookings`, tOwnerB)).body.bookings.length, 0);

  assert.equal((await api("POST", `/businesses/${A}/bookings/${held}/cancel`, tStranger)).status, 404);
  assert.equal((await api("POST", `/businesses/${B}/bookings/${held}/cancel`, tOwnerB)).status, 404);
  assert.equal((await api("POST", `/businesses/${A}/bookings/${held}/cancel`, tStaffA)).status, 200);
  assert.equal((await api("POST", `/businesses/${A}/bookings/${confirmed}/cancel`, tOwnerA)).status, 200);
  const again = await api("POST", `/businesses/${A}/bookings/${held}/cancel`, tOwnerA);
  assert.equal(again.status, 409);
  assert.equal(again.body.status, "released");
  const st = await withTenant(A, (db) => many(db, "select id, status from holds where id = any($1)", [[held, confirmed]]));
  assert.deepEqual(Object.fromEntries(st.map((h: any) => [h.id, h.status])), { [held]: "released", [confirmed]: "cancelled" });
  assert.ok((await withTenant(A, (db) => many(db, "select 1 from audit_log where action in ('booking.cancelled', 'hold.released') and detail->>'via' = 'web'"))).length >= 2);
});

test("activity: runs with their steps, and the audit trail with filters and paging", async () => {
  const runs = await api("GET", `/businesses/${A}/runs`, tStaffA);
  assert.equal(runs.status, 200);
  assert.ok(runs.body.runs.length > 0);
  const withSteps = runs.body.runs.find((r: any) => r.agents.length > 0);
  assert.ok(withSteps, "each run lists the agent versions that handled it");
  const one1 = await api("GET", `/businesses/${A}/runs/${withSteps.id}`, tStaffA);
  assert.equal(one1.status, 200);
  assert.ok(one1.body.events.length > 0);
  assert.equal((await api("GET", `/businesses/${B}/runs/${withSteps.id}`, tOwnerB)).status, 404);
  assert.equal((await api("GET", `/businesses/${B}/runs`, tOwnerB)).body.runs.length, 0);

  const all = await api("GET", `/businesses/${A}/audit?limit=3`, tStaffA);
  assert.equal(all.body.entries.length, 3);
  const older = await api("GET", `/businesses/${A}/audit?limit=3&before=${encodeURIComponent(all.body.entries[2].at)}`, tStaffA);
  assert.ok(older.body.entries.every((e: any) => new Date(e.at) < new Date(all.body.entries[2].at)));
  const drafts = await api("GET", `/businesses/${A}/audit?action=draft`, tStaffA);
  assert.ok(drafts.body.entries.length > 0 && drafts.body.entries.every((e: any) => e.action.startsWith("draft.")));
  assert.equal((await api("GET", `/businesses/${A}/audit?action=%27%3B--`, tStaffA)).status, 422);
  assert.ok((await api("GET", `/businesses/${B}/audit`, tOwnerB)).body.entries.every((e: any) => !JSON.stringify(e).includes(A)));
});

// ---------------------------------------------------------------- data requests and agents
test("data requests: owners only, one identifier, and erase/suppress need it typed again", async () => {
  const phone = "+447700900701";
  const path = (k: string) => `/businesses/${A}/data/${k}`;
  assert.equal((await api("POST", path("export"), tStaffA, { phone })).status, 403);
  assert.equal((await api("POST", `/businesses/${B}/data/export`, tOwnerB, { phone })).status, 404, "another business has no such person");
  assert.equal((await api("POST", path("export"), tOwnerA, {})).status, 422);
  assert.equal((await api("POST", path("export"), tOwnerA, { phone, email: "a@b.co" })).status, 422);

  const exp = await api("POST", path("export"), tOwnerA, { phone: "07700 900701" });
  assert.equal(exp.status, 200);
  assert.ok(exp.body.data.messages.length > 0);
  assert.equal((await api("POST", path("export"), tOwnerA, { phone: "+447700900999" })).status, 404);

  assert.equal((await api("POST", path("erase"), tOwnerA, { phone })).status, 422, "needs confirmation");
  assert.equal((await api("POST", path("erase"), tOwnerA, { phone, confirm: "+447700900702" })).status, 422);
  assert.equal((await api("POST", path("erase"), tOwnerA, { phone, confirm: "+44 7700 900701" })).status, 200);
  assert.equal((await api("POST", path("erase"), tOwnerA, { phone, confirm: phone })).status, 404, "already gone");
  const left = await withTenant(A, (db) => many(db, "select m.body from messages m join conversations v on v.id = m.conversation_id join contact_identities i on i.contact_id = v.contact_id where i.value = $1", [phone]));
  assert.ok(left.every((m: any) => m.body === null));

  assert.equal((await api("POST", path("suppress"), tOwnerA, { email: "spam@example.com" })).status, 422);
  assert.equal((await api("POST", path("suppress"), tOwnerA, { email: "spam@example.com", confirm: "spam@example.com", reason: "asked us to stop" })).status, 200);
  const sup = await withTenant(A, (db) => one(db, "select value from suppression where value = 'spam@example.com'"));
  assert.ok(sup);
  const log = await withTenant(A, (db) => one(db, "select actor from audit_log where action = 'contact.suppressed' order by id desc limit 1"));
  assert.match(log.actor, /^member:/, "the audit log names who did it");

  const reqs = await api("GET", path("requests"), tOwnerA);
  assert.deepEqual([...new Set(reqs.body.requests.map((r: any) => r.kind))].sort(), ["erase", "export"]);
  assert.equal((await api("GET", path("requests"), tStaffA)).status, 403);
});

test("agents: platform admins see versions and which business pins what", async () => {
  assert.equal((await api("GET", "/agents", tOwnerA)).status, 403);
  assert.equal((await api("GET", "/agents", tAdminNoMfa)).status, 403);
  await withAdmin((db) => db.query("update tenants set settings = settings || '{\"agentVersions\": {\"drafting\": \"1.0.0\"}}'::jsonb where id = $1", [A]));
  const res = await api("GET", "/agents", tAdminMfa);
  assert.equal(res.status, 200);
  assert.ok(res.body.agents.length > 0 && res.body.agents.every((a: any) => a.versions.length > 0));
  assert.deepEqual(res.body.businesses.find((b: any) => b.id === A).pinned, { drafting: "1.0.0" });
  assert.deepEqual(res.body.businesses.find((b: any) => b.id === B).pinned, {});
  await withAdmin((db) => db.query("update tenants set settings = settings - 'agentVersions' where id = $1", [A]));
});
