import { Hono } from "hono";
import { env } from "./env.js";
import { one, withAdmin, withTenant } from "./db.js";
import { encryptJson, sign, verify, verifyMetaSignature } from "./crypto.js";
import { clients } from "./integrations/index.js";
import { parseCheckatradeWebhook, parseWebForm, parseWhatsAppWebhook, waToInbound } from "./channels/parse.js";
import { ingest } from "./ingest.js";
import { handleOwnerMessage } from "./approvals.js";
import { audit } from "./audit.js";

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

// ---------------------------------------------------------------- WhatsApp (customers and owners)
app.get("/webhooks/whatsapp", (c) => {
  const q = c.req.query();
  if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === env.waVerifyToken) return c.text(q["hub.challenge"] ?? "");
  return c.text("Forbidden", 403);
});

app.post("/webhooks/whatsapp", async (c) => {
  const raw = await c.req.text();
  if (!verifyMetaSignature(raw, c.req.header("x-hub-signature-256"), env.waAppSecret)) return c.text("Invalid signature", 401);
  for (const w of parseWhatsAppWebhook(JSON.parse(raw))) {
    if (w.phoneNumberId === env.platformWaPhoneNumberId) {
      await handleOwnerMessage(w);              // an owner answering an approval request
      continue;
    }
    const conn = await withAdmin((db) => one<{ tenant_id: string }>(db,
      "select tenant_id from channel_connections where kind = 'whatsapp' and external_id = $1 and status = 'active'", [w.phoneNumberId]));
    if (conn) await ingest(conn.tenant_id, waToInbound(w)); // a customer messaging a business
  }
  return c.text("ok");
});

// ---------------------------------------------------------------- Website forms
app.post("/webhooks/forms/:token", async (c) => {
  const conn = await withAdmin((db) => one<{ tenant_id: string }>(db,
    "select tenant_id from channel_connections where kind = 'web_form' and external_id = $1 and status = 'active'", [c.req.param("token")]));
  if (!conn) return c.text("Not found", 404);
  const type = c.req.header("content-type") ?? "";
  const body = type.includes("application/json") ? await c.req.json() : Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]));
  await ingest(conn.tenant_id, parseWebForm(body));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- Checkatrade lead webhook (strategic accounts)
app.post("/webhooks/checkatrade/:token", async (c) => {
  const allowed = env.checkatradeAllowedIps;
  const ip = (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim();
  if (allowed.length && !allowed.includes(ip)) return c.text("Forbidden", 403);
  const conn = await withAdmin((db) => one<{ tenant_id: string }>(db,
    "select tenant_id from channel_connections where kind = 'checkatrade_webhook' and external_id = $1 and status = 'active'", [c.req.param("token")]));
  if (!conn) return c.text("Not found", 404);
  await ingest(conn.tenant_id, parseCheckatradeWebhook(await c.req.json()));
  return c.text("Created", 201);
});

// ---------------------------------------------------------------- Google connection (Gmail + Calendar)
export function googleConnectLink(tenantId: string): string {
  return `${env.publicBaseUrl}/connect/google?s=${encodeURIComponent(sign({ t: tenantId, exp: Math.floor(Date.now() / 1000) + 7 * 86400 }))}`;
}
const redirectUri = () => `${env.publicBaseUrl}/oauth/google/callback`;

app.get("/connect/google", (c) => {
  const s = c.req.query("s") ?? "";
  if (!verify<{ t: string; exp?: number }>(s)) return c.html(page("This link has expired. Ask for a new one."), 400);
  return c.redirect(clients.google.authUrl(s, redirectUri()));
});

app.get("/oauth/google/callback", async (c) => {
  const state = verify<{ t: string; exp?: number }>(c.req.query("state") ?? "");
  const code = c.req.query("code");
  if (!state || !code) return c.html(page("Something went wrong connecting Google. Please try the link again."), 400);
  const tokens = await clients.google.exchangeCode(code, redirectUri());
  const profile = await clients.google.gmailProfile(tokens.access_token);
  const grant = profile.emailAddress;
  await withTenant(state.t, async (db) => {
    const secret = encryptJson(tokens);
    for (const [kind, cursor] of [["gmail", { historyId: profile.historyId }], ["google_calendar", {}]] as const) {
      await db.query(
        `insert into channel_connections (tenant_id, kind, external_id, label, secret_ciphertext, config, cursor)
         values (app_current_tenant(), $1, $2, $2, $3, $4, $5)
         on conflict (kind, external_id) do update set secret_ciphertext = excluded.secret_ciphertext, status = 'active', last_error = null, config = excluded.config`,
        [kind, profile.emailAddress, secret, { grant }, cursor]);
    }
    await audit(db, { tenantId: state.t, actor: "owner", action: "google.connected", detail: { account: profile.emailAddress } });
  });
  return c.html(page(`Connected ✓<br>Gmail and Google Calendar for ${profile.emailAddress} are now linked. You can close this page.`));
});

const page = (msg: string) =>
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><p>${msg}</p></body>`;
