import { parseArgs } from "node:util";
import { closePool, many, withTenant } from "../db.js";
import { addWebhook, connectWhatsApp, createTenant, setTenantStatus, tenantBySlug } from "../onboarding.js";
import { googleConnectLink } from "../app.js";
import { releaseQueue } from "../jobs/queue.js";

const HELP = `
Onboard and manage businesses.

  npm run tenant -- create --slug marks-flooring --name "Mark's Flooring" --pack flooring \\
       --owner "Mark Jones" --owner-whatsapp 07700900123 [--owner-email mark@example.com] \\
       [--use-cases answer_enquiries,book_appointments]
  npm run tenant -- google-link --slug marks-flooring          New link for the owner to connect Gmail + Calendar
  npm run tenant -- whatsapp --slug marks-flooring --phone-number-id 1234 --token EAAG...
  npm run tenant -- add-form --slug marks-flooring [--label "Website contact form"]
  npm run tenant -- add-checkatrade-webhook --slug marks-flooring
  npm run tenant -- activate --slug marks-flooring             Start handling messages
  npm run tenant -- show --slug marks-flooring
`;

const [cmd, ...rest] = process.argv.slice(2);
const { values: a } = parseArgs({
  args: rest, strict: false,
  options: {
    slug: { type: "string" }, name: { type: "string" }, pack: { type: "string" },
    owner: { type: "string" }, "owner-whatsapp": { type: "string" }, "owner-email": { type: "string" },
    "use-cases": { type: "string" }, "phone-number-id": { type: "string" }, token: { type: "string" }, label: { type: "string" },
  },
}) as { values: Record<string, string | undefined> };

try {
  switch (cmd) {
    case "create": {
      const r = await createTenant({
        slug: a.slug!, name: a.name!, pack: a.pack!,
        owner: { name: a.owner!, whatsapp: a["owner-whatsapp"]!, email: a["owner-email"] },
        useCases: a["use-cases"]?.split(","),
      });
      console.log(`Created ${a.name} (${r.id}).

Next steps:
1. Send the owner this link to connect Gmail and Google Calendar (valid 7 days):
   ${r.googleLink}
2. Ask the owner to send any message to the platform WhatsApp number, so approvals arrive as buttons straight away.
3. Connect their WhatsApp number:  npm run tenant -- whatsapp --slug ${a.slug} --phone-number-id ... --token ...
4. Add website form / Checkatrade webhooks if they have them:  add-form, add-checkatrade-webhook
5. Check the settings (prices, hours, area) in the tenants table, then:  npm run tenant -- activate --slug ${a.slug}`);
      break;
    }
    case "google-link": console.log(googleConnectLink((await tenantBySlug(a.slug!)).id)); break;
    case "whatsapp": await connectWhatsApp((await tenantBySlug(a.slug!)).id, a["phone-number-id"]!, a.token!); console.log("WhatsApp connected."); break;
    case "add-form": console.log(`Point the website form's webhook at:\n${await addWebhook((await tenantBySlug(a.slug!)).id, "web_form", a.label)}`); break;
    case "add-checkatrade-webhook": console.log(`Give Checkatrade this lead webhook URL:\n${await addWebhook((await tenantBySlug(a.slug!)).id, "checkatrade_webhook")}`); break;
    case "activate": await setTenantStatus((await tenantBySlug(a.slug!)).id, "active"); console.log("Active."); break;
    case "show": {
      const t = await tenantBySlug(a.slug!);
      await withTenant(t.id, async (db) => {
        console.log(`${t.name} – ${t.status}`);
        console.table(await many(db, "select kind, external_id, status, last_error from channel_connections order by kind"));
        console.table(await many(db, "select use_case, enabled from tenant_use_cases"));
        console.table(await many(db, "select name, whatsapp_phone, is_approver from tenant_members"));
        console.table(await many(db, "select status, count(*)::int from drafts group by status"));
      });
      break;
    }
    default: console.log(HELP);
  }
} finally {
  await releaseQueue();
  await closePool();
}
