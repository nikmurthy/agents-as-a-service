import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "graphile-worker";
import { closePool, getPool } from "../db.js";

// Applies supabase/migrations/*.sql in order (once each), then the job queue's own tables.
// On Supabase you can use `supabase db push` instead for the SQL files; this script still sets up the queue.
export async function migrate(log = console.log) {
  const pool = getPool();
  await pool.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const dir = new URL("../../supabase/migrations/", import.meta.url).pathname;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const done = await pool.query("select 1 from schema_migrations where name = $1", [f]);
    if (done.rowCount) continue;
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(readFileSync(join(dir, f), "utf8"));
      await client.query("insert into schema_migrations (name) values ($1)", [f]);
      await client.query("commit");
      log(`applied ${f}`);
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
  await runMigrations({ pgPool: pool });
  log("job queue ready");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await migrate();
  await closePool();
}
