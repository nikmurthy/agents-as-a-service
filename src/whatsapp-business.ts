import type { Db } from "./db.js";
import { many, one, withAdmin, withTenant } from "./db.js";
import { audit } from "./audit.js";
import { encryptJson, phoneHash } from "./crypto.js";
import { clients } from "./integrations/index.js";
import { releaseHold } from "./calendar.js";
import type { WaEcho, WaSavedContact } from "./channels/parse.js";

/**
 * One WhatsApp number for a sole trader. The number they already use in the WhatsApp Business app is shared with
 * the platform (Meta "coexistence"), so customers, friends and family all message the same number. This module:
 * - leaves personal chats alone (people saved in their phone, unless already a customer; anyone they chose to ignore);
 * - notices when the owner answers a customer themselves in the app, and drops our draft so nobody gets two replies;
 * - connects the number through Meta's Embedded Signup.
 */

export interface WaNumber { tenantId: string; coexistence: boolean }

/** Which business a WhatsApp number belongs to. */
export async function businessForNumber(phoneNumberId: string): Promise<WaNumber | undefined> {
  const r = await withAdmin((db) => one<{ tenant_id: string; config: any }>(db,
    "select tenant_id, config from channel_connections where kind = 'whatsapp' and external_id = $1 and status = 'active'", [phoneNumberId]));
  return r && { tenantId: r.tenant_id, coexistence: r.config?.coexistence === true };
}

/**
 * Should a message from this number be read at all? On a shared number, someone saved in the owner's phone is
 * treated as personal unless they're already a customer, or the business chose "everyone" in Settings.
 * (People the owner chose to ignore are stopped in ingest(), for every channel.)
 */
export async function isForTheBusiness(n: WaNumber, from: string): Promise<boolean> {
  if (!n.coexistence) return true;
  return withTenant(n.tenantId, async (db) => {
    const t = await one<{ settings: any }>(db, "select settings from tenants where id = $1", [n.tenantId]);
    if (t?.settings?.whatsappPeople === "everyone") return true;
    if (await one(db, "select 1 from contact_identities where kind = 'phone' and value = $1", [from])) return true; // a customer already
    return !(await one(db, "select 1 from wa_saved_contacts where phone_hash = $1", [phoneHash(n.tenantId, from)]));
  });
}

/** Contacts from the owner's WhatsApp Business app. Only a keyed hash of each number is kept. */
export async function saveContacts(tenantId: string, items: WaSavedContact[]): Promise<void> {
  if (!items.length) return;
  await withTenant(tenantId, async (db) => {
    for (const c of items) {
      const h = phoneHash(tenantId, c.phone);
      if (c.action === "remove") await db.query("delete from wa_saved_contacts where phone_hash = $1", [h]);
      else await db.query("insert into wa_saved_contacts (tenant_id, phone_hash) values (app_current_tenant(), $1) on conflict do nothing", [h]);
    }
  });
}

/** Drops pending drafts in a conversation (never sent), freeing any times held for them. Returns how many. */
export async function dropPendingDrafts(db: Db, where: string, param: string): Promise<number> {
  const drafts = await many<{ id: string; booking: any }>(db,
    `select d.id, r.booking from drafts d left join runs r on r.id = d.run_id
     where d.status = 'pending_approval' and ${where} for update of d`, [param]);
  for (const d of drafts) {
    await db.query("update drafts set status = 'superseded', decided_at = now() where id = $1", [d.id]);
    await db.query("update approval_requests set state = 'done', updated_at = now() where draft_id = $1", [d.id]);
    for (const h of d.booking?.action === "propose_slots" ? d.booking.holdIds ?? [] : []) await releaseHold(db, h, "released");
  }
  return drafts.length;
}

/**
 * The owner sent a message from the WhatsApp Business app. If it's to a customer we're talking to, record it in the
 * conversation and drop any reply still waiting for approval. Messages to anyone else (friends, family) are ignored.
 */
export async function ownerReplied(tenantId: string, e: WaEcho): Promise<void> {
  await withTenant(tenantId, async (db) => {
    const conv = await one<{ id: string }>(db,
      `select c.id from contact_identities i join conversations c on c.contact_id = i.contact_id join contacts ct on ct.id = c.contact_id
       where i.kind = 'phone' and i.value = $1 and c.status = 'open' and ct.ignored_at is null order by c.created_at desc limit 1`, [e.to]);
    if (!conv) return;
    if (await one(db, "select 1 from messages where channel = 'whatsapp' and channel_message_id = $1", [e.id])) return; // seen it, or we sent it
    if (await one(db, "select 1 from outbox where provider_message_id = $1", [e.id])) return;
    await db.query(
      `insert into messages (tenant_id, conversation_id, direction, channel, channel_message_id, body, from_name, received_at)
       values (app_current_tenant(), $1, 'out', 'whatsapp', $2, $3, 'owner', $4)`,
      [conv.id, e.id, e.type === "text" ? (e.text ?? "") : `[${e.type} sent from the WhatsApp Business app]`,
       new Date(Number(e.timestamp) * 1000 || Date.now()).toISOString()]);
    const dropped = await dropPendingDrafts(db, "d.conversation_id = $1", conv.id);
    await audit(db, { tenantId, actor: "owner", action: "reply.owner_answered", entity: "conversation", entityId: conv.id, detail: { dropped } });
  });
}

