// Recording fakes for Google and WhatsApp, so the whole platform can be tested against a real database.
import type { GoogleClient, CalendarEvent, GoogleTokens } from "../src/integrations/google.js";
import type { WhatsAppClient } from "../src/integrations/whatsapp.js";
import { localToUtc } from "../src/time.js";

export function fakeGoogle() {
  let n = 0;
  let historyId = 100;
  const events = new Map<string, CalendarEvent & { calendarId: string; deleted?: boolean }>();
  const inbox: { id: string; historyId: number; msg: any }[] = [];
  const sent: { raw: string; threadId?: string }[] = [];
  const client: GoogleClient = {
    authUrl: (state, redirect) => `https://accounts.google.example/auth?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirect)}`,
    exchangeCode: async () => ({ access_token: "access-1", refresh_token: "refresh-1", expires_at: Date.now() + 3600_000 }),
    refresh: async (t: GoogleTokens) => ({ ...t, access_token: `access-${++n}`, expires_at: Date.now() + 3600_000 }),
    gmailProfile: async () => ({ emailAddress: "owner@business.example", historyId: String(historyId) }),
    gmailNewMessageIds: async (_t, start) => ({ ids: inbox.filter((m) => m.historyId > Number(start)).map((m) => m.id), historyId: String(historyId) }),
    gmailGet: async (_t, id) => inbox.find((m) => m.id === id)!.msg,
    gmailSend: async (_t, raw, threadId) => { sent.push({ raw, threadId }); return { id: `sent-${sent.length}` }; },
    freeBusy: async (_t, calendarId, from, to) =>
      [...events.values()].filter((e) => !e.deleted && e.calendarId === calendarId)
        .map((e) => ({ start: localToUtc(e.start.dateTime.slice(0, 16), e.start.timeZone).toISOString(), end: localToUtc(e.end.dateTime.slice(0, 16), e.end.timeZone).toISOString() }))
        .filter((b) => b.end > from && b.start < to),
    insertEvent: async (_t, calendarId, ev) => { const id = `ev-${++n}`; events.set(id, { ...ev, calendarId }); return { id }; },
    patchEvent: async (_t, _c, id, patch) => { Object.assign(events.get(id)!, patch); },
    deleteEvent: async (_t, _c, id) => { const e = events.get(id); if (e) e.deleted = true; },
  };
  return {
    client, events, sent,
    addEmail(msg: any) { historyId += 1; inbox.push({ id: msg.id, historyId, msg }); },
    liveEvents: () => [...events.entries()].filter(([, e]) => !e.deleted),
  };
}

export function fakeWhatsApp() {
  const sent: { kind: "text" | "buttons" | "template"; from: string; to: string; text: string; buttons?: string[] }[] = [];
  let n = 0;
  const client: WhatsAppClient = {
    sendText: async (from, to, text) => { sent.push({ kind: "text", from: from.phoneNumberId, to, text }); return { id: `wamid.${++n}` }; },
    sendButtons: async (from, to, body, buttons) => { sent.push({ kind: "buttons", from: from.phoneNumberId, to, text: body, buttons: buttons.map((b) => b.id) }); return { id: `wamid.${++n}` }; },
    sendTemplate: async (from, to, _name, _lang, params, payloads) => { sent.push({ kind: "template", from: from.phoneNumberId, to, text: params.join(" | "), buttons: payloads }); return { id: `wamid.${++n}` }; },
  };
  return { client, sent, last: (to: string) => [...sent].reverse().find((s) => s.to === to) };
}

// ---- payload builders
export const waWebhook = (phoneNumberId: string, from: string, msg: Record<string, unknown>, name = "Customer") => ({
  object: "whatsapp_business_account",
  entry: [{ id: "WABA", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { display_phone_number: "440000", phone_number_id: phoneNumberId },
    contacts: [{ profile: { name }, wa_id: from.replace("+", "") }],
    messages: [{ from: from.replace("+", ""), id: `wamid.in.${Math.random().toString(36).slice(2)}`, timestamp: String(Math.floor(Date.now() / 1000)), ...msg }],
  } }] }],
});

export const gmailMsg = (o: { id: string; from: string; to: string; subject: string; text?: string; html?: string }) => ({
  id: o.id, threadId: `t-${o.id}`, internalDate: String(Date.now()), labelIds: ["INBOX", "UNREAD"],
  payload: {
    mimeType: o.html ? "text/html" : "text/plain",
    headers: [{ name: "From", value: o.from }, { name: "To", value: o.to }, { name: "Subject", value: o.subject }, { name: "Message-ID", value: `<${o.id}@mail.example>` }],
    body: { data: Buffer.from(o.html ?? o.text ?? "").toString("base64url") },
  },
});
