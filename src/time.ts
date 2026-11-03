// Local wall-clock <-> UTC for a tenant's timezone, without a date library. Local times look like "2026-11-05T16:00".

function partsIn(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Offset of tz from UTC at this instant, in minutes (e.g. +60 in BST). */
function offsetMinutes(date: Date, tz: string): number {
  const p = partsIn(date, tz);
  return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - date.getTime()) / 60_000);
}

export function localToUtc(local: string, tz: string): Date {
  const [d, t = "00:00"] = local.split("T");
  const [y, mo, day] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, day, h, mi);
  let result = guess - offsetMinutes(new Date(guess), tz) * 60_000;
  result = guess - offsetMinutes(new Date(result), tz) * 60_000; // second pass handles DST edges
  return new Date(result);
}

export function utcToLocal(date: Date, tz: string): string {
  const p = partsIn(date, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** 1=Mon..7=Sun for a local date string. */
export function isoWeekday(localDate: string): number {
  const [y, m, d] = localDate.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
}

export function addDaysLocal(localDate: string, days: number): string {
  const [y, m, d] = localDate.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function formatLocal(local: string): string {
  const [y, m, d] = local.slice(0, 10).split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  return `${day} at ${local.slice(11, 16)}`;
}