/** "Ignore this person": drop what's waiting, forget their message text, and don't store or answer anything new from them. */
export async function ignorePerson(tenantId: string, conversationId: string, actor: string): Promise<boolean> {
  return withTenant(tenantId, async (db) => {
    const c = await one<{ contact_id: string }>(db, "select contact_id from conversations where id = $1", [conversationId]);
    if (!c) return false;
    await db.query("update contacts set ignored_at = now() where id = $1", [c.contact_id]);
    const dropped = await dropPendingDrafts(db, "d.conversation_id in (select id from conversations where contact_id = $1)", c.contact_id);
    await db.query("update messages set body = null, subject = null, structured = null, attachments = null where conversation_id in (select id from conversations where contact_id = $1)", [c.contact_id]);
    await db.query("update conversations set status = 'closed' where contact_id = $1", [c.contact_id]);
    await audit(db, { tenantId, actor, action: "contact.ignored", entity: "conversation", entityId: conversationId, detail: { dropped } });
    return true;
  });
}

export async function stopIgnoring(tenantId: string, conversationId: string, actor: string): Promise<boolean> {
  return withTenant(tenantId, async (db) => {
    const r = await one(db, "update contacts set ignored_at = null where id = (select contact_id from conversations where id = $1) returning id", [conversationId]);
    if (r) await audit(db, { tenantId, actor, action: "contact.unignored", entity: "conversation", entityId: conversationId });
    return !!r;
  });
}

/**
 * The end of Meta's Embedded Signup: swap the code for a token, ask Meta to send this number's messages to us,
 * store the connection (replacing any earlier WhatsApp number), and ask for the saved-contacts list once.
 * Message history is deliberately not requested: it would pull in personal chats.
 */
export async function finishWhatsAppSignup(tenantId: string, s: { code: string; wabaId: string; phoneNumberId?: string }, actor: string) {
  const { accessToken } = await clients.whatsapp.exchangeSignupCode(s.code);
  await clients.whatsapp.subscribeApp(s.wabaId, accessToken);
  // The Business-app flow may report only the account; its number is then the account's only one.
  const phoneNumberId = s.phoneNumberId ?? (await clients.whatsapp.accountNumbers(s.wabaId, accessToken))[0];
  if (!phoneNumberId) throw new Error("No phone number on that WhatsApp account");
  const sender = { phoneNumberId, accessToken };
  const info = await clients.whatsapp.numberInfo(sender);
  await withTenant(tenantId, async (db) => {
    await db.query("update channel_connections set status = 'disconnected' where kind = 'whatsapp' and external_id <> $1", [phoneNumberId]);
    await db.query(
      `insert into channel_connections (tenant_id, kind, external_id, label, secret_ciphertext, config) values (app_current_tenant(), 'whatsapp', $1, $2, $3, $4)
       on conflict (kind, external_id) do update set label = excluded.label, secret_ciphertext = excluded.secret_ciphertext, config = excluded.config, status = 'active', last_error = null`,
      [phoneNumberId, info.displayPhone ?? null, encryptJson({ accessToken }), { coexistence: info.onBusinessApp, wabaId: s.wabaId, verifiedName: info.verifiedName }]);
    await audit(db, { tenantId, actor, action: "whatsapp.connected", detail: { coexistence: info.onBusinessApp } });
  });
  if (info.onBusinessApp) {
    try {
      const r = await clients.whatsapp.requestContactSync(sender);
      await withTenant(tenantId, (db) => db.query(
        "update channel_connections set config = config || $2 where kind = 'whatsapp' and external_id = $1", [phoneNumberId, { contactSyncRequest: r.requestId ?? true }]));
    } catch (e) {
      // Not fatal: without the list, only the triage step keeps personal chats out. It can only be retried by reconnecting.
      console.error("contact sync request failed", tenantId, e instanceof Error ? e.message : e);
    }
  }
  return { display: info.displayPhone, coexistence: info.onBusinessApp };
}
