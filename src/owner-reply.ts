import type { Db } from "./db.js";
import { one, withTenant } from "./db.js";
import { audit } from "./audit.js";
import { enqueue } from "./jobs/queue.js";
import { loadTenant } from "./tenants.js";
import { chooseRoute } from "./workflows/answer-enquiry.js";
import { dropPendingDrafts } from "./whatsapp-business.js";
import type { Actor } from "./decisions.js";

/**
 * The owner writes their own reply from the Inbox. It goes the same way an approved reply would (WhatsApp or email),
 * after the owner has seen exactly what goes and how. Routes we can't send from here (text, phone, Checkatrade, or
 * WhatsApp more than 24 hours after the customer's last message) are refused with the reason, not queued.
 */

export interface ReplyPlan {
  canSend: boolean;
  route: string;
  customer: string;
  /** Where it goes, as shown to the owner: their number or email. The owner can see these already. */
  to: string | null;
  /** Why it can't be sent from here, in a sentence. */
  reason?: string;
  /** Replies still waiting for approval that this one replaces. */
  replaces: number;
}

const SENDABLE = new Set(["whatsapp", "email"]);

async function plan(db: Db, tenantId: string, convId: string): Promise<ReplyPlan | undefined> {
  const c = await one<any>(db,
    `select c.id, c.whatsapp_window_closes_at, ct.name, ct.ignored_at,
       (select channel from messages m where m.conversation_id = c.id and m.direction = 'in' order by m.received_at desc limit 1) as channel,
       (select value from contact_identities i where i.contact_id = c.contact_id and kind = 'email' limit 1) as email,
       (select value from contact_identities i where i.contact_id = c.contact_id and kind = 'phone' limit 1) as phone,
       (select count(*)::int from drafts d where d.conversation_id = c.id and d.status = 'pending_approval') as pending
     from conversations c join contacts ct on ct.id = c.contact_id where c.id = $1`, [convId]);
  if (!c) return undefined;
  const customer = (c.name ?? "").trim().split(/\s+/)[0] || "the customer";
  const whatsappOpen = !!c.whatsapp_window_closes_at && new Date(c.whatsapp_window_closes_at) > new Date();
  const tenant = await loadTenant(db, tenantId);
  const route = await chooseRoute(db, tenant, c.channel ?? "whatsapp", { email: c.email ?? undefined, phone: c.phone ?? undefined }, { whatsappOpen });
  const base = { route, customer, replaces: c.pending, to: route === "email" ? c.email : c.phone };
  if (c.ignored_at) return { ...base, canSend: false, reason: `You chose to ignore ${customer}. Stop ignoring them first.` };
  const addresses = [c.phone, c.email].filter(Boolean);
  if (addresses.length && await one(db, "select 1 from suppression where value = any($1)", [addresses]))
    return { ...base, canSend: false, reason: `${customer} has asked not to be contacted.` };
  if (!SENDABLE.has(route)) {
    const why = c.channel === "whatsapp" && !whatsappOpen
      ? `WhatsApp only allows replies within 24 hours of ${customer}'s last message. Message them from your phone instead.`
      : `This can't be sent from here. Send it yourself${c.phone ? ` (${c.phone})` : ""}.`;
    return { ...base, canSend: false, reason: why };
  }
  return { ...base, canSend: true };
}

export function replyPlan(tenantId: string, convId: string) {
  return withTenant(tenantId, (db) => plan(db, tenantId, convId));
}

export async function sendOwnerReply(tenantId: string, actor: Actor, convId: string, body: string):
  Promise<{ ok: true; plan: ReplyPlan } | { ok: false; reason: string; notFound?: boolean }> {
  const r = await withTenant(tenantId, async (db) => {
    const p = await plan(db, tenantId, convId);
    if (!p) return { ok: false as const, reason: "Not found", notFound: true };
    if (!p.canSend) return { ok: false as const, reason: p.reason! };
    // Whatever was waiting for approval is replaced by what the owner wrote: nobody gets two replies.
    await dropPendingDrafts(db, "d.conversation_id = $1", convId);
    const d = await one<{ id: string }>(db,
      `insert into drafts (tenant_id, conversation_id, reply_route, body, original_body, status, decided_by, decided_at)
       values (app_current_tenant(), $1, $2, $3, $3, 'approved', $4, now()) returning id`, [convId, p.route, body, actor.memberId]);
    await audit(db, { tenantId, actor: actor.audit, action: "reply.owner_written", entity: "draft", entityId: d!.id, detail: { route: p.route, replaced: p.replaces } });
    return { ok: true as const, plan: p, draftId: d!.id };
  });
  if (!r.ok) return r;
  await enqueue("send_outbox", { tenantId, draftId: r.draftId }, { jobKey: `outbox:${r.draftId}` });
  return { ok: true, plan: r.plan };
}
