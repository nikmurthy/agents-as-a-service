import type { Db } from "./db.js";
import { one } from "./db.js";
import { decryptJson, encryptJson, sign } from "./crypto.js";
import { clients } from "./integrations/index.js";
import type { GoogleTokens } from "./integrations/google.js";
import type { WaSender } from "./integrations/whatsapp.js";
import { env } from "./env.js";

export interface Connection {
  id: string; tenant_id: string; kind: string; external_id: string; status: string;
  secret_ciphertext: string | null; config: any; cursor: any;
}

export async function getConnection(db: Db, kind: string): Promise<Connection | undefined> {
  return one<Connection>(db, "select * from channel_connections where kind = $1 and status = 'active' order by created_at limit 1", [kind]);
}

/** A valid Google access token for this connection, refreshing and re-saving if needed. */
export async function googleToken(db: Db, conn: Connection): Promise<string> {
  if (!conn.secret_ciphertext) throw new Error("Google connection has no stored token");
  let tokens = decryptJson<GoogleTokens>(conn.secret_ciphertext);
  if (tokens.expires_at < Date.now() + 30_000) {
    try {
      tokens = await clients.google.refresh(tokens);
    } catch (e: any) {
      await db.query("update channel_connections set status = 'error', last_error = $2 where id = $1", [conn.id, e.message]);
      throw e;
    }
    // Google connections come in pairs (Gmail + Calendar) sharing one grant: update both.
    await db.query(
      "update channel_connections set secret_ciphertext = $2 where tenant_id = $1 and kind in ('gmail', 'google_calendar') and config->>'grant' = $3",
      [conn.tenant_id, encryptJson(tokens), conn.config.grant],
    );
  }
  return tokens.access_token;
}

/** The business's own WhatsApp number (coexistence), for replying to customers. */
export async function tenantWaSender(db: Db): Promise<WaSender | undefined> {
  const conn = await getConnection(db, "whatsapp");
  if (!conn?.secret_ciphertext) return undefined;
  const { accessToken } = decryptJson<{ accessToken: string }>(conn.secret_ciphertext);
  return { phoneNumberId: conn.external_id, accessToken };
}

/** The platform's own WhatsApp number, for messages to business owners. */
export const platformWaSender = (): WaSender => ({ phoneNumberId: env.platformWaPhoneNumberId, accessToken: env.platformWaToken });

/** Link the owner opens to connect Gmail and Google Calendar. Valid for a week. */
export function googleConnectLink(tenantId: string): string {
  return `${env.publicBaseUrl}/connect/google?s=${encodeURIComponent(sign({ t: tenantId, exp: Math.floor(Date.now() / 1000) + 7 * 86400 }))}`;
}
