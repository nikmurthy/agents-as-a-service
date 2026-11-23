// "Learn, then offer to automate". The owner approves every reply at first. Once they've approved the last N replies
// of one kind without changing them, we offer to send that kind automatically. Nothing switches on without a yes.
// Even then: every Nth one (Settings → spot check) still comes to the owner, and changing or rejecting one of those
// goes back to asking. Complaints, emergencies, health questions, flagged drafts, Checkatrade leads and anything
// we can't send ourselves (text, phone, Checkatrade) are never automated: they have no category or the wrong route.
import type { Db } from "./db.js";
import { many, one, withTenant } from "./db.js";
import { audit } from "./audit.js";
import { enqueue } from "./jobs/queue.js";
import { approvers } from "./tenants.js";
import { clients } from "./integrations/index.js";
import { platformWaSender } from "./connections.js";
import type { BookingResult, Tenant, TriageResult } from "./types.js";

export const CATEGORIES = {
  answer_question: { label: "Answering questions", example: "Replies to questions and quote requests that don't need a visit" },
  offer_times: { label: "Offering times", example: "Replies offering free times from your calendar" },
  confirm_booking: { label: "Confirming bookings", example: "Replies confirming the time the customer picked" },
  quote_followup: { label: "Quote follow-ups", example: "The one nudge after a quote goes quiet" },
  feedback_request: { label: "Feedback requests", example: "Asking the customer how it went, once the job is done" },
} as const;
export type Category = keyof typeof CATEGORIES;

export const DEFAULT_LEARN_AFTER = 5;
const AUTO_ROUTES = new Set(["email", "whatsapp"]);
const NEVER_INTENTS = new Set(["complaint", "emergency", "clinical_question", "spam", "other"]);

/** The kind of reply a draft is. Undefined means it is never automated. */
export function categorise(t: TriageResult, booking: Pick<BookingResult, "action"> | undefined, escalated: boolean): Category | undefined {
  if (escalated || t.needsHuman || NEVER_INTENTS.has(t.intent) || t.nextStep === "escalate") return undefined;
  if (booking?.action === "confirm_slot") return "confirm_booking";
  if (booking?.action === "propose_slots") return "offer_times";
  if (booking?.action === "move_appointment" || t.nextStep === "reschedule") return undefined; // moving a booking: always ask
  return "answer_question";
}

/** After how many unchanged approvals in a row to offer automation. 0 = always ask, never offer. */
export async function learnAfter(db: Db): Promise<number> {
  const r = await one<{ config: { learnAfter?: number } }>(db, "select config from tenant_use_cases where use_case = 'answer_enquiries'");
  const n = r?.config?.learnAfter;
  return typeof n === "number" && n >= 0 && n <= 50 ? n : DEFAULT_LEARN_AFTER;
}

/** How many of the most recent decisions on this kind of reply were approvals with no changes, in a row. */
export async function unchangedStreak(db: Db, category: string, upTo = 50): Promise<number> {
  const rows = await many<{ ok: boolean }>(db,
    `select (status not in ('rejected', 'expired') and body = original_body) as ok from drafts
     where category = $1 and decided_at is not null and not auto_sent order by decided_at desc limit $2`, [category, upTo]);
  const firstBad = rows.findIndex((r) => !r.ok);
  return firstBad < 0 ? rows.length : firstBad;
}

export const automationState = (db: Db, category: string) =>
  one<{ state: "offered" | "on" | "declined"; updated_at: Date }>(db, "select state, updated_at from automations where category = $1", [category]);

export type NextStep = { job: "send_approval" | "send_outbox"; tenantId: string; draftId: string };

/**
 * A new draft is ready. Send it automatically if this kind is automated (and it isn't a spot check),
 * otherwise ask the owner as usual. Call inside the tenant transaction that created the draft, then pass the
 * result to queueNext() once that transaction has committed (the queue uses its own connection).
 */
export async function approveOrAsk(db: Db, tenant: Tenant, draftId: string): Promise<NextStep> {
  const ask: NextStep = { job: "send_approval", tenantId: tenant.id, draftId };
  const d = await one<{ category: string | null; reply_route: string; needs_attention: boolean }>(db,
    "select category, reply_route, needs_attention from drafts where id = $1", [draftId]);
  if (!d?.category || d.needs_attention || !AUTO_ROUTES.has(d.reply_route)) return ask;
  const a = await automationState(db, d.category);
  if (a?.state !== "on" || (await learnAfter(db)) === 0) return ask;
  // Spot check: every Nth one of this kind since it was switched on still comes to the owner. 1 = always ask.
  const every = Math.max(1, Number(tenant.settings.spotCheckEvery) || 1);
  const since = await one<{ n: number }>(db, "select count(*)::int as n from drafts where category = $1 and created_at >= $2", [d.category, a.updated_at]);
  if (every === 1 || since!.n % every === 0) {
    await db.query("update drafts set attention_reason = 'Spot check: replies like this usually send automatically.' where id = $1 and attention_reason is null", [draftId]);
    return ask;
  }
  await db.query("update drafts set status = 'approved', auto_sent = true, decided_at = now() where id = $1", [draftId]);
  await audit(db, { tenantId: tenant.id, actor: "system", action: "draft.auto_approved", entity: "draft", entityId: draftId, detail: { category: d.category } });
  return { job: "send_outbox", tenantId: tenant.id, draftId };
}

