import { readFileSync, existsSync } from "node:fs";
import { one, withAdmin, withTenant } from "./db.js";
import { encryptJson, randomToken } from "./crypto.js";
import { normalisePhone } from "./channels/parse.js";
import { audit } from "./audit.js";
import { env } from "./env.js";
import { googleConnectLink } from "./google-link.js";
import type { TenantSettings } from "./types.js";

const packDir = new URL("../config/packs/", import.meta.url).pathname;

export function packTemplate(pack: string): { settings: TenantSettings; useCases: string[] } {
  const f = `${packDir}${pack}.template.json`;
  if (!existsSync(f)) throw new Error(`No template for pack "${pack}" (expected config/packs/${pack}.template.json)`);
  return JSON.parse(readFileSync(f, "utf8"));
}

export interface NewTenant {
  slug: string; name: string; pack: string;
  owner: { name: string; whatsapp: string; email?: string };
  useCases?: string[];
  settings?: Partial<TenantSettings>;
  by?: string;                         // audit actor, default "admin"
}

/** Creates a business from its sector template, with the owner as approver. Returns the next-step links. */
export async function createTenant(t: NewTenant) {
  const tpl = packTemplate(t.pack);
  const settings = { ...tpl.settings, ...t.settings };
  const phone = normalisePhone(t.owner.whatsapp);
  if (!phone) throw new Error("Owner WhatsApp number is required");
  const tenant = await withAdmin(async (db) => {
    const row = await one<{ id: string }>(db, "insert into tenants (slug, name, pack, settings) values ($1, $2, $3, $4) returning id", [t.slug, t.name, t.pack, settings]);
    await audit(db, { tenantId: row!.id, actor: t.by ?? "admin", action: "tenant.created", detail: { pack: t.pack } });
    return row!;
  });
  await withTenant(tenant.id, async (db) => {
    await db.query("insert into tenant_members (tenant_id, name, role, email, whatsapp_phone) values (app_current_tenant(), $1, 'owner', $2, $3)",
      [t.owner.name, t.owner.email ?? null, phone]);
    for (const u of t.useCases ?? tpl.useCases) {
      await db.query("insert into tenant_use_cases (tenant_id, use_case) values (app_current_tenant(), $1)", [u]);
    }
  });
  return { id: tenant.id, googleLink: googleConnectLink(tenant.id) };
}

export async function tenantBySlug(slug: string) {
  const t = await withAdmin((db) => one<{ id: string; name: string; status: string }>(db, "select id, name, status from tenants where slug = $1", [slug]));
  if (!t) throw new Error(`No business with slug "${slug}"`);
  return t;
}

/** Until Meta Embedded Signup is set up: store the business's WhatsApp phone number id and token by hand. */
export async function connectWhatsApp(tenantId: string, phoneNumberId: string, accessToken: string, by = "admin") {
  await withTenant(tenantId, async (db) => {
    await db.query(
      `insert into channel_connections (tenant_id, kind, external_id, secret_ciphertext) values (app_current_tenant(), 'whatsapp', $1, $2)
       on conflict (kind, external_id) do update set secret_ciphertext = excluded.secret_ciphertext, status = 'active'`,
      [phoneNumberId, encryptJson({ accessToken })]);
    await audit(db, { tenantId, actor: by, action: "whatsapp.connected" });
  });
}

export async function addWebhook(tenantId: string, kind: "web_form" | "checkatrade_webhook", label?: string, by = "admin") {
  const token = randomToken();
  await withTenant(tenantId, async (db) => {
    await db.query("insert into channel_connections (tenant_id, kind, external_id, label) values (app_current_tenant(), $1, $2, $3)", [kind, token, label ?? null]);
    await audit(db, { tenantId, actor: by, action: `${kind}.added` });
  });
  return `${env.publicBaseUrl}/webhooks/${kind === "web_form" ? "forms" : "checkatrade"}/${token}`;
}

export async function setTenantStatus(tenantId: string, status: "active" | "paused") {
  await withAdmin((db) => db.query("update tenants set status = $2 where id = $1", [tenantId, status]));
}
