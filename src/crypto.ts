import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

// AES-256-GCM for tokens and secrets at rest. Format: v1.<iv>.<tag>.<ciphertext>, base64url parts.
// Rotating keys: add v2 with a new key and re-encrypt on read.
function key(): Buffer {
  const k = Buffer.from(env.dataEncryptionKey, "base64");
  if (k.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptJson<T>(blob: string): T {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1") throw new Error("Unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8"));
}

/** Short signed tokens for OAuth state and links. payload.exp is a unix time in seconds. */
export function sign(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", env.signingSecret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verify<T extends { exp?: number }>(token: string): T | undefined {
  const [body, mac] = token.split(".");
  if (!body || !mac) return undefined;
  const expected = createHmac("sha256", env.signingSecret).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return undefined;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  if (payload.exp && payload.exp < Date.now() / 1000) return undefined;
  return payload;
}

/** Meta webhook signature: X-Hub-Signature-256 = sha256=<hex HMAC of the raw body with the app secret>. */
export function verifyMetaSignature(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest();
  const got = Buffer.from(header.slice(7), "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export const randomToken = (bytes = 18) => randomBytes(bytes).toString("base64url");
