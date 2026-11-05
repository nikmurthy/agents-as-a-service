import type { Context } from "hono";
import { z } from "zod";
import { formatIssues } from "./settings-schema.js";
import type { Caller } from "./auth.js";
import type { DecisionActor } from "../decisions.js";

export type Vars = { Variables: { caller: Caller } };

// ---------------------------------------------------------------- access checks
/** view: see the business. approve: also decide drafts. manage: change settings and connections (owners and admins). */
export type Level = "view" | "approve" | "manage";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Granted = { ok: true; tenantId: string; actor: DecisionActor; manage: boolean } | { ok: false; res: Response };

function mfaRequired(c: Context) { return c.json({ error: "mfa_required", message: "Platform admins must sign in with a second factor." }, 403); }

export function guard(c: Context<Vars>, tenantId: string, level: Level): Granted {
  const caller = c.get("caller");
  const notFound = { ok: false as const, res: c.json({ error: "not_found" }, 404) };
  if (!UUID.test(tenantId)) return notFound;
  const m = caller.memberships.find((x) => x.tenantId === tenantId);
  if (caller.isPlatformAdmin) {
    if (!caller.mfa) return { ok: false, res: mfaRequired(c) };
    return { ok: true, tenantId, manage: true, actor: { memberId: m?.memberId ?? null, label: `admin:${caller.email ?? caller.userId}`, via: "web" } };
  }
  if (!m) return notFound; // someone else's business looks the same as one that doesn't exist
  if (level === "manage" && m.role !== "owner") return { ok: false, res: c.json({ error: "forbidden", message: "Only the owner can change this." }, 403) };
  return { ok: true, tenantId, manage: m.role === "owner", actor: { memberId: m.memberId, label: `member:${m.memberId}`, via: "web" } };
}

export function guardAdmin(c: Context<Vars>): { ok: true; label: string } | { ok: false; res: Response } {
  const caller = c.get("caller");
  if (!caller.isPlatformAdmin) return { ok: false, res: c.json({ error: "forbidden" }, 403) };
  if (!caller.mfa) return { ok: false, res: mfaRequired(c) };
  return { ok: true, label: `admin:${caller.email ?? caller.userId}` };
}

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  const raw = await c.req.json().catch(() => undefined);
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, data: r.data };
  return { ok: false, res: c.json({ error: "invalid", issues: formatIssues(r.error) }, 422) };
}

