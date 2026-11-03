import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db.js";
import { many } from "../db.js";
import type { AgentDefinition } from "../types.js";

const root = new URL("../../", import.meta.url).pathname;

export function configAgents(): AgentDefinition[] {
  return readdirSync(join(root, "config/agents")).filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(root, "config/agents", f), "utf8")));
}

export function packRules(pack: string): string {
  return readFileSync(join(root, "config/packs", `${pack}.md`), "utf8");
}

const cmpVersion = (a: string, b: string) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

/**
 * Agent definitions come from the database (versioned; loaded with `npm run agents:sync`).
 * A tenant can pin a version in settings.agentVersions, e.g. { "drafting": "1.0.0" }.
 */
export async function loadAgents(db: Db, pinned: Record<string, string> = {}): Promise<Record<string, AgentDefinition>> {
  const rows = await many<{ agent_key: string; version: string; definition: AgentDefinition }>(db, "select agent_key, version, definition from agent_definitions");
  const out: Record<string, AgentDefinition> = {};
  for (const r of rows) {
    if (pinned[r.agent_key]) { if (r.version === pinned[r.agent_key]) out[r.agent_key] = r.definition; continue; }
    if (!out[r.agent_key] || cmpVersion(r.version, out[r.agent_key].version) > 0) out[r.agent_key] = r.definition;
  }
  for (const a of configAgents()) out[a.id] ??= a;    // fall back to files if not synced yet
  return out;
}
