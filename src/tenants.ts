import type { Db } from "./db.js";
import { one } from "./db.js";
import type { Tenant } from "./types.js";

export async function loadTenant(db: Db, tenantId: string): Promise<Tenant> {
  const t = await one<Tenant>(db, "select id, slug, name, pack, settings, status from tenants where id = $1", [tenantId]);
  if (!t) throw new Error(`Tenant ${tenantId} not found`);
  return t;
}

export async function useCaseEnabled(db: Db, useCase: string): Promise<boolean> {
  return !!(await one(db, "select 1 from tenant_use_cases where use_case = $1 and enabled", [useCase]));
}
