import { closePool, withAdmin } from "../db.js";
import { configAgents } from "../agents/registry.js";

// Loads config/agents/*.json into the database as versioned definitions. Existing versions are never changed:
// bump "version" in the file to publish a change. Tenants can pin a version in settings.agentVersions.
export async function syncAgents(log = console.log) {
  await withAdmin(async (db) => {
    for (const a of configAgents()) {
      const r = await db.query(
        "insert into agent_definitions (agent_key, version, definition) values ($1, $2, $3) on conflict (agent_key, version) do nothing",
        [a.id, a.version, a]);
      log(`${a.id} ${a.version}: ${r.rowCount ? "published" : "already published"}`);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await syncAgents();
  await closePool();
}
