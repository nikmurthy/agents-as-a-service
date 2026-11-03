// Channel parsers: raw payload in, InboundMessage out. No tenant logic here: the caller has already
// resolved which business the payload belongs to from the connection it arrived on.
import type { InboundMessage } from "../types.js";

export function normalisePhone(input?: string): string | undefined {
  if (!input) return undefined;
  const digits = input.replace(/[^\d+]/g, "");
  if (!digits) return undefined;
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("44")) return "+" + digits;
  if (digits.startsWith("0")) return "+44" + digits.slice(1);
  return "+" + digits;
}
export const normaliseEmail = (s?: string) => s?.trim().toLowerCase() || undefined;

export function parseAddress(value: string): { name?: string; email?: string } {
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || undefined, email: normaliseEmail(m[2]) };
  return { email: normaliseEmail(value) };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|h\d|tr|div|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/td>\s*<td[^>]*>/gi, ": ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
}

const MOBILE = /(?:\+44\s?7|\b07)\d{3}\s?\d{3}\s?\d{3}\b/;

// ---------------------------------------------------------------- Gmail
/** Decodes a Gmail API message (format=full), walking multipart bodies. Prefers text/plain. */
export function decodeGmail(msg: any): { headers: Record<string, string>; text?: string; html?: string } {
  const headers: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;
  let text: string | undefined, html: string | undefined;
  const walk = (part: any) => {
    if (!part) return;
    const data = part.body?.data ? Buffer.from(part.body.data, "base64url").toString("utf8") : undefined;
    if (data && part.mimeType === "text/plain" && text === undefined) text = data;
    if (data && part.mimeType === "text/html" && html === undefined) html = data;
    for (const p of part.parts ?? []) walk(p);
  };
  walk(msg.payload);
  return { headers, text, html };
}

export function parseGmail(msg: any, opts: { checkatradeSenders: string[] }): InboundMessage {
  const { headers, text, html } = decodeGmail(msg);
  const from = parseAddress(headers["from"] ?? "");
  const base = {
    channelMessageId: msg.id as string,
    receivedAt: new Date(Number(msg.internalDate)).toISOString(),
    email: { threadId: msg.threadId as string, messageId: headers["message-id"] },
  };
  const isCheckatrade = !!from.email && (opts.checkatradeSenders.includes(from.email) || /@(.+\.)?checkatrade\.com$/.test(from.email));
  if (isCheckatrade && html) return { ...base, ...parseCheckatradeEmailHtml(html), subject: headers["subject"] };

  const body = (text ?? (html ? htmlToText(html) : "")).trim();
  return {
    ...base,
    channel: "email",
    from: { name: from.name, email: from.email, phone: normalisePhone(body.match(MOBILE)?.[0]) },
    subject: headers["subject"],
    text: stripQuotedReply(body),
  };
}

/** Drop the quoted previous message from email replies ("On ... wrote:"). */
export function stripQuotedReply(body: string): string {
  const cut = body.search(/\n(On .{5,80} wrote:|-{2,}\s*Original Message|From: .+\nSent: )/);
  return (cut > 0 ? body.slice(0, cut) : body).trim();
}

// ---------------------------------------------------------------- Checkatrade
/** Lead and new-message notification emails: read label/value table rows; fall back to the whole text. */
export function parseCheckatradeEmailHtml(html: string): Omit<InboundMessage, "channelMessageId" | "receivedAt"> {
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<tr>\s*<td[^>]*>\s*<b>([^<]{1,60})<\/b>\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)) {
    fields[htmlToText(m[1])] = htmlToText(m[2]);
  }
  const get = (...labels: string[]) => {
    const k = Object.keys(fields).find((f) => labels.includes(f.toLowerCase()));
    return k ? fields[k] : undefined;
  };
  const skip = new Set(["description", "message", "customer", "phone", "email"]);
  return {
    channel: "checkatrade",
    from: { name: get("customer", "name"), email: normaliseEmail(get("email")), phone: normalisePhone(get("phone")) },
    text: get("description", "message") ?? htmlToText(html),
    structured: Object.fromEntries(Object.entries(fields).filter(([k]) => !skip.has(k.toLowerCase()))),
  };
}

