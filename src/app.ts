import { Hono } from "hono";
import { env } from "./env.js";
import { one, withAdmin, withTenant } from "./db.js";
import { encryptJson, randomToken, sign, verify, verifyMetaSignature } from "./crypto.js";
import { clients } from "./integrations/index.js";
import { parseCheckatradeWebhook, parseSmsRelay, parseWebForm, parseWhatsAppContactSync, parseWhatsAppEchoes, parseWhatsAppWebhook, waToInbound } from "./channels/parse.js";
import { businessForNumber, finishWhatsAppSignup, isForTheBusiness, ownerReplied, saveContacts } from "./whatsapp-business.js";
import { ingest } from "./ingest.js";
import { handleOwnerMessage } from "./approvals.js";
import { audit } from "./audit.js";
import { googleConnectLink, googleRedirectUri } from "./google-link.js";
import { whatsappConnectLink } from "./whatsapp-link.js";
import { admin } from "./admin/routes.js";
import { adminApp } from "./admin/static.js";

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

// Admin web app API (Supabase sign-in). See src/admin/.
app.route("/api", admin);
app.route("/", adminApp);

// ---------------------------------------------------------------- WhatsApp (customers and owners)
app.get("/webhooks/whatsapp", (c) => {
  const q = c.req.query();
  if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === env.waVerifyToken) return c.text(q["hub.challenge"] ?? "");
  return c.text("Forbidden", 403);
});

