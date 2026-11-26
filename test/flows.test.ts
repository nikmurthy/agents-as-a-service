// Flows: the owner arranges times themselves, "learn then offer to automate", spot checks, and asking for feedback.
// Needs a throwaway Postgres in TEST_DATABASE_URL: it is wiped at the start.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://platform_dev:platform_dev@localhost:5432/platform_test";
process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.SIGNING_SECRET = "test-signing-secret";
process.env.AGENT_MODE = "mock";
process.env.WA_APP_SECRET = "test-app-secret";
process.env.WA_VERIFY_TOKEN = "verify-me";
process.env.GOOGLE_CLIENT_ID = "gid";
process.env.GOOGLE_CLIENT_SECRET = "gsecret";
process.env.PUBLIC_BASE_URL = "https://platform.example";

const { getPool, closePool, withTenant, one, many } = await import("../src/db.js");
const { migrate } = await import("../src/cli/migrate.js");
const { syncAgents } = await import("../src/cli/agents-sync.js");
const { clients } = await import("../src/integrations/index.js");
const { createTenant, connectWhatsApp, setTenantStatus } = await import("../src/onboarding.js");
const { app } = await import("../src/app.js");
const { taskList } = await import("../src/jobs/tasks.js");
const { releaseQueue } = await import("../src/jobs/queue.js");
const { askFeedback } = await import("../src/workflows/ask-feedback.js");
const { withBookingLink } = await import("../src/workflows/answer-enquiry.js");
const { approveDraft, editAndApproveDraft } = await import("../src/decisions.js");
const { answerOffer } = await import("../src/automation.js");
const { runOnce, Logger } = await import("graphile-worker");
const { fakeGoogle, fakeWhatsApp, waWebhook } = await import("./fakes.js");

const google = fakeGoogle();
const wa = fakeWhatsApp();
clients.google = google.client;
clients.whatsapp = wa.client;

const OWNER = "+447700900001";
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
// The owner decides in the Inbox; nothing is sent to them on WhatsApp.
let ownerId: string;
const owner = () => ({ memberId: ownerId, audit: `member:${ownerId}` });
const waiting = () => withTenant(A, (db) => one<any>(db, "select * from drafts where status = 'pending_approval' order by created_at desc limit 1"));
const pendingCount = () => withTenant(A, (db) => one<{ n: number }>(db, "select count(*)::int as n from drafts where status = 'pending_approval'")).then((r) => r!.n);
let n = 0;
async function enquiry(text = "Hi, could you quote for laminate in our lounge?") {
  const phone = `+4477009007${String(++n).padStart(2, "0")}`;
  await postWhatsApp(waWebhook("TENANT_WA", phone, { type: "text", text: { body: text } }, `Customer${n} Smith`));
  await drain();
  return phone;
}

let A: string;
let B: string;

before(async () => {
  const pool = getPool();
  await pool.query("drop schema if exists graphile_worker cascade; drop schema if exists public cascade; create schema public;");
  await migrate(() => {});
  await syncAgents(() => {});
  // No calendar connected: the owner arranges times themselves.
  A = (await createTenant({ slug: "marks-flooring", name: "Mark's Flooring", pack: "flooring", owner: { name: "Mark", whatsapp: "07700 900001" }, settings: { signOff: "Mark" } })).id;
  B = (await createTenant({ slug: "other-biz", name: "Other Business", pack: "trades", owner: { name: "Olu", whatsapp: "07700 900002" } })).id;
  await connectWhatsApp(A, "TENANT_WA", "tenant-wa-token");
  await setTenantStatus(A, "active");
  await setTenantStatus(B, "active");
  await withTenant(A, (db) => db.query("update tenant_use_cases set config = '{\"learnAfter\": 2}' where use_case = 'answer_enquiries'"));
  ownerId = (await withTenant(A, (db) => one<{ id: string }>(db, "select id from tenant_members where role = 'owner'")))!.id;
});

after(async () => { await releaseQueue(); await closePool(); });

test("no calendar: the reply says the owner will arrange a time, and offers none", async () => {
  const phone = await enquiry();
  const d = await waiting();
  assert.match(d.body, /be in touch shortly to arrange a time/);
  assert.equal(await withTenant(A, (db) => one(db, "select count(*)::int as n from holds")).then((r) => r.n), 0);
  await approveDraft(A, owner(), d.id);
  await drain();
  assert.match(wa.last(phone)!.text, /arrange a time/);
});

