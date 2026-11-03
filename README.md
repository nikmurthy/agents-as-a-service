# Agent platform

The base for onboarding businesses and running agent use cases for them.

**Live at launch:** *Answer enquiries* and *Book appointments*, across Gmail, WhatsApp, website forms and Checkatrade, with every reply approved by the business owner on WhatsApp.

## How it works

```
Gmail (checked every minute) ─┐
WhatsApp (business number) ───┤                      ┌─ triage ─ booking (Google Calendar) ─ draft ─ review ─┐
Website form webhook ─────────┼─► ingest ─► queue ─► │                                                       │
Checkatrade email / webhook ──┘   (contact matched   └───────────────────────────────────────────────────────┘
                                   across channels)                              │
                                                                                 ▼
                                             Owner's WhatsApp: [Approve] [Edit] [Reject]
                                                                                 │
                                       WhatsApp / Gmail sent automatically · Checkatrade or phone: wording sent to owner
```

1. A message arrives on any channel and is saved once, matched to the same person across channels, and queued.
2. The agents triage it. For a new job they find real free times in the owner's Google Calendar and **hold** up to three, shown as tentative events. They then draft a reply in the business's voice, and an independent reviewer scores it.
3. The owner gets the draft on WhatsApp with **Approve / Edit / Reject** buttons. Emergencies, complaints and anything the reviewer doubts are marked ⚠️.
4. **Approve** sends the reply by WhatsApp or email. For Checkatrade, text or phone, the owner gets the final wording to paste or say. **Edit** asks for their wording and sends that. **Reject** sends nothing and frees the held times.
5. When the customer picks a time, it's confirmed in the diary, the other held times are released, and a confirmation goes to the owner for approval. Unpicked holds expire after 48 hours.

## What's in the box

| Part | Where |
|---|---|
| Database: businesses, people, channels, conversations, drafts, holds, audit log, data requests. Row-level security on every table | `supabase/migrations/` |
| Webhook server: WhatsApp (signature checked), forms, Checkatrade, Google connection | `src/app.ts` |
| Worker: agent runs, approvals, sending, Gmail checks, hold expiry, retention, stuck-message sweep | `src/jobs/tasks.ts`, `src/worker.ts` |
| Use cases | `src/workflows/answer-enquiry.ts` |
| WhatsApp approvals | `src/approvals.ts` |
| Sending | `src/outbox.ts` |
| Diary: availability, holds, confirmation | `src/calendar.ts` |
| Agents (versioned) and sector rules | `config/agents/`, `config/packs/*.md` |
| Sector templates for onboarding | `config/packs/*.template.json` (flooring, trades, practitioner) |
| Onboarding and data-rights commands | `src/cli/` |

## One-time setup

