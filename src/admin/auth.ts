import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { env } from "../env.js";
import { many, one, withAdmin } from "../db.js";

// Who is calling the admin API. The web app signs people in with Supabase Auth and sends its access token as
// `Authorization: Bearer <token>` (no cookies, so there is nothing for a cross-site request to ride on).

export interface Membership { tenantId: string; memberId: string; role: "owner" | "staff"; name: string; slug: string }
export interface Caller {
  userId: string;
  email: string | null;
  mfa: boolean;                 // the sign-in used a second factor (Supabase aal2)
  isPlatformAdmin: boolean;
  memberships: Membership[];
}

let jwks: JWTVerifyGetKey | undefined;

/** The user id and claims of a valid Supabase access token, or undefined. */
export async function verifyAccessToken(token: string): Promise<{ userId: string; email: string | null; mfa: boolean } | undefined> {
  try {
    const secret = env.supabaseJwtSecret;
    const url = env.supabaseUrl.replace(/\/$/, "");
    if (!secret && !url) return undefined;
    const opts = { audience: "authenticated", ...(url ? { issuer: `${url}/auth/v1` } : {}) };
    let payload;
    if (secret) {
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), { ...opts, algorithms: ["HS256"] }));
    } else {
      jwks ??= createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
      ({ payload } = await jwtVerify(token, jwks, { ...opts, algorithms: ["ES256", "RS256"] }));
    }
    if (!payload.sub || payload.role !== "authenticated") return undefined;
    return { userId: payload.sub, email: typeof payload.email === "string" ? payload.email : null, mfa: payload.aal === "aal2" };
  } catch {
    return undefined;
  }
}

/** Looks up what a signed-in user may see: platform admin, and the businesses they belong to. */
export async function loadCaller(token: string): Promise<Caller | undefined> {
  const v = await verifyAccessToken(token);
  if (!v) return undefined;
  // Cross-business lookup by user id: this is the one place that has to see across businesses, so it is kept small.
  const { admin, memberships } = await withAdmin(async (db) => ({
    admin: await one(db, "select 1 from platform_admins where user_id = $1", [v.userId]),
    memberships: await many<Membership>(db,
      `select t.id as "tenantId", m.id as "memberId", m.role, t.name, t.slug
       from tenant_members m join tenants t on t.id = m.tenant_id
       where m.user_id = $1 and t.status <> 'closed' order by t.name`, [v.userId]),
  }));
  return { ...v, isPlatformAdmin: !!admin, memberships };
}
