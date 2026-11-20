import type { Db } from "../db.js";
import { one, withTenantSession } from "../db.js";
import type { BookingResult, DraftResult, ReplyRoute, ReviewResult, RunEvent, Tenant, TriageResult } from "../types.js";
import { loadTenant, useCaseEnabled } from "../tenants.js";
import { loadAgents } from "../agents/registry.js";
import { runAgent } from "../agents/runner.js";
import type { ToolContext } from "../agents/tools.js";
import { modelView } from "../privacy.js";
import { calendarConnection, confirmHold, createHold, isFree, openHolds, releaseHold } from "../calendar.js";
import { getConnection } from "../connections.js";
import { audit } from "../audit.js";
import { checkatradeSteps, isNewLead, openLead, recordLead, suggestForLead } from "../leads.js";
import { notifyOwners } from "../outbox.js";
import { approveOrAsk, categorise, queueNext } from "../automation.js";

const ESCALATE_INTENTS = new Set(["emergency", "complaint", "clinical_question"]);

/**
 * Use cases "answer enquiries" + "book appointments", for one inbound message:
 * triage -> (booking) -> draft -> independent review -> approval request to the owner.
 * Agents judge; the fixed rules here decide what is allowed. Nothing reaches a customer without the owner's approval.
 */
export async function answerEnquiry(tenantId: string, messageId: string, now = new Date()): Promise<void> {
  await withTenantSession(tenantId, async (db) => {
    if (!(await useCaseEnabled(db, "answer_enquiries"))) return;
    if (await one(db, "select 1 from runs where message_id = $1 and status = 'done'", [messageId])) return; // already handled

    const tenant = await loadTenant(db, tenantId);
    if (tenant.status !== "active") {
      // Onboarding or paused: keep the message, don't act on it.
      await db.query("insert into runs (tenant_id, message_id, use_case, status, outcome, outcome_reason, finished_at) values (app_current_tenant(), $1, 'answer_enquiries', 'done', 'skipped', $2, now())",
        [messageId, `Business is ${tenant.status}`]);
      return;
    }
    const msg = await one(db,
      `select m.*, c.contact_id, c.id as conv_id, c.whatsapp_window_closes_at, ct.name as contact_name,
              (select value from contact_identities i where i.contact_id = c.contact_id and kind = 'email' limit 1) as email,
              (select value from contact_identities i where i.contact_id = c.contact_id and kind = 'phone' limit 1) as phone,
              exists (select 1 from messages p where p.conversation_id = c.id and p.id <> m.id) as known
       from messages m join conversations c on c.id = m.conversation_id join contacts ct on ct.id = c.contact_id where m.id = $1`, [messageId]);
    if (!msg) return;

    const run = await one<{ id: string }>(db,
      "insert into runs (tenant_id, message_id, use_case) values (app_current_tenant(), $1, 'answer_enquiries') returning id", [messageId]);
    const events: RunEvent[] = [];
    const log = async () => {
      for (const e of events.splice(0)) {
        await db.query(
          "insert into run_events (tenant_id, run_id, step, agent, agent_version, model, input_tokens, output_tokens, ms, detail) values (app_current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9)",
          [run!.id, e.step, e.agent ?? null, e.agentVersion ?? null, e.model ?? null, e.inputTokens ?? null, e.outputTokens ?? null, e.ms ?? null, e.detail ?? null]);
      }
    };
    const finish = async (outcome: string, reason: string, extra: { triage?: TriageResult; booking?: BookingResult & { holdIds?: string[] } } = {}) => {
      await log();
      await db.query("update runs set status = 'done', outcome = $2, outcome_reason = $3, triage = $4, booking = $5, finished_at = now() where id = $1",
        [run!.id, outcome, reason, extra.triage ?? null, extra.booking ?? null]);
      await audit(db, { tenantId, actor: "system", action: `run.${outcome}`, entity: "run", entityId: run!.id });
    };

    try {
      const agents = await loadAgents(db, (tenant.settings as any).agentVersions ?? {});
      const ctx: ToolContext = { db, tenant, conversationId: msg.conv_id, contactId: msg.contact_id, now };
      const view = modelView({ channel: msg.channel, receivedAt: msg.received_at.toISOString(), fromName: msg.from_name ?? msg.contact_name, subject: msg.subject, text: msg.body ?? "", structured: msg.structured, attachments: msg.attachments });
      const offered = (await openHolds(db, msg.conv_id, tenant.settings.timezone)).filter((h) => h.status === "held");

      // 1. Triage
      const triage = await runAgent<TriageResult>(agents.triage, { message: view, knownCustomer: msg.known, offeredTimes: offered, services: tenant.settings.services.map((s) => s.name) }, ctx, events);
      // A new Checkatrade lead: suggest "I'm interested" or "Not for me" (the owner does it in Checkatrade by hand).
      const lead = msg.channel === "checkatrade" && isNewLead(msg.structured) ? suggestForLead(triage) : undefined;
      if (lead) await recordLead(db, { id: messageId, conv_id: msg.conv_id, structured: msg.structured }, lead);
      if (triage.intent === "spam" || triage.nextStep === "ignore") {
        if (lead) {
          const first = (msg.from_name ?? msg.contact_name ?? "a customer").split(/\s+/)[0];
          await notifyOwners(db, `${tenant.name}\n\nCheckatrade lead from ${first} looks like one to turn down: ${lead.reason}.\n\n${checkatradeSteps(await openLead(db, msg.conv_id), "not_for_me", lead.reason)}`);
        }
        return finish("ignored", "Spam or irrelevant.", { triage });
      }
      const mustEscalate = triage.urgency === "emergency" || triage.nextStep === "escalate" || ESCALATE_INTENTS.has(triage.intent);

      // 2. Booking (only with the use case on, a calendar connected, and nothing that needs the owner first)
      let booking: (BookingResult & { holdIds?: string[] }) | undefined;
      const wantsBooking = ["book_visit", "book_consultation", "confirm_booking", "reschedule"].includes(triage.nextStep);
      // Flows → Booking: "offer times" needs the use case on and a calendar; otherwise the owner arranges the time.
      const offersTimes = (await useCaseEnabled(db, "book_appointments")) && !!(await calendarConnection(db));
      if (wantsBooking && !mustEscalate && triage.inServiceArea !== false && offersTimes) {
        booking = await runAgent<BookingResult>(agents.booking, { message: view, triage, offeredTimes: offered }, ctx, events);
        booking = await applyBooking(db, tenant, booking, msg, offered, now, events);
      }

      // 3. Reply route
      // WhatsApp only allows a free-form reply within 24 hours of the customer's last WhatsApp message.
      const whatsappOpen = !!msg.whatsapp_window_closes_at && new Date(msg.whatsapp_window_closes_at) > now;
      const route = await chooseRoute(db, tenant, msg.channel, { email: msg.email, phone: msg.phone }, { whatsappOpen });
      events.push({ step: "reply_route", detail: route });

      // 4. Draft and independent review
      const draft = await runAgent<DraftResult>(agents.drafting, {
        message: view,
        channel: { kind: msg.channel, replyVia: route, replyStyle: ["whatsapp", "checkatrade_message", "sms"].includes(route) ? "short" : "email" },
        triage, booking: booking ? { action: booking.action, slots: booking.slots } : undefined, proposedSlots: booking?.slots ?? [],
        bookingPolicy: wantsBooking && !booking ? "owner_arranges" : undefined,
      }, ctx, events);
      const review = await runAgent<ReviewResult>(agents.reviewer, { message: view, triage, proposedSlots: booking?.slots ?? [], draft }, ctx, events);
      const minScore = Math.min(...Object.values(review.scores));
      const passed = review.pass && minScore >= tenant.settings.reviewerPassScore;

      const attention = mustEscalate ? `Needs you: ${triage.reason}`
        : !passed ? `Check carefully: ${review.issues.join(" ") || "reviewer score low"}`
        : draft.needsHumanBeforeSending || triage.needsHuman ? "Agent asked you to check this one." : null;

      // A new Checkatrade lead needs the owner's decision in Checkatrade, so it is never automated.
      const category = lead ? undefined : categorise(triage, booking, mustEscalate);
      const d = await one<{ id: string }>(db,
        `insert into drafts (tenant_id, run_id, conversation_id, reply_route, body, original_body, review, needs_attention, attention_reason, category)
         values (app_current_tenant(), $1, $2, $3, $4, $4, $5, $6, $7, $8) returning id`,
        [run!.id, msg.conv_id, route, draft.replyText, { ...review, internalNote: draft.internalNote }, !!attention, attention, category ?? null]);
      await finish(mustEscalate ? "escalated" : attention ? "needs_attention" : "ready_for_approval", attention ?? "Draft passed review.", { triage, booking });
      await queueNext(await approveOrAsk(db, tenant, d!.id)); // statements here commit as they run
    } catch (e: any) {
      await log();
      await db.query("update runs set status = 'failed', error = $2, finished_at = now() where id = $1", [run!.id, String(e?.message ?? e).slice(0, 2000)]);
      throw e; // the queue retries
    }
  });
}

