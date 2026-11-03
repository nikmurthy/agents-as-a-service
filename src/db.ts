import pg from "pg";
import { env } from "./env.js";

export type Db = pg.PoolClient;

let pool: pg.Pool | undefined;
export function getPool(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: env.databaseUrl, max: 10 });
  return pool;
}
export async function closePool() { await pool?.end(); pool = undefined; }

/**
 * Run tenant work. Switches to the app_tenant role and sets app.tenant_id for this transaction only,
 * so row-level security limits every query to this one business. Use this for everything a tenant does.
 */
export async function withTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("set local role app_tenant");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Long-running tenant work (an agent run that waits on model calls). Same isolation as withTenant, but each
 * statement commits on its own, so no transaction is held open while agents think, and a failure halfway
 * doesn't silently undo things already done outside the database (like calendar events).
 * Needs a session-level connection: Supabase direct or session pooler (port 5432), not the transaction pooler.
 */
export async function withTenantSession<T>(tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("set role app_tenant");
    await client.query("select set_config('app.tenant_id', $1, false)", [tenantId]);
    return await fn(client);
  } finally {
    await client.query("reset role").catch(() => {});
    await client.query("select set_config('app.tenant_id', '', false)").catch(() => {});
    client.release();
  }
}

/**
 * Platform-level work that has to see across tenants: routing an incoming webhook to the right business,
 * onboarding, scheduled sweeps. Keep it small: find the tenant, then hand over to withTenant.
 */
export async function withAdmin<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function one<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await db.query(sql, params)).rows[0] as T | undefined;
}
export async function many<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}
