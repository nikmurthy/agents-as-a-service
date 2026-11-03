import { env } from "../env.js";

// Google OAuth, Gmail and Calendar over plain REST. Scopes: read and send mail, read free/busy, manage events.
export const GOOGLE_SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

export interface GoogleTokens { access_token: string; refresh_token?: string; expires_at: number }

export interface GoogleClient {
  authUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<GoogleTokens>;
  refresh(tokens: GoogleTokens): Promise<GoogleTokens>;
  gmailProfile(token: string): Promise<{ emailAddress: string; historyId: string }>;
  gmailNewMessageIds(token: string, startHistoryId: string): Promise<{ ids: string[]; historyId: string }>;
  gmailGet(token: string, id: string): Promise<any>;
  gmailSend(token: string, rawRfc822: string, threadId?: string): Promise<{ id: string }>;
  freeBusy(token: string, calendarId: string, fromIso: string, toIso: string): Promise<{ start: string; end: string }[]>;
  insertEvent(token: string, calendarId: string, ev: CalendarEvent): Promise<{ id: string }>;
  patchEvent(token: string, calendarId: string, eventId: string, patch: Partial<CalendarEvent>): Promise<void>;
  deleteEvent(token: string, calendarId: string, eventId: string): Promise<void>;
}

export interface CalendarEvent {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  status?: "tentative" | "confirmed";
  extendedProperties?: { private: Record<string, string> };
}

async function call(token: string, url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (res.status === 204) return undefined;
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google API ${res.status}: ${json?.error?.message ?? json?.error ?? "unknown error"}`);
  return json;
}

async function tokenRequest(params: Record<string, string>): Promise<GoogleTokens> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.googleClientId, client_secret: env.googleClientSecret, ...params }),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`Google token error: ${json.error_description ?? json.error}`);
  return { access_token: json.access_token, refresh_token: json.refresh_token, expires_at: Date.now() + (json.expires_in - 60) * 1000 };
}

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL = "https://www.googleapis.com/calendar/v3";

export const googleRest: GoogleClient = {
  authUrl(state, redirectUri) {
    const q = new URLSearchParams({
      client_id: env.googleClientId, redirect_uri: redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  },
  exchangeCode: (code, redirectUri) => tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  async refresh(tokens) {
    if (!tokens.refresh_token) throw new Error("No refresh token: the business needs to reconnect Google");
    const next = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    return { ...next, refresh_token: next.refresh_token ?? tokens.refresh_token };
  },
  gmailProfile: (token) => call(token, `${GMAIL}/profile`),
  async gmailNewMessageIds(token, startHistoryId) {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let historyId = startHistoryId;
    do {
      const q = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded", labelId: "INBOX" });
      if (pageToken) q.set("pageToken", pageToken);
      const json = await call(token, `${GMAIL}/history?${q}`);
      for (const h of json.history ?? []) for (const a of h.messagesAdded ?? []) ids.add(a.message.id);
      historyId = json.historyId ?? historyId;
      pageToken = json.nextPageToken;
    } while (pageToken);
    return { ids: [...ids], historyId };
  },
  gmailGet: (token, id) => call(token, `${GMAIL}/messages/${id}?format=full`),
  gmailSend: (token, raw, threadId) =>
    call(token, `${GMAIL}/messages/send`, { method: "POST", body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url"), threadId }) }),
  async freeBusy(token, calendarId, fromIso, toIso) {
    const json = await call(token, `${CAL}/freeBusy`, { method: "POST", body: JSON.stringify({ timeMin: fromIso, timeMax: toIso, items: [{ id: calendarId }] }) });
    return json.calendars?.[calendarId]?.busy ?? [];
  },
  insertEvent: (token, calendarId, ev) => call(token, `${CAL}/calendars/${encodeURIComponent(calendarId)}/events`, { method: "POST", body: JSON.stringify(ev) }),
  async patchEvent(token, calendarId, eventId, patch) {
    await call(token, `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, { method: "PATCH", body: JSON.stringify(patch) });
  },
  async deleteEvent(token, calendarId, eventId) {
    await call(token, `${CAL}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, { method: "DELETE" });
  },
};

/** Builds a plain-text email reply (RFC 822). */
export function buildEmail(o: { from: string; to: string; subject: string; body: string; inReplyTo?: string }): string {
  const headers = [
    `From: ${o.from}`, `To: ${o.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(o.subject).toString("base64")}?=`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit",
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
  ];
  return headers.join("\r\n") + "\r\n\r\n" + o.body;
}
