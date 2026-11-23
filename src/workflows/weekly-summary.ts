import type { Db } from "../db.js";
import { many, one, withAdmin, withTenant } from "../db.js";
import { audit } from "../audit.js";
import { notifyOwners } from "../outbox.js";

/**
 * "Here's what I did this week": a calm, factual summary for the owner. Shown at the top of Overview, and sent on
 * WhatsApp on Friday afternoon if the owner switched it on (settings.weeklySummary). Counts only: no names, no text.
 */
export interface WeekNumbers {
  messagesIn: number;
  repliesSent: number;          // replies that went to customers, or wording handed to the owner to send
  avgMinutesToReply: number | null;
  booked: number;               // appointments the customer picked
  quotesChased: number;
  feedbackAsked: number;
  sentAutomatically: number;
}

export async function weekNumbers(db: Db, now = new Date()): Promise<WeekNumbers> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const r = await one<any>(db,
    `select
       (select count(*)::int from messages where direction = 'in' and received_at > $1 and received_at <= $2) as messages_in,
       (select count(*)::int from drafts where kind = 'reply' and status in ('sent', 'manual') and decided_at > $1 and decided_at <= $2) as replies_sent,
       (select round(avg(extract(epoch from (o.sent_at - m.received_at)) / 60))::int
          from outbox o join drafts d on d.id = o.draft_id join runs r on r.id = d.run_id join messages m on m.id = r.message_id
          where d.kind = 'reply' and o.status = 'sent' and o.sent_at > $1 and o.sent_at <= $2) as avg_minutes,
       (select count(*)::int from audit_log where action = 'booking.confirmed' and at > $1 and at <= $2) as booked,
       (select count(*)::int from drafts where kind = 'chase' and status in ('sent', 'manual') and decided_at > $1 and decided_at <= $2) as chased,
       (select count(*)::int from drafts where kind = 'feedback' and status in ('sent', 'manual') and decided_at > $1 and decided_at <= $2) as feedback,
       (select count(*)::int from drafts where auto_sent and status = 'sent' and decided_at > $1 and decided_at <= $2) as automatic`, [since, now]);
  return {
    messagesIn: r.messages_in, repliesSent: r.replies_sent, avgMinutesToReply: r.avg_minutes ?? null, booked: r.booked,
    quotesChased: r.chased, feedbackAsked: r.feedback, sentAutomatically: r.automatic,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export function minutesWord(m: number): string {
  if (m < 60) return plural(Math.max(1, m), "minute", "minutes");
  const h = Math.round(m / 60);
  return h < 48 ? plural(h, "hour", "hours") : plural(Math.round(h / 24), "day", "days");
}

/** The WhatsApp message. Undefined when nothing happened: no point sending an empty week. */
export function weeklyText(name: string, w: WeekNumbers): string | undefined {
  if (!w.messagesIn && !w.repliesSent && !w.booked && !w.quotesChased && !w.feedbackAsked) return undefined;
  const lines = [
    `${plural(w.repliesSent, "reply", "replies")} sent${w.avgMinutesToReply != null ? `, on average ${minutesWord(w.avgMinutesToReply)} after the message arrived` : ""}.`,
    w.sentAutomatically ? `${w.sentAutomatically} of them went automatically.` : undefined,
    w.booked ? `${plural(w.booked, "appointment", "appointments")} booked.` : undefined,
    w.quotesChased ? `${plural(w.quotesChased, "quote", "quotes")} chased.` : undefined,
    w.feedbackAsked ? `${plural(w.feedbackAsked, "customer", "customers")} asked how it went.` : undefined,
    `${plural(w.messagesIn, "message", "messages")} came in.`,
  ].filter(Boolean);
  return `${name}: your week\n\n${lines.join("\n")}\n\nHave a good weekend. (Turn these off in the admin app: Overview.)`;
}

/** Friday afternoon, for each business that asked for it. */
export async function sendWeeklySummaries(now = new Date()): Promise<void> {
  const tenants = await withAdmin((db) => many<{ id: string; name: string }>(db,
    "select id, name from tenants where status = 'active' and (settings->>'weeklySummary')::boolean is true"));
  for (const t of tenants) {
    try {
      await withTenant(t.id, async (db) => {
        const w = await weekNumbers(db, now);
        const text = weeklyText(t.name, w);
        if (!text) return;
        await notifyOwners(db, text);
        await audit(db, { tenantId: t.id, actor: "system", action: "summary.sent", detail: { replies: w.repliesSent, booked: w.booked } });
      });
    } catch (e) {
      console.error("weekly summary failed", t.id, e instanceof Error ? e.message : e);
    }
  }
}
