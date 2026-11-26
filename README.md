# Agents as a service

A team of AI helpers for small businesses, each one doing a dull job the owner would otherwise do on their phone at 10pm.

## The aim

Small businesses lose work because they can't answer fast enough. A flooring fitter is on their knees all day; a nutritionist is with clients back to back. Enquiries arrive by email, WhatsApp, text, website forms and Checkatrade, and the first business to reply usually wins the job.

This platform answers for them, in their own voice, without taking control away from them:

- **Every message is answered quickly,** on whichever channel it came from, with real free times from the owner's diary or their own booking link.
- **The owner stays in charge.** Nothing reaches a customer until the owner taps **Approve** on WhatsApp or in the web app. Only once a kind of reply has been approved unchanged several times does the platform *offer* to send replies like it automatically. It never switches that on by itself, it keeps spot-checking, and it tells the owner every time.
- **The boring follow-ups happen.** Quiet quotes get one polite nudge. Finished jobs get a request for feedback or a review.
- **Customer data is handled properly.** Each business is walled off from the others in the database. The AI never sees email addresses or phone numbers. Every decision is in an audit log. People can ask for their data to be exported or erased.

One platform serves many businesses ("tenants"). Each picks an **industry pack** (flooring, trades, practitioner) that sets sensible defaults. They then shape every step in **Flows**: how bookings work, how replies sound, when to automate, when to ask for feedback.

**First customers:** The Health Nutritionist (practitioner pack) and trades businesses such as flooring fitters.

## What it does today

| Use case | What happens |
|---|---|
| **Answer enquiries** | Any new message is triaged. The platform drafts a reply in the business's voice, an independent reviewer scores it, and it goes to the owner to approve. |
| **Book appointments** | The owner chooses one of three ways, per business: offer up to three real free times from their Google Calendar (held as tentative events); send their own booking link (Halaxy, Cliniko, Jane, Fresha, Timely, Setmore, Calendly, Acuity, SimplyBook.me or another); or say "I'll arrange a time myself". |
| **Chase quotes** | The owner marks a quote as sent. If the customer goes quiet for a set number of days, one polite follow-up is drafted. |
| **Ask for feedback** | Once a booked appointment has ended, or the owner taps **Job done**, the customer is asked how it went, once, with an optional review link. Everyone is asked the same way: the platform never picks only happy customers. |
| **Checkatrade leads** | Lead emails are read. The owner gets a suggestion: **Interested** or **Not for me** (with the reason). They get the three taps to make in Checkatrade, then replies go straight to the customer. |

**Channels in:** Gmail (checked every minute), WhatsApp, website forms, Checkatrade (email, or the webhook for strategic accounts), and texts (SMS/RCS) forwarded from the owner's iPhone through a small relay on their Mac.

**Channels out:** WhatsApp (inside the 24-hour window) and email are sent automatically after approval. For Checkatrade, texts and phone calls, the owner gets the final wording to paste or say.

**One number for a sole trader.** A sole trader can connect the one number they already use in the **WhatsApp Business app**, and keep using the app as now (Meta "coexistence"). Customers message that number; approved replies go from it; approvals arrive as a separate chat from the platform's number, or in the admin app. People saved in their phone are left alone unless they're already customers, any chat can be marked **Not a customer? Ignore**, and if the owner answers a customer themselves in the app, the waiting draft is dropped. This needs Meta Tech Provider approval; until then, test with Meta's test numbers. Step by step: `docs/whatsapp-setup.md`.

## How it works

```
Gmail ───────────────┐
WhatsApp ────────────┤
Website form ────────┼─► ingest ─► queue ─► triage ─► booking ─► reply writer ─► reviewer
Checkatrade ─────────┤   (same person                (calendar /   (tone, style,     (scores it,
Texts (Mac relay) ───┘    matched across               link / owner)  examples)         flags doubts)
                          channels)                                                       │
                                                                                          ▼
                                     approveOrAsk(): does the owner need to see this one?
                                       │                                         │
                          yes (default, and always for complaints,     no (owner said yes to automating
                          emergencies, health questions, flagged)       this kind of reply; not a spot check)
                                       │                                         │
                                       ▼                                         │
                  Owner's WhatsApp or web Inbox: [Approve] [Edit] [Reject]       │
                                       │                                         │
                                       └──────────────► outbox ◄─────────────────┘
                                                          │
                       WhatsApp / email sent · Checkatrade, text or phone: wording sent to the owner
                       Automatic sends: the owner gets a note on WhatsApp each time
```