/** Turns the booking agent's decision into diary changes, after checking it against the real diary. */
async function applyBooking(db: Db, tenant: Tenant, b: BookingResult, msg: any, offered: { holdId: string }[], now: Date, events: RunEvent[]) {
  const holdIds: string[] = [];
  if (b.action === "confirm_slot") {
    if (b.holdId && offered.some((o) => o.holdId === b.holdId)) {
      await confirmHold(db, b.holdId, msg.contact_name ?? msg.from_name);
      events.push({ step: "booking", detail: `confirmed hold ${b.holdId}` });
      return { ...b, holdIds: [b.holdId] };
    }
    events.push({ step: "guard", detail: "booking agent confirmed a time we hadn't offered: ignored" });
    return { ...b, action: "none" as const, slots: [] };
  }
  if (b.action === "propose_slots" || b.action === "move_appointment") {
    const valid = [];
    for (const s of b.slots.slice(0, 3)) if (await isFree(db, tenant, now, s)) valid.push(s);
    if (valid.length < b.slots.length) events.push({ step: "guard", detail: `removed ${b.slots.length - valid.length} slot(s) not free in the diary` });
    // A fresh offer replaces any earlier unconfirmed one.
    for (const o of offered) await releaseHold(db, o.holdId, "released");
    for (const s of valid) {
      holdIds.push(await createHold(db, tenant, { conversationId: msg.conv_id, contactId: msg.contact_id, contactName: msg.contact_name ?? msg.from_name, service: b.service, slot: s }));
    }
    events.push({ step: "booking", detail: `held ${holdIds.length} slot(s)` });
    return { ...b, slots: valid, holdIds };
  }
  return { ...b, holdIds };
}

/** First route in the tenant's preference list that we can actually use for this customer. */
export async function chooseRoute(db: Db, tenant: Tenant, channel: string, contact: { email?: string; phone?: string }, opts: { whatsappOpen?: boolean } = {}): Promise<ReplyRoute> {
  const prefs: ReplyRoute[] = (tenant.settings.replyVia as any)?.[channel] ?? [];
  const hasWa = !!(await getConnection(db, "whatsapp"));
  const hasGmail = !!(await getConnection(db, "gmail"));
  const ok = (r: ReplyRoute) =>
    r === "whatsapp" ? !!contact.phone && hasWa && opts.whatsappOpen !== false
    : r === "email" ? !!contact.email && hasGmail
    : r === "checkatrade_message" ? channel === "checkatrade"
    : r === "sms" || r === "phone" ? !!contact.phone
    : false;
  const fallback: ReplyRoute[] = channel === "whatsapp" ? ["whatsapp", "phone"] : channel === "sms" ? ["sms", "whatsapp", "phone"] : channel === "checkatrade" ? ["email", "checkatrade_message", "phone"] : ["email", "whatsapp", "phone"];
  return [...prefs, ...fallback].find(ok) ?? "phone";
}