test("after the set number of unchanged approvals, the owner is offered automation; yes turns it on", async () => {
  await enquiry();
  const r = await approveDraft(A, owner(), (await waiting()).id);
  await drain();
  const offer = r.ok ? r.automation : undefined;
  assert.equal(offer?.offer, "answer_question", "offered after 2 unchanged approvals in a row");
  assert.match(offer!.text, /last 2 answering questions replies/);

  assert.match(await answerOffer(A, "answer_question", true, ownerId, `member:${ownerId}`), /will now send automatically/);
  const a = await withTenant(A, (db) => one(db, "select state, decided_by from automations where category = 'answer_question'"));
  assert.equal(a.state, "on");
  assert.ok(a.decided_by, "who said yes is recorded");
});

test("automated replies go without asking and show as sent automatically; every 3rd is a spot check", async () => {
  const p1 = await enquiry();
  assert.match(wa.last(p1)!.text, /arrange a time/, "sent to the customer without approval");
  assert.equal(await pendingCount(), 0, "nothing waiting for the owner");
  const d = await withTenant(A, (db) => one(db, "select status, auto_sent, decided_by from drafts order by created_at desc limit 1"));
  assert.deepEqual([d.status, d.auto_sent, d.decided_by], ["sent", true, null]);

  await enquiry();                                      // 2nd: automatic
  const p3 = await enquiry();                           // 3rd: spot check (Settings: spot check every 3)
  const check = await waiting();
  assert.ok(check, "spot check waits for the owner");
  assert.match(check.attention_reason, /Spot check/);
  assert.notEqual(wa.last(p3)?.text?.includes("arrange"), true, "nothing sent yet");

  // The owner changes the spot-checked reply: back to asking.
  const r = await editAndApproveDraft(A, owner(), check.id, "Hi! Mark here, I'll ring you tomorrow to sort a time.");
  await drain();
  assert.equal(wa.last(p3)!.text, "Hi! Mark here, I'll ring you tomorrow to sort a time.");
  assert.match(r.ok ? r.automation?.text ?? "" : "", /go back to asking you about answering questions/);
  assert.equal((await withTenant(A, (db) => one(db, "select state from automations where category = 'answer_question'"))).state, "declined");

  await enquiry();
  assert.equal(await pendingCount(), 1, "asks again");
  const again = await approveDraft(A, owner(), (await waiting()).id);
  assert.equal(again.ok && again.automation, undefined, "declined: not offered again on its own");
  await drain();
  assert.deepEqual(wa.sent.filter((s) => s.to === OWNER), [], "the owner is never messaged on WhatsApp");
});

test("complaints are never automated, even with automation on", async () => {
  await withTenant(A, (db) => db.query("update automations set state = 'on', updated_at = now() - interval '1 hour' where category = 'answer_question'"));
  const phone = await enquiry("I'm not happy, there are gaps opening in the floor you fitted");
  assert.equal(await pendingCount(), 1, "waits for the owner");
  assert.equal(wa.last(phone), undefined, "nothing went to the customer");
  const d = await withTenant(A, (db) => one(db, "select category, auto_sent from drafts order by created_at desc limit 1"));
  assert.deepEqual([d.category, d.auto_sent], [null, false]);
});

test("feedback: asked once the booked job has ended, once, with the review link; not before", async () => {
  await withTenant(A, async (db) => {
    await db.query("insert into tenant_use_cases (tenant_id, use_case, enabled, config) values (app_current_tenant(), 'ask_feedback', true, $1) on conflict (tenant_id, use_case) do update set enabled = true, config = excluded.config",
      [{ afterDays: 1, reviewLink: "https://g.page/r/marks-flooring/review" }]);
    const convs = await many(db, "select id, contact_id from conversations order by created_at limit 2");
    // Job 1 ended two days ago; job 2 is tomorrow.
    await db.query("insert into holds (tenant_id, conversation_id, contact_id, start_at, end_at, status) values (app_current_tenant(), $1, $2, now() - interval '2 days 2 hours', now() - interval '2 days', 'confirmed')", [convs[0].id, convs[0].contact_id]);
    await db.query("insert into holds (tenant_id, conversation_id, contact_id, start_at, end_at, status) values (app_current_tenant(), $1, $2, now() + interval '1 day', now() + interval '1 day 2 hours', 'confirmed')", [convs[1].id, convs[1].contact_id]);
  });
  assert.equal(await askFeedback(A), 1, "only the finished job");
  await drain();
  const ask = await withTenant(A, (db) => one<any>(db, "select * from drafts where kind = 'feedback' and status = 'pending_approval'"));
  assert.match(ask.body, /https:\/\/g\.page\/r\/marks-flooring\/review/);
  assert.equal(await askFeedback(A), 0, "asked once only");
});

