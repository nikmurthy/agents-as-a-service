// All configuration comes from environment variables. See .env.example.
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}
const opt = (name: string, fallback = "") => process.env[name] ?? fallback;

export const env = {
  get databaseUrl() { return req("DATABASE_URL"); },
  get publicBaseUrl() { return opt("PUBLIC_BASE_URL", "http://localhost:8080"); },
  get port() { return Number(opt("PORT", "8080")); },
  /** 32 random bytes, base64. Encrypts stored tokens. Generate: openssl rand -base64 32 */
  get dataEncryptionKey() { return req("DATA_ENCRYPTION_KEY"); },
  /** Signs OAuth state and webhook links. Generate: openssl rand -base64 32 */
  get signingSecret() { return req("SIGNING_SECRET"); },

  get agentMode(): "live" | "mock" { return opt("AGENT_MODE", "live") === "mock" ? "mock" : "live"; },
  get anthropicApiKey() { return opt("ANTHROPIC_API_KEY"); },

  // Meta / WhatsApp Cloud API
  get graphApiVersion() { return opt("GRAPH_API_VERSION", "v21.0"); },
  get waAppSecret() { return req("WA_APP_SECRET"); },          // verifies webhook signatures
  /** Optional: a second Meta app's secret, for webhooks from a second Meta app (e.g. a test app). */
  get waAppSecrets() { return [req("WA_APP_SECRET"), opt("PLATFORM_WA_APP_SECRET")].filter(Boolean); },
  get waVerifyToken() { return req("WA_VERIFY_TOKEN"); },      // webhook subscription handshake
  // Embedded Signup: lets a business connect the number they already use in the WhatsApp Business app.
  // Needs Meta Tech Provider status. META_APP_SECRET defaults to WA_APP_SECRET (same Meta app).
  get metaAppId() { return opt("META_APP_ID"); },
  get metaAppSecret() { return opt("META_APP_SECRET") || opt("WA_APP_SECRET"); },
  get metaSignupConfigId() { return opt("META_SIGNUP_CONFIG_ID"); },

  // Google (Gmail + Calendar)
  get googleClientId() { return req("GOOGLE_CLIENT_ID"); },
  get googleClientSecret() { return req("GOOGLE_CLIENT_SECRET"); },

  // Checkatrade lead webhook (strategic accounts only): comma-separated source IPs allowed
  get checkatradeAllowedIps() { return opt("CHECKATRADE_ALLOWED_IPS").split(",").map((s) => s.trim()).filter(Boolean); },

  // Admin web app: Supabase Auth. Set SUPABASE_JWT_SECRET (legacy HS256 projects) or SUPABASE_URL (asymmetric keys, verified via JWKS).
  get supabaseUrl() { return opt("SUPABASE_URL"); },
  get supabaseAnonKey() { return opt("SUPABASE_ANON_KEY"); },
  get supabaseJwtSecret() { return opt("SUPABASE_JWT_SECRET"); },

  get holdHours() { return Number(opt("HOLD_HOURS", "48")); },
};
