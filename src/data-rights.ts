import { many, one, withTenant } from "./db.js";
import { audit } from "./audit.js";
import { releaseHold } from "./calendar.js";
import { normaliseEmail, normalisePhone } from "./channels/parse.js";

const identity = (who: { email?: string; phone?: string }) =>
  who.email ? { kind: "email", value: normaliseEmail(who.email)! } : { kind: "phone", value: normalisePhone(who.phone)! };

/** Everything held about one person at one business (subject access request). */
export async function exportPerson(tenantId: string, who: { email?: string; phone?: string }, requestedBy: string) {
  const id = identity(who);
  return withTenant(tenantId, async (db) => {
    const c = await one(db, "select c.* from contacts c join contact_identities i on i.contact_id = c.id where i.kind = $1 and i.value = $2", [id.kind, id.value]);
    if (!c) return undefined;
    const data = {
      contact: c,
      identities: await many(db, "select kind, value from contact_identities where contact_id = $1", [c.id]),
      messages: await many(db, "select m.direction, m.channel, m.subject, m.body, m.received_at, m.data_tags from messages m join conversations v on v.id = m.conversation_id where v.contact_id = $1 order by m.received_at", [c.id]),
      appointments: await many(db, "select service, start_at, end_at, status from holds where contact_id = $1", [c.id]),
    };
    await db.query("insert into data_requests (tenant_id, contact_id, kind, requested_by) values (app_current_tenant(), $1, 'export', $2)", [c.id, requestedBy]);
    await audit(db, { tenantId, actor: requestedBy, action: "data.exported", entity: "contact", entityId: c.id });
    return data;
  });
}

/** Erase one person: message text, drafts, contact details, held times. Keeps an audit record that it happened. */
export async function erasePerson(tenantId: string, who: { email?: string; phone?: string }, requestedBy: string): Promise<boolean> {
  const id = identity(who);
  return withTenant(tenantId, async (db) => {
    const c = await one(db, "select c.id from contacts c join contact_identities i on i.contact_id = c.id where i.kind = $1 and i.value = $2", [id.kind, id.value]);
    if (!c) return false;
    for (const h of await many(db, "select id from holds where contact_id = $1 and status in ('held', 'confirmed')", [c.id])) await releaseHold(db, h.id, "cancelled");
    await db.query("update messages set body = null, subject = null, structured = null, attachments = null, from_name = null where conversation_id in (select id from conversations where contact_id = $1)", [c.id]);
    await db.query("update drafts set body = '[erased]', original_body = '[erased]' where conversation_id in (select id from conversations where contact_id = $1)", [c.id]);
    await db.query("update outbox set body = '[erased]', to_address = null where conversation_id in (select id from conversations where contact_id = $1)", [c.id]);
    await db.query("update conversations set email_thread = null, status = 'closed' where contact_id = $1", [c.id]);
    await db.query("delete from contact_identities where contact_id = $1", [c.id]);
    await db.query("update contacts set name = null, erased_at = now() where id = $1", [c.id]);
    await db.query("insert into data_requests (tenant_id, contact_id, kind, requested_by) values (app_current_tenant(), $1, 'erase', $2)", [c.id, requestedBy]);
    await audit(db, { tenantId, actor: requestedBy, action: "data.erased", entity: "contact", entityId: c.id });
    return true;
  });
}

/** Opt-out: never send this person anything again from this business. */
export async function suppress(tenantId: string, who: { email?: string; phone?: string }, reason: string) {
  const id = identity(who);
  await withTenant(tenantId, async (db) => {
    await db.query("insert into suppression (tenant_id, kind, value, reason) values (app_current_tenant(), $1, $2, $3) on conflict do nothing", [id.kind, id.value, reason]);
    await audit(db, { tenantId, actor: "admin", action: "contact.suppressed" });
  });
}
