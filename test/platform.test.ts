// End-to-end tests against a real Postgres database, with Google and WhatsApp replaced by recording fakes
// and agents in mock mode. Set TEST_DATABASE_URL to a throwaway database: it is wiped at the start.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

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

const { getPool, closePool, withTenant, withAdmin, one, many } = await import("../src/db.js");
const { migrate } = await import("../src/cli/migrate.js");
const { syncAgents } = await import("../src/cli/agents-sync.js");
const { clients } = await import("../src/integrations/index.js");
const { createTenant, connectWhatsApp, addWebhook, setTenantStatus } = await import("../src/onboarding.js");
const { app } = await import("../src/app.js");
const { googleConnectLink } = await import("../src/connections.js");
const { taskList } = await import("../src/jobs/tasks.js");
const { releaseQueue } = await import("../src/jobs/queue.js");
const { erasePerson } = await import("../src/data-rights.js");
const { formatLocal } = await import("../src/time.js");
const { runOnce, Logger } = await import("graphile-worker");
const { fakeGoogle, fakeWhatsApp, waWebhook, gmailMsg } = await import("./fakes.js");

const google = fakeGoogle();
const wa = fakeWhatsApp();
clients.google = google.client;
clients.whatsapp = wa.client;

const OWNER = "+447700900001";
const CUSTOMER = "+447700900555";
const jobErrors: string[] = [];
const logger = new Logger(() => (level, message) => { if (level === "error") jobErrors.push(message); });

/** Run queued jobs until there are none left. */
async function drain() {
  for (let i = 0; i < 6; i++) await runOnce({ pgPool: getPool(), taskList, logger });
  assert.deepEqual(jobErrors, [], "jobs should not fail");
}
async function postWhatsApp(body: unknown, secret = process.env.WA_APP_SECRET!) {
  const raw = JSON.stringify(body);
  const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  return app.request("/webhooks/whatsapp", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-hub-signature-256": sig } });
}
const pressButton = (id: string, viaTemplate = false) => postWhatsApp(waWebhook("PLATFORM", OWNER,
  viaTemplate ? { type: "button", button: { payload: id, text: "Approve" } } : { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "x" } } }, "Mark"));
const lastButtons = () => [...wa.sent].reverse().find((s) => s.to === OWNER && s.buttons)!;

let A: string; // the floor layer
let B: string; // another business, to prove isolation

before(async () => {
  const pool = getPool();
  await pool.query("drop schema if exists graphile_worker cascade; drop schema if exists public cascade; create schema public;");
  await migrate(() => {});
  await syncAgents(() => {});

  A = (await createTenant({ slug: "marks-flooring", name: "Mark's Flooring", pack: "flooring", owner: { name: "Mark", whatsapp: "07700 900001" }, settings: { signOff: "Mark" } })).id;
  B = (await createTenant({ slug: "other-biz", name: "Other Business", pack: "trades", owner: { name: "Olu", whatsapp: "07700 900002" } })).id;
  await connectWhatsApp(A, "TENANT_WA", "tenant-wa-token");
  await setTenantStatus(A, "active");
  await setTenantStatus(B, "active");
});

after(async () => { await releaseQueue(); await closePool(); });

