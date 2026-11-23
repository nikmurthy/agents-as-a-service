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
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ": ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&pound;/g, "£")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
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

/**
 * Reads one Gmail message. Checkatrade emails are read as Checkatrade leads; Checkatrade's other emails
 * (reviews, invoices, account notices) return null so they never become enquiries.
 */
export function parseGmail(msg: any, opts: { checkatradeSenders: string[] }): InboundMessage | null {
  const { headers, text, html } = decodeGmail(msg);
  const from = parseAddress(headers["from"] ?? "");
  const base = {
    channelMessageId: msg.id as string,
    receivedAt: new Date(Number(msg.internalDate)).toISOString(),
  };
  if (isCheckatradeSender(from.email, opts.checkatradeSenders)) {
    const lead = parseCheckatradeEmail({ subject: headers["subject"], html, text });
    // No email thread: a reply by email goes to the customer as a fresh email, never into Checkatrade's notification.
    return lead && { ...base, ...lead };
  }

  const body = (text ?? (html ? htmlToText(html) : "")).trim();
  return {
    ...base,
    email: { threadId: msg.threadId as string, messageId: headers["message-id"] },
    channel: "email",
    from: { name: from.name, email: from.email, phone: normalisePhone(body.match(MOBILE)?.[0]) },
    subject: headers["subject"],
    text: stripQuotedReply(body),
  };
}

export const isCheckatradeSender = (email: string | undefined, extra: string[] = []) =>
  !!email && (extra.includes(email) || /@(.+\.)?checkatrade\.com$/.test(email));

/** Drop the quoted previous message from email replies ("On ... wrote:"). */
export function stripQuotedReply(body: string): string {
  const cut = body.search(/\n(On .{5,80} wrote:|-{2,}\s*Original Message|From: .+\nSent: )/);
  return (cut > 0 ? body.slice(0, cut) : body).trim();
}

// ---------------------------------------------------------------- Checkatrade
// Checkatrade's emails vary by lead type and change over time, so they are read as "Label: value" lines
// (table rows become such lines in htmlToText) against a list of known labels, rather than one exact layout.
const CT_LABELS: Record<string, string[]> = {
  name: ["customer", "customer name", "name", "homeowner", "contact name", "client", "client name"],
  phone: ["phone", "phone number", "telephone", "telephone number", "mobile", "mobile number", "contact number", "tel"],
  email: ["email", "email address", "e-mail", "customer email"],
  description: ["description", "job description", "details", "job details", "message", "customer message", "enquiry", "notes", "additional information"],
  reference: ["job reference", "job ref", "job reference number", "reference", "ref", "job id", "job number", "lead id", "lead reference"],
  job: ["job", "job title", "title", "job type", "category", "trade", "work type", "service"],
  postcode: ["postcode", "post code", "location", "area"],
  start: ["preferred start", "start date", "when", "timeframe", "timescale", "preferred start date"],
};
const CT_CANON = new Map(Object.entries(CT_LABELS).flatMap(([k, ls]) => ls.map((l) => [l, k] as const)));
const NICE: Record<string, string> = { reference: "Job reference", job: "Job", postcode: "Postcode", start: "Preferred start" };
const NOT_ENQUIRY = /\b(review|reviews|feedback|invoice|payment|receipt|statement|direct debit|password|verify|verification|newsletter|webinar|renewal|membership|subscription|vetting|insurance|survey)\b/i;
const ENQUIRY = /\b(lead|leads|enquiry|enquiries|job|request|quote|message|messaged|replied|contacted)\b/i;

/** Reads "Label: value" lines, and a known label on its own line followed by its value. */
export function labelledFields(text: string): { label: string; value: string }[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const out: { label: string; value: string }[] = [];
  const known = (l: string) => CT_CANON.has(l.toLowerCase().replace(/[:*]+$/, "").trim());
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z][A-Za-z '’/()&-]{0,39}?)\s*[:*]+\s*(.+)$/);
    if (m) { out.push({ label: m[1].trim(), value: m[2].trim() }); continue; }
    if (known(lines[i]) && lines[i + 1] && !known(lines[i + 1])) {
      out.push({ label: lines[i].replace(/[:*]+$/, "").trim(), value: lines[i + 1] });
      i++;
    }
  }
  return out;
}

/**
 * A Checkatrade lead or new-message notification email. Returns null for Checkatrade's other emails.
 * The job reference (when there is one) links later messages about the same job to the same conversation.
 */