1. A message arrives on any channel. It is saved once, matched to the same person across channels, and queued.
2. **Triage** works out what the person wants and whether anything is urgent or sensitive.
3. **Booking** follows the business's choice in Flows: hold real free times from the calendar, add the booking link, or tell the customer the owner will be in touch.
4. The **reply writer** drafts a reply using the business's tone, details (greeting, length, emoji, spelling, words to avoid) and up to three example replies the owner has pasted. It copies their style, never the content. An independent **reviewer** scores the draft.
5. **Code, not the AI, decides** what happens next. By default the owner gets the draft on WhatsApp and in the web Inbox, with **Approve / Edit / Reject**. Emergencies, complaints and anything the reviewer doubts are marked ⚠️.
6. **Learn, then offer to automate.** Each draft has a *kind*: answering questions, offering times, confirming bookings, quote follow-ups or feedback requests. After the owner approves, say, 5 of one kind without changing a word, they're asked: "Want me to send replies like these automatically from now on?" If they say yes:
   - those replies go without asking;
   - every 3rd one (set in Settings) still comes to them as a spot check;
   - editing or rejecting one switches that kind back to asking.

   Complaints, emergencies, health questions, flagged drafts, new Checkatrade leads, moving bookings, and text, phone and Checkatrade routes are never automated.
7. When the customer picks a time, it's confirmed in the diary and the other held times are released. Held times that aren't picked expire after 48 hours.
8. After the job, the feedback request goes through the same approve-or-automate step.

## The admin web app

A phone-friendly web app at `/admin/` on the same server. Owners and staff see only their own business. Platform admins see everything.

**For each business**
| Tab | What it's for |
|---|---|
| **Overview** | **Replies waiting for you**, one at a time: what the customer said, our reply, and big **Approve / Edit / Reject** buttons, with a "1 of 3" counter. Then **Get set up** as a task list (Done / To do / Can't start yet, and what you'll need to have to hand), **This week** (replies sent, average time to reply, bookings, quotes chased, with an optional Friday WhatsApp summary), today's numbers and what needs you. |
| **Inbox** | Every conversation with its full thread. Drafts show their review scores and an **Approve / Edit / Reject** that works exactly like WhatsApp. Also here: Checkatrade lead cards, **Job done**, "sent automatically" labels, spot-check notes, and automation offers. |
| **Flows** | Each flow drawn as a row of picture steps, each icon showing the choice made, with the whole flow read as one sentence underneath (tap any underlined part to change it). **Try it** plays a pretend message through the flow and shows the exact reply, without saving, holding or sending anything (owners only, 30 a day). **You approve** shows a trust ladder per kind of reply: Asking you → Ready to offer → Automatic, with a progress bar; kinds that are never automated show a lock and why. **Enquiry flow:** Message arrives → Triage → Booking ⚙ → Reply ⚙ → You approve ⚙ → Sent → Feedback ⚙. **Chasing quotes:** Quote sent → Wait ⚙ → Follow-up → You approve ⚙ → Sent. |
| **Settings** | Name, sign-off, services and prices, hours, service area, reply routes per channel, spot-check rate, data retention. |
| **Connections** | Google (Gmail + Calendar); **Your WhatsApp Business number** (a connect link for the owner) and **Who gets an answer on WhatsApp** (new people and customers, or everyone); a number by its ID for Meta test numbers; website form and Checkatrade webhooks; the Mac text relay. |
| **People** | Owners, staff and approvers, and their WhatsApp numbers. |
| **Bookings** | Held and confirmed appointments. |
| **What happened** | Everything as plain sentences, such as "Sent the reply to Sam automatically by WhatsApp", each saying why, with a **Switch back to asking me** link on automatic sends. The **Details** and **Audit log** tabs keep every agent run with its outcome, versions and cost. |
| **Data requests** | Export, erase or suppress a person. Each one needs a typed confirmation. |

The whole app uses the Atkinson Hyperlegible font (made for low-vision readers), larger text, 48px buttons, plain words ("Pencilled in", "Looks good / Have a closer look") and status in words as well as colour. On a phone, the decision buttons stay at the bottom of the screen.