test("owner connects Google through the signed link", async () => {
  const link = googleConnectLink(A);
  const start = await app.request(link.replace("https://platform.example", ""));
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const cb = await app.request(`/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(cb.status, 200);
  const conns = await withTenant(A, (db) => many(db, "select kind, external_id, secret_ciphertext from channel_connections order by kind"));
  assert.deepEqual(conns.map((c) => c.kind), ["gmail", "google_calendar", "whatsapp"]);
  assert.ok(conns.every((c) => !String(c.secret_ciphertext).includes("refresh-1")), "tokens are stored encrypted");

  const forged = await app.request(`/oauth/google/callback?code=abc&state=${encodeURIComponent(state.slice(0, -2) + "xx")}`);
  assert.equal(forged.status, 400);
});

test("rejects WhatsApp webhooks with a bad signature", async () => {
  const res = await postWhatsApp(waWebhook("TENANT_WA", CUSTOMER, { type: "text", text: { body: "hi" } }), "wrong-secret");
  assert.equal(res.status, 401);
});

test("WhatsApp enquiry -> held times in the diary -> approval by template -> owner approves -> customer gets reply", async () => {
  const res = await postWhatsApp(waWebhook("TENANT_WA", CUSTOMER, { type: "text", text: { body: "Hi, could you quote for laminate in our lounge, about 4m x 5m?" } }, "Jo Smith"));
  assert.equal(res.status, 200);
  await drain();

  const holds = await withTenant(A, (db) => many(db, "select * from holds where status = 'held' order by start_at"));
  assert.equal(holds.length, 3, "three measure-up times held");
  assert.equal(google.liveEvents().filter(([, e]) => e.status === "tentative").length, 3, "held as tentative events in Google Calendar");
  assert.equal(new Set(holds.map((h) => h.start_at.toISOString().slice(0, 10))).size, 3, "spread over three days");

  const approval = lastButtons();
  assert.equal(approval.kind, "template", "owner hasn't messaged yet, so a template is used");
  assert.match(approval.text, /Jo/);

  await pressButton(approval.buttons![0], true);
  await drain();
  const toCustomer = wa.last(CUSTOMER)!;
  assert.equal(toCustomer.from, "TENANT_WA", "sent from the business's own number");
  assert.match(toCustomer.text, /measure up/);
  const draft = await withTenant(A, (db) => one(db, "select status from drafts order by created_at desc limit 1"));
  assert.equal(draft.status, "sent");
});

test("customer picks a time -> booking confirmed, other holds released -> approval now uses buttons", async () => {
  const offered = await withTenant(A, (db) => many(db, "select id, start_at from holds where status = 'held' order by start_at"));
  const pick = offered[1];
  const weekday = formatLocal(new Date(pick.start_at).toLocaleString("sv-SE", { timeZone: "Europe/London" }).replace(" ", "T").slice(0, 16)).split(" ")[0];
  await postWhatsApp(waWebhook("TENANT_WA", CUSTOMER, { type: "text", text: { body: `${weekday} works for me, thanks` } }, "Jo Smith"));
  await drain();

  const holds = await withTenant(A, (db) => many(db, "select id, status from holds order by start_at"));
  assert.equal(holds.find((h) => h.id === pick.id).status, "confirmed");
  assert.equal(holds.filter((h) => h.status === "released").length, 2);
  const live = google.liveEvents();
  assert.equal(live.length, 1, "only the booked event remains in the diary");
  assert.equal(live[0][1].status, "confirmed");

  const approval = lastButtons();
  assert.equal(approval.kind, "buttons", "owner messaged within 24h, so interactive buttons");
  assert.match(approval.text, /booked in/);
  await pressButton(approval.buttons![0]);
  await drain();
  assert.match(wa.last(CUSTOMER)!.text, /booked in/);
});

test("Checkatrade lead by email -> reply route is Checkatrade -> owner gets wording to paste", async () => {
  google.addEmail(gmailMsg({
    id: "ct1", from: "Checkatrade <noreply@checkatrade.com>", to: "owner@business.example", subject: "New lead: Flooring in BS16",
    html: `<table><tr><td><b>Job</b></td><td>LVT kitchen</td></tr><tr><td><b>Description</b></td><td>Click LVT in kitchen diner, about 25m2.</td></tr><tr><td><b>Customer</b></td><td>Chloe Bennett</td></tr><tr><td><b>Phone</b></td><td>07700 900801</td></tr></table>`,
  }));
  await taskList.poll_gmail!({}, {} as any);
  await drain();

  const msg = await withTenant(A, (db) => one(db, "select channel, body, from_name from messages where channel_message_id = 'ct1'"));
  assert.equal(msg.channel, "checkatrade");
  assert.equal(msg.from_name, "Chloe Bennett");
  const draft = await withTenant(A, (db) => one(db, "select id, reply_route from drafts order by created_at desc limit 1"));
  assert.equal(draft.reply_route, "checkatrade_message");

  await pressButton(lastButtons().buttons![0]);
  await drain();
  assert.match(wa.last(OWNER)!.text, /^Paste this into Checkatrade/);
  assert.equal((await withTenant(A, (db) => one(db, "select status from drafts where id = $1", [draft.id]))).status, "manual");
});

test("owner edits a draft: their wording is what gets sent", async () => {
  await postWhatsApp(waWebhook("TENANT_WA", "+447700900666", { type: "text", text: { body: "Do you fit carpet on stairs?" } }, "Sam"));
  await drain();
  await pressButton(lastButtons().buttons![1]);           // Edit
  await drain();
  assert.match(wa.last(OWNER)!.text, /exactly as you want/);
  await postWhatsApp(waWebhook("PLATFORM", OWNER, { type: "text", text: { body: "Yes we do! When are you free for me to pop round? Mark" } }, "Mark"));
  await drain();
  assert.equal(wa.last("+447700900666")!.text, "Yes we do! When are you free for me to pop round? Mark");
});

test("complaint is flagged to the owner; rejecting it sends nothing", async () => {
  google.addEmail(gmailMsg({ id: "c1", from: "Lisa Morgan <lisa@example.com>", to: "owner@business.example", subject: "Gaps", text: "The laminate you fitted has gaps opening by the patio doors. Not happy." }));
  await taskList.poll_gmail!({}, {} as any);
  await drain();
  const approval = lastButtons();
  assert.match(approval.text, /⚠️/);
  const sentBefore = google.sent.length;
  await pressButton(approval.buttons![2]);                 // Reject
  await drain();
  assert.match(wa.last(OWNER)!.text, /Rejected/);
  assert.equal(google.sent.length, sentBefore, "no email sent");
});

test("pressing a button twice doesn't send twice", async () => {
  const d = await withTenant(A, (db) => one(db, "select id from drafts where status = 'sent' limit 1"));
  const before = wa.sent.length;
  await pressButton(`a:${d.id}`);
  await drain();
  assert.match(wa.last(OWNER)!.text, /Already sent/);
  assert.equal(wa.sent.filter((s) => s.to !== OWNER).length, wa.sent.slice(0, before).filter((s) => s.to !== OWNER).length);
});

test("website form webhook lands as a message for the right business", async () => {
  const url = await addWebhook(A, "web_form");
  const res = await app.request(url.replace("https://platform.example", ""), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ submissionId: "f1", fields: { Name: "Tom", Email: "tom@example.com", Phone: "07700 900777", Message: "Need a quote for oak flooring" } }) });
  assert.equal(res.status, 200);
  const m = await withTenant(A, (db) => one(db, "select channel, body from messages where channel_message_id = 'f1'"));
  assert.equal(m.channel, "web_form");
  assert.equal((await app.request("/webhooks/forms/not-a-token", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status, 404);
  await drain();
});

test("row-level security keeps businesses apart", async () => {
  const aCount = await withTenant(A, (db) => one(db, "select count(*)::int as n from contacts"));
  const bCount = await withTenant(B, (db) => one(db, "select count(*)::int as n from contacts"));
  assert.ok(aCount.n > 0);
  assert.equal(bCount.n, 0, "business B sees none of A's contacts");
  const someone = await withTenant(A, (db) => one(db, "select id from contacts limit 1"));
  assert.equal((await withTenant(B, (db) => one(db, "select id from contacts where id = $1", [someone.id]))), undefined);
  await assert.rejects(withTenant(B, (db) => db.query("insert into contacts (tenant_id, name) values ($1, 'x')", [A])), /row-level security/);
  const bDrafts = await withTenant(B, (db) => one(db, "select count(*)::int as n from drafts"));
  assert.equal(bDrafts.n, 0);
});

test("audit log can't be edited", async () => {
  await assert.rejects(withAdmin((db) => db.query("update audit_log set action = 'x'")), /append-only/);
  await assert.rejects(withAdmin((db) => db.query("delete from audit_log")), /append-only/);
});

test("erasing a person removes their details and cancels their booking", async () => {
  assert.equal(await erasePerson(A, { phone: CUSTOMER }, "admin:test"), true);
  const left = await withTenant(A, (db) => one(db,
    "select count(*)::int as n from messages m join conversations c on c.id = m.conversation_id where c.contact_id = (select id from contacts where erased_at is not null limit 1) and m.body is not null"));
  assert.equal(left.n, 0);
  assert.equal((await withTenant(A, (db) => one(db, "select count(*)::int as n from contact_identities where value = $1", [CUSTOMER]))).n, 0);
  assert.equal(google.liveEvents().filter(([, e]) => e.status === "confirmed").length, 0, "booking removed from the diary");
  const logged = await withTenant(A, (db) => one(db, "select count(*)::int as n from audit_log where action = 'data.erased'"));
  assert.equal(logged.n, 1);
});

test("messages for a paused business are kept but not acted on", async () => {
  await setTenantStatus(B, "paused");
  const before = wa.sent.length;
  const url = await addWebhook(B, "web_form");
  await app.request(url.replace("https://platform.example", ""), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ submissionId: "pb1", fields: { Name: "Ann", Email: "ann@example.com", Message: "Boiler service please" } }) });
  await drain();
  const run = await withTenant(B, (db) => one(db, "select outcome from runs order by created_at desc limit 1"));
  assert.equal(run.outcome, "skipped");
  assert.equal(wa.sent.length, before);
});
