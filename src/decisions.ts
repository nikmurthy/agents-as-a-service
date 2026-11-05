import { one, withTenant } from "./db.js";
import { audit } from "./audit.js";
import { enqueue } from "./jobs/queue.js";
import { releaseHold } from "./calendar.js";

// The one place a draft is approved, edited or rejected. WhatsApp buttons and the web app both come through here,
// so the two can never disagree, and the row lock means a double tap (or two people at once) only acts once.

/** Who decided. `memberId` is null for a platform admin acting on a business they don't belong to. */
export interface DecisionActor { memberId: string | null; label: string; via: "whatsapp" | "web" }

export type Decision = { action: "approve" } | { action: "reject" } | { action: "edit"; body: string };

export type DecisionResult =
  | { outcome: "not_found" }
  | { outcome: "already_decided"; status: string }
  | { outcome: "approved" | "edited" | "rejected"; customer: string; route: string };

export async function decideDraft(tenantId: string, actor: DecisionActor, draftId: string, decision: Decision): Promise<DecisionResult> {
  const result = await withTenant(tenantId, async (db): Promise<DecisionResult> => {
    const d = await one(db,
      `select d.status, d.reply_route, coalesce(ct.name, 'the customer') as customer, r.booking
       from drafts d join conversations c on c.id = d.conversation_id join contacts ct on ct.id = c.contact_id
       left join runs r on r.id = d.run_id where d.id = $1 for update of d`, [draftId]);
    if (!d) return { outcome: "not_found" };
    if (d.status !== "pending_approval") return { outcome: "already_decided", status: d.status };
    const detail = { via: actor.via };
    const base = { tenantId, actor: actor.label, entity: "draft", entityId: draftId, detail };

    if (decision.action === "reject") {
      await db.query("update drafts set status = 'rejected', decided_by = $2, decided_at = now() where id = $1", [draftId, actor.memberId]);
      await db.query("update approval_requests set state = 'done', updated_at = now() where draft_id = $1", [draftId]);
      // Free any times we were holding for this reply.
      for (const h of d.booking?.action === "propose_slots" ? d.booking.holdIds ?? [] : []) await releaseHold(db, h, "released");
      await audit(db, { ...base, action: "draft.rejected" });
      return { outcome: "rejected", customer: d.customer, route: d.reply_route };
    }

    if (decision.action === "edit") {
      await db.query("update drafts set body = $2, status = 'approved', decided_by = $3, decided_at = now() where id = $1", [draftId, decision.body, actor.memberId]);
      await db.query("update approval_requests set state = 'done', updated_at = now() where draft_id = $1", [draftId]);
      await audit(db, { ...base, action: "draft.edited_and_approved" });
      return { outcome: "edited", customer: d.customer, route: d.reply_route };
    }

    await db.query("update drafts set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [draftId, actor.memberId]);
    await db.query("update approval_requests set state = 'done', updated_at = now() where draft_id = $1", [draftId]);
    await audit(db, { ...base, action: "draft.approved" });
    return { outcome: "approved", customer: d.customer, route: d.reply_route };
  });
  if (result.outcome === "approved" || result.outcome === "edited") {
    await enqueue("send_outbox", { tenantId, draftId }, { jobKey: `outbox:${draftId}` });
  }
  return result;
}
