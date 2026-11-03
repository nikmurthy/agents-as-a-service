# Rules for this codebase

Multi-tenant platform: each business is a tenant. Keep to these rules in every change.

## Tenancy and data
- All tenant work goes through `withTenant` (short) or `withTenantSession` (agent runs). These switch to the `app_tenant` role and set `app.tenant_id`, so row-level security limits every query to one business. Never query tenant tables through `withAdmin` except to route an incoming webhook to its tenant or for platform-wide sweeps, and then hand over to `withTenant`.
- Every new tenant table: `tenant_id uuid not null`, RLS enabled and forced, the `tenant_isolation` and `platform_admin` policies, grants to `app_tenant`. Add it to the arrays in the migration pattern. Add a test that business B can't see business A's rows.
- Secrets (tokens) only ever stored via `encryptJson`. Never log them.
- Agents see `modelView` only: no email addresses or phone numbers.
- `audit()` for every decision and every send. No message text or health details in audit detail.
- New schema changes go in a new file in `supabase/migrations/`; never edit an applied migration.

## Agents and use cases
- Agents are versioned JSON in `config/agents/`. Change = bump `version`, then `npm run agents:sync`. Never edit a published version.
- Agents judge; code decides. Escalation, slot validation, reply routes and sending rules live in TypeScript, not prompts.
- Nothing reaches a customer without an approved draft. Keep it that way unless the business explicitly opts into auto-send for a use case (not built yet).
- A new use case = a workflow in `src/workflows/`, a task in `src/jobs/tasks.ts`, a value in the `tenant_use_cases` check constraint, and tests.
- A new channel = a parser in `src/channels/parse.ts`, a route into `ingest()`, and tests. Nothing downstream changes.

## Testing
- `npm run typecheck` and `npm test` must pass. Tests wipe the database in TEST_DATABASE_URL: never point it at a real one.
- External APIs (Google, WhatsApp) go through `clients` in `src/integrations/index.ts` so tests can use fakes.
