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

1. **Supabase:** create a project in the London region (eu-west-2). Copy the *session pooler* connection string into `DATABASE_URL`.
2. **Secrets:** copy `.env.example` to `.env`, then generate `DATA_ENCRYPTION_KEY` and `SIGNING_SECRET` with `openssl rand -base64 32`.
3. **Claude API key** from the Console, under your business entity.
4. **Google Cloud:**
   - Create an OAuth client (Web), with redirect URI `https://<your domain>/oauth/google/callback`.
   - Enable the Gmail API and the Google Calendar API.
   - Add the scopes listed in `src/integrations/google.ts`.
5. **Meta (WhatsApp):**
   - Create an app with WhatsApp, and register a phone number for the platform itself (this sends approvals to owners).
   - Point the webhook at `https://<your domain>/webhooks/whatsapp` with your `WA_VERIFY_TOKEN`, and subscribe to `messages`.
   - Create the approval template (below) and wait for approval.
6. **Install, migrate and publish the agents:**
   ```bash
   npm install
   npm run migrate        # database tables + job queue
   npm run agents:sync    # publishes config/agents/*.json as versioned definitions
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

## Onboarding a business (about 10 minutes)

```bash
npm run tenant -- create --slug marks-flooring --name "Mark's Flooring" --pack flooring \
  --owner "Mark Jones" --owner-whatsapp 07700900123
```

This prints a link for the owner to connect Gmail and Google Calendar, and the next steps:

```bash
npm run tenant -- whatsapp --slug marks-flooring --phone-number-id <id> --token <token>   # their WhatsApp number
npm run tenant -- add-form --slug marks-flooring                                           # website form webhook URL
npm run tenant -- add-checkatrade-webhook --slug marks-flooring                            # only for Checkatrade strategic accounts
npm run tenant -- show --slug marks-flooring
npm run tenant -- activate --slug marks-flooring
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
  npm run data -- export   --slug marks-flooring --email jo@example.com --by "Charlotte"
  npm run data -- erase    --slug marks-flooring --phone 07700900555 --by "Charlotte"
  npm run data -- suppress --slug marks-flooring --email jo@example.com --reason "opted out"
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
