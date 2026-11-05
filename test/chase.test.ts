// Chase quotes: a quote marked as sent, left unanswered, gets one follow-up draft for the owner to approve.
// Needs a throwaway Postgres in TEST_DATABASE_URL: it is wiped at the start.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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

const { getPool, closePool, withTenant, one, many } = await import("../src/db.js");
const { migrate } = await import("../src/cli/migrate.js");
const { syncAgents } = await import("../src/cli/agents-sync.js");
const { clients } = await import("../src/integrations/index.js");
const { createTenant, connectWhatsApp, setTenantStatus } = await import("../src/onboarding.js");
const { encryptJson } = await import("../src/crypto.js");
const { app } = await import("../src/app.js");
const { taskList } = await import("../src/jobs/tasks.js");
const { releaseQueue } = await import("../src/jobs/queue.js");
const { chaseQuotes, chaseAllQuotes } = await import("../src/workflows/chase-quotes.js");
const { runOnce, Logger } = await import("graphile-worker");
const { fakeGoogle, fakeWhatsApp } = await import("./fakes.js");

const google = fakeGoogle();
const wa = fakeWhatsApp();
clients.google = google.client;
clients.whatsapp = wa.client;
const logger = new Logger(() => () => {});
const drain = async () => { for (let i = 0; i < 4; i++) await runOnce({ pgPool: getPool(), taskList, logger }); };

