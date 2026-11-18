import { env } from "./env.js";
import { sign } from "./crypto.js";

export function googleConnectLink(tenantId: string): string {
  return `${env.publicBaseUrl}/connect/google?s=${encodeURIComponent(sign({ t: tenantId, exp: Math.floor(Date.now() / 1000) + 7 * 86400 }))}`;
}
export const googleRedirectUri = () => `${env.publicBaseUrl}/oauth/google/callback`;
