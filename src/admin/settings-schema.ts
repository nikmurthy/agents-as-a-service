import { z } from "zod";
import type { TenantSettings } from "../types.js";

// The one definition of a business's settings. The API validates every save with it and the web form uses the same
// rules. Messages are written for the person filling in the form.

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour time like 08:00");
const text = (label: string, max: number) => z.string().trim().min(1, `${label} is required`).max(max, `${label} is too long (max ${max} characters)`);
const route = z.enum(["whatsapp", "email", "checkatrade_message", "sms", "phone"]);
const routes = z.array(route).min(1, "Choose at least one way to reply").max(5).refine((r) => new Set(r).size === r.length, "Each reply route can only appear once");

const timezone = z.string().refine((tz) => {
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; }
}, "Not a recognised timezone (e.g. Europe/London)");

const workingHours = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one working day").refine((d) => new Set(d).size === d.length, "Each day can only appear once"),
  start: time,
  end: time,
}).refine((h) => h.end > h.start, { message: "Finishing time must be after the starting time", path: ["end"] });

export const settingsSchema = z.object({
  tone: text("Tone", 600),
  signOff: text("Sign-off", 100),
  timezone,
  services: z.array(z.object({
    name: text("Service name", 100),
    durationMinutes: z.number().int("Duration must be a whole number of minutes").min(5, "Duration must be at least 5 minutes").max(1440, "Duration can't be more than a day"),
    price: z.string().trim().max(100).optional(),
  })).max(50),
  priceGuide: z.array(z.object({ item: text("Price guide item", 200), range: text("Price range", 100) })).max(100).optional(),
  replyGuidance: z.string().trim().max(2000, "Reply guidance is too long (max 2000 characters)").optional(),
  replyVia: z.object({
    email: routes.optional(),
    whatsapp: routes.optional(),
    web_form: routes.optional(),
    checkatrade: routes.optional(),
  }).strict(),
  workingHours,
  serviceArea: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{1,2}[0-9][0-9A-Z]?$/, "Use postcode districts like SW1 or BN3")).max(200).optional(),
  escalationName: text("Escalation name", 100),
  spotCheckEvery: z.number().int().min(0, "Use 0 to switch spot checks off").max(1000),
  reviewerPassScore: z.number().min(1, "Scores run from 1 to 5").max(5, "Scores run from 1 to 5"),
  checkatradeSenders: z.array(z.string().trim().toLowerCase().email("Not a valid email address")).max(20).optional(),
  retentionDays: z.number().int().min(30, "Keep messages for at least 30 days").max(3650, "Keep messages for at most 10 years").optional(),
}).strict();

// Compile-time check that the schema and TenantSettings stay in step.
export type ParsedSettings = z.infer<typeof settingsSchema>;
const _assignable: (s: ParsedSettings) => TenantSettings = (s) => s;
void _assignable;

export interface FieldIssue { path: string; message: string }

export function parseSettings(input: unknown): { ok: true; settings: ParsedSettings } | { ok: false; issues: FieldIssue[] } {
  const r = settingsSchema.safeParse(input);
  if (r.success) return { ok: true, settings: r.data };
  return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
}

export function formatIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