test("feedback: a job the owner marked as done is asked about the next day", async () => {
  const conv = await withTenant(A, (db) => one(db, `select c.id from conversations c where c.feedback_asked_at is null
     and not exists (select 1 from drafts d where d.conversation_id = c.id and d.status = 'pending_approval') order by c.created_at desc limit 1`));
  await withTenant(A, (db) => db.query("update conversations set completed_at = now() - interval '25 hours' where id = $1", [conv.id]));
  assert.equal(await askFeedback(A), 1);
  const d = await withTenant(A, (db) => one(db, "select kind, category, status from drafts where conversation_id = $1 order by created_at desc limit 1", [conv.id]));
  assert.deepEqual([d.kind, d.category, d.status], ["feedback", "feedback_request", "pending_approval"]);
});

test("booking link (e.g. Halaxy): replies to someone who wants an appointment always include it", async () => {
  await withTenant(A, async (db) => {
    await db.query("delete from automations");
    await db.query("update tenant_use_cases set enabled = false, config = $1 where use_case = 'book_appointments'",
      [{ mode: "link", system: "halaxy", link: "https://www.halaxy.com/book/marks-flooring/12345" }]);
  });
  await enquiry("Can I book a measure-up for new carpet?");
  const d = await withTenant(A, (db) => one(db, "select body from drafts order by created_at desc limit 1"));
  assert.match(d.body, /You can book a time that suits you here: https:\/\/www\.halaxy\.com\/book\/marks-flooring\/12345\n\nMark$|https:\/\/www\.halaxy\.com\/book\/marks-flooring\/12345$/, "the code adds the link the agent left out");
  const run = await withTenant(A, (db) => one(db, "select count(*)::int as n from run_events where step = 'guard' and detail like 'added the booking link%'"));
  assert.equal(run.n, 1);
  assert.equal((await withTenant(A, (db) => one(db, "select count(*)::int as n from holds where status = 'held'"))).n, 0, "no times held");
});

test("withBookingLink puts the link before a short sign-off", () => {
  assert.equal(withBookingLink("Hi Jo, thanks.\n\nMark", "https://x.example/b"), "Hi Jo, thanks.\n\nYou can book a time that suits you here: https://x.example/b\n\nMark");
  assert.equal(withBookingLink("Hi Jo, thanks. Mark", "https://x.example/b"), "Hi Jo, thanks. Mark\n\nYou can book a time that suits you here: https://x.example/b");
});

test("reply style reaches the reply writer: greeting, length, examples as style only", async () => {
  const { tenantSummary } = await import("../src/agents/runner.js");
  const tenant = await withTenant(A, (db) => one(db, "select id, slug, name, pack, settings, status from tenants where id = app_current_tenant()"));
  tenant.settings.replyStyle = { greeting: "hello", length: "short", emoji: "never", spelling: "american", avoid: "cheap", examples: ["Hello there, happy to help. Mark"] };
  const text = tenantSummary(tenant, new Date());
  assert.match(text, /Greeting: start with "Hello <first name>,"/);
  assert.match(text, /Reply length: short/);
  assert.match(text, /Emoji: never use emoji/);
  assert.match(text, /Spelling: American English/);
  assert.match(text, /never to use: cheap/);
  assert.match(text, /Never copy facts, prices, names, dates or promises from them:\n<example 1>\nHello there, happy to help. Mark\n<\/example 1>/);
});

test("automations are kept per business", async () => {
  const seenByB = await withTenant(B, (db) => many(db, "select * from automations"));
  assert.equal(seenByB.length, 0);
  await assert.rejects(withTenant(B, (db) => db.query("insert into automations (tenant_id, category, state) values ($1, 'answer_question', 'on')", [A])));
});
