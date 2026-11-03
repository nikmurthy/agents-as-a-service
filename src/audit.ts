import type { Db } from "./db.js";

/** Append-only audit trail. Never put message text or health details in `detail`: ids and decisions only. */
export async function audit(
  db: Db,
  e: { tenantId?: string | null; actor: string; action: string; entity?: string; entityId?: string; detail?: Record<string, unknown> },
) {
  await db.query(
    "insert into audit_log (tenant_id, actor, action, entity, entity_id, detail) values ($1, $2, $3, $4, $5, $6)",
    [e.tenantId ?? null, e.actor, e.action, e.entity ?? null, e.entityId ?? null, e.detail ?? null],
  );
}
