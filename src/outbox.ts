import { one, withTenantSession } from "./db.js";
import { clients } from "./integrations/index.js";
import { buildEmail } from "./integrations/google.js";
import { getConnection, googleToken, platformWaSender, tenantWaSender } from "./connections.js";
import { approvers } from "./tenants.js";
import { audit } from "./audit.js";

/**
 * Sends an approved draft by its route. WhatsApp and email go automatically. Checkatrade, text and phone
 * have no sending API here, so the owner gets the final wording to paste or say, and the draft is marked "manual".
 */
export async function sendOutbox(tenantId: string, draftId: string, attempt = 1, maxAttempts = 5): Promise<void> {
  await withTenantSession(tenantId, async (db) => {
    const d = await one(db,
      `select d.*, c.whatsapp_window_closes_at, c.email_thread, coalesce(ct.name, '') as customer,
              (select value from contact_identities i where i.contact_id = c.contact_id and kind = 'email' limit 1) as email,
              (select value from contact_identities i where i.contact_id = c.contact_id and kind = 'phone' limit 1) as phone
       from drafts d join conversations c on c.id = d.conversation_id join contacts ct on ct.id = c.contact_id where d.id = $1`, [draftId]);
    if (!d || d.status !== "approved") return;
    const to = d.reply_route === "email" ? d.email : d.phone;
    const ob = (await one(db, "select * from outbox where draft_id = $1", [draftId]))
      ?? (await one(db, "insert into outbox (tenant_id, draft_id, conversation_id, route, to_address, body) values (app_current_tenant(), $1, $2, $3, $4, $5) returning *",
        [draftId, d.conversation_id, d.reply_route, to ?? null, d.body]));
    if (ob.status !== "queued") return;

    const fail = async (reason: string, tellOwner: boolean) => {
      await db.query("update outbox set status = 'failed', error = $2, attempts = attempts + 1 where id = $1", [ob.id, reason]);
      await db.query("update drafts set status = 'failed' where id = $1", [draftId]);
      await audit(db, { tenantId, actor: "system", action: "reply.failed", entity: "draft", entityId: draftId, detail: { reason } });
      if (tellOwner) await notifyOwners(db, `Couldn't send your reply to ${first(d.customer)}: ${reason}\n\nHere it is to send yourself:\n\n${d.body}`);
    };
    const done = async (status: "sent" | "manual", providerId?: string) => {
      await db.query("update outbox set status = $2, provider_message_id = $3, sent_at = now(), attempts = attempts + 1 where id = $1", [ob.id, status, providerId ?? null]);
      await db.query("update drafts set status = $2 where id = $1", [draftId, status]);
      await db.query(
        "insert into messages (tenant_id, conversation_id, direction, channel, channel_message_id, body, received_at) values (app_current_tenant(), $1, 'out', $2, $3, $4, now())",
        [d.conversation_id, d.reply_route, providerId ?? null, d.body]);
      await audit(db, { tenantId, actor: "system", action: `reply.${status}`, entity: "draft", entityId: draftId, detail: { route: d.reply_route } });
    };

    if (to && (await one(db, "select 1 from suppression where value = $1", [to]))) return fail("this person has opted out of messages", true);

    try {
      if (d.reply_route === "whatsapp") {
        if (!d.phone) return fail("no mobile number for this customer", true);
        if (!d.whatsapp_window_closes_at || new Date(d.whatsapp_window_closes_at) < new Date()) {
          // Free-form WhatsApp messages are only allowed within 24 hours of the customer's last message.
          return fail("WhatsApp only allows replies within 24 hours of the customer's last message", true);
        }
        const sender = await tenantWaSender(db);
        if (!sender) return fail("your WhatsApp number isn't connected", true);
        const r = await clients.whatsapp.sendText(sender, d.phone, d.body);
        return done("sent", r.id);
      }
      if (d.reply_route === "email") {
        if (!d.email) return fail("no email address for this customer", true);
        const conn = await getConnection(db, "gmail");
        if (!conn) return fail("your Gmail isn't connected", true);
        const thread = d.email_thread ?? {};
        const subject = thread.subject ? (/^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`) : "Your enquiry";
        const raw = buildEmail({ from: conn.external_id, to: d.email, subject, body: d.body, inReplyTo: thread.messageId });
        const r = await clients.google.gmailSend(await googleToken(db, conn), raw, thread.threadId);
        return done("sent", r.id);
      }
      // Manual routes: hand the final wording to the owner.
      const how = d.reply_route === "checkatrade_message" ? "Paste this into Checkatrade"
        : d.reply_route === "sms" ? `Text this to ${d.phone ?? "the customer"}`
        : `Call ${first(d.customer)}${d.phone ? ` on ${d.phone}` : ""}. Suggested wording`;
      await notifyOwners(db, `${how}:\n\n${d.body}`);
      return done("manual");
    } catch (e: any) {
      if (attempt >= maxAttempts) return fail(String(e?.message ?? e), true);
      await db.query("update outbox set attempts = attempts + 1, error = $2 where id = $1", [ob.id, String(e?.message ?? e)]);
      throw e; // retried by the queue with backoff
    }
  });
}

async function notifyOwners(db: any, text: string) {
  for (const p of await approvers(db)) await clients.whatsapp.sendText(platformWaSender(), p.whatsapp_phone, text);
}
const first = (s: string) => (s || "the customer").split(/\s+/)[0];
