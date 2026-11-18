import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { env } from "../env.js";

// Serves the built admin app (apps/admin, `npm run admin:build`) at /admin.
export const adminApp = new Hono();

adminApp.use("*", async (c, next) => {
  await next();
  const supabase = env.supabaseUrl ? ` ${new URL(env.supabaseUrl).origin}` : "";
  c.header("Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'${supabase}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  if (c.req.path === "/admin/config.json" || c.req.path === "/admin" || c.req.path === "/admin/") c.header("Cache-Control", "no-store");
});

// Public by design: the Supabase URL and anon key are meant to be in the browser. Row-level security and our own API checks do the protecting.
adminApp.get("/admin/config.json", (c) => c.json({ supabaseUrl: env.supabaseUrl ?? null, supabaseAnonKey: env.supabaseAnonKey ?? null }));

adminApp.get("/admin", (c) => c.redirect("/admin/"));
adminApp.use("/admin/*", serveStatic({ root: "./apps/admin/dist", rewriteRequestPath: (p) => p.replace(/^\/admin/, "") || "/" }));
