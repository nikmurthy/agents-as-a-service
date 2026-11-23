import type { Db } from "../db.js";
import { many } from "../db.js";
import { CATEGORIES, type Category } from "../automation.js";

// "What happened": the audit log told as plain sentences for the owner, each saying what happened, to whom, and why.
// Built from ids in the audit log joined to names; message text is never part of it.

export interface FeedItem {
  id: number;
  at: string;
  /** Who acted: you (a person at the business), the assistant, or the customer. Drives the icon and colour. */
  who: "you" | "assistant" | "customer" | "platform";
  text: string;
  why?: string;
  conversationId?: string;
  /** Set when this was an automatic send of a kind that is still automatic: the owner can switch it back to asking. */
  automatic?: Category;
}

const ROUTE: Record<string, string> = { whatsapp: "WhatsApp", email: "email", checkatrade_message: "Checkatrade", sms: "text", phone: "phone" };
const CHANNEL: Record<string, string> = { whatsapp: "WhatsApp", email: "email", web_form: "your website form", checkatrade: "Checkatrade", sms: "text" };
const USE_CASE: Record<string, string> = {
  answer_enquiries: "Answering enquiries", book_appointments: "Booking", chase_quotes: "Chasing quotes", ask_feedback: "Asking for feedback",
};
const label = (c?: string | null) => (c && c in CATEGORIES ? CATEGORIES[c as Category].label : "");
const first = (s?: string | null) => (s ?? "").trim().split(/\s+/)[0] || "a customer";