/** Checkatrade lead delivery webhook (strategic accounts). */
export function parseCheckatradeWebhook(raw: any): InboundMessage {
  const structured: Record<string, string> = {
    Job: raw.title, Category: raw.category, Postcode: raw.postcode,
    "Preferred start": raw.preferredStart?.option, "Lead type": raw.source,
  };
  for (const qa of raw.additionalInformation ?? []) structured[qa.question] = qa.answer;
  return {
    channel: "checkatrade",
    channelMessageId: raw.jobId,
    receivedAt: new Date(raw.dateCreated ?? Date.now()).toISOString(),
    from: { name: raw.customerName, email: normaliseEmail(raw.customerEmail), phone: normalisePhone(raw.customerPhone) },
    subject: raw.title,
    text: raw.jobDescription ?? "",
    structured: Object.fromEntries(Object.entries(structured).filter(([, v]) => v)),
    attachments: (raw.media ?? []).map((url: string) => ({ url, kind: "image" })),
  };
}

// ---------------------------------------------------------------- WhatsApp
export interface WaInbound {
  phoneNumberId: string;
  from: string;              // E.164
  name?: string;
  id: string;
  timestamp: string;
  type: string;
  text?: string;
  buttonId?: string;         // interactive button reply id, or template quick-reply payload
}

/** Flattens a WhatsApp Cloud API webhook into its inbound messages (ignores delivery statuses). */
export function parseWhatsAppWebhook(body: any): WaInbound[] {
  const out: WaInbound[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (!v?.messages) continue;
      for (const m of v.messages) {
        const contact = (v.contacts ?? []).find((c: any) => c.wa_id === m.from) ?? v.contacts?.[0];
        out.push({
          phoneNumberId: v.metadata.phone_number_id,
          from: normalisePhone(m.from)!,
          name: contact?.profile?.name,
          id: m.id,
          timestamp: m.timestamp,
          type: m.type,
          text: m.text?.body ?? m.interactive?.button_reply?.title ?? m.button?.text,
          buttonId: m.interactive?.button_reply?.id ?? m.button?.payload,
        });
      }
    }
  }
  return out;
}

export function waToInbound(w: WaInbound): InboundMessage {
  return {
    channel: "whatsapp",
    channelMessageId: w.id,
    receivedAt: new Date(Number(w.timestamp) * 1000).toISOString(),
    from: { name: w.name, phone: w.from },
    text: w.type === "text" ? (w.text ?? "") : `[${w.type} message received: open WhatsApp to view]`,
  };
}

// ---------------------------------------------------------------- Website forms
const pick = (fields: Record<string, string>, ...names: string[]) => {
  for (const [k, v] of Object.entries(fields)) if (names.some((n) => k.toLowerCase().includes(n))) return v;
  return undefined;
};

/** Website form webhook. Accepts { fields: {...} } or a flat object of fields. */
export function parseWebForm(raw: any): InboundMessage {
  const f: Record<string, string> = Object.fromEntries(
    Object.entries(raw.fields ?? raw).filter(([, v]) => typeof v === "string") as [string, string][],
  );
  const message = pick(f, "message", "help", "enquiry", "details", "comments") ?? "";
  const structured: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (v !== message) structured[k] = v;
  return {
    channel: "web_form",
    channelMessageId: String(raw.submissionId ?? raw.id ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    receivedAt: new Date(raw.submittedAt ?? Date.now()).toISOString(),
    from: { name: pick(f, "name"), email: normaliseEmail(pick(f, "email")), phone: normalisePhone(pick(f, "phone", "mobile")) },
    text: message,
    structured,
    attachments: raw.attachments,
  };
}
