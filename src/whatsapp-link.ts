import { env } from "./env.js";
import { sign } from "./crypto.js";

/** A signed, week-long link for the owner to connect their WhatsApp Business app number (Meta Embedded Signup). */
export const whatsappConnectLink = (tenantId: string) =>
  `${env.publicBaseUrl}/connect/whatsapp?s=${encodeURIComponent(sign({ t: tenantId, exp: Math.floor(Date.now() / 1000) + 7 * 86400 }))}`;