app.post("/webhooks/whatsapp", async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header("x-hub-signature-256");
  if (!env.waAppSecrets.some((secret) => verifyMetaSignature(raw, sig, secret))) {
    // Usually WA_APP_SECRET is from a different Meta app than the one sending. Never log the body or the secret.
    console.warn("WhatsApp webhook refused: signature doesn't match WA_APP_SECRET or PLATFORM_WA_APP_SECRET", sig ? "" : "(no signature)");
    return c.text("Invalid signature", 401);
  }
  const body = JSON.parse(raw);
  for (const w of parseWhatsAppWebhook(body)) {
    if (env.hasPlatformWa && w.phoneNumberId === env.platformWaPhoneNumberId) {
      await handleOwnerMessage(w);              // an owner answering an approval request
      continue;
    }
    const n = await businessForNumber(w.phoneNumberId);
    // The Phone number ID isn't connected to any business (often the account ID was pasted instead). Not personal data.
    if (!n) console.warn("WhatsApp message for a number no business has connected: Phone number ID", w.phoneNumberId);
    // A customer messaging a business. On a sole trader's one shared number, personal chats are left alone.
    if (n && (await isForTheBusiness(n, w.from))) await ingest(n.tenantId, waToInbound(w));
  }
  // The owner answered someone themselves in the WhatsApp Business app.
  for (const e of parseWhatsAppEchoes(body)) {
    const n = await businessForNumber(e.phoneNumberId);
    if (n) await ownerReplied(n.tenantId, e);
  }
  // The contacts saved in the owner's WhatsApp Business app (kept only as hashes).
  const synced = parseWhatsAppContactSync(body);
  for (const id of new Set(synced.map((s) => s.phoneNumberId))) {
    const n = await businessForNumber(id);
    if (n) await saveContacts(n.tenantId, synced.filter((s) => s.phoneNumberId === id));
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

// ---------------------------------------------------------------- Text messages from a Mac (tools/mac-sms-relay)
// The relay posts { messages: [{ id, from, name?, text, receivedAt }] }. The token in the URL is the secret.
app.post("/webhooks/sms/:token", async (c) => {
  const conn = await withAdmin((db) => one<{ tenant_id: string }>(db,
    "select tenant_id from channel_connections where kind = 'sms_relay' and external_id = $1 and status = 'active'", [c.req.param("token")]));
  if (!conn) return c.text("Not found", 404);
  const body = await c.req.json().catch(() => null);
  const list: any[] = Array.isArray(body?.messages) ? body.messages.slice(0, 100) : body ? [body] : [];
  let accepted = 0;
  for (const raw of list) {
    let msg;
    try { msg = parseSmsRelay(raw); } catch { continue; }
    await ingest(conn.tenant_id, msg); accepted++;
  }
  return c.json({ ok: true, accepted });
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
export { googleConnectLink };
const redirectUri = googleRedirectUri;

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

// ---------------------------------------------------------------- WhatsApp Business app number (Meta Embedded Signup)
// The owner opens a signed link, signs in to Facebook in Meta's own popup and picks the number they use in the
// WhatsApp Business app. We never see their Facebook password. This page alone loads Meta's script.
export { whatsappConnectLink };

app.get("/connect/whatsapp", (c) => {
  const s = c.req.query("s") ?? "";
  if (!verify<{ t: string; exp?: number }>(s)) return c.html(page("This link has expired. Ask for a new one."), 400);
  if (!env.metaAppId || !env.metaSignupConfigId) return c.html(page("Connecting a WhatsApp Business app number isn't switched on yet. It's waiting for Meta's approval."), 503);
  const nonce = randomToken(12);
  c.header("Content-Security-Policy", [
    "default-src 'self'", `script-src 'nonce-${nonce}' https://connect.facebook.net`, "frame-src https://*.facebook.com",
    "connect-src 'self' https://*.facebook.com", "img-src 'self' data: https:", "style-src 'unsafe-inline'",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join("; "));
  return c.html(whatsappSignupPage(nonce, s));
});

app.post("/connect/whatsapp/finish", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const state = verify<{ t: string; exp?: number }>(String(b.s ?? ""));
  const ok = (v: unknown) => typeof v === "string" && /^[\w-]{1,512}$/.test(v);
  if (!state || !ok(b.code) || !ok(b.wabaId) || (b.phoneNumberId != null && !ok(b.phoneNumberId))) return c.json({ message: "Something went wrong. Please try the link again." }, 400);
  try {
    const r = await finishWhatsAppSignup(state.t, { code: b.code, wabaId: b.wabaId, phoneNumberId: b.phoneNumberId ?? undefined }, "owner");
    return c.json({ ok: true, ...r });
  } catch (e: any) {
    console.error("whatsapp signup failed", state.t, e?.message);
    return c.json({ message: /already|duplicate|row-level/.test(String(e?.message)) ? "That number is already connected to another business." : "Meta didn't accept the connection. Please try again." }, 502);
  }
});

const whatsappSignupPage = (nonce: string, s: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect your WhatsApp</title>
<body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.6;font-size:18px">
<h1 style="font-size:1.5rem">Connect your WhatsApp Business number</h1>
<p>You'll sign in to Facebook in Meta's own window and choose the number you use in the WhatsApp Business app. You keep using the app exactly as now.</p>
<ul><li>Have your phone with the WhatsApp Business app to hand.</li><li>Your personal chats stay yours: people saved in your phone are left alone.</li></ul>
<button id="go" style="font-size:1.1rem;min-height:48px;padding:0 1.5rem;border-radius:8px;border:0;background:#1a7f37;color:#fff">Connect WhatsApp</button>
<p id="msg" role="status"></p>
<script nonce="${nonce}">
  var S = ${JSON.stringify(s)}, got = {}, msg = document.getElementById("msg");
  function say(t) { msg.textContent = t; }
  function finish() {
    if (!got.code || !got.wabaId) return;
    say("Connecting…");
    fetch("/connect/whatsapp/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ s: S, code: got.code, wabaId: got.wabaId, phoneNumberId: got.phoneNumberId }) })
      .then(function (r) { return r.json().then(function (j) { return [r.ok, j]; }); })
      .then(function (x) { say(x[0] ? "Connected ✓ " + (x[1].display || "Your number") + " is linked. You can close this page." : x[1].message); })
      .catch(function () { say("Something went wrong. Please try again."); });
  }
  window.addEventListener("message", function (e) {
    if (!/facebook\\.com$/.test(new URL(e.origin).hostname)) return;
    try {
      var d = JSON.parse(e.data);
      if (d.type !== "WA_EMBEDDED_SIGNUP") return;
      if (/^FINISH/.test(d.event)) { got.wabaId = d.data.waba_id; got.phoneNumberId = d.data.phone_number_id; finish(); }
      else if (d.event === "CANCEL") say("Stopped before the end. Press Connect WhatsApp to try again.");
      else if (d.event === "ERROR") say("Meta reported a problem: " + (d.data && d.data.error_message || "unknown"));
    } catch (_) {}
  });
  window.fbAsyncInit = function () { FB.init({ appId: ${JSON.stringify(env.metaAppId)}, autoLogAppEvents: true, xfbml: false, version: ${JSON.stringify(env.graphApiVersion)} }); };
  document.getElementById("go").addEventListener("click", function () {
    FB.login(function (r) { if (r.authResponse && r.authResponse.code) { got.code = r.authResponse.code; finish(); } else say("Stopped before the end. Press Connect WhatsApp to try again."); },
      { config_id: ${JSON.stringify(env.metaSignupConfigId)}, response_type: "code", override_default_response_type: true,
        extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" } });
  });
</script>
<script nonce="${nonce}" async defer crossorigin="anonymous" src="https://connect.facebook.net/en_US/sdk.js"></script>
</body>`;

const page = (msg: string) =>
  `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><p>${msg}</p></body>`;
