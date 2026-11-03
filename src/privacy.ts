import type { DataTag, InboundMessage } from "./types.js";

// Tag sensitive data on arrival (drives retention, access and erasure) and minimise what reaches models.
const HEALTH = /\b(ibs|chemo\w*|cancer|diabet\w*|gp|doctor|medication|tablets|supplements?|pregnan\w*|allerg\w*|eating disorder|condition|diagnos\w*|symptoms?|treatment|crohn'?s|coeliac)\b/i;
const CHILD = /\b(my (son|daughter|child|kids?|baby|toddler)|\d{1,2}[- ]?(year|month)[- ]?old|baby)\b/i;

export function tagData(m: InboundMessage, pack: string): DataTag[] {
  const tags = new Set<DataTag>(["personal"]);
  const all = [m.subject ?? "", m.text, ...Object.values(m.structured ?? {})].join(" ");
  if (pack === "practitioner" && HEALTH.test(all)) tags.add("health");
  if (CHILD.test(all)) tags.add("child");
  return [...tags];
}

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE = /(\+44\s?|0)\d[\d\s]{8,12}\d/g;
export const maskForModel = (s: string) => s.replace(EMAIL, "[email address]").replace(PHONE, "[phone number]");

/** What agents see: no email addresses or phone numbers, first name only. */
export function modelView(m: { channel: string; receivedAt: string; fromName?: string | null; subject?: string | null; text: string; structured?: Record<string, string> | null; attachments?: unknown[] | null }) {
  const structured = Object.fromEntries(
    Object.entries(m.structured ?? {})
      .filter(([k]) => !/email|phone|mobile|^name$|customer/i.test(k))
      .map(([k, v]) => [k, maskForModel(String(v))]),
  );
  return {
    channel: m.channel,
    receivedAt: m.receivedAt,
    customerFirstName: m.fromName?.split(/\s+/)[0],
    subject: m.subject ? maskForModel(m.subject) : undefined,
    text: maskForModel(m.text),
    details: Object.keys(structured).length ? structured : undefined,
    attachments: m.attachments?.length ? `${m.attachments.length} attachment(s)` : undefined,
  };
}
