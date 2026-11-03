import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { closePool } from "../db.js";
import { tenantBySlug } from "../onboarding.js";
import { erasePerson, exportPerson, suppress } from "../data-rights.js";
import { releaseQueue } from "../jobs/queue.js";

const HELP = `
Data protection requests for one person at one business.

  npm run prod:data -- export   --slug marks-flooring --email jo@example.com [--out jo.json] --by "Charlotte"
  npm run prod:data -- erase    --slug marks-flooring --phone 07700900123 --by "Charlotte"
  npm run prod:data -- suppress --slug marks-flooring --email jo@example.com --reason "asked not to be contacted"
`;
const [cmd, ...rest] = process.argv.slice(2);
const { values: a } = parseArgs({ args: rest, strict: false, options: {
  slug: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, out: { type: "string" }, by: { type: "string" }, reason: { type: "string" },
} }) as { values: Record<string, string | undefined> };

try {
  const who = { email: a.email, phone: a.phone };
  if (!cmd || (!who.email && !who.phone)) { console.log(HELP); }
  else {
    const t = await tenantBySlug(a.slug!);
    if (cmd === "export") {
      const data = await exportPerson(t.id, who, `admin:${a.by ?? "unknown"}`);
      if (!data) console.log("No one with those details.");
      else if (a.out) { writeFileSync(a.out, JSON.stringify(data, null, 2)); console.log(`Written to ${a.out}`); }
      else console.log(JSON.stringify(data, null, 2));
    } else if (cmd === "erase") {
      console.log((await erasePerson(t.id, who, `admin:${a.by ?? "unknown"}`)) ? "Erased." : "No one with those details.");
    } else if (cmd === "suppress") {
      await suppress(t.id, who, a.reason ?? "opted out"); console.log("Suppressed.");
    } else console.log(HELP);
  }
} finally {
  await releaseQueue();
  await closePool();
}
