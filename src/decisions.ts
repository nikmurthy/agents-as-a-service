import { one, withTenant } from "./db.js";
import { audit } from "./audit.js";
import { enqueue } from "./jobs/queue.js";
import { releaseHold } from "./calendar.js";
import { decideLead } from "./leads.js";
import { afterDecision, type Category } from "./automation.js";

// The one place a draft is approved, edited or rejected. The WhatsApp buttons and the web app both call
// these, so the two can never disagree about what a decision does.

export interface Actor {
  /** tenant_members.id, when the decider is a member of the business. Null for a platform admin. */
  memberId: string | null;
  /** Written to the audit log: member:<id> or admin:<email>. */
  audit: string;
}

export type DecisionResult =
  | { ok: true; customer: string; route: string; lead?: { job_url: string | null; suggestion_reason: string | null; decision: "interested" | "not_for_me" };
      /** "Learn then offer to automate": a note for the owner, and the kind of reply to offer, if any. */
      automation?: { text: string; offer?: Category } }
  | { ok: false; reason: "not_found" | "already_decided"; status?: string };

type Decision = { kind: "approve" } | { kind: "reject" } | { kind: "edit"; body: string };

async function decide(tenantId: string, actor: Actor, draftId: string, decision: Decision): Promise<DecisionResult> {
  const result = await withTenant(tenantId, async (db): Promise<DecisionResult> => {
    const d = await one(db,
      `select d.status, d.reply_route, coalesce(ct.name, 'the customer') as customer, r.booking
       from drafts d join conversations c on c.id = d.conversation_id join contacts ct on ct.id = c.contact_id
       left join runs r on r.id = d.run_id where d.id = $1 for update of d`, [draftId]);
    if (!d) return { ok: false, reason: "not_found" };
    if (d.status !== "pending_approval") return { ok: false, reason: "already_decided", status: d.status };

    if (decision.kind === "reject") {
      await db.query("update drafts set status = 'rejected', decided_by = $2, decided_at = now() where id = $1", [draftId, actor.memberId]);
      // Free any times we were holding for this reply.
      for (const h of d.booking?.action === "propose_slots" ? d.booking.holdIds ?? [] : []) await releaseHold(db, h, "released");
    } else if (decision.kind === "edit") {
      await db.query("update drafts set body = $2, status = 'approved', decided_by = $3, decided_at = now() where id = $1", [draftId, decision.body, actor.memberId]);
    } else {
      await db.query("update drafts set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [draftId, actor.memberId]);
    }
    await db.query("update approval_requests set state = 'done', updated_at = now() where draft_id = $1", [draftId]);
    // Answering a new Checkatrade lead: approving means "I'm interested", rejecting means "Not for me".
    const pending = await one(db,
      `select l.job_url, l.suggestion_reason from checkatrade_leads l join drafts d on d.conversation_id = l.conversation_id
       where d.id = $1 and d.kind = 'reply' and l.decision = 'pending' order by l.created_at desc limit 1`, [draftId]);
    const leadDecision = decision.kind === "reject" ? "not_for_me" as const : "interested" as const;
    if (pending) await decideLead(db, draftId, leadDecision, actor.memberId);
    const action = { approve: "draft.approved", reject: "draft.rejected", edit: "draft.edited_and_approved" }[decision.kind];
    await audit(db, { tenantId, actor: actor.audit, action, entity: "draft", entityId: draftId });
    return { ok: true, customer: d.customer, route: d.reply_route, lead: pending ? { ...pending, decision: leadDecision } : undefined };
  });
  if (result.ok && decision.kind !== "reject") {
    await enqueue("send_outbox", { tenantId, draftId }, { jobKey: `outbox:${draftId}` });
  }
  if (result.ok) result.automation = await afterDecision(tenantId, draftId, actor.memberId);
  return result;
}

export const approveDraft = (tenantId: string, actor: Actor, draftId: string) => decide(tenantId, actor, draftId, { kind: "approve" });
export const rejectDraft = (tenantId: string, actor: Actor, draftId: string) => decide(tenantId, actor, draftId, { kind: "reject" });
export const editAndApproveDraft = (tenantId: string, actor: Actor, draftId: string, body: string) => decide(tenantId, actor, draftId, { kind: "edit", body });
