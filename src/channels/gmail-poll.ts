import { many, withAdmin, withTenantSession } from "../db.js";
import { clients } from "../integrations/index.js";
import { googleToken, type Connection } from "../connections.js";
import { parseGmail, parseAddress } from "./parse.js";
import { ingest } from "../ingest.js";
import { loadTenant } from "../tenants.js";

/** Checks every connected Gmail inbox for new messages since the last check (Gmail history API). */
export async function pollAllGmail(): Promise<number> {
  const conns = await withAdmin((db) => many<Connection>(db, "select * from channel_connections where kind = 'gmail' and status = 'active'"));
  let total = 0;
  for (const c of conns) {
    try {
      total += await pollGmail(c);
    } catch (e: any) {
      await withAdmin((db) => db.query("update channel_connections set last_error = $2 where id = $1", [c.id, String(e?.message ?? e).slice(0, 500)]));
    }
  }
  return total;
}

async function pollGmail(conn: Connection): Promise<number> {
  const found: { tenantId: string; parsed: ReturnType<typeof parseGmail> }[] = [];
  await withTenantSession(conn.tenant_id, async (db) => {
    const tenant = await loadTenant(db, conn.tenant_id);
    const token = await googleToken(db, conn);
    let start: string | undefined = conn.cursor?.historyId;
    if (!start) {
      const p = await clients.google.gmailProfile(token);
      await db.query("update channel_connections set cursor = $2 where id = $1", [conn.id, { historyId: p.historyId }]);
      return; // start from now: don't import the whole inbox
    }
    let res: { ids: string[]; historyId: string };
    try {
      res = await clients.google.gmailNewMessageIds(token, start);
    } catch (e: any) {
      if (/404/.test(String(e?.message))) { // history too old: restart from now
        const p = await clients.google.gmailProfile(token);
        await db.query("update channel_connections set cursor = $2 where id = $1", [conn.id, { historyId: p.historyId }]);
        return;
      }
      throw e;
    }
    for (const id of res.ids) {
      const msg = await clients.google.gmailGet(token, id);
      const labels: string[] = msg.labelIds ?? [];
      if (!labels.includes("INBOX") || labels.includes("SENT") || labels.includes("DRAFT") || labels.includes("SPAM")) continue;
      const from = parseAddress((msg.payload?.headers ?? []).find((h: any) => h.name.toLowerCase() === "from")?.value ?? "");
      if (from.email === conn.external_id) continue; // our own sent mail
      found.push({ tenantId: conn.tenant_id, parsed: parseGmail(msg, { checkatradeSenders: tenant.settings.checkatradeSenders ?? [] }) });
    }
    await db.query("update channel_connections set cursor = $2, last_error = null where id = $1", [conn.id, { historyId: res.historyId }]);
  });
  for (const f of found) await ingest(f.tenantId, f.parsed);
  return found.length;
}
