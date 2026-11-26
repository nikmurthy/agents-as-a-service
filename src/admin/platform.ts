import { env } from "../env.js";
import { clients } from "../integrations/index.js";
import { anthropic } from "../agents/runner.js";
import { googleRedirectUri } from "../google-link.js";

// Platform keys live in Bitwarden and reach the app as environment variables (see README, "Deploying to Fly.io").
// The admin app may only learn whether each one is set and whether it works. Never return a value.

export type Service = "claude" | "google" | "whatsapp" | "whatsapp_signup";

const SERVICES: { id: Service; name: string; purpose: string; keys: string[]; where: string }[] = [
  {
    id: "claude", name: "Claude",
    purpose: "Every agent (Triage, Booking, Drafting, Reviewer) runs on this one key.",
    keys: ["ANTHROPIC_API_KEY"],
    where: "Claude Console → API keys. Spending limit and credit are set there too.",
  },
  {
    id: "google", name: "Google (Gmail and Calendar)",
    purpose: "Lets each business sign in with Google so we can read enquiries, send approved replies and hold calendar times.",
    keys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    where: "Google Cloud console → Google Auth Platform → Clients.",
  },
  {
    id: "whatsapp", name: "WhatsApp",
    purpose: "The webhook that receives every business's WhatsApp messages. Each business's own number and token are added in its Connections.",
    keys: ["WA_APP_SECRET", "WA_VERIFY_TOKEN"],
    where: "Meta for Developers → your app → App settings → Basic for the app secret. The verify token is the one you chose for the webhook.",
  },
  {
    id: "whatsapp_signup", name: "WhatsApp Business app numbers",
    purpose: "Lets a sole trader connect the one number they already use in the WhatsApp Business app (Meta Embedded Signup). Needs Meta Tech Provider approval.",
    keys: ["META_APP_ID", "META_SIGNUP_CONFIG_ID"],
    where: "Meta for Developers → your app → App settings → Basic for the App ID; Facebook Login for Business → Configurations for the configuration ID.",
  },
];

const isSet = (k: string) => Boolean(process.env[k]?.trim());

export function platformStatus() {
  return {
    agentMode: env.agentMode,
    services: SERVICES.map((s) => ({ ...s, keys: s.keys.map((name) => ({ name, set: isSet(name) })), ready: s.keys.every(isSet) })),
  };
}

export const servicesReady = () => Object.fromEntries(SERVICES.map((s) => [s.id, s.keys.every(isSet)])) as Record<Service, boolean>;

/** Makes one small real call with the stored keys. Messages never include a key. */
export async function testService(id: Service): Promise<{ ok: boolean; detail: string }> {
  const s = SERVICES.find((x) => x.id === id)!;
  const missing = s.keys.filter((k) => !isSet(k));
  if (missing.length) return { ok: false, detail: `Not set yet: ${missing.join(", ")}. Add it in Bitwarden, then run the Deploy production workflow.` };
  try {
    if (id === "claude") {
      // The cheapest real request, so it also catches an empty credit balance (a fraction of a cent).
      await anthropic().messages.create({ model: "claude-haiku-5-5", max_tokens: 64, messages: [{ role: "user", content: "Reply with OK." }] });
      return { ok: true, detail: "Claude answered. The key works and there is credit." };
    }
    if (id === "google") return await clients.google.checkClient(googleRedirectUri());
    // Both WhatsApp keys are only checked by Meta: the secret on each webhook, the verify token when the webhook is set up.
    return { ok: true, detail: id === "whatsapp_signup" ? "Both are set. Meta checks them when a business connects its number." : "Both are set. Meta checks them on each message it sends here." };
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (id === "claude") {
      if (e?.status === 401) return { ok: false, detail: "Claude didn't accept the key. Make a new one in the Claude Console." };
      if (/credit balance/i.test(msg)) return { ok: false, detail: "The key works but there's no credit. Add funds in the Claude Console → Billing." };
      if (/spend limit|usage limit/i.test(msg)) return { ok: false, detail: "This month's spending limit has been reached. Raise it in the Claude Console → Limits." };
    }
    return { ok: false, detail: msg.slice(0, 300) };
  }
}
