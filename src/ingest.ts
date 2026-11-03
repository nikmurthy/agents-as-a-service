import type { Db } from "./db.js";
import { one, withTenant } from "./db.js";
import type { InboundMessage } from "./types.js";
import { tagData } from "./privacy.js";
import { audit } from "./audit.js";
import { enqueue } from "./jobs/queue.js";

/**
 * Every channel ends here. Stores the message once (de-duplicated on the source id), matches the person
 * across channels by email or phone, attaches it to their open conversation, and queues it for the agents.
 */
export async function ingest(tenantId: string, m: InboundMessage): Promise<string | undefined> {
  const messageId = await withTenant(tenantId, async (db) => {
    if (await one(db, "select 1 from messages where direction = 'in' and channel = $1 and channel_message_id = $2", [m.channel, m.channelMessageId])) {
      return undefined; // already have it (webhooks and Checkatrade can resend)
    }
    const tenant = await one<{ pack: string }>(db, "select pack from tenants where id = $1", [tenantId]);
    const contactId = await matchOrCreateContact(db, m);
    const conversationId = await openConversation(db, contactId, m);
    const tags = tagData(m, tenant!.pack);
    const row = await one<{ id: string }>(db,
      `insert into messages (tenant_id, conversation_id, direction, channel, channel_message_id, subject, body, structured, attachments, from_name, data_tags, received_at)
       values (app_current_tenant(), $1, 'in', $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [conversationId, m.channel, m.channelMessageId, m.subject ?? null, m.text, m.structured ?? null,
       m.attachments ? JSON.stringify(m.attachments) : null, m.from.name ?? null, tags, m.receivedAt]);
    await audit(db, { tenantId, actor: "system", action: "message.received", entity: "message", entityId: row!.id, detail: { channel: m.channel, tags } });
    return row!.id;
  });
  if (messageId) await enqueue("process_inbound", { tenantId, messageId }, { jobKey: `inbound:${messageId}` });
  return messageId;
}

async function matchOrCreateContact(db: Db, m: InboundMessage): Promise<string> {
  const ids: [string, string][] = [];
  if (m.from.email) ids.push(["email", m.from.email]);
  if (m.from.phone) ids.push(["phone", m.from.phone]);
  for (const [kind, value] of ids) {
    const found = await one<{ contact_id: string }>(db, "select contact_id from contact_identities where kind = $1 and value = $2", [kind, value]);
    if (found) {
      for (const [k, v] of ids) {
        await db.query("insert into contact_identities (tenant_id, contact_id, kind, value) values (app_current_tenant(), $1, $2, $3) on conflict do nothing", [found.contact_id, k, v]);
      }
      if (m.from.name) await db.query("update contacts set name = coalesce(name, $2) where id = $1", [found.contact_id, m.from.name]);
      return found.contact_id;
    }
  }
  const c = await one<{ id: string }>(db, "insert into contacts (tenant_id, name) values (app_current_tenant(), $1) returning id", [m.from.name ?? null]);
  for (const [kind, value] of ids) {
    await db.query("insert into contact_identities (tenant_id, contact_id, kind, value) values (app_current_tenant(), $1, $2, $3) on conflict do nothing", [c!.id, kind, value]);
  }
  return c!.id;
}

async function openConversation(db: Db, contactId: string, m: InboundMessage): Promise<string> {
  const existing = await one<{ id: string }>(db,
    "select id from conversations where contact_id = $1 and status = 'open' and coalesce(last_inbound_at, created_at) > now() - interval '30 days' order by created_at desc limit 1",
    [contactId]);
  const windowCloses = m.channel === "whatsapp" ? new Date(Date.parse(m.receivedAt) + 24 * 3600_000) : null;
  const thread = m.email ? JSON.stringify({ ...m.email, subject: m.subject }) : null;
  if (existing) {
    await db.query(
      `update conversations set last_inbound_at = $2,
         whatsapp_window_closes_at = coalesce($3, whatsapp_window_closes_at),
         email_thread = coalesce($4::jsonb, email_thread) where id = $1`,
      [existing.id, m.receivedAt, windowCloses, thread]);
    return existing.id;
  }
  const c = await one<{ id: string }>(db,
    "insert into conversations (tenant_id, contact_id, last_inbound_at, whatsapp_window_closes_at, email_thread) values (app_current_tenant(), $1, $2, $3, $4) returning id",
    [contactId, m.receivedAt, windowCloses, thread]);
  return c!.id;
}
