// One WhatsApp number for a sole trader: their WhatsApp Business app number shared with the platform (coexistence).
// No platform WhatsApp number is set in this file: owners approve in the admin app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://platform_dev:platform_dev@localhost:5432/platform_test";
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.SIGNING_SECRET = "test-signing-secret";
process.env.AGENT_MODE = "mock";
process.env.WA_APP_SECRET = "test-app-secret";
process.env.WA_VERIFY_TOKEN = "verify-me";
process.env.PLATFORM_WA_APP_SECRET = "second-app-secret";
delete process.env.PLATFORM_WA_PHONE_NUMBER_ID;
delete process.env.PLATFORM_WA_TOKEN;
process.env.GOOGLE_CLIENT_ID = "gid";
process.env.GOOGLE_CLIENT_SECRET = "gsecret";
process.env.PUBLIC_BASE_URL = "https://platform.example";

const { getPool, closePool, withTenant, many, one } = await import("../src/db.js");
const { migrate } = await import("../src/cli/migrate.js");
const { syncAgents } = await import("../src/cli/agents-sync.js");
const { clients } = await import("../src/integrations/index.js");
const { createTenant, connectWhatsApp, setTenantStatus } = await import("../src/onboarding.js");
const { app, googleConnectLink, whatsappConnectLink } = await import("../src/app.js");
const { taskList } = await import("../src/jobs/tasks.js");
const { releaseQueue } = await import("../src/jobs/queue.js");
const { ignorePerson, stopIgnoring } = await import("../src/whatsapp-business.js");
const { feed } = await import("../src/admin/feed.js");
const { runOnce, Logger } = await import("graphile-worker");
const { fakeGoogle, fakeWhatsApp, waWebhook } = await import("./fakes.js");

const google = fakeGoogle();
const wa = fakeWhatsApp();
clients.google = google.client;
clients.whatsapp = wa.client;

const OWNER = "+447700900001";
const NEWBIE = "+447700900600";   // someone the owner doesn't know: an enquiry
const FRIEND = "+447700900700";   // saved in the owner's phone
const REGULAR = "+447700900800";  // a customer, also saved in the owner's phone
const NUMBER = "BIZ_APP_NUMBER";  // the owner's one number (from the fake signup)

