import type { TaskList } from "graphile-worker";
import { many, withAdmin, withTenant } from "../db.js";
import { answerEnquiry } from "../workflows/answer-enquiry.js";
import { sendApproval } from "../approvals.js";
import { sendOutbox } from "../outbox.js";
import { pollAllGmail } from "../channels/gmail-poll.js";
import { releaseHold } from "../calendar.js";
import { audit } from "../audit.js";
import { enqueue } from "./queue.js";

export const taskList: TaskList = {
  process_inbound: async (p: any) => answerEnquiry(p.tenantId, p.messageId),
  send_approval: async (p: any) => sendApproval(p.tenantId, p.draftId),
  send_outbox: async (p: any, helpers) => sendOutbox(p.tenantId, p.draftId, helpers.job.attempts, helpers.job.max_attempts),

  // ---- scheduled (see crontab in worker.ts)
  poll_gmail: async () => { await pollAllGmail(); },

  /** Release held times the customer didn't pick in time. */
  expire_holds: async () => {
    const due = await withAdmin((db) => many<{ id: string; tenant_id: string }>(db, "select id, tenant_id from holds where status = 'held' and expires_at < now()"));
    for (const h of due) await withTenant(h.tenant_id, (db) => releaseHold(db, h.id, "expired"));
  },

  /** Safety net: any inbound message that never got processed (e.g. a crash between saving and queueing). */
  sweep_unprocessed: async () => {
    const stuck = await withAdmin((db) => many<{ id: string; tenant_id: string }>(db,
      `select m.id, m.tenant_id from messages m where m.direction = 'in' and m.created_at < now() - interval '3 minutes'
       and m.created_at > now() - interval '2 days' and not exists (select 1 from runs r where r.message_id = m.id) limit 100`));
    for (const m of stuck) await enqueue("process_inbound", { tenantId: m.tenant_id, messageId: m.id }, { jobKey: `inbound:${m.id}` });
  },

  /** Data retention: remove message text after each business's retention period (default 365 days). */
  retention: async () => {
    const tenants = await withAdmin((db) => many<{ id: string; days: number }>(db, "select id, coalesce((settings->>'retentionDays')::int, 365) as days from tenants"));
    for (const t of tenants) {
      await withTenant(t.id, async (db) => {
        const r = await db.query(
          "update messages set body = null, structured = null, attachments = null, subject = null where body is not null and received_at < now() - make_interval(days => $1)", [t.days]);
        const d = await db.query(
          "update drafts set body = '[removed under retention policy]', original_body = '[removed under retention policy]' where created_at < now() - make_interval(days => $1) and body <> '[removed under retention policy]'", [t.days]);
        if (r.rowCount || d.rowCount) await audit(db, { tenantId: t.id, actor: "system", action: "retention.applied", detail: { messages: r.rowCount, drafts: d.rowCount, days: t.days } });
      });
    }
  },
};

export const crontab = [
  "* * * * * poll_gmail",
  "*/15 * * * * expire_holds",
  "*/5 * * * * sweep_unprocessed",
  "30 3 * * * retention",
].join("\n");