export async function queueNext(n: NextStep | undefined) {
  if (!n) return;
  const key = n.job === "send_approval" ? `approval:${n.draftId}` : `outbox:${n.draftId}`;
  await enqueue(n.job, { tenantId: n.tenantId, draftId: n.draftId }, { jobKey: key, maxAttempts: n.job === "send_approval" ? 8 : 5 });
}

/**
 * A person just decided on a draft. If it was a spot check they changed, go back to asking.
 * If it completes a run of unchanged approvals, offer to automate. Returns a message for the owner, if any.
 */
export async function afterDecision(tenantId: string, draftId: string, memberId: string | null): Promise<{ text: string; offer?: Category } | undefined> {
  return withTenant(tenantId, async (db) => {
    const d = await one<{ category: Category | null; changed: boolean; reply_route: string }>(db,
      "select category, (status in ('rejected', 'expired') or body <> original_body) as changed, reply_route from drafts where id = $1", [draftId]);
    if (!d?.category || !(d.category in CATEGORIES)) return undefined;
    const label = CATEGORIES[d.category].label.toLowerCase();
    const a = await automationState(db, d.category);
    if (a?.state === "on") {
      if (!d.changed) return undefined;
      await setState(db, tenantId, d.category, "declined", memberId, "automation.paused");
      return { text: `You changed that one, so I'll go back to asking you about ${label}. Switch it back on any time in Flows.` };
    }
    if (d.changed || a) return undefined; // already offered (or declined): don't keep asking
    if (!AUTO_ROUTES.has(d.reply_route)) return undefined;
    const n = await learnAfter(db);
    if (n === 0 || (await unchangedStreak(db, d.category, n)) < n) return undefined;
    await setState(db, tenantId, d.category, "offered", null, "automation.offered");
    const t = await one<{ n: number }>(db, "select coalesce((settings->>'spotCheckEvery')::int, 3) as n from tenants where id = app_current_tenant()");
    const every = t?.n ?? 3;
    const spot = every <= 1 ? "every one" : every === 2 ? "every other one" : `every ${ordinal(every)} one`;
    return { offer: d.category, text: `You've approved the last ${n} ${label} replies without changing them. Want me to send replies like these automatically from now on?\n\nI'll tell you each time one goes, ${spot} will still come to you to check, and complaints, emergencies and anything unusual always come to you.` };
  });
}

export async function setState(db: Db, tenantId: string, category: string, state: "offered" | "on" | "declined", memberId: string | null, action: string) {
  await db.query(
    `insert into automations (tenant_id, category, state, decided_by, updated_at) values (app_current_tenant(), $1, $2, $3, now())
     on conflict (tenant_id, category) do update set state = excluded.state, decided_by = excluded.decided_by, updated_at = now()`,
    [category, state, memberId]);
  await audit(db, { tenantId, actor: memberId ? `member:${memberId}` : "system", action, entity: "automation", entityId: category, detail: { state } });
}

/** Sends the offer with Yes / Keep asking buttons. Only when the person's WhatsApp window is open (they just pressed a button). */
export async function sendOffer(tenantId: string, category: string, to: string, text: string) {
  await clients.whatsapp.sendButtons(platformWaSender()!, to, text, [
    { id: `au:y:${tenantId}:${category}`, title: "Yes, automate" },
    { id: `au:n:${tenantId}:${category}`, title: "Keep asking me" },
  ]);
}
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** Owner's answer to an offer, from WhatsApp or the web app. */
export async function answerOffer(tenantId: string, category: string, yes: boolean, memberId: string | null, actorAudit: string) {
  if (!(category in CATEGORIES)) return "Sorry, I didn't recognise that.";
  await withTenant(tenantId, async (db) => {
    await db.query(
      `insert into automations (tenant_id, category, state, decided_by, updated_at) values (app_current_tenant(), $1, $2, $3, now())
       on conflict (tenant_id, category) do update set state = excluded.state, decided_by = excluded.decided_by, updated_at = now()`,
      [category, yes ? "on" : "declined", memberId]);
    await audit(db, { tenantId, actor: actorAudit, action: yes ? "automation.on" : "automation.declined", entity: "automation", entityId: category });
  });
  const label = CATEGORIES[category as Category].label.toLowerCase();
  return yes
    ? `Done ✓ ${CATEGORIES[category as Category].label} will now send automatically. I'll tell you each time. Switch it off any time in Flows.`
    : `OK, I'll keep asking you about ${label}. You can switch it on later in Flows.`;
}

/** Tell the owners what went automatically, so nothing is sent unseen. */
export async function notifyAutoSent(db: Db, customer: string, route: string, category: string | null, body: string) {
  const label = category && category in CATEGORIES ? CATEGORIES[category as Category].label.toLowerCase() : "reply";
  const first = (customer || "the customer").split(/\s+/)[0];
  for (const p of await approvers(db)) {
    await clients.whatsapp.sendText(platformWaSender()!, p.whatsapp_phone, `Sent to ${first} automatically by ${route} (${label}):\n\n${body}`);
  }
}
