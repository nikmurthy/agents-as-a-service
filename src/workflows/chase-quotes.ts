import { many, one, withAdmin, withTenant } from "../db.js";
import { loadTenant, useCaseEnabled } from "../tenants.js";
import { audit } from "../audit.js";
import { enqueue } from "../jobs/queue.js";
import { chooseRoute } from "./answer-enquiry.js";
import type { Tenant } from "../types.js";

/**
 * Use case "chase quotes": a quote the owner marked as sent, with no word from the customer since,
 * gets one polite follow-up. The wording is a fixed template (no model needed) and goes through the usual
 * approval, so nothing reaches the customer unless the owner says so.
 */
export const CHASE_AFTER_DAYS = 3;
const STALE_AFTER_DAYS = 30;

export function chaseWording(tenant: Tenant, customer: string | null): string {
  const first = (customer ?? "").trim().split(/\s+/)[0];
  const signOff = tenant.settings.signOff?.trim();
  const sign = signOff && !signOff.includes("[") ? signOff : tenant.name; // pack templates ship a "[First name]" placeholder
  return `Hi${first ? " " + first : ""}, just a quick follow-up on the quote we sent over. Have you had a chance to look at it? Happy to answer any questions or adjust anything.\n\n${sign}`;
}

/** Daily sweep across all businesses: finds quotes that have gone quiet and hands each to its business. */
export async function chaseAllQuotes(): Promise<void> {
  const tenants = await withAdmin((db) => many<{ id: string }>(db,
    `select distinct c.tenant_id as id from conversations c join tenants t on t.id = c.tenant_id
     where t.status = 'active' and c.quoted_at is not null and c.chased_at is null`));
  for (const t of tenants) await chaseQuotes(t.id);
}

export async function chaseQuotes(tenantId: string, now = new Date()): Promise<number> {
  return withTenant(tenantId, async (db) => {
    if (!(await useCaseEnabled(db, "chase_quotes"))) return 0;
    const cfg = await one<{ config: { afterDays?: number } }>(db, "select config from tenant_use_cases where use_case = 'chase_quotes'");
    const afterDays = Math.max(1, Math.min(Number(cfg?.config?.afterDays) || CHASE_AFTER_DAYS, STALE_AFTER_DAYS));
    const tenant = await loadTenant(db, tenantId);
    if (tenant.status !== "active") return 0;

    const due = await many<any>(db,
      `select c.id, c.contact_id, c.whatsapp_window_closes_at, ct.name,
         (select value from contact_identities i where i.contact_id = c.contact_id and kind = 'email' limit 1) as email,
         (select value from contact_identities i where i.contact_id = c.contact_id and kind = 'phone' limit 1) as phone,
         (select m.channel from messages m where m.conversation_id = c.id and m.direction = 'in' order by m.received_at desc limit 1) as channel
       from conversations c join contacts ct on ct.id = c.contact_id
       where c.quoted_at is not null and c.chased_at is null and ct.erased_at is null
         and c.quoted_at <= $1::timestamptz - make_interval(days => $2) and c.quoted_at > $1::timestamptz - make_interval(days => $3)
         and (c.last_inbound_at is null or c.last_inbound_at <= c.quoted_at)
         and not exists (select 1 from drafts d where d.conversation_id = c.id and d.status = 'pending_approval')
       order by c.quoted_at limit 100`, [now, afterDays, STALE_AFTER_DAYS]);

    let made = 0;
    for (const c of due) {
      const suppressed = await one(db, "select 1 from suppression where value = any($1)", [[c.email, c.phone].filter(Boolean)]);
      if (suppressed) {
        await db.query("update conversations set chased_at = $2 where id = $1", [c.id, now]);
        await audit(db, { tenantId, actor: "system", action: "chase.skipped", entity: "conversation", entityId: c.id, detail: { reason: "opted_out" } });
        continue;
      }
      const windowOpen = !!c.whatsapp_window_closes_at && new Date(c.whatsapp_window_closes_at) > now;
      const route = await chooseRoute(db, tenant, c.channel ?? "email", { email: c.email, phone: c.phone }, { whatsappOpen: windowOpen });
      const body = chaseWording(tenant, c.name);
      const d = await one<{ id: string }>(db,
        `insert into drafts (tenant_id, conversation_id, kind, reply_route, body, original_body)
         values (app_current_tenant(), $1, 'chase', $2, $3, $3) returning id`, [c.id, route, body]);
      await db.query("update conversations set chased_at = $2 where id = $1", [c.id, now]);
      await audit(db, { tenantId, actor: "system", action: "chase.drafted", entity: "draft", entityId: d!.id, detail: { route } });
      await enqueue("send_approval", { tenantId, draftId: d!.id }, { jobKey: `approval:${d!.id}`, maxAttempts: 8 });
      made++;
    }
    return made;
  });
}