1. **Supabase:** create a project in the London region (eu-west-2, chosen as a *specific* region). Keep its *session pooler* connection string for Bitwarden (next step), not in a file.
2. **Secrets:** put every production secret in Bitwarden Secrets Manager. See [Secrets and security](#secrets-and-security). Generate `DATA_ENCRYPTION_KEY` and `SIGNING_SECRET` with `openssl rand -base64 32` and store them there straight away.
3. **Claude API key** from the Console, under your business entity.
4. **Google Cloud:**
   - Create an OAuth client (Web), with redirect URI `https://<your domain>/oauth/google/callback`.
   - Enable the Gmail API and the Google Calendar API.
   - Add the scopes listed in `src/integrations/google.ts`.
5. **Meta (WhatsApp):**
   - Create an app with WhatsApp, and register a phone number for the platform itself (this sends approvals to owners).
   - Point the webhook at `https://<your domain>/webhooks/whatsapp` with your `WA_VERIFY_TOKEN`, and subscribe to `messages`.
   - Create the approval template (below) and wait for approval.
6. **Install, migrate and publish the agents.** Preferably run the **Migrate production** GitHub Action (Actions tab → Run workflow), so your laptop never needs production access. From a terminal instead:
   ```bash
   npm install
   npm run prod:migrate       # database tables + job queue, secrets injected by Bitwarden
   npm run prod:agents:sync   # publishes config/agents/*.json as versioned definitions
   ```
7. **Run two processes** (any UK or EU host, e.g. Fly.io in London or Render in Frankfurt):
   ```bash
   npm run server         # webhooks, public URL
   npm run worker         # jobs; run more than one to scale
   ```

**Approval template** (Meta → WhatsApp Manager → Message templates). Category *Utility*, name `draft_ready_for_approval`, language English (UK).
- Body: `{{1}}: new message from {{2}}. Suggested reply: {{3}}`
- Quick-reply buttons: `Approve`, `Edit`, `Reject`

This template is only used when the owner hasn't messaged the platform number in the last 24 hours. Otherwise approvals arrive as normal button messages.

## Secrets and security

Production secrets never live in files, code, chat or GitHub. They live in **Bitwarden Secrets Manager** and are handed to a command only while it runs.

**Set up once**
1. In Bitwarden, open **Secrets Manager** and create a project called `agents-as-a-service-production`.
2. Add each production secret, named exactly as the variable in `.env.example`: `DATABASE_URL`, `DATA_ENCRYPTION_KEY`, `SIGNING_SECRET`, `ANTHROPIC_API_KEY`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `PLATFORM_WA_PHONE_NUMBER_ID`, `PLATFORM_WA_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_BASE_URL`. Names must have no spaces.
3. Create two **machine accounts**, each with read access to that project only:
   - `laptop`: its access token is stored as an item in your Bitwarden password manager, never in a file.
   - `github-actions`: its access token goes in GitHub → Settings → Environments → `production` → secret `BW_ACCESS_TOKEN`. In the same environment, add variables `BW_SECRET_ID_DATABASE_URL`, `BW_SECRET_ID_DATA_ENCRYPTION_KEY` and `BW_SECRET_ID_SIGNING_SECRET`, holding each secret's Bitwarden ID (not its value). Turn on **Required reviewers** so production runs need your approval.
4. Install the Bitwarden Secrets Manager CLI, `bws`.

**Running a production command from a terminal**
```bash
export BWS_ACCESS_TOKEN="$(…paste from Bitwarden…)"   # this terminal only; gone when it closes
export BWS_PROJECT_ID=<project id>
npm run prod:tenant -- create --slug ... # or prod:migrate, prod:agents:sync, prod:data
unset BWS_ACCESS_TOKEN
```
`bws run` injects the project's secrets into that one command and nothing is written to disk. For a Bitwarden EU account, also `export BWS_SERVER_URL=https://vault.bitwarden.eu`.

**The app host** (Fly.io, Render…): set the same variables in its encrypted secrets settings, or start the processes with `bws run` and a separate `app-host` machine account.

**Rules**
- `.env` is for **development only**, against a local or separate development database. Never put production values in it. It's ignored by git.
- Turn on two-factor sign-in for Bitwarden, Supabase, GitHub, Google Cloud, Meta and the Claude Console.
- In Supabase → Database → **Network restrictions**, allow only your app host's addresses once it's deployed. A stolen password alone then can't reach the database. If you do this, run migrations from the app host rather than GitHub Actions, whose addresses change.
- If a secret might have leaked: rotate it in its own service, update it in Bitwarden, then redeploy. If it's the `DATA_ENCRYPTION_KEY`, every business must reconnect Google and WhatsApp.
- Revoke a machine account's token in Bitwarden the moment a laptop is lost or a person leaves.

## Onboarding a business (about 10 minutes)

```bash
npm run prod:tenant -- create --slug marks-flooring --name "Mark's Flooring" --pack flooring \
  --owner "Mark Jones" --owner-whatsapp 07700900123
```

This prints a link for the owner to connect Gmail and Google Calendar, and the next steps:

```bash
read -s TENANT_WA_TOKEN && export TENANT_WA_TOKEN                                   # paste the token; not echoed or saved in history
npm run prod:tenant -- whatsapp --slug marks-flooring --phone-number-id <id>          # their WhatsApp number
npm run prod:tenant -- add-form --slug marks-flooring                                           # website form webhook URL
npm run prod:tenant -- add-checkatrade-webhook --slug marks-flooring                            # only for Checkatrade strategic accounts
npm run prod:tenant -- show --slug marks-flooring
npm run prod:tenant -- activate --slug marks-flooring
```

Before activating, set their real prices, hours, sign-off and service area in `tenants.settings` (Supabase table editor). The template's prices are examples. Until a business is active, its messages are stored but not acted on.

Checkatrade lead emails are picked up automatically from their Gmail.

## Data protection

- Every business's data is separated by row-level security, and the tests check this.
- Google and WhatsApp tokens are encrypted at rest.
- Agents never see email addresses or phone numbers.
- Health and children's details are tagged when messages arrive.
- Message text is deleted after `retentionDays`: 365 by default, 180 for the practitioner pack.
- The audit log can't be edited or deleted.
- To handle a person's data request:
  ```bash
  npm run prod:data -- export   --slug marks-flooring --email jo@example.com --by "Charlotte"
  npm run prod:data -- erase    --slug marks-flooring --phone 07700900555 --by "Charlotte"
  npm run prod:data -- suppress --slug marks-flooring --email jo@example.com --reason "opted out"
  ```

## Tests

```bash
TEST_DATABASE_URL=postgres://...throwaway... npm test
```

The tests wipe that database. They run the whole journey against real Postgres, with Google and WhatsApp faked:

- A WhatsApp enquiry gets three held times, an approval and a sent reply.
- The customer picks a time, the booking is confirmed and the other holds are released.
- A Checkatrade email produces wording for the owner to paste.
- An owner edit is sent as written.
- A complaint is flagged and rejected without anything being sent.
- A double-tapped button doesn't send twice.
- A website form webhook arrives as a message for the right business.
- Row-level security keeps businesses apart.
- The audit log can't be edited.
- Erasing a person removes their details and cancels their booking.
- Messages for a paused business are stored but not acted on.

## Limits to know before the first customers

- **Google verification.** While the Google app is in *Testing*, only test users you list can connect (up to 100), and their connection expires every 7 days. Before real customers, submit the app for verification. Reading Gmail is a restricted scope and needs an annual independent security assessment. Calendar alone is much lighter.
- **WhatsApp for each business.** Connecting a business's own number is done by hand for now (phone number id + token). For scale, become a Meta Tech Provider and add Embedded Signup. WhatsApp replies to customers only go out within 24 hours of their last message; after that the owner is told to reply directly.
- **Checkatrade.** There's no reply API, so the owner pastes Checkatrade replies themselves. The lead webhook is only for strategic accounts. Most leads arrive by email, which is covered.
- **Not built yet:** Outlook, Instagram and Facebook DMs, SMS, a web dashboard (Supabase logins are already allowed for in the security rules), self-serve sign-up, billing, and auto-send without approval.
