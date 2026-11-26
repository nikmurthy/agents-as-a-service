import { many, one, withAdmin, withTenant } from "../db.js";
import { loadTenant, useCaseEnabled } from "../tenants.js";
import { audit } from "../audit.js";
import { chooseRoute } from "./answer-enquiry.js";
import { approveOrAsk, queueNext, type NextStep } from "../automation.js";
import type { Tenant } from "../types.js";

/**
 * Use case "ask for feedback": once the job is done, ask the customer how it went, once.
 * "Done" means a booked appointment has ended, or the owner marked the job as done in the Inbox.
 * The wording is a fixed template and goes through the usual approval (or automation, if the owner switched it on).
 * Everyone is asked the same way: we never pick only happy customers to ask for a review.
 */
export const FEEDBACK_AFTER_DAYS = 1;
const TOO_OLD_DAYS = 14;

export interface FeedbackConfig { afterDays?: number; reviewLink?: string }

export function feedbackWording(tenant: Tenant, customer: string | null, reviewLink?: string): string {
  const first = (customer ?? "").trim().split(/\s+/)[0];
  const signOff = tenant.settings.signOff?.trim();
  const sign = signOff && !signOff.includes("[") ? signOff : tenant.name;
  const ask = reviewLink
    ? `If you have a minute, we'd really appreciate a short review: ${reviewLink}`
    : "If you have a minute, just reply and let us know how we did. We'd really appreciate it.";
  return `Hi${first ? " " + first : ""}, thanks again for choosing ${tenant.name}. We hope you're happy with everything. ${ask}\n\n${sign}`;
}

/** Daily sweep across all businesses with the use case on. */
export async function askAllFeedback(): Promise<void> {
  const tenants = await withAdmin((db) => many<{ id: string }>(db,
    `select u.tenant_id as id from tenant_use_cases u join tenants t on t.id = u.tenant_id
     where u.use_case = 'ask_feedback' and u.enabled and t.status = 'active'`));
  for (const t of tenants) await askFeedback(t.id);
}

export async function askFeedback(tenantId: string, now = new Date()): Promise<number> {
  const next: (NextStep | undefined)[] = [];
  const made = await withTenant(tenantId, async (db) => {
    if (!(await useCaseEnabled(db, "ask_feedback"))) return 0;
    const cfg = (await one<{ config: FeedbackConfig }>(db, "select config from tenant_use_cases where use_case = 'ask_feedback'"))?.config ?? {};
    const afterDays = Math.max(0, Math.min(Number(cfg.afterDays ?? FEEDBACK_AFTER_DAYS) || 0, TOO_OLD_DAYS - 1));
    const tenant = await loadTenant(db, tenantId);
    if (tenant.status !== "active") return 0;

    // Done = the last booked appointment ended, or the owner marked the job done. Not too long ago, asked once.
    const due = await many<any>(db,
      `select c.id, c.whatsapp_window_closes_at, ct.name,
         (select value from contact_identities i where i.contact_id = c.contact_id and kind = 'email' limit 1) as email,
         (select value from contact_identities i where i.contact_id = c.contact_id and kind = 'phone' limit 1) as phone,
         (select m.channel from messages m where m.conversation_id = c.id and m.direction = 'in' order by m.received_at desc limit 1) as channel
       from conversations c join contacts ct on ct.id = c.contact_id
       cross join lateral (select greatest(c.completed_at,
         (select max(h.end_at) from holds h where h.conversation_id = c.id and h.status = 'confirmed')) as done_at) x
       where c.feedback_asked_at is null and ct.erased_at is null and x.done_at is not null
         and x.done_at <= $1::timestamptz - make_interval(days => $2) and x.done_at > $1::timestamptz - make_interval(days => $3)
         and not exists (select 1 from holds h where h.conversation_id = c.id and h.status = 'confirmed' and h.end_at > $1)
         and not exists (select 1 from drafts d where d.conversation_id = c.id and d.status = 'pending_approval')
       order by x.done_at limit 100`, [now, afterDays, TOO_OLD_DAYS]);

    let n = 0;
    for (const c of due) {
      await db.query("update conversations set feedback_asked_at = $2 where id = $1", [c.id, now]);
      const suppressed = await one(db, "select 1 from suppression where value = any($1)", [[c.email, c.phone].filter(Boolean)]);
      if (suppressed) {
        await audit(db, { tenantId, actor: "system", action: "feedback.skipped", entity: "conversation", entityId: c.id, detail: { reason: "opted_out" } });
        continue;
      }
      const windowOpen = !!c.whatsapp_window_closes_at && new Date(c.whatsapp_window_closes_at) > now;
      const route = await chooseRoute(db, tenant, c.channel ?? "email", { email: c.email, phone: c.phone }, { whatsappOpen: windowOpen });
      const body = feedbackWording(tenant, c.name, cfg.reviewLink);
      const d = await one<{ id: string }>(db,
        `insert into drafts (tenant_id, conversation_id, kind, category, reply_route, body, original_body)
         values (app_current_tenant(), $1, 'feedback', 'feedback_request', $2, $3, $3) returning id`, [c.id, route, body]);
      await audit(db, { tenantId, actor: "system", action: "feedback.drafted", entity: "draft", entityId: d!.id, detail: { route } });
      next.push(await approveOrAsk(db, tenant, d!.id));
      n++;
    }
    return n;
  });
  for (const s of next) await queueNext(s);
  return made;
}