**Platform admin only:** Businesses (create, pause, close), Agents (what each agent does, its instructions and running cost), Keys (whether each platform key is set, with a **Test** button; values are never shown), and Map (the live workforce map, showing each block's build status and this week's counts).

**Sign-in and roles**
- Sign-in is through Supabase Auth with email and password. Platform admins must also pass a two-factor code.
- Owners change settings, flows, connections and people. Staff can look and approve.
- A WhatsApp token is encrypted on save and is never returned.
- Every change goes in the audit log with who made it. The log never contains message text or example replies.

## What's in the box

| Part | Where |
|---|---|
| Database: businesses, people, channels, conversations, drafts, holds, automations, Checkatrade leads, audit log, data requests. Row-level security on every table | `supabase/migrations/` |
| Webhook server: WhatsApp (signature checked), forms, Checkatrade, texts, Google connection; admin API | `src/app.ts`, `src/admin/` |
| Worker: agent runs, sending, Gmail checks, hold expiry, quote chasing (09:00), feedback (10:00), retention, stuck-message sweep | `src/jobs/tasks.ts`, `src/worker.ts` |
| Use cases | `src/workflows/answer-enquiry.ts`, `chase-quotes.ts`, `ask-feedback.ts` |
| Try it (a read-only dry run) and the weekly summary | `src/workflows/try-enquiry.ts`, `weekly-summary.ts` |
| "What happened": the audit log as plain sentences | `src/admin/feed.ts` |
| Approve or automate, offers, spot checks (all in the Inbox) | `src/automation.ts`, `src/decisions.ts` |
| Approve / reject / edit, shared by WhatsApp and the web app | `src/decisions.ts` |
| One WhatsApp number: personal chats left alone, the owner's own replies, "ignore this person", Embedded Signup | `src/whatsapp-business.ts` |
| Sending | `src/outbox.ts` |
| Diary: availability, holds, confirmation | `src/calendar.ts` |
| Checkatrade lead reading and suggestions | `src/leads.ts`, `src/channels/parse.ts` |
| Settings schema (shared by the API and the web form), reply style | `src/settings-schema.ts` |
| Agents (versioned JSON) and sector rules | `config/agents/`, `config/packs/*.md` |
| Industry packs for onboarding | `config/packs/*.template.json` (flooring, trades, practitioner) |
| Mac relay for texts | `tools/mac-sms-relay/` |
| Onboarding and data-rights commands | `src/cli/` |
| Admin web app | `apps/admin/` (Vite + React) |

**Agents** (current versions): triage 1.1.0, booking 1.1.0, drafting 1.5.0, reviewer 1.1.0. Agents judge; code decides. Escalation, slot checks, reply routes and sending rules are TypeScript, not prompts. See `CLAUDE.md`.

## Releasing

Changes arrive as pull requests. To release one:
1. Merge the pull request.
2. Run **Migrate production** (Actions tab → Run workflow). It applies new database migrations and publishes new agent versions.
3. Run **Deploy production**. It copies secrets from Bitwarden into Fly, deploys, and checks `/health`.

## Release history

