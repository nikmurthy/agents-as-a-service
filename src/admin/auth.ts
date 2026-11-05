import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { env } from "../env.js";
import { many, one, withAdmin } from "../db.js";
import type { Actor } from "../decisions.js";

// Sign-in is Supabase Auth. The browser sends its access token as a Bearer header (no cookies, so no CSRF).
// Every request is checked against the database: who is this, which businesses are they a member of, are they a platform admin.

export type Role = "owner" | "staff";
export interface Membership { memberId: string; tenantId: string; role: Role; name: string; slug: string; status: string }
export interface Access {
  userId: string;
  email: string;
  isAdmin: boolean;
  /** A platform admin who hasn't completed two-factor sign-in yet: gets no admin powers until they do. */
  adminPendingMfa: boolean;
  memberships: Membership[];
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

async function verifyToken(token: string): Promise<JWTPayload & { email?: string; aal?: string }> {
  if (env.supabaseJwtSecret) {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(env.supabaseJwtSecret), { algorithms: ["HS256"], audience: "authenticated" });
    return payload;
  }
  if (env.supabaseUrl) {
    jwks ??= createRemoteJWKSet(new URL(`${env.supabaseUrl.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`));
    const { payload } = await jwtVerify(token, jwks, { audience: "authenticated" });
    return payload;
  }
  throw new HTTPException(503, { message: "Sign-in is not configured (set SUPABASE_URL or SUPABASE_JWT_SECRET)" });
}

/** Loads what this login may do. Invited people are linked to their membership by email on first sign-in. */
async function loadAccess(userId: string, email: string, aal: string | undefined): Promise<Access> {
  return withAdmin(async (db) => {
    if (email) {
      await db.query("update tenant_members set user_id = $1 where user_id is null and lower(email) = lower($2)", [userId, email]);
    }
    const admin = await one(db, "select 1 from platform_admins where user_id = $1", [userId]);
    const memberships = await many<Membership>(db,
      `select m.id as "memberId", m.tenant_id as "tenantId", m.role, m.name, t.slug, t.status
       from tenant_members m join tenants t on t.id = m.tenant_id where m.user_id = $1 order by t.name`, [userId]);
    // Platform admins must have signed in with a second factor.
    return { userId, email, isAdmin: !!admin && aal === "aal2", adminPendingMfa: !!admin && aal !== "aal2", memberships };
  });
}

export const requireUser: MiddlewareHandler<{ Variables: { access: Access } }> = async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  if (!header.startsWith("Bearer ")) throw new HTTPException(401, { message: "Sign in required" });
  let payload;
  try {
    payload = await verifyToken(header.slice(7));
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    throw new HTTPException(401, { message: "Your session has expired. Please sign in again." });
  }
  if (!payload.sub) throw new HTTPException(401, { message: "Sign in required" });
  c.set("access", await loadAccess(payload.sub, String(payload.email ?? ""), payload.aal));
  await next();
};

export interface TenantAccess { tenantId: string; role: Role | "admin"; actor: Actor }

/**
 * Checks the signed-in person may use this business. Platform admins can use any; everyone else only their own.
 * Someone else's business answers 404, so its existence isn't revealed. Staff can view and approve; owners can change things.
 */
export function tenantAccess(c: Context, tenantId: string, need: "view" | "manage" = "view"): TenantAccess {
  const access = c.get("access") as Access;
  if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new HTTPException(404, { message: "Not found" });
  if (access.isAdmin) return { tenantId, role: "admin", actor: { memberId: null, audit: `admin:${access.email}` } };
  const m = access.memberships.find((x) => x.tenantId === tenantId);
  if (!m) throw new HTTPException(404, { message: "Not found" });
  if (need === "manage" && m.role !== "owner") throw new HTTPException(403, { message: "Only the business owner can do that" });
  return { tenantId, role: m.role, actor: { memberId: m.memberId, audit: `member:${m.memberId}` } };
}

export function requireAdmin(c: Context): Access {
  const access = c.get("access") as Access;
  if (!access.isAdmin) throw new HTTPException(403, { message: "Platform admins only" });
  return access;
}
