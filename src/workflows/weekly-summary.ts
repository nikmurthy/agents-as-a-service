import type { Db } from "../db.js";
import { one } from "../db.js";

/** "Here's what I did this week": a calm, factual summary at the top of Overview. Counts only: no names, no text. */
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
