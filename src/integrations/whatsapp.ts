import { env } from "../env.js";

export interface WaSender { phoneNumberId: string; accessToken: string }
export interface WhatsAppClient {
  sendText(from: WaSender, to: string, text: string): Promise<{ id: string }>;
  /** Up to 3 reply buttons. Only allowed inside the 24-hour customer service window. */
  sendButtons(from: WaSender, to: string, body: string, buttons: { id: string; title: string }[]): Promise<{ id: string }>;
  /** Pre-approved template: works outside the 24-hour window. Quick-reply payloads come back as button replies. */
  sendTemplate(from: WaSender, to: string, name: string, lang: string, bodyParams: string[], quickReplyPayloads: string[]): Promise<{ id: string }>;
  /** Looks the number up with Meta using its token. Sends nothing. */
  checkSender(from: WaSender): Promise<{ ok: boolean; detail: string }>;

  // Embedded Signup (a business connecting the number they use in the WhatsApp Business app).
  /** Swaps the code from Meta's signup popup for a token that acts for that business. */
  exchangeSignupCode(code: string): Promise<{ accessToken: string }>;
  /** Asks Meta to send this business's messages to our webhook. */
  subscribeApp(wabaId: string, accessToken: string): Promise<void>;
  accountNumbers(wabaId: string, accessToken: string): Promise<string[]>;
  numberInfo(from: WaSender): Promise<{ displayPhone?: string; verifiedName?: string; onBusinessApp: boolean }>;
  /** One-off: Meta sends the contacts saved in the WhatsApp Business app to the webhook (smb_app_state_sync). */
  requestContactSync(from: WaSender): Promise<{ requestId?: string }>;
}

const toWa = (e164: string) => e164.replace(/^\+/, "");

async function graphCall(path: string, token: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<any> {
  const url = new URL(`https://graph.facebook.com/${env.graphApiVersion}/${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { "Content-Type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta ${res.status}: ${json?.error?.message ?? "unknown error"}`);
  return json;
}

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
  async checkSender(from) {
    const res = await fetch(`https://graph.facebook.com/${env.graphApiVersion}/${from.phoneNumberId}?fields=display_phone_number,verified_name`, {
      headers: { Authorization: `Bearer ${from.accessToken}` },
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, detail: `Meta said: ${json?.error?.message ?? res.status}` };
    return { ok: true, detail: `Sending as ${json.verified_name ?? "your business"} (${json.display_phone_number ?? from.phoneNumberId}).` };
  },
  async exchangeSignupCode(code) {
    const json = await graphCall("oauth/access_token", "", { query: { client_id: env.metaAppId, client_secret: env.metaAppSecret, code } });
    if (!json.access_token) throw new Error("Meta didn't return a token");
    return { accessToken: json.access_token };
  },
  async subscribeApp(wabaId, accessToken) { await graphCall(`${wabaId}/subscribed_apps`, accessToken, { method: "POST" }); },
  async accountNumbers(wabaId, accessToken) {
    const j = await graphCall(`${wabaId}/phone_numbers`, accessToken, { query: { fields: "id" } });
    return (j.data ?? []).map((n: any) => String(n.id));
  },
  async numberInfo(from) {
    const j = await graphCall(from.phoneNumberId, from.accessToken, { query: { fields: "display_phone_number,verified_name,is_on_biz_app,platform_type" } });
    return { displayPhone: j.display_phone_number, verifiedName: j.verified_name, onBusinessApp: j.is_on_biz_app === true };
  },
  async requestContactSync(from) {
    const j = await graphCall(`${from.phoneNumberId}/smb_app_data`, from.accessToken, { method: "POST", body: { messaging_product: "whatsapp", sync_type: "smb_app_state_sync" } });
    return { requestId: j.request_id };
  },
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