const jobErrors: string[] = [];
const logger = new Logger(() => (level, message) => { if (level === "error") jobErrors.push(message); });
async function drain() {
  for (let i = 0; i < 6; i++) await runOnce({ pgPool: getPool(), taskList, logger });
  assert.deepEqual(jobErrors, [], "jobs should not fail");
}
async function postWhatsApp(body: unknown, secret = process.env.WA_APP_SECRET!) {
  const raw = JSON.stringify(body);
  const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  return app.request("/webhooks/whatsapp", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-hub-signature-256": sig } });
}
const say = (from: string, text: string, name = "Someone") => postWhatsApp(waWebhook(NUMBER, from, { type: "text", text: { body: text } }, name));
const meta = (field: string, value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA-1", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: "447700900777", phone_number_id: NUMBER }, ...value } }] }],
});
const contactSync = (phone: string, action = "add") => meta("smb_app_state_sync", {
  state_sync: [{ type: "contact", contact: { full_name: "Saved Person", first_name: "Saved", phone_number: phone.replace("+", "") }, action, metadata: { timestamp: String(Math.floor(Date.now() / 1000)) } }],
});
const ownerSends = (to: string, text: string) => meta("smb_message_echoes", {
  message_echoes: [{ from: "447700900777", to: to.replace("+", ""), id: `wamid.echo.${Math.random().toString(36).slice(2)}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
});
const stored = (from: string) => withTenant(A, (db) => many(db,
  "select m.body from messages m join conversations c on c.id = m.conversation_id join contact_identities i on i.contact_id = c.contact_id where i.kind = 'phone' and i.value = $1 and m.direction = 'in'", [from]));
const draftsFor = (from: string) => withTenant(A, (db) => many(db,
  "select d.id, d.status, d.run_id from drafts d join conversations c on c.id = d.conversation_id join contact_identities i on i.contact_id = c.contact_id where i.kind = 'phone' and i.value = $1 order by d.created_at", [from]));

let A: string;
let B: string;

before(async () => {
  const pool = getPool();
  await pool.query("drop schema if exists graphile_worker cascade; drop schema if exists public cascade; create schema public;");
  await migrate(() => {});
  await syncAgents(() => {});
  A = (await createTenant({ slug: "sole-trader", name: "Sole Trader Floors", pack: "flooring", owner: { name: "Sam", whatsapp: "07700 900001" }, settings: { signOff: "Sam" } })).id;
  B = (await createTenant({ slug: "other-trader", name: "Other Trader", pack: "trades", owner: { name: "Olu", whatsapp: "07700 900002" } })).id;
  await connectWhatsApp(A, "OLD_TEST_NUMBER", "old-token");
  await setTenantStatus(A, "active");
  await setTenantStatus(B, "active");
  // Google, so enquiries get times pencilled in (and we can check they're freed).
  const start = await app.request(googleConnectLink(A).replace("https://platform.example", ""));
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  await app.request(`/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
});

after(async () => { await releaseQueue(); await closePool(); });

test("connect page: needs a valid link, waits for Meta approval, then loads only Meta's script", async () => {
  const path = whatsappConnectLink(A).replace("https://platform.example", "");
  assert.equal((await app.request("/connect/whatsapp?s=forged")).status, 400);
  assert.equal((await app.request(path)).status, 503, "not switched on until Meta approves the platform");

  process.env.META_APP_ID = "123";
  process.env.META_SIGNUP_CONFIG_ID = "456";
  const res = await app.request(path);
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy")!;
  assert.match(csp, /script-src 'nonce-[\w-]+' https:\/\/connect\.facebook\.net/);
  assert.match(await res.text(), /whatsapp_business_app_onboarding/);
});

test("owner connects their WhatsApp Business app number: token swapped, webhooks subscribed, contacts requested, history not", async () => {
  const s = new URL(whatsappConnectLink(A)).searchParams.get("s")!;
  const bad = await app.request("/connect/whatsapp/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ s: s + "x", code: "c1", wabaId: "WABA-1" }) });
  assert.equal(bad.status, 400);

  // The Business-app flow may only report the account: the number is looked up.
  const res = await app.request("/connect/whatsapp/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ s, code: "c1", wabaId: "WABA-1" }) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, display: "+44 7700 900777", coexistence: true });
  assert.deepEqual(wa.signup, ["exchange:c1", "subscribe:WABA-1:biz-token-c1", "sync:BIZ_APP_NUMBER"]);

  const conns = await withTenant(A, (db) => many(db, "select external_id, status, config, secret_ciphertext from channel_connections where kind = 'whatsapp' order by created_at"));
  assert.deepEqual(conns.map((c) => [c.external_id, c.status]), [["OLD_TEST_NUMBER", "disconnected"], [NUMBER, "active"]], "the new number replaces the test number");
  assert.equal(conns[1].config.coexistence, true);
  assert.ok(!String(conns[1].secret_ciphertext).includes("biz-token"), "token stored encrypted");
});

test("webhooks signed by either Meta app are accepted; anything else is refused", async () => {
  const ping = meta("messages", { statuses: [] });
  assert.equal((await postWhatsApp(ping, "second-app-secret")).status, 200);
  assert.equal((await postWhatsApp(ping, "wrong")).status, 401);
});

test("saved contacts are kept only as hashes", async () => {
  for (const p of [FRIEND, REGULAR]) assert.equal((await postWhatsApp(contactSync(p))).status, 200);
  const rows = await withTenant(A, (db) => many(db, "select phone_hash from wa_saved_contacts"));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => !r.phone_hash.includes("7700900")), "no phone numbers stored");
  assert.equal((await withTenant(B, (db) => many(db, "select * from wa_saved_contacts"))).length, 0, "another business can't see them");
});

test("a new person's enquiry is answered; a friend saved in the phone is left alone and nothing is kept", async () => {
  await say(NEWBIE, "Hi, could you quote for laminate in our hallway?", "Nia New");
  await say(FRIEND, "Are we still on for Saturday?", "Fran");
  await drain();
  assert.equal((await stored(NEWBIE)).length, 1);
  assert.equal((await draftsFor(NEWBIE))[0].status, "pending_approval", "waits for the owner in the app");
  assert.equal((await stored(FRIEND)).length, 0, "friend's message not stored");
  assert.equal(wa.sent.filter((m) => m.to === OWNER).length, 0, "no platform number: nothing sent to the owner on WhatsApp");
});

test("a saved contact who is already a customer is answered", async () => {
  await setPeople("everyone");
  await say(REGULAR, "Hi Sam, can you quote for our kitchen too?", "Rita Regular");
  await setPeople("new_and_customers");
  await drain();
  assert.equal((await stored(REGULAR)).length, 1);
  await say(REGULAR, "Also the downstairs loo please", "Rita Regular");
  await drain();
  assert.equal((await stored(REGULAR)).length, 2, "known customer gets through though saved in the phone");
});

test("'answer everyone' lets saved contacts through", async () => {
  await setPeople("everyone");
  await say(FRIEND, "Could you quote for my bathroom floor?", "Fran");
  await drain();
  assert.equal((await stored(FRIEND)).length, 1);
  await setPeople("new_and_customers");
});

test("a personal message from a new number is read, set aside, and not answered", async () => {
  const MATE = "+447700900900";
  await say(MATE, "Fancy a pint tonight?", "Mate");
  await drain();
  assert.equal((await draftsFor(MATE)).length, 0);
  const run = await withTenant(A, (db) => one(db, "select r.outcome from runs r join messages m on m.id = r.message_id join conversations c on c.id = m.conversation_id join contact_identities i on i.contact_id = c.contact_id where i.value = $1", [MATE]));
  assert.equal(run?.outcome, "ignored");
});

test("owner answers a customer themselves in the app: our draft is dropped and its held times freed", async () => {
  const [d] = await draftsFor(NEWBIE);
  const held = await withTenant(A, (db) => many(db, "select h.id from holds h join drafts d on d.conversation_id = h.conversation_id where d.id = $1 and h.status = 'held'", [d.id]));
  assert.ok(held.length > 0, "times were pencilled in");

  await postWhatsApp(ownerSends(NEWBIE, "Hi Nia, I can pop round Thursday at 4?"));
  const after = await withTenant(A, (db) => one(db, "select status from drafts where id = $1", [d.id]));
  assert.equal(after?.status, "superseded");
  const stillHeld = await withTenant(A, (db) => many(db, `select id from holds where id = any($1) and status = 'held'`, [held.map((h) => h.id)]));
  assert.equal(stillHeld.length, 0, "held times released");
  const out = await withTenant(A, (db) => many(db, "select m.body, m.from_name from messages m join drafts d on d.conversation_id = m.conversation_id where d.id = $1 and m.direction = 'out'", [d.id]));
  assert.deepEqual(out, [{ body: "Hi Nia, I can pop round Thursday at 4?", from_name: "owner" }]);
  await drain();
  assert.equal(wa.sent.filter((m) => m.to === NEWBIE).length, 0, "the customer only got the owner's own message");

  const items = await withTenant(A, (db) => feed(db, "Europe/London"));
  assert.ok(items.some((i) => i.text === "You answered Nia yourself in WhatsApp." && /dropped/.test(i.why ?? "")));
  const pencilled = items.filter((i) => i.text.startsWith("Pencilled in") && i.text.endsWith("for Nia."));
  assert.ok(pencilled.length > 0 && pencilled.every((i) => i.why === "Freed again: it's no longer needed."), "old lines say the times were freed");
  assert.ok(!items.some((i) => /from Mate\b/.test(i.text)), "a personal chat isn't named in Activity");
  assert.ok(items.some((i) => i.text.startsWith("A message was set aside")));
});

test("owner messaging a friend from the app is not recorded", async () => {
  const before = await withTenant(A, (db) => one<{ n: number }>(db, "select count(*)::int as n from messages"));
  await postWhatsApp(ownerSends("+447700900111", "See you at 8!"));
  const after = await withTenant(A, (db) => one<{ n: number }>(db, "select count(*)::int as n from messages"));
  assert.equal(after!.n, before!.n);
});

test("ignore this person: what's waiting is dropped, their text forgotten, and new messages aren't kept", async () => {
  const LATE = "+447700900950";
  await say(LATE, "Can you quote for carpet in two bedrooms?", "Lee");
  await drain();
  const [d] = await draftsFor(LATE);
  const conv = await withTenant(A, (db) => one<{ conversation_id: string }>(db, "select conversation_id from drafts where id = $1", [d.id]));
  assert.ok(await ignorePerson(A, conv!.conversation_id, "member:test"));

  assert.equal((await draftsFor(LATE))[0].status, "superseded");
  assert.deepEqual((await stored(LATE)).map((m) => m.body), [null], "their text is deleted");
  await say(LATE, "Hello?", "Lee");
  await drain();
  assert.equal((await stored(LATE)).length, 1, "new message not kept");
  assert.equal(await ignorePerson(B, conv!.conversation_id, "member:x"), false, "another business can't ignore them");

  assert.ok(await stopIgnoring(A, conv!.conversation_id, "member:test"));
  await say(LATE, "Hello again", "Lee");
  await drain();
  assert.equal((await stored(LATE)).length, 2);
});

async function setPeople(people: string) {
  await withTenant(A, (db) => db.query("update tenants set settings = settings || $1::jsonb where id = app_current_tenant()", [{ whatsappPeople: people }]));
}