/** Short local date and time, e.g. "Tue 25 Nov, 09:00". */
export function shortWhen(d: Date | string, tz: string, withTime = true): string {
  return new Date(d).toLocaleString("en-GB", {
    timeZone: tz, weekday: "short", day: "numeric", month: "short", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

export async function feed(db: Db, tz: string, opts: { limit?: number; before?: number } = {}): Promise<FeedItem[]> {
  const rows = await many<any>(db,
    `select a.id, a.at, a.actor, a.action, a.entity, a.entity_id, a.detail,
       coalesce(m.name, case when a.actor like 'admin:%' then 'The platform team' end) as actor_name,
       d.kind as draft_kind, d.category, d.reply_route, d.auto_sent, d.conversation_id as draft_conv,
       coalesce(dc.name, hc.name, mc.name, cc.name) as customer,
       h.start_at, h.expires_at, h.service, h.conversation_id as hold_conv,
       msg.channel as msg_channel, msg.conversation_id as msg_conv,
       au.state as auto_state, au.updated_at as auto_since,
       ar.state as cat_state, ar.updated_at as cat_since
     from audit_log a
     left join tenant_members m on a.actor = 'member:' || m.id::text
     left join drafts d on a.entity = 'draft' and d.id::text = a.entity_id
     left join conversations dv on dv.id = d.conversation_id left join contacts dc on dc.id = dv.contact_id
     left join holds h on a.entity = 'hold' and h.id::text = a.entity_id
     left join contacts hc on hc.id = h.contact_id
     left join messages msg on a.entity = 'message' and msg.id::text = a.entity_id
     left join conversations mv on mv.id = msg.conversation_id left join contacts mc on mc.id = mv.contact_id
     left join conversations cv on a.entity = 'conversation' and cv.id::text = a.entity_id left join contacts cc on cc.id = cv.contact_id
     left join automations au on au.category = d.category
     left join automations ar on a.entity = 'automation' and ar.category = a.entity_id
     where ($1::bigint is null or a.id < $1)
       and a.action not in ('approval.requested', 'platform.key_tested', 'run.ready_for_approval', 'run.needs_attention')
     order by a.id desc limit $2`, [opts.before ?? null, opts.limit ?? 60]);
  return rows.map((r) => describe(r, tz)).filter((x): x is FeedItem => !!x);
}

/** One audit row as a sentence. Unknown actions are left out rather than shown as jargon. */
export function describe(r: any, tz: string): FeedItem | undefined {
  const base = { id: Number(r.id), at: new Date(r.at).toISOString() };
  const you = r.actor_name ?? "You";
  const name = first(r.customer);
  const by = ROUTE[r.reply_route] ?? r.reply_route;
  const kind = r.draft_kind === "chase" ? "quote follow-up" : r.draft_kind === "feedback" ? "feedback request" : "reply";
  const conv = r.draft_conv ?? r.hold_conv ?? r.msg_conv ?? (r.entity === "conversation" ? r.entity_id : undefined);
  const item = (who: FeedItem["who"], text: string, why?: string, extra: Partial<FeedItem> = {}): FeedItem =>
    ({ ...base, who, text, ...(why ? { why } : {}), ...(conv ? { conversationId: conv } : {}), ...extra });

  switch (r.action) {
    case "message.received":
      return item("customer", `New message from ${name} by ${CHANNEL[r.msg_channel] ?? CHANNEL[r.detail?.channel] ?? "message"}.`);
    case "run.escalated":
      return item("assistant", "A message needs you. It looked like a complaint, an emergency or a health question, so it's waiting for you and won't be sent automatically.");
    case "run.ignored":
      return item("assistant", "A message was set aside as spam or a personal chat. Nothing was sent.");
    case "run.skipped":
      return item("assistant", "A message was kept but not answered, because the business was paused or still being set up.");
    case "booking.held":
      return item("assistant", `Pencilled in ${shortWhen(r.start_at, tz)} in your calendar for ${name}.`,
        r.expires_at ? `Released on ${shortWhen(r.expires_at, tz, false)} if ${name} doesn't pick it.` : undefined);
    case "booking.confirmed":
      return item("customer", `${name} picked ${shortWhen(r.start_at, tz)}. It's booked in your calendar, and the other times were released.`);
    case "booking.cancelled":
      return item("you", `${you} released ${r.start_at ? shortWhen(r.start_at, tz) : "a time"}${r.customer ? ` for ${name}` : ""}.`);
    case "draft.approved":
      return item("you", `${you} approved the ${kind} to ${name}.`);
    case "draft.edited_and_approved":
      return item("you", `${you} changed the ${kind} to ${name}, then approved it.`);
    case "draft.rejected":
      return item("you", `${you} rejected the ${kind} to ${name}. Nothing was sent.`);
    case "draft.auto_approved":
      return undefined; // told once it's actually sent (reply.sent)
    case "reply.sent": {
      if (r.auto_sent) {
        const still = r.auto_state === "on";
        return item("assistant", `Sent the ${kind} to ${name} automatically by ${by}.`,
          `You said yes to sending "${label(r.category)}" replies automatically${r.auto_since && still ? ` on ${shortWhen(r.auto_since, tz, false)}` : ""}.`,
          still ? { automatic: r.category } : {});
      }
      return item("assistant", `Sent the ${kind} to ${name} by ${by}.`);
    }
    case "reply.manual":
      return item("assistant", `Gave you the wording for ${name}, to send yourself by ${by}.`, "This route can't be sent automatically.");
    case "reply.failed":
      return item("assistant", `Couldn't send the ${kind} to ${name}. You were sent the wording to send yourself.`);
    case "chase.drafted":
      return item("assistant", `Wrote a follow-up to ${name} about their quote.`, "They hadn't replied since you marked the quote as sent.");
    case "feedback.drafted":
      return item("assistant", `Wrote to ${name} asking how the job went.`, "The job was finished, and Feedback is on in Flows.");
    case "feedback.skipped":
      return item("assistant", `Didn't ask ${name} for feedback.`, "They've asked not to be contacted.");
    case "chase.skipped":
      return item("assistant", `Didn't chase ${name}'s quote.`, r.detail?.reason === "opted_out" ? "They've asked not to be contacted." : undefined);
    case "automation.offered":
      return item("assistant", `Offered to send "${label(r.entity_id)}" replies automatically.`, "You'd approved the last few without changing them.");
    case "automation.on":
      return item("you", `${you} said yes to sending "${label(r.entity_id)}" replies automatically.`, "Every few still come to you as a spot check.");
    case "automation.declined":
      return item("you", `${you} chose to keep approving "${label(r.entity_id)}" replies.`);
    case "automation.paused":
      return item("assistant", `Went back to asking you about "${label(r.entity_id)}" replies.`, "You changed or rejected one of them.");
    case "quote.marked_sent":
      return item("you", `${you} marked a quote to ${name} as sent.`);
    case "job.marked_done":
      return item("you", `${you} marked ${name}'s job as done.`);
    case "contact.details_added":
      return item("you", `${you} added ${name}'s contact details. Replies can now go to them directly.`);
    case "settings.updated":
      return item("you", `${you} changed the business settings.`);
    case "reply_style.updated":
      return item("you", `${you} changed how replies sound.`);
    case "use_case.changed":
      return item("you", `${you} changed ${USE_CASE[r.entity_id] ?? "a flow"} in Flows${r.detail?.enabled === false ? " (now off)" : ""}.`);
    case "member.added": return item("you", `${you} added a person.`);
    case "member.updated": return item("you", `${you} changed a person's details.`);
    case "member.removed": return item("you", `${you} removed a person.`);
    case "google.connected": return item("you", "Google was connected.");
    case "whatsapp.connected":
      return r.detail?.coexistence
        ? item("you", "Your WhatsApp Business number was connected. You keep using the app as before.", "People saved in your phone are left alone unless they're already customers.")
        : item("you", "A WhatsApp number was connected.");
    case "whatsapp_people.changed":
      return item("you", r.detail?.people === "everyone" ? `${you} chose to answer everyone who messages on WhatsApp.` : `${you} chose to answer only new people and customers on WhatsApp.`);
    case "reply.owner_answered":
      return item("you", `You answered ${name} yourself in WhatsApp.`, r.detail?.dropped ? "So the reply waiting for you was dropped, and nothing else was sent." : undefined);
    case "contact.ignored":
      return item("you", `${you} chose to ignore ${name}. Their messages won't be kept or answered.`, "It was a personal chat, not a customer.");
    case "contact.unignored":
      return item("you", `${you} stopped ignoring ${name}.`);
    case "connection.disabled": return item("you", `${you} switched off a connection.`);
    case "tenant.status_changed":
      return item(r.actor === "system" ? "platform" : "you", `${you} ${r.detail?.to === "paused" ? "paused the business" : r.detail?.to === "active" ? "switched the business on" : "changed the business's status"}.`);
    case "tenant.created": return item("platform", "The business was set up.");
    case "data.exported": return item("you", `${you} exported a person's data.`);
    case "data.erased": return item("you", `${you} erased a person's data.`);
    case "contact.suppressed": return item("you", `${you} marked a person as not to be contacted.`);
    case "summary.sent": return item("assistant", "Sent you this week's summary on WhatsApp.");
    case "retention.applied": return item("assistant", "Old message text was deleted, as your data settings say.");
    default:
      if (/^(web_form|checkatrade_webhook|sms_relay)\.added$/.test(r.action)) return item("you", `${you} added a connection.`);
      return undefined;
  }
}
