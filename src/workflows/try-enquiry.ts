import { one, withTenant } from "../db.js";
import type { BookingResult, DraftResult, ReviewResult, RunEvent, TriageResult } from "../types.js";
import { loadTenant } from "../tenants.js";
import { loadAgents } from "../agents/registry.js";
import { runAgent } from "../agents/runner.js";
import type { ToolContext } from "../agents/tools.js";
import { modelView } from "../privacy.js";
import { calendarConnection, isFree } from "../calendar.js";
import { googleToken } from "../connections.js";
import { automationState, categorise, CATEGORIES } from "../automation.js";
import { withBookingLink, type BookingConfig } from "./answer-enquiry.js";
import { formatLocal } from "../time.js";

/**
 * Flows → "Try it": plays a pretend message through the enquiry flow and shows the reply the customer would get.
 * A dry run: it runs inside a read-only transaction, so nothing is saved, nothing is held in the calendar,
 * and nothing is sent. It uses the same agents, settings and rules as a real message.
 */

export interface TryStep { key: "triage" | "booking" | "reply" | "approve"; title: string; detail: string; flag?: boolean }
export interface TryResult { steps: TryStep[]; reply?: string; route: string; review?: { ok: boolean; note: string } }

const NIL = "00000000-0000-0000-0000-000000000000";
const ESCALATE_INTENTS = new Set(["emergency", "complaint", "clinical_question"]);
const INTENT: Record<TriageResult["intent"], string> = {
  new_job_enquiry: "a new job", quote_request: "a request for a quote", booking_request: "a request to book", booking_confirmation: "someone picking a time",
  reschedule: "a request to move a booking", general_question: "a question", follow_up: "a follow-up", clinical_question: "a health question",
  complaint: "a complaint", emergency: "an emergency", spam: "spam", other: "something unusual",
};
const ROUTE: Record<string, string> = { email: "email", whatsapp: "WhatsApp", sms: "text", phone: "phone", checkatrade_message: "Checkatrade" };

export async function tryEnquiry(tenantId: string, text: string, channel: "email" | "whatsapp" = "email", now = new Date()): Promise<TryResult> {
  // A Google token refresh writes to the database, so make sure the token is fresh before going read-only.
  await withTenant(tenantId, async (db) => { const c = await calendarConnection(db); if (c) await googleToken(db, c); });

  return withTenant(tenantId, async (db) => {
    await db.query("set transaction read only");
    const tenant = await loadTenant(db, tenantId);
    const agents = await loadAgents(db, (tenant.settings as any).agentVersions ?? {});
    const ctx: ToolContext = { db, tenant, conversationId: NIL, contactId: NIL, now };
    const events: RunEvent[] = [];
    const view = modelView({ channel, receivedAt: now.toISOString(), fromName: "Sam Taylor", text });
    const steps: TryStep[] = [];
    const route = channel === "whatsapp" ? "whatsapp" : "email";

    const triage = await runAgent<TriageResult>(agents.triage, { message: view, knownCustomer: false, offeredTimes: [], services: tenant.settings.services.map((s) => s.name) }, ctx, events);
    const mustEscalate = triage.urgency === "emergency" || triage.nextStep === "escalate" || ESCALATE_INTENTS.has(triage.intent);
    steps.push({ key: "triage", title: "Read and sorted", detail: `Looks like ${INTENT[triage.intent] ?? "a message"}${triage.urgency === "high" || triage.urgency === "emergency" ? ", and urgent" : ""}.`, flag: mustEscalate });
    if (triage.intent === "spam" || triage.nextStep === "ignore") {
      steps.push({ key: "reply", title: "No reply", detail: "Spam is set aside. Nothing would be written or sent." });
      return { steps, route };
    }

    const wantsBooking = ["book_visit", "book_consultation", "confirm_booking", "reschedule"].includes(triage.nextStep);
    const cfg = await one<{ enabled: boolean; config: BookingConfig }>(db, "select enabled, config from tenant_use_cases where use_case = 'book_appointments'");
    const offersTimes = !!cfg?.enabled && !!(await calendarConnection(db));
    const bookingLink = !offersTimes && cfg?.config?.mode === "link" ? cfg.config.link : undefined;
    let booking: BookingResult | undefined;
    if (!wantsBooking) steps.push({ key: "booking", title: "Booking", detail: "No appointment needed for this one." });
    else if (mustEscalate) steps.push({ key: "booking", title: "Booking", detail: "Left for you: this one needs you first." });
    else if (offersTimes && triage.inServiceArea !== false) {
      const b = await runAgent<BookingResult>(agents.booking, { message: view, triage, offeredTimes: [] }, ctx, events);
      const valid = [];
      if (b.action === "propose_slots") for (const s of b.slots.slice(0, 3)) if (await isFree(db, tenant, now, s)) valid.push(s);
      booking = { ...b, slots: valid };
      steps.push({ key: "booking", title: "Found free times", detail: valid.length
        ? `${valid.map((s) => formatLocal(s.start)).join(", ")}. In real life these would be pencilled in your calendar.`
        : "Nothing suitable was free, so the reply won't offer times." });
    } else if (bookingLink) steps.push({ key: "booking", title: "Booking link", detail: "Your booking link goes in the reply." });
    else steps.push({ key: "booking", title: "Booking", detail: "The reply says you'll be in touch to arrange a time." });

    const draft = await runAgent<DraftResult>(agents.drafting, {
      message: view,
      channel: { kind: channel, replyVia: route, replyStyle: route === "whatsapp" ? "short" : "email" },
      triage, booking: booking ? { action: booking.action, slots: booking.slots } : undefined, proposedSlots: booking?.slots ?? [],
      bookingPolicy: wantsBooking && !booking ? (bookingLink ? "booking_link" : "owner_arranges") : undefined,
      bookingLink: wantsBooking && !booking ? bookingLink : undefined,
    }, ctx, events);
    if (wantsBooking && !booking && bookingLink && !draft.replyText.includes(bookingLink)) draft.replyText = withBookingLink(draft.replyText, bookingLink);
    const review = await runAgent<ReviewResult>(agents.reviewer, { message: view, triage, proposedSlots: booking?.slots ?? [], draft }, ctx, events);
    const passed = review.pass && Math.min(...Object.values(review.scores)) >= tenant.settings.reviewerPassScore;
    steps.push({ key: "reply", title: "Wrote the reply", detail: passed ? "Checked: looks good." : `Checked: have a closer look. ${review.issues.join(" ")}`.trim(), flag: !passed });

    const category = categorise(triage, booking, mustEscalate);
    const auto = category ? await automationState(db, category) : undefined;
    steps.push({ key: "approve", title: "You approve", flag: mustEscalate,
      detail: mustEscalate ? "This one would always come to you, marked to look at carefully."
        : category && auto?.state === "on" ? `Would be sent automatically by ${ROUTE[route]}, because you said yes to "${CATEGORIES[category].label}" (unless it's a spot check).`
        : `Would come to you to approve, then go by ${ROUTE[route]}.` });
    return { steps, reply: draft.replyText, route, review: { ok: passed, note: passed ? "Looks good" : "Have a closer look" } };
  });
}
