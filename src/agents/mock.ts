// Deterministic stand-ins for the agents (AGENT_MODE=mock). Used by the automated tests so the whole platform
// can be exercised without model calls. They say nothing about real agent quality.
import type { BookingResult, DraftResult, ReviewResult, TriageResult } from "../types.js";
import { tools, type ToolContext } from "./tools.js";
import { formatLocal } from "../time.js";

const has = (s: string, re: RegExp) => re.test(s);

async function triage(input: any): Promise<TriageResult> {
  const m = input.message;
  const all = [m.subject, m.text, JSON.stringify(m.details ?? {})].join(" ").toLowerCase();
  const base = { missingInfo: [] as string[], inServiceArea: null };
  if (has(all, /smell(ing)? gas|through (the )?ceiling/)) return { ...base, intent: "emergency", urgency: "emergency", needsHuman: true, nextStep: "escalate", reason: "Emergency." };
  if (has(all, /unsubscribe|trade prices/)) return { ...base, intent: "spam", urgency: "low", needsHuman: false, nextStep: "ignore", reason: "Marketing." };
  if (has(all, /black square tiles|not happy|gaps opening|complain/)) return { ...base, intent: "complaint", urgency: "normal", needsHuman: true, nextStep: "escalate", reason: "Needs the owner." };
  if (input.offeredTimes?.length && has(all, /works|suits|perfect|that one|book me in|monday|tuesday|wednesday|thursday|friday|saturday/))
    return { ...base, intent: "booking_confirmation", urgency: "normal", needsHuman: false, nextStep: "confirm_booking", reason: "Customer picked a time." };
  return { ...base, intent: "quote_request", urgency: "normal", needsHuman: false, nextStep: "book_visit", service: input.services?.[0], reason: "New job needing a visit." };
}

async function booking(input: any, ctx: ToolContext): Promise<BookingResult> {
  const service = ctx.tenant.settings.services[0];
  if (input.triage.nextStep === "confirm_booking") {
    const offered = await tools.list_offered_times.run(ctx);
    const text = String(input.message.text).toLowerCase();
    const pick = offered.find((o) => text.includes(formatLocal(o.start).split(" ")[0].toLowerCase())) ?? offered[0];
    if (pick) return { action: "confirm_slot", holdId: pick.holdId, slots: [{ start: pick.start, end: pick.end }], service: pick.service ?? service.name, notes: "Mock: matched by weekday." };
  }
  const free = await tools.get_availability.run(ctx, { durationMinutes: service.durationMinutes });
  // Spread across days, like the real agent is asked to.
  const byDay: typeof free = [];
  for (const s of free) if (!byDay.some((b) => b.start.slice(0, 10) === s.start.slice(0, 10))) byDay.push(s);
  return { action: "propose_slots", service: service.name, slots: byDay.slice(0, 3).map(({ start, end }) => ({ start, end })), notes: "Mock: first free slot on each of the next days." };
}

async function draft(input: any, ctx: ToolContext): Promise<DraftResult> {
  const name = input.message.customerFirstName ?? "there";
  const sign = ctx.tenant.settings.signOff;
  if (input.triage.nextStep === "escalate") return { replyText: `Hi ${name}, thanks for getting in touch. I'll come back to you personally shortly. ${sign}`, needsHumanBeforeSending: true, internalNote: "Needs the owner." };
  if (input.booking?.action === "confirm_slot") return { replyText: `Great, you're booked in for ${formatLocal(input.booking.slots[0].start)}. See you then! ${sign}`, needsHumanBeforeSending: false, internalNote: "" };
  const slots = (input.booking?.slots ?? []).map((s: any) => formatLocal(s.start)).join(", ");
  return { replyText: `Hi ${name}, thanks for your message. I could come to measure up on ${slots}. Which suits you? ${sign}`, needsHumanBeforeSending: false, internalNote: "" };
}

async function review(): Promise<ReviewResult> {
  return { scores: { tone: 5, clarity: 5, accuracy: 5, safety: 5 }, pass: true, issues: [] };
}

export async function mockAgent(id: string, input: unknown, ctx: ToolContext): Promise<unknown> {
  switch (id) {
    case "triage": return triage(input);
    case "booking": return booking(input, ctx);
    case "drafting": return draft(input, ctx);
    case "reviewer": return review();
    default: throw new Error(`No mock for agent ${id}`);
  }
}