| # | Date | What changed |
|---|---|---|
| 20 | 26 Nov 2026 | **The Inbox is the one place to deal with replies.** Owners are no longer messaged on WhatsApp: no approval requests, no "sent automatically" or "send this yourself" messages, no Friday summary (it stays on Overview). No platform number or Meta approval template is needed, and an owner's WhatsApp number is no longer asked for. The Inbox says how many customers need you, marks replies that went automatically, and shows wording to paste, text or say on its card; Meta delivery failures show as "Couldn't send" with the reason. |
| 19 | 24 Nov 2026 | **One WhatsApp number for a sole trader:** connect the WhatsApp Business app number through Meta's Embedded Signup and keep using the app. Personal chats are left alone (saved contacts kept only as hashes; "Not a customer? Ignore"); a reply the owner sends from the app drops the waiting draft; the platform number is now optional (approve in the app). Triage agent 1.2.0 sets personal messages aside. |
| 18 | 21 Nov 2026 | **Making it obvious:** all nine design ideas. Replies waiting one at a time; setup as a task list; This week, with an optional Friday WhatsApp summary; the flow as pictures and a sentence; **Try it**; the trust ladder; "What happened" in plain sentences with a switch-back link; plain words, a more readable font and bigger buttons throughout. |
| 17 | 21 Nov 2026 | This README and `docs/design-ideas.md`. |
| 16 | 20 Nov 2026 | **Flows → Reply:** pick a tone (Warm and friendly, Professional, Short), each with a sector example, or describe your own. Also set the details (greeting, length, emoji, spelling, words to avoid) and paste up to three of your own replies to copy the style of. Contact details are removed from examples. Drafting agent 1.5.0. |
| 15 | 20 Nov 2026 | **Booking link:** a third booking choice that sends the business's own booking page (Halaxy, Cliniko, Fresha…). The code adds the link if the reply leaves it out. Drafting agent 1.4.0. |
| 14 | 20 Nov 2026 | **Flows tab** (replaces Use cases), with per-step choices: book from the calendar or "I'll arrange it". **Learn, then offer to automate**, with spot checks and a note on every automatic send. **Ask for feedback** after the job, with an optional review link. Drafting agent 1.3.0. |
| 13 | 19 Nov 2026 | **Checkatrade:** lead emails read in any layout, **Interested / Not for me** suggestions, three-step instructions, the customer's details added by WhatsApp or the web, then direct replies. Fixed WhatsApp being chosen outside its 24-hour window. |
| 12 | 19 Nov 2026 | **Texts** from the owner's iPhone, through a relay on their Mac. Map: WhatsApp review, industry pack explanations, Current / Future filter. |
| 10–11 | 19 Nov 2026 | **Live workforce map** for platform admins, rebuilt around the map's blocks and their live status. |
| 9 | 19 Nov 2026 | **Agents page** explaining each agent, **Keys page** (set or not, and a Test button), and a setup checklist per business. |
| 4–8 | 18 Nov 2026 | **Deployed to Fly.io London.** Secrets go from Bitwarden into Fly. Agents moved to cheaper current models. |
| 3 | 5 Nov 2026 | **Chase quotes.** |
| 2 | 5 Nov 2026 | **Admin web app** and its API. Approval decisions are shared with WhatsApp. |

## One-time setup

