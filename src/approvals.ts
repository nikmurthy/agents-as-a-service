import { many, one, withAdmin, withTenant, withTenantSession } from "./db.js";
import { clients } from "./integrations/index.js";
import { platformWaSender } from "./connections.js";
import { approvers } from "./tenants.js";
import { env } from "./env.js";
import { audit } from "./audit.js";
import { approveDraft, editAndApproveDraft, rejectDraft, type Actor } from "./decisions.js";
import type { WaInbound } from "./channels/parse.js";

// Owners approve drafts on WhatsApp, from the platform's own number.
// Inside WhatsApp's 24-hour window (the owner messaged us recently) we send interactive buttons.
// Outside it, Meta only allows a pre-approved template, which carries the same three quick-reply buttons.

const ROUTE_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp", email: "email", checkatrade_message: "Checkatrade (you paste it in)", sms: "text (you send it)", phone: "phone call",
};
const CHANNEL_LABEL: Record<string, string> = { email: "Email", whatsapp: "WhatsApp", web_form: "Website form", checkatrade: "Checkatrade" };

export async function sendApproval(tenantId: string, draftId: string): Promise<void> {
  await withTenantSession(tenantId, async (db) => {
    const d = await one(db,
      `select d.*, t.name as business, d.kind, m.channel, m.body as inbound, coalesce(m.from_name, ct.name) as customer
       from drafts d join tenants t on t.id = d.tenant_id
       left join runs r on r.id = d.run_id left join messages m on m.id = r.message_id
       join conversations c on c.id = d.conversation_id join contacts ct on ct.id = c.contact_id
       where d.id = $1`, [draftId]);
    if (!d || d.status !== "pending_approval") return;
    const people = await approvers(db);
    if (!people.length) {
      await audit(db, { tenantId, actor: "system", action: "approval.no_approver", entity: "draft", entityId: draftId });
      return;
    }
    const first = (d.customer ?? "A customer").split(/\s+/)[0];
    const head = d.kind === "chase"
      ? `Quote follow-up for ${first}: no reply since you sent the quote.`
      : `${d.needs_attention ? "⚠️ " + d.attention_reason + "\n\n" : ""}${CHANNEL_LABEL[d.channel] ?? "New"} message from ${first}:\n"${clip(d.inbound ?? "", 300)}"`;
    const draftBlock = `Reply by ${ROUTE_LABEL[d.reply_route] ?? d.reply_route}:\n${d.body}`;
    const buttons = [{ id: `a:${draftId}`, title: "Approve" }, { id: `e:${draftId}`, title: "Edit" }, { id: `r:${draftId}`, title: "Reject" }];

    for (const p of people) {
      const windowOpen = p.approver_last_inbound_at && p.approver_last_inbound_at.getTime() > Date.now() - 23.5 * 3600_000;
      let sent: { id: string };
      if (windowOpen) {
        const body = `${d.business}\n\n${head}\n\n${draftBlock}`;
        if (body.length <= 1024) {
          sent = await clients.whatsapp.sendButtons(platformWaSender(), p.whatsapp_phone, body, buttons);
        } else {
          await clients.whatsapp.sendText(platformWaSender(), p.whatsapp_phone, body);
          sent = await clients.whatsapp.sendButtons(platformWaSender(), p.whatsapp_phone, `Approve this reply to ${first}?`, buttons);
        }
      } else {
        // Template body (set up once in Meta): "{{1}}: new message from {{2}}. Draft reply: {{3}}" with buttons Approve / Edit / Reject.
        sent = await clients.whatsapp.sendTemplate(platformWaSender(), p.whatsapp_phone, env.approvalTemplateName, env.approvalTemplateLang,
          [d.business, `${first} (${d.kind === "chase" ? "quote follow-up" : CHANNEL_LABEL[d.channel] ?? "message"})${d.needs_attention ? " ⚠️ " + d.attention_reason : ""}`, clip(d.body, 700)],
          buttons.map((b) => b.id));
      }
      await db.query("insert into approval_requests (tenant_id, draft_id, member_id, wa_message_id) values (app_current_tenant(), $1, $2, $3)", [draftId, p.id, sent.id]);
    }
    await audit(db, { tenantId, actor: "system", action: "approval.requested", entity: "draft", entityId: draftId, detail: { approvers: people.length } });
  });
}

