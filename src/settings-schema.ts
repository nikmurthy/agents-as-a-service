import { z } from "zod";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 08:30");
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

const replyRoute = z.enum(["whatsapp", "email", "checkatrade_message", "sms", "phone"]);
const channel = z.enum(["email", "whatsapp", "web_form", "checkatrade"]);

const timezone = z.string().refine((tz) => {
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; }
}, "Not a known timezone, e.g. Europe/London");

/** One schema for the settings form and the API. Mirrors TenantSettings in types.ts. */
export const tenantSettingsSchema = z.object({
  tone: z.string().trim().min(1, "Describe the tone of voice").max(1000),
  signOff: z.string().trim().min(1, "Add a sign-off").max(100),
  timezone,
  services: z.array(z.object({
    name: z.string().trim().min(1, "Every service needs a name").max(120),
    durationMinutes: z.number().int().min(5, "At least 5 minutes").max(24 * 60),
    price: z.string().trim().max(200).optional(),
  })).max(50),
  priceGuide: z.array(z.object({
    item: z.string().trim().min(1).max(120),
    range: z.string().trim().min(1).max(120),
  })).max(100).optional(),
  replyGuidance: z.string().trim().max(4000).optional(),
  replyVia: z.partialRecord(channel, z.array(replyRoute).min(1, "Pick at least one reply route")),
  workingHours: z.object({
    days: z.array(z.number().int().min(1).max(7)).min(1, "Pick at least one working day"),
    start: time,
    end: time,
  }).refine((h) => minutes(h.end) > minutes(h.start), { message: "Working hours must end after they start", path: ["end"] }),
  serviceArea: z.array(z.string().trim().min(1).max(10)).max(500).optional(),
  escalationName: z.string().trim().min(1).max(100),
  spotCheckEvery: z.number().int().min(1, "1 means every reply is checked").max(100),
  reviewerPassScore: z.number().min(1).max(5),
  checkatradeSenders: z.array(z.string().trim().toLowerCase().email("Not a valid email address")).max(20).optional(),
  retentionDays: z.number().int().min(7, "At least 7 days").max(3650).optional(),
}).strict();

export type SettingsInput = z.infer<typeof tenantSettingsSchema>;

export const newBusinessSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]{3,40}$/, "3 to 40 lowercase letters, numbers or hyphens"),
  name: z.string().trim().min(1).max(120),
  pack: z.enum(["flooring", "trades", "practitioner"]),
  owner: z.object({
    name: z.string().trim().min(1).max(120),
    whatsapp: z.string().trim().min(6).max(30),
    email: z.string().trim().email().optional(),
  }),
  useCases: z.array(z.enum(["answer_enquiries", "book_appointments"])).optional(),
});

export const USE_CASES = ["answer_enquiries", "book_appointments", "chase_quotes"] as const;