const key = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
const OWNER_A = { sub: "00000000-0000-4000-8000-0000000000a1", email: "mark@a.example" };
const OWNER_B = { sub: "00000000-0000-4000-8000-0000000000b1", email: "olu@b.example" };
async function api(u: typeof OWNER_A, method: string, path: string, body?: unknown) {
  const jwt = await new SignJWT({ email: u.email, aal: "aal1" }).setProtectedHeader({ alg: "HS256" }).setSubject(u.sub)
    .setAudience("authenticated").setIssuedAt().setExpirationTime("1h").sign(key);
  const res = await app.request(`/api${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

let A: string;
let B: string;

/** A customer conversation whose quote was marked as sent `daysAgo` days ago. */
async function quoted(tenantId: string, o: { name?: string; email?: string; phone?: string; channel?: string; daysAgo?: number; windowOpen?: boolean; inboundAfterQuote?: boolean }) {
  return withTenant(tenantId, async (db) => {
    const ct = await one<{ id: string }>(db, "insert into contacts (tenant_id, name) values (app_current_tenant(), $1) returning id", [o.name ?? "Jo Bloggs"]);
    for (const [kind, value] of [["email", o.email], ["phone", o.phone]] as const) {
      if (value) await db.query("insert into contact_identities (tenant_id, contact_id, kind, value) values (app_current_tenant(), $1, $2, $3)", [ct!.id, kind, value]);
    }
    const days = o.daysAgo ?? 4;
    const cv = await one<{ id: string }>(db,
      `insert into conversations (tenant_id, contact_id, last_inbound_at, whatsapp_window_closes_at, quoted_at)
       values (app_current_tenant(), $1, now() - make_interval(days => $2 + 1) - ($4 || ' minutes')::interval, $3, now() - make_interval(days => $2)) returning id`,
      [ct!.id, days, o.windowOpen ? new Date(Date.now() + 3600_000) : new Date(Date.now() - 3600_000), o.inboundAfterQuote ? "-60000" : "0"]);
    await db.query("insert into messages (tenant_id, conversation_id, direction, channel, body, from_name) values (app_current_tenant(), $1, 'in', $2, 'Can you quote for a kitchen floor?', $3)",
      [cv!.id, o.channel ?? "email", o.name ?? "Jo Bloggs"]);
    return cv!.id;
  });
}
const chaseDrafts = (tenantId: string, convId: string) =>
  withTenant(tenantId, (db) => many<any>(db, "select * from drafts where conversation_id = $1 and kind = 'chase'", [convId]));

before(async () => {
  await getPool().query("drop schema if exists graphile_worker cascade; drop schema if exists public cascade; create schema public;");
  await migrate(() => {});
  await syncAgents(() => {});
  A = (await createTenant({ slug: "marks-flooring", name: "Mark's Flooring", pack: "flooring", owner: { name: "Mark", whatsapp: "07700 900001", email: OWNER_A.email } })).id;
  B = (await createTenant({ slug: "other-biz", name: "Other Business", pack: "trades", owner: { name: "Olu", whatsapp: "07700 900002", email: OWNER_B.email } })).id;
  await connectWhatsApp(A, "TENANT_WA", "tenant-wa-token");
  await setTenantStatus(A, "active");
  await setTenantStatus(B, "active");
  await withTenant(A, (db) => db.query(
    "insert into channel_connections (tenant_id, kind, external_id, secret_ciphertext, config) values (app_current_tenant(), 'gmail', 'mark@marksflooring.example', $1, '{\"grant\":\"g\"}')",
    [encryptJson({ access_token: "a", refresh_token: "r", expires_at: Date.now() + 3600_000 })]));
});

after(async () => { await releaseQueue(); await closePool(); });

test("flooring and trades businesses get the use case by default", async () => {
  const on = (t: string) => withTenant(t, (db) => one(db, "select 1 from tenant_use_cases where use_case = 'chase_quotes' and enabled"));
  assert.ok(await on(A));
  assert.ok(await on(B));
});

test("an owner can mark a quote as sent, and un-mark it; another business can't", async () => {
  const conv = await quoted(A, {});
  await withTenant(A, (db) => db.query("update conversations set quoted_at = null where id = $1", [conv]));
  assert.equal((await api(OWNER_A, "POST", `/businesses/${A}/conversations/${conv}/quote`, { sent: true })).status, 200);
  const shown = (await api(OWNER_A, "GET", `/businesses/${A}/conversations/${conv}`)).json.conversation;
  assert.ok(shown.quoted_at);
  assert.equal(shown.chased_at, null);
  assert.equal((await api(OWNER_B, "POST", `/businesses/${A}/conversations/${conv}/quote`, { sent: false })).status, 404);
  assert.equal((await api(OWNER_A, "POST", `/businesses/${A}/conversations/${conv}/quote`, { sent: "yes" })).status, 400);
  assert.equal((await api(OWNER_A, "POST", `/businesses/${A}/conversations/00000000-0000-4000-8000-000000000999/quote`, { sent: true })).status, 404);
  assert.equal((await api(OWNER_A, "POST", `/businesses/${A}/conversations/${conv}/quote`, { sent: false })).status, 200);
  assert.equal((await api(OWNER_A, "GET", `/businesses/${A}/conversations/${conv}`)).json.conversation.quoted_at, null);
  const audits = await withTenant(A, (db) => many<{ action: string }>(db, "select action from audit_log where entity_id = $1 order by id", [conv]));
  assert.deepEqual(audits.map((a) => a.action), ["quote.marked_sent", "quote.unmarked"]);
});

test("a quiet quote gets one follow-up draft, by email, waiting for approval", async () => {
  const fresh = await quoted(A, { name: "Fresh Fran", email: "fran@example.com", daysAgo: 1 });
  const quiet = await quoted(A, { name: "Quiet Quentin", email: "q@example.com", daysAgo: 4 });
  assert.equal(await chaseQuotes(A), 1);
  assert.equal((await chaseDrafts(A, fresh)).length, 0, "too soon to chase");
  const [d] = await chaseDrafts(A, quiet);
  assert.equal(d.status, "pending_approval");
  assert.equal(d.reply_route, "email");
  assert.equal(d.run_id, null);
  assert.match(d.body, /^Hi Quiet, /);
  assert.match(d.body, /quote/);
  assert.match(d.body, /Mark.s Flooring$/, "signed with the business name while the sign-off is still a template placeholder");
  // Only once.
  assert.equal(await chaseQuotes(A), 0);
  assert.equal((await chaseDrafts(A, quiet)).length, 1);
  const c = await withTenant(A, (db) => one<any>(db, "select chased_at from conversations where id = $1", [quiet]));
  assert.ok(c.chased_at);
  const log = await withTenant(A, (db) => many<{ detail: any }>(db, "select detail from audit_log where action = 'chase.drafted'"));
  assert.ok(log.length >= 1);
  assert.ok(!JSON.stringify(log).includes("Quiet"), "no customer text in the audit log");
});

test("the owner is asked on WhatsApp, and approving sends it by email", async () => {
  const conv = await quoted(A, { name: "Email Ed", email: "ed@example.com", daysAgo: 5 });
  await withTenant(A, (db) => db.query("update tenant_members set approver_last_inbound_at = now() where role = 'owner'"));
  wa.sent.length = 0;
  await chaseQuotes(A);
  await drain();
  const ask = wa.sent.find((s) => s.text.includes("Quote follow-up for Email"));
  assert.ok(ask, "owner got an approval request");
  assert.equal(ask!.kind, "buttons");
  const [d] = await chaseDrafts(A, conv);
  const before = google.sent.length;
  assert.equal((await api(OWNER_A, "POST", `/businesses/${A}/drafts/${d.id}/approve`)).status, 200);
  await drain();
  assert.equal(google.sent.length, before + 1);
  assert.equal((await chaseDrafts(A, conv))[0].status, "sent");
});

test("WhatsApp is only chosen while the 24-hour window is open", async () => {
  const closed = await quoted(A, { name: "Closed Cara", phone: "+447700900111", channel: "whatsapp", windowOpen: false });
  const open = await quoted(A, { name: "Open Olly", phone: "+447700900222", channel: "whatsapp", windowOpen: true });
  await chaseQuotes(A);
  assert.equal((await chaseDrafts(A, closed))[0].reply_route, "phone", "falls back to a call suggestion, which the owner makes themselves");
  assert.equal((await chaseDrafts(A, open))[0].reply_route, "whatsapp");
});

test("no follow-up if the customer has replied since, the quote is stale, or they opted out", async () => {
  const replied = await quoted(A, { name: "Replied Rita", email: "rita@example.com", daysAgo: 4 });
  await withTenant(A, (db) => db.query("update conversations set last_inbound_at = now() where id = $1", [replied]));
  const stale = await quoted(A, { name: "Stale Stan", email: "stan@example.com", daysAgo: 45 });
  const optedOut = await quoted(A, { name: "Out Olive", email: "olive@example.com", daysAgo: 4 });
  await withTenant(A, (db) => db.query("insert into suppression (tenant_id, kind, value) values (app_current_tenant(), 'email', 'olive@example.com')"));
  const waiting = await quoted(A, { name: "Waiting Will", email: "will@example.com", daysAgo: 4 });
  await withTenant(A, (db) => db.query("insert into drafts (tenant_id, conversation_id, reply_route, body, original_body) values (app_current_tenant(), $1, 'email', 'x', 'x')", [waiting]));
  await chaseQuotes(A);
  for (const c of [replied, stale, optedOut, waiting]) assert.equal((await chaseDrafts(A, c)).length, 0);
  const skipped = await withTenant(A, (db) => one(db, "select 1 from audit_log where action = 'chase.skipped' and entity_id = $1", [optedOut]));
  assert.ok(skipped, "the opt-out is recorded");
  assert.equal((await withTenant(A, (db) => one<any>(db, "select chased_at from conversations where id = $1", [optedOut])))!.chased_at !== null, true, "and not retried every day");
});

test("a business that turned the use case off, or is paused, is left alone", async () => {
  const conv = await quoted(B, { name: "Bee Bee", email: "bee@example.com", daysAgo: 4 });
  await withTenant(B, (db) => db.query("update tenant_use_cases set enabled = false where use_case = 'chase_quotes'"));
  assert.equal(await chaseQuotes(B), 0);
  await withTenant(B, (db) => db.query("update tenant_use_cases set enabled = true where use_case = 'chase_quotes'"));
  await setTenantStatus(B, "paused");
  await chaseAllQuotes();
  assert.equal((await chaseDrafts(B, conv)).length, 0);
  await setTenantStatus(B, "active");
  await chaseAllQuotes();
  assert.equal((await chaseDrafts(B, conv)).length, 1, "the daily sweep covers every business");
});

test("a business can set how many days to wait", async () => {
  const conv = await quoted(A, { name: "Patient Pat", email: "pat@example.com", daysAgo: 4 });
  await withTenant(A, (db) => db.query("update tenant_use_cases set config = '{\"afterDays\": 7}' where use_case = 'chase_quotes'"));
  assert.equal(await chaseQuotes(A), 0);
  await withTenant(A, (db) => db.query("update tenant_use_cases set config = '{\"afterDays\": 2}' where use_case = 'chase_quotes'"));
  assert.equal(await chaseQuotes(A), 1);
  assert.equal((await chaseDrafts(A, conv)).length, 1);
});

test("marking the quote as sent again re-arms the follow-up", async () => {
  const conv = await quoted(A, { name: "Again Abi", email: "abi@example.com", daysAgo: 4 });
  await chaseQuotes(A);
  assert.equal((await chaseDrafts(A, conv)).length, 1);
  await withTenant(A, (db) => db.query("update drafts set status = 'rejected' where conversation_id = $1", [conv]));
  await api(OWNER_A, "POST", `/businesses/${A}/conversations/${conv}/quote`, { sent: true });
  await withTenant(A, (db) => db.query("update conversations set quoted_at = now() - interval '4 days' where id = $1", [conv]));
  await chaseQuotes(A);
  assert.equal((await chaseDrafts(A, conv)).length, 2);
});

test("business B can't see business A's conversations through the quote route", async () => {
  const conv = await quoted(A, { name: "Private Pete", email: "pete@example.com", daysAgo: 1 });
  const seen = await withTenant(B, (db) => many(db, "select id from conversations where id = $1", [conv]));
  assert.equal(seen.length, 0);
  assert.equal((await api(OWNER_B, "POST", `/businesses/${B}/conversations/${conv}/quote`, { sent: true })).status, 404);
});
