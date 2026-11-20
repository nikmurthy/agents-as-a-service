// Checkatrade leads. Checkatrade doesn't allow automated access, so a person makes the one decision that has to
// happen inside Checkatrade ("I'm interested" or "Not for me"). We suggest which, record what they chose, and
// once "I'm interested" reveals the customer's phone or email, they give it to us: from then on replies to that
// customer can go by email, WhatsApp or text like any other enquiry.
import type { Db } from "./db.js";
import { one, withTenant } from "./db.js";
import { audit } from "./audit.js";
import { normaliseEmail, normalisePhone } from "./channels/parse.js";
import type { TriageResult } from "./types.js";

export interface Suggestion { suggestion: "interested" | "not_for_me"; reason?: string }

/** Agents judge the message; this rule turns their judgement into a suggestion. */
export function suggestForLead(t: TriageResult): Suggestion {
  if (t.intent === "spam") return { suggestion: "not_for_me", reason: "This job is spam" };
  if (t.inServiceArea === false) return { suggestion: "not_for_me", reason: "Outside the area we cover" };
  if (t.nextStep === "ignore") return { suggestion: "not_for_me", reason: "Not the kind of work we do" };
  return { suggestion: "interested" };
}

/** The open Checkatrade lead for a conversation, if any. */
export const openLead = (db: Db, conversationId: string) =>
  one<{ id: string; job_url: string | null; job_ref: string | null; suggestion: string; suggestion_reason: string | null; decision: string; details_added_at: Date | null }>(db,
    "select * from checkatrade_leads where conversation_id = $1 order by created_at desc limit 1", [conversationId]);

/** Records a new Checkatrade lead (the first message of a job). Follow-up messages about the same job don't create one. */
export function isNewLead(structured?: Record<string, string> | null) {
  return structured?.["Checkatrade email"] !== "Message from the customer";
}
export async function recordLead(db: Db, msg: { id: string; conv_id: string; structured?: Record<string, string> | null }, s: Suggestion) {
  const ref = msg.structured?.["Job reference"] ?? null;
  const known = ref
    ? await one(db, "select 1 from checkatrade_leads where job_ref = $1", [ref])
    : await one(db, "select 1 from checkatrade_leads where conversation_id = $1 and created_at > now() - interval '14 days'", [msg.conv_id]);
  if (!isNewLead(msg.structured) || known) return;
  await db.query(
    `insert into checkatrade_leads (tenant_id, conversation_id, message_id, job_ref, job_url, suggestion, suggestion_reason)
     values (app_current_tenant(), $1, $2, $3, $4, $5, $6) on conflict (message_id) do nothing`,
    [msg.conv_id, msg.id, msg.structured?.["Job reference"] ?? null, msg.structured?.["Job link"] ?? null, s.suggestion, s.reason ?? null]);
}

/** The owner's decision on a draft is also their decision on the lead it answers. */
export async function decideLead(db: Db, draftId: string, decision: "interested" | "not_for_me", memberId: string | null) {
  await db.query(
    `update checkatrade_leads set decision = $2, decided_by = $3, decided_at = now()
     where decision = 'pending' and conversation_id = (select conversation_id from drafts where id = $1 and kind = 'reply')`,
    [draftId, decision, memberId]);
}

/** What to do in Checkatrade, in plain steps. */
export function checkatradeSteps(lead: { job_url: string | null; suggestion_reason?: string | null } | undefined, decision: "interested" | "not_for_me", reason?: string | null) {
  const open = lead?.job_url ? `Open the job: ${lead.job_url}` : "Open the job in the Checkatrade app (Jobs)";
  return decision === "interested"
    ? `1. ${open}\n2. Tap "I'm interested"\n3. Paste the reply below into the chat`
    : `1. ${open}\n2. Tap "Not for me"\n3. Choose: ${reason ?? lead?.suggestion_reason ?? "the reason that fits"}`;
}

/** Pulls a phone number and/or email address out of whatever the owner typed or pasted. */
export function findContactDetails(text: string): { email?: string; phone?: string } {
  const email = normaliseEmail(text.match(/[^\s<>(),;:]+@[^\s<>(),;:]+\.[a-z]{2,}/i)?.[0]);
  const raw = text.replace(/[^\s<>(),;:]+@[^\s<>(),;:]+/g, " ").match(/(?:\+44\s?|\b0)(?:\d[\s-]?){9,10}\b/)?.[0];
  const phone = raw ? normalisePhone(raw) : undefined;
  return { email, phone: phone && /^\+44\d{10}$/.test(phone) ? phone : undefined };
}

export type AddDetailsResult =
  | { ok: true; added: ("email" | "phone")[]; customer: string }
  | { ok: false; reason: "not_found" | "nothing_found" | "belongs_to_someone_else" };

/** Adds the customer's phone and/or email to the person in this conversation, so replies can go direct. */
export async function addContactDetails(tenantId: string, conversationId: string, details: { email?: string; phone?: string }, actor: string): Promise<AddDetailsResult> {
  const email = normaliseEmail(details.email);
  const phone = details.phone ? normalisePhone(details.phone) : undefined;
  if (!email && !phone) return { ok: false, reason: "nothing_found" };
  return withTenant(tenantId, async (db): Promise<AddDetailsResult> => {
    const conv = await one<{ contact_id: string; name: string | null }>(db,
      "select v.contact_id, ct.name from conversations v join contacts ct on ct.id = v.contact_id where v.id = $1", [conversationId]);
    if (!conv) return { ok: false, reason: "not_found" };
    const added: ("email" | "phone")[] = [];
    for (const [kind, value] of [["email", email], ["phone", phone]] as const) {
      if (!value) continue;
      const owner = await one<{ contact_id: string }>(db, "select contact_id from contact_identities where kind = $1 and value = $2", [kind, value]);
      if (owner && owner.contact_id !== conv.contact_id) return { ok: false, reason: "belongs_to_someone_else" };
      if (!owner) {
        await db.query("insert into contact_identities (tenant_id, contact_id, kind, value) values (app_current_tenant(), $1, $2, $3)", [conv.contact_id, kind, value]);
        added.push(kind);
      }
    }
    await db.query("update checkatrade_leads set details_added_at = coalesce(details_added_at, now()) where conversation_id = $1", [conversationId]);
    await db.query("update approval_requests set state = 'done', updated_at = now() where state = 'awaiting_details' and draft_id in (select id from drafts where conversation_id = $1)", [conversationId]);
    await audit(db, { tenantId, actor, action: "contact.details_added", entity: "conversation", entityId: conversationId, detail: { kinds: added } });
    return { ok: true, added, customer: conv.name ?? "the customer" };
  });
}
