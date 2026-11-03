import { many, one, withAdmin, withTenant, withTenantSession } from "./db.js";
import { clients } from "./integrations/index.js";
import { platformWaSender } from "./connections.js";
import { approvers } from "./tenants.js";
import { env } from "./env.js";
import { audit } from "./audit.js";
import { enqueue } from "./jobs/queue.js";
import { releaseHold } from "./calendar.js";
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
      `select d.*, t.name as business, m.channel, m.body as inbound, coalesce(m.from_name, ct.name) as customer
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
    const head = `${d.needs_attention ? "⚠️ " + d.attention_reason + "\n\n" : ""}${CHANNEL_LABEL[d.channel] ?? "New"} message from ${first}:\n"${clip(d.inbound ?? "", 300)}"`;
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
          [d.business, `${first} (${CHANNEL_LABEL[d.channel] ?? "message"})${d.needs_attention ? " ⚠️ " + d.attention_reason : ""}`, clip(d.body, 700)],
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
      const result = await withTenant(pending.tenant_id, async (db) => {
        const d = await one(db, "select status from drafts where id = $1 for update", [pending.draft_id]);
        if (d?.status !== "pending_approval") return "That draft has already been dealt with.";
        await db.query("update drafts set body = $2, status = 'approved', decided_by = $3, decided_at = now() where id = $1", [pending.draft_id, w.text, pending.member_id]);
        await db.query("update approval_requests set state = 'done', updated_at = now() where draft_id = $1", [pending.draft_id]);
        await audit(db, { tenantId: pending.tenant_id, actor: `member:${pending.member_id}`, action: "draft.edited_and_approved", entity: "draft", entityId: pending.draft_id });
        return "Got it. Sending your version now ✓";
      });
      await enqueue("send_outbox", { tenantId: pending.tenant_id, draftId: pending.draft_id }, { jobKey: `outbox:${pending.draft_id}` });
      await reply(result);
      return;
    }
  }
  await reply("Use the Approve, Edit or Reject buttons on a draft. After pressing Edit, send the reply exactly as you want it to go.");
}

async function decide(tenantId: string, memberId: string, draftId: string, action: "a" | "e" | "r"): Promise<string | undefined> {
  const out = await withTenant(tenantId, async (db) => {
    const d = await one(db,
      "select d.status, d.reply_route, coalesce(ct.name, 'the customer') as customer, r.booking from drafts d join conversations c on c.id = d.conversation_id join contacts ct on ct.id = c.contact_id left join runs r on r.id = d.run_id where d.id = $1 for update of d",
      [draftId]);
    if (!d) return { text: "Sorry, I couldn't find that draft." };
    if (d.status !== "pending_approval") return { text: `Already ${d.status.replace("_", " ")}.` };
    const first = d.customer.split(/\s+/)[0];
    if (action === "e") {
      await db.query("update approval_requests set state = 'awaiting_edit', updated_at = now() where draft_id = $1 and member_id = $2", [draftId, memberId]);
      return { text: `OK. Send me the reply to ${first} exactly as you want it to go.` };
    }
    if (action === "r") {
      await db.query("update drafts set status = 'rejected', decided_by = $2, decided_at = now() where id = $1", [draftId, memberId]);
      await db.query("update approval_requests set state = 'done', updated_at = now() where draft_id = $1", [draftId]);
      // Free any times we were holding for this reply.
      for (const h of d.booking?.action === "propose_slots" ? d.booking.holdIds ?? [] : []) await releaseHold(db, h, "released");
      await audit(db, { tenantId, actor: `member:${memberId}`, action: "draft.rejected", entity: "draft", entityId: draftId });
      return { text: `Rejected. Nothing was sent to ${first}.` };
    }
    await db.query("update drafts set status = 'approved', decided_by = $2, decided_at = now() where id = $1", [draftId, memberId]);
    await db.query("update approval_requests set state = 'done', updated_at = now() where draft_id = $1", [draftId]);
    await audit(db, { tenantId, actor: `member:${memberId}`, action: "draft.approved", entity: "draft", entityId: draftId });
    return { text: ["whatsapp", "email"].includes(d.reply_route) ? `Approved. Sending to ${first} now ✓` : undefined, send: true };
  });
  if ((out as any).send) await enqueue("send_outbox", { tenantId, draftId }, { jobKey: `outbox:${draftId}` });
  return out.text;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
