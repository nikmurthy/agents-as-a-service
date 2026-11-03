import type { Db } from "./db.js";
import { many, one } from "./db.js";
import type { Tenant } from "./types.js";
import { clients } from "./integrations/index.js";
import { getConnection, googleToken, type Connection } from "./connections.js";
import { addDaysLocal, isoWeekday, localToUtc, utcToLocal } from "./time.js";
import { env } from "./env.js";

// Availability = working hours, minus busy time in the business's Google Calendar, minus our own open holds.
// Holds are written to Google as tentative events too, so the owner sees them in their diary.

export interface Slot { start: string; end: string; day?: string }   // local wall-clock in tenant timezone

const DAY = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export async function calendarConnection(db: Db): Promise<Connection | undefined> {
  return getConnection(db, "google_calendar");
}

export async function availability(
  db: Db, tenant: Tenant, now: Date,
  args: { durationMinutes: number; fromDate?: string; toDate?: string; limit?: number },
): Promise<Slot[]> {
  const conn = await calendarConnection(db);
  if (!conn) return [];
  const tz = tenant.settings.timezone;
  const nowLocal = utcToLocal(now, tz);
  const fromDate = args.fromDate && args.fromDate > nowLocal.slice(0, 10) ? args.fromDate : nowLocal.slice(0, 10);
  const toDate = args.toDate ?? addDaysLocal(nowLocal, 14);
  const rangeStart = localToUtc(fromDate + "T00:00", tz);
  const rangeEnd = localToUtc(addDaysLocal(toDate, 1) + "T00:00", tz);

  const token = await googleToken(db, conn);
  const busyGoogle = await clients.google.freeBusy(token, conn.external_id, rangeStart.toISOString(), rangeEnd.toISOString());
  const busyHolds = await many<{ start_at: Date; end_at: Date }>(db,
    "select start_at, end_at from holds where status in ('held', 'confirmed') and end_at > $1 and start_at < $2", [rangeStart, rangeEnd]);
  const busy = [
    ...busyGoogle.map((b) => [Date.parse(b.start), Date.parse(b.end)]),
    ...busyHolds.map((h) => [h.start_at.getTime(), h.end_at.getTime()]),
  ];

  const earliest = now.getTime() + 2 * 3600_000;     // nothing in the next two hours
  const dur = args.durationMinutes * 60_000;
  const { days, start, end } = tenant.settings.workingHours;
  const slots: Slot[] = [];
  for (let d = fromDate; d <= toDate; d = addDaysLocal(d, 1)) {
    const dow = isoWeekday(d);
    if (!days.includes(dow)) continue;
    const open = localToUtc(`${d}T${start}`, tz).getTime();
    const close = localToUtc(`${d}T${end}`, tz).getTime();
    for (let s = open; s + dur <= close; s += 30 * 60_000) {
      if (s < earliest) continue;
      if (busy.some(([b0, b1]) => s < b1 && s + dur > b0)) continue;
      slots.push({ start: utcToLocal(new Date(s), tz), end: utcToLocal(new Date(s + dur), tz), day: DAY[dow] });
      if (slots.length >= (args.limit ?? 40)) return slots;
    }
  }
  return slots;
}

export async function isFree(db: Db, tenant: Tenant, now: Date, slot: Slot): Promise<boolean> {
  const tz = tenant.settings.timezone;
  const dur = Math.round((localToUtc(slot.end, tz).getTime() - localToUtc(slot.start, tz).getTime()) / 60_000);
  if (!(dur > 0)) return false;
  const day = slot.start.slice(0, 10);
  const free = await availability(db, tenant, now, { durationMinutes: dur, fromDate: day, toDate: day, limit: 200 });
  return free.some((f) => f.start === slot.start.slice(0, 16));
}

/** Holds a slot: a tentative event in Google Calendar plus a hold row that expires if the customer doesn't pick it. */
export async function createHold(
  db: Db, tenant: Tenant,
  h: { conversationId: string; contactId: string; contactName?: string; service?: string; slot: Slot },
): Promise<string> {
  const conn = await calendarConnection(db);
  if (!conn) throw new Error("No calendar connected");
  const tz = tenant.settings.timezone;
  const token = await googleToken(db, conn);
  const row = await one<{ id: string }>(db,
    `insert into holds (tenant_id, conversation_id, contact_id, calendar_connection_id, service, start_at, end_at, expires_at)
     values (app_current_tenant(), $1, $2, $3, $4, $5, $6, now() + make_interval(hours => $7)) returning id`,
    [h.conversationId, h.contactId, conn.id, h.service ?? null, localToUtc(h.slot.start, tz), localToUtc(h.slot.end, tz), env.holdHours]);
  const ev = await clients.google.insertEvent(token, conn.external_id, {
    summary: `HELD: ${h.service ?? "Appointment"} – ${h.contactName ?? "customer"}`,
    description: "Held automatically while the customer chooses a time. Released if not chosen.",
    start: { dateTime: h.slot.start + ":00", timeZone: tz },
    end: { dateTime: h.slot.end + ":00", timeZone: tz },
    status: "tentative",
    extendedProperties: { private: { holdId: row!.id } },
  });
  await db.query("update holds set calendar_event_id = $2 where id = $1", [row!.id, ev.id]);
  return row!.id;
}

export async function confirmHold(db: Db, holdId: string, contactName?: string): Promise<void> {
  const hold = await one(db, "select h.*, c.external_id as calendar_id from holds h join channel_connections c on c.id = h.calendar_connection_id where h.id = $1", [holdId]);
  if (!hold) throw new Error("Hold not found");
  const conn = await one<Connection>(db, "select * from channel_connections where id = $1", [hold.calendar_connection_id]);
  const token = await googleToken(db, conn!);
  if (hold.calendar_event_id) {
    await clients.google.patchEvent(token, hold.calendar_id, hold.calendar_event_id, {
      summary: `${hold.service ?? "Appointment"} – ${contactName ?? "customer"}`, status: "confirmed",
    });
  }
  await db.query("update holds set status = 'confirmed', expires_at = null where id = $1", [holdId]);
  // Release the other times we offered this customer.
  const others = await many(db, "select id from holds where conversation_id = $1 and status = 'held' and id <> $2", [hold.conversation_id, holdId]);
  for (const o of others) await releaseHold(db, o.id, "released");
}

export async function releaseHold(db: Db, holdId: string, status: "released" | "expired" | "cancelled"): Promise<void> {
  const hold = await one(db, "select * from holds where id = $1", [holdId]);
  if (!hold || !["held", "confirmed"].includes(hold.status)) return;
  if (hold.calendar_event_id && hold.calendar_connection_id) {
    const conn = await one<Connection>(db, "select * from channel_connections where id = $1", [hold.calendar_connection_id]);
    if (conn) {
      try {
        await clients.google.deleteEvent(await googleToken(db, conn), conn.external_id, hold.calendar_event_id);
      } catch { /* already gone from the diary: fine */ }
    }
  }
  await db.query("update holds set status = $2 where id = $1", [holdId, status]);
}

export async function openHolds(db: Db, conversationId: string, tz: string) {
  const rows = await many(db, "select id, service, start_at, end_at, status from holds where conversation_id = $1 and status in ('held', 'confirmed') order by start_at", [conversationId]);
  return rows.map((r) => ({ holdId: r.id, service: r.service, status: r.status, start: utcToLocal(r.start_at, tz), end: utcToLocal(r.end_at, tz) }));
}