/** A message from an owner to the platform number: a button press, or the new wording after "Edit". */
export async function handleOwnerMessage(w: WaInbound): Promise<void> {
  const members = await withAdmin((db) => many<{ id: string; tenant_id: string; name: string }>(db,
    "select id, tenant_id, name from tenant_members where whatsapp_phone = $1 and is_approver", [w.from]));
  const reply = (text: string) => clients.whatsapp.sendText(platformWaSender(), w.from, text);
  if (!members.length) return; // not someone we know: ignore
  await withAdmin((db) => db.query("update tenant_members set approver_last_inbound_at = now() where whatsapp_phone = $1", [w.from]));

  const button = w.buttonId?.match(/^([aer]):([0-9a-f-]{36})$/);
  if (button) {
    const [, action, draftId] = button;
    const owner = await withAdmin((db) => one<{ tenant_id: string }>(db, "select tenant_id from drafts where id = $1", [draftId]));
    const member = members.find((m) => m.tenant_id === owner?.tenant_id);
    if (!owner || !member) return void (await reply("Sorry, I couldn't find that draft."));
    const result = await decide(owner.tenant_id, member.id, draftId, action as "a" | "e" | "r");
    if (result) await reply(result);
    return;
  }

  // New wording after pressing Edit: the most recent pending edit across this person's businesses.
  if (w.type === "text" && w.text) {
    const pending = await withAdmin((db) => one<{ id: string; tenant_id: string; draft_id: string; member_id: string }>(db,
      `select ar.id, ar.tenant_id, ar.draft_id, ar.member_id from approval_requests ar
       where ar.member_id = any($1) and ar.state = 'awaiting_edit' order by ar.updated_at desc limit 1`, [members.map((m) => m.id)]));
    if (pending) {
      const r = await editAndApproveDraft(pending.tenant_id, memberActor(pending.member_id), pending.draft_id, w.text);
      await reply(r.ok ? "Got it. Sending your version now ✓" : "That draft has already been dealt with.");
      return;
    }
  }
  await reply("Use the Approve, Edit or Reject buttons on a draft. After pressing Edit, send the reply exactly as you want it to go.");
}

const memberActor = (memberId: string): Actor => ({ memberId, audit: `member:${memberId}` });

async function decide(tenantId: string, memberId: string, draftId: string, action: "a" | "e" | "r"): Promise<string | undefined> {
  const actor = memberActor(memberId);
  const info = await withTenant(tenantId, (db) => one<{ status: string; reply_route: string; customer: string }>(db,
    `select d.status, d.reply_route, coalesce(ct.name, 'the customer') as customer from drafts d
     join conversations c on c.id = d.conversation_id join contacts ct on ct.id = c.contact_id where d.id = $1`, [draftId]));
  if (!info) return "Sorry, I couldn't find that draft.";
  const first = info.customer.split(/\s+/)[0];

  if (action === "e") {
    if (info.status !== "pending_approval") return `Already ${info.status.replace("_", " ")}.`;
    await withTenant(tenantId, (db) => db.query("update approval_requests set state = 'awaiting_edit', updated_at = now() where draft_id = $1 and member_id = $2", [draftId, memberId]));
    return `OK. Send me the reply to ${first} exactly as you want it to go.`;
  }
  const r = action === "r" ? await rejectDraft(tenantId, actor, draftId) : await approveDraft(tenantId, actor, draftId);
  if (!r.ok) return r.reason === "not_found" ? "Sorry, I couldn't find that draft." : `Already ${(r.status ?? "dealt with").replace("_", " ")}.`;
  if (action === "r") return `Rejected. Nothing was sent to ${first}.`;
  return ["whatsapp", "email"].includes(r.route) ? `Approved. Sending to ${first} now ✓` : undefined;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