1. **Supabase:** create a project in the London region (eu-west-2, chosen as a *specific* region). Keep its *session pooler* connection string for Bitwarden (next step), not in a file.
2. **Secrets:** put every production secret in Bitwarden Secrets Manager. See [Secrets and security](#secrets-and-security). Generate `DATA_ENCRYPTION_KEY` and `SIGNING_SECRET` with `openssl rand -base64 32` and store them there straight away.
3. **Claude API key** from the Console, under your business entity.
4. **Google Cloud:**
   - Create an OAuth client (Web), with redirect URI `https://<your domain>/oauth/google/callback`.
   - Enable the Gmail API and the Google Calendar API.
   - Add the scopes listed in `src/integrations/google.ts`.
5. **Meta (WhatsApp):**
   - Create an app with WhatsApp. Each business connects its own number; the platform has none of its own.
   - Point the webhook at `https://<your domain>/webhooks/whatsapp` with your `WA_VERIFY_TOKEN`, and subscribe to `messages`.
6. **Install, migrate and publish the agents.** Preferably run the **Migrate production** GitHub Action (Actions tab → Run workflow), so your laptop never needs production access. From a terminal instead:
   ```bash
   npm install
   npm run prod:migrate       # database tables + job queue, secrets injected by Bitwarden
   npm run prod:agents:sync   # publishes config/agents/*.json as versioned definitions
   ```
7. **Run two processes:** `server` (webhooks, admin app, public URL) and `worker` (jobs). Both come from one container image (`Dockerfile`), so any container host works. We use **Fly.io in London**; see [Deploying to Fly.io](#deploying-to-flyio).

## Deploying to Fly.io

`fly.toml` runs the image in London (`lhr`) as two process groups: `server` (always on, health-checked at `/health`) and `worker`. Fly.io keeps no customer data: everything lasting is in Supabase, so either process can be replaced at any time.

**Once**
```bash
brew install flyctl
fly auth login
fly apps create aaas-platform
```

**Deploying normally: the *Deploy production* GitHub Action** (Actions tab → Deploy production → Run workflow). It fetches the secrets from Bitwarden, copies them into Fly, deploys, and checks `/health`. Your laptop never touches production. It needs, in the `production` environment, `FLY_API_TOKEN` (`fly tokens create deploy -a aaas-platform`, which can deploy only this app) as well as the Bitwarden settings used by *Migrate production*. It copies **every** secret in the Bitwarden project into Fly, so a new secret only needs adding in Bitwarden (named exactly as in `.env.example`), then a new run. The run warns about any expected secret that's still missing. `PUBLIC_BASE_URL`, `SUPABASE_URL` and `SUPABASE_ANON_KEY` aren't secret and are set in `fly.toml`.

**From a terminal instead.** Secrets go straight from Bitwarden into Fly's encrypted store, without being shown or written to disk. Anyone who can sign in to the Fly account can read them from a running machine, so turn on two-factor sign-in for Fly. In a terminal of your own (not shared with anyone or any tool):
```bash
read -s "BWS_ACCESS_TOKEN?Bitwarden access token: " && export BWS_ACCESS_TOKEN   # not shown, not saved in history
bws secret list <project id> --output env | fly secrets import --app aaas-platform --stage
unset BWS_ACCESS_TOKEN
```
Run this again whenever a secret changes in Bitwarden, then `fly deploy` (or `fly secrets deploy`) to restart with it.

**Deploy**
```bash
fly deploy                  # builds the image on Fly and rolls out server + worker
fly status                  # both process groups running
curl https://aaas-platform.fly.dev/health
fly logs                    # live logs
```

Until a custom domain is set up, `PUBLIC_BASE_URL` is `https://aaas-platform.fly.dev` (set in `fly.toml`). Use that for the Google OAuth redirect and the WhatsApp webhook.

## Secrets and security

Production secrets never live in files, code, chat or GitHub. They live in **Bitwarden Secrets Manager** and are handed to a command only while it runs.

**Set up once**
1. In Bitwarden, open **Secrets Manager** and create a project called `agents-as-a-service-production`.
2. Add each production secret, named exactly as the variable in `.env.example`: `DATABASE_URL`, `DATA_ENCRYPTION_KEY`, `SIGNING_SECRET`, `ANTHROPIC_API_KEY`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_BASE_URL`. Names must have no spaces.
3. Create two **machine accounts**, each with read access to that project only:
   - `laptop`: its access token is stored as an item in your Bitwarden password manager, never in a file.
   - `github-actions`: its access token goes in GitHub → Settings → Environments → `production` → secret `BW_ACCESS_TOKEN`. In the same environment, add variables `BW_SECRET_ID_DATABASE_URL`, `BW_SECRET_ID_DATA_ENCRYPTION_KEY` and `BW_SECRET_ID_SIGNING_SECRET`, holding each secret's Bitwarden ID (not its value).
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


## Admin web app: setting up

The API is under `/api` (`src/admin/`), the app is in `apps/admin/`. Production builds it into the container image, so a deploy is enough. For a fresh install:

1. In Supabase:
   - Authentication → Providers: keep email on.
   - Authentication → Multi-factor: enable TOTP.
   - Turn off public sign-ups. People are added by an admin or an owner.
2. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_JWT_SECRET` (Project Settings → API). With a newer project that signs with asymmetric keys, leave `SUPABASE_JWT_SECRET` empty.
3. Run the migrations. This adds `platform_admins`.
4. Create your own login in Supabase (Authentication → Users). Then make yourself a platform admin:
   ```sql
   insert into platform_admins (user_id, email) values ('<your auth user id>', '<your email>');
   ```
5. Sign in at `https://<your domain>/admin/`. You'll be asked to set up two-factor on first sign-in.
6. Create a business, then add its owner under **People**. When the owner first signs in with the same email address, their login is linked automatically.

For local work, `npm run admin:install && npm run admin:dev` runs the app with hot reload.

## Tests

```bash
TEST_DATABASE_URL=postgres://...throwaway... npm test
```

The tests wipe that database. They run whole journeys against real Postgres, with Google, WhatsApp and the AI faked (`AGENT_MODE=mock`). There are 88 tests across `test/platform`, `admin`, `flows`, `chase`, `checkatrade`, `whatsapp` and `runner`. Among the things they check:

- **Enquiries:** a WhatsApp enquiry gets held times, an approval and a sent reply. The customer picks a time, the booking is confirmed, and the other holds are released.
- **Owner decisions:** an owner's edit is sent as written. A complaint is flagged and nothing is sent. A double-tapped button doesn't send twice, on WhatsApp or the web.
- **Booking choices:**
  - With the "I'll arrange it" choice, no times are offered.
  - With a booking link, the link is always in the reply.
  - The reply style reaches the reply writer.
- **Automation:**
  - It is offered after the set number of unchanged approvals.
  - Once switched on, replies go without asking and the owner is told each time.
  - Every 3rd reply is a spot check, and an edit pauses automation.
  - Complaints are never automated.
- **Feedback:** asked once after the job ends, not before.
- **Checkatrade:** Interested, Not for me and spam journeys, plus the email reader's layouts.
- **Chasing quotes:** one follow-up, and none if the customer replied, opted out, or the quote is too old.
- **Keeping businesses apart:** one business can't see another's data, in the database, API or web app, including automations and Checkatrade leads.
- **Making it obvious:** replies waiting come in the right order; "What happened" says why each automatic send went and offers the switch back; **Try it** writes nothing and sends nothing, and flags a complaint; the weekly summary counts correctly and isn't sent for an empty week.
- **One WhatsApp number:** connecting through Embedded Signup (token swapped and stored encrypted, webhooks subscribed, contacts requested, history not); saved contacts stored only as hashes and invisible to other businesses; a friend saved in the phone isn't stored, while a new person and an existing customer are answered; a personal message is set aside; the owner's own reply drops the draft and frees held times; "ignore this person" deletes their text and stops new messages being kept.
- **Records and data rights:** the audit log can't be edited. Erasing a person removes their details and cancels their booking.

## Limits to know before the first customers

- **Google verification.** While the Google app is in *Testing*, only listed test users can connect (up to 100), and their connection expires every 7 days. Submit for verification before real customers. Reading Gmail is a restricted scope and needs an annual independent security assessment.
- **WhatsApp for each business:** connecting a business's own WhatsApp Business app number is built but switched off until Meta approves the platform as a Tech Provider (`docs/whatsapp-setup.md`, Part B). Until then numbers are connected by ID, which suits Meta's test numbers. WhatsApp replies only go out within 24 hours of the customer's last message.
- **Checkatrade** has no reply API and doesn't allow bots in its app, so the owner taps "I'm interested" themselves. The platform makes that take seconds.
- **Booking systems** (Halaxy, Cliniko…) are linked to, not connected: the customer books on the business's own page, and the platform doesn't see those bookings yet.
- **Try it uses real AI calls,** so it needs Claude API credit. It is limited to owners and 30 tries a day per business.
- **Not built yet:** Outlook, Instagram and Facebook DMs, self-serve sign-up, billing, magic-link and Google sign-in, invite emails.

## Next build

### Now: get the first business live
1. Finish Google OAuth consent for Test Business. Add Claude API credit and press **Test** on the Keys page.
2. Switch on Test Business and send a real test enquiry end to end.
3. Test WhatsApp with Meta's test numbers (`docs/whatsapp-setup.md`, Part A), and apply to be a Meta Tech Provider now (Part B), as it takes weeks. Optionally, set up the Mac text relay.
4. Tune the Checkatrade reader on a real lead email.
5. **Onboard The Health Nutritionist** (practitioner pack, likely the Halaxy booking link).

### Next: keeping it easy to use
- The design ideas in `docs/design-ideas.md` are all built (#18). To keep the app that way:
  - write the design rules into `CLAUDE.md` so every change follows them;
  - run an automatic accessibility scan and take phone-width screenshots on every pull request;
  - watch a few owners use it for real tasks, starting with the first live business.
- Order materials for a job. When a job is confirmed, draft the supplier order for delivery the day before.
- A standard skill format (trigger, agents, tools, approval rule), so new use cases are mostly configuration.

### Before more customers
- Google app verification. Start early: it takes weeks.
- Meta Tech Provider status and WhatsApp Embedded Signup.
- Billing (Stripe) and self-serve sign-up.
- Separate development and production Supabase projects. Restrict database network access to the app host.
- Move Google Cloud and Fly to a business account.
- A data processing agreement, a privacy notice, and a DPIA for the practitioner pack.
