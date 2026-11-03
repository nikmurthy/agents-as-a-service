import { env } from "../env.js";

export interface WaSender { phoneNumberId: string; accessToken: string }
export interface WhatsAppClient {
  sendText(from: WaSender, to: string, text: string): Promise<{ id: string }>;
  /** Up to 3 reply buttons. Only allowed inside the 24-hour customer service window. */
  sendButtons(from: WaSender, to: string, body: string, buttons: { id: string; title: string }[]): Promise<{ id: string }>;
  /** Pre-approved template: works outside the 24-hour window. Quick-reply payloads come back as button replies. */
  sendTemplate(from: WaSender, to: string, name: string, lang: string, bodyParams: string[], quickReplyPayloads: string[]): Promise<{ id: string }>;
}

const toWa = (e164: string) => e164.replace(/^\+/, "");

async function graph(from: WaSender, payload: Record<string, unknown>): Promise<{ id: string }> {
  const res = await fetch(`https://graph.facebook.com/${env.graphApiVersion}/${from.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${from.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${json?.error?.message ?? "unknown error"}`);
  return { id: json.messages?.[0]?.id ?? "" };
}

export const whatsAppCloud: WhatsAppClient = {
  sendText: (from, to, text) => graph(from, { to: toWa(to), type: "text", text: { body: text.slice(0, 4096), preview_url: false } }),
  sendButtons: (from, to, body, buttons) =>
    graph(from, {
      to: toWa(to),
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body.slice(0, 1024) },
        action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })) },
      },
    }),
  sendTemplate: (from, to, name, lang, bodyParams, payloads) =>
    graph(from, {
      to: toWa(to),
      type: "template",
      template: {
        name,
        language: { code: lang },
        components: [
          { type: "body", parameters: bodyParams.map((p) => ({ type: "text", text: p.replace(/\s+/g, " ").slice(0, 900) })) },
          ...payloads.map((payload, index) => ({ type: "button", sub_type: "quick_reply", index: String(index), parameters: [{ type: "payload", payload }] })),
        ],
      },
    }),
};
