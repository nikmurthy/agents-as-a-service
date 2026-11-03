export type ChannelKind = "email" | "whatsapp" | "web_form" | "checkatrade";
export type ReplyRoute = "whatsapp" | "email" | "checkatrade_message" | "sms" | "phone";
export type DataTag = "personal" | "health" | "child";

/** What every channel parser produces. Tenant is resolved separately, from the connection the payload arrived on. */
export interface InboundMessage {
  channel: ChannelKind;
  channelMessageId: string;
  receivedAt: string;
  from: { name?: string; email?: string; phone?: string };
  subject?: string;
  text: string;
  structured?: Record<string, string>;
  attachments?: { url: string; kind: string }[];
  email?: { threadId: string; messageId?: string };   // for replying in the same email thread
}

export interface TenantSettings {
  tone: string;
  signOff: string;
  timezone: string;                    // IANA, e.g. Europe/London
  services: { name: string; durationMinutes: number; price?: string }[];
  priceGuide?: { item: string; range: string }[];
  replyGuidance?: string;
  replyVia: Partial<Record<ChannelKind, ReplyRoute[]>>;
  workingHours: { days: number[]; start: string; end: string };   // 1=Mon..7=Sun, "08:00"
  serviceArea?: string[];
  escalationName: string;
  spotCheckEvery: number;
  reviewerPassScore: number;
  checkatradeSenders?: string[];       // From addresses of Checkatrade lead emails
  retentionDays?: number;              // message bodies deleted after this many days
}

export interface Tenant { id: string; slug: string; name: string; pack: string; settings: TenantSettings; status: string }

export interface AgentDefinition {
  id: string;
  version: string;
  model: string;
  description: string;
  instructions: string;
  tools: string[];
  output: { name: string; description: string; schema: Record<string, unknown> };
  maxTokens: number;
}

export interface TriageResult {
  intent:
    | "new_job_enquiry" | "quote_request" | "booking_request" | "booking_confirmation" | "reschedule"
    | "general_question" | "follow_up" | "clinical_question" | "complaint" | "emergency" | "spam" | "other";
  urgency: "emergency" | "high" | "normal" | "low";
  service?: string;
  postcode?: string;
  inServiceArea?: boolean | null;
  needsHuman: boolean;
  nextStep: "book_visit" | "book_consultation" | "confirm_booking" | "reschedule" | "reply_with_info" | "escalate" | "ignore";
  missingInfo: string[];
  reason: string;
}

export interface BookingResult {
  action: "propose_slots" | "confirm_slot" | "move_appointment" | "none";
  service?: string;
  slots: { start: string; end: string }[];   // local wall-clock "YYYY-MM-DDTHH:MM" in the tenant's timezone
  holdId?: string;                           // for confirm_slot / move_appointment
  notes: string;
}

export interface DraftResult { replyText: string; needsHumanBeforeSending: boolean; internalNote: string }
export interface ReviewResult { scores: { tone: number; clarity: number; accuracy: number; safety: number }; pass: boolean; issues: string[] }

export interface RunEvent {
  step: string; agent?: string; agentVersion?: string; model?: string;
  inputTokens?: number; outputTokens?: number; ms?: number; detail?: string;
}