export function parseCheckatradeEmail(e: { subject?: string; html?: string; text?: string }): Omit<InboundMessage, "channelMessageId" | "receivedAt"> | null {
  const subject = e.subject?.trim() ?? "";
  const body = (e.html ? htmlToText(e.html) : e.text ?? "").trim();
  const found: Record<string, string> = {};
  const structured: Record<string, string> = {};
  for (const { label, value } of labelledFields(body)) {
    const key = CT_CANON.get(label.toLowerCase());
    if (key && !found[key]) found[key] = value;
    if (key && NICE[key]) structured[NICE[key]] ??= value.slice(0, 200);
    else if (!key && label.length <= 30 && value.length <= 200 && !/https?:/i.test(value)) structured[label] ??= value;
  }
  if (!found.reference) {
    const ref = `${subject}\n${body}`.match(/\b(?:job|lead)\s*(?:ref(?:erence)?|id|number|no\.?)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})\b/i)?.[1];
    if (ref) { found.reference = ref; structured["Job reference"] = ref; }
  }
  const email = normaliseEmail(found.email?.match(/[^\s<>()]+@[^\s<>()]+\.[a-z]{2,}/i)?.[0]);
  const contact = {
    name: found.name?.slice(0, 100),
    email: email && !isCheckatradeSender(email) ? email : undefined,
    phone: normalisePhone(found.phone ?? body.match(MOBILE)?.[0]),
  };
  const isMessage = /\b(new message|sent you a message|messaged you|has replied|replied to you)\b/i.test(subject);
  const isEnquiry = !!found.description || !!contact.phone || !!contact.email || !!found.reference || ENQUIRY.test(subject);
  if ((NOT_ENQUIRY.test(subject) && !found.description) || !isEnquiry) return null;
  structured["Checkatrade email"] = isMessage ? "Message from the customer" : "New lead";
  const link = checkatradeJobLink(`${e.html ?? ""}\n${e.text ?? ""}`);
  if (link) structured["Job link"] = link;
  for (const k of ["name", "phone", "email"]) delete structured[k];
  return {
    channel: "checkatrade",
    from: contact,
    subject: subject || undefined,
    text: (found.description ?? body).slice(0, 5000),
    structured,
  };
}

/** The first link to a job in Checkatrade's members' app (the trade's view of the job), if there is one. */
export function checkatradeJobLink(s: string): string | undefined {
  for (const m of s.matchAll(/https:\/\/(?:[a-z0-9-]+\.)*checkatrade\.com\/[^\s"'<>)]*/gi)) {
    const url = m[0].replace(/&amp;/g, "&").replace(/[.,]+$/, "");
    if (/members|\/jobs?\//i.test(url) && !/unsubscribe|preferences|support|blog/i.test(url)) return url.slice(0, 500);
  }
  return undefined;
}

/** Checkatrade lead delivery webhook (strategic accounts). */
export function parseCheckatradeWebhook(raw: any): InboundMessage {
  const structured: Record<string, string | undefined> = {
    Job: raw.title, Category: raw.category, Postcode: raw.postcode,
    "Preferred start": raw.preferredStart?.option, "Lead type": raw.source,
    "Job reference": raw.jobId, "Job link": typeof raw.tradeWebUrl === "string" ? checkatradeJobLink(raw.tradeWebUrl) : undefined,
  };
  for (const qa of raw.additionalInformation ?? []) structured[qa.question] = qa.answer;
  return {
    channel: "checkatrade",
    channelMessageId: raw.jobId,
    receivedAt: new Date(raw.dateCreated ?? Date.now()).toISOString(),
    from: { name: raw.customerName, email: normaliseEmail(raw.customerEmail), phone: normalisePhone(raw.customerPhone) },
    subject: raw.title,
    text: raw.jobDescription ?? "",
    structured: Object.fromEntries(Object.entries(structured).filter(([, v]) => v)) as Record<string, string>,
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

/** A message the owner sent from the WhatsApp Business app on a shared ("coexistence") number. */
export interface WaEcho { phoneNumberId: string; to: string; id: string; timestamp: string; type: string; text?: string }

export function parseWhatsAppEchoes(body: any): WaEcho[] {
  const out: WaEcho[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "smb_message_echoes") continue;
      for (const e of change.value?.message_echoes ?? []) {
        const to = normalisePhone(e.to);
        if (!to || !e.id) continue;
        out.push({ phoneNumberId: change.value.metadata?.phone_number_id, to, id: e.id, timestamp: e.timestamp, type: e.type, text: e.text?.body });
      }
    }
  }
  return out;
}

/** Contacts saved in the WhatsApp Business app, sent once after connecting and then as they change. */
export interface WaSavedContact { phoneNumberId: string; phone: string; action: "add" | "remove" }

export function parseWhatsAppContactSync(body: any): WaSavedContact[] {
  const out: WaSavedContact[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "smb_app_state_sync") continue;
      for (const s of change.value?.state_sync ?? []) {
        const phone = normalisePhone(s.contact?.phone_number);
        if (s.type !== "contact" || !phone) continue;
        out.push({ phoneNumberId: change.value.metadata?.phone_number_id, phone, action: s.action === "remove" ? "remove" : "add" });
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

// ---------------------------------------------------------------- Text messages (Mac relay)
/** One text read from the Messages app on the business's Mac by tools/mac-sms-relay. */
export function parseSmsRelay(raw: any): InboundMessage {
  const id = String(raw?.id ?? "").trim();
  const from = normalisePhone(String(raw?.from ?? ""));
  if (!id || !from) throw new Error("A text needs an id and the sender's number");
  const at = new Date(raw.receivedAt ?? Date.now());
  return {
    channel: "sms",
    channelMessageId: id,
    receivedAt: (isNaN(at.getTime()) ? new Date() : at).toISOString(),
    from: { name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 100) : undefined, phone: from },
    text: String(raw.text ?? "").slice(0, 5000),
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
