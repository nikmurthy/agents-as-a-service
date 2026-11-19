import { Link } from "react-router-dom";
import { get } from "../api";
import { ErrorNote, Loading, useLoad } from "../ui";

// The agent workforce map, block for block, with what's actually running today laid over each block.
// Kind = the block's colour on the map. State = what the platform shows right now, from /api/map.

type Kind = "use" | "ready" | "limited" | "pack" | "core" | "infra" | "later";
type State = "live" | "built" | "different" | "todo" | "parked" | "offline";
type Counts = any;
interface Data { counts: Counts; keys: { claude: boolean; google: boolean; whatsapp: boolean }; agentMode: string }
interface Chip { name: string; sub?: string; kind: Kind; tag?: string; uses?: string; wide?: boolean; live: (d: Data) => [State, string] }
interface Layer { title: string; note?: string; serves?: string; one?: boolean; chips: Chip[] }

const KIND_LABEL: Record<Kind, string> = {
  use: "Use case", ready: "Ready now", limited: "Limited", pack: "Industry pack", core: "Core you build", infra: "Infrastructure", later: "Later",
};
const STATE_LABEL: Record<State, string> = {
  live: "Running", built: "Built, not in use yet", different: "Built differently", todo: "Not built yet", parked: "Later", offline: "Kept as documents",
};

const n = (o: Record<string, number> | undefined, ...keys: string[]) => keys.reduce((s, k) => s + (o?.[k] ?? 0), 0);
const sum = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
const plural = (x: number, one: string, many = one + "s") => `${x} ${x === 1 ? one : many}`;
const biz = (x: number) => plural(x, "business", "businesses");
const later = (why = "Not started"): Chip["live"] => () => ["parked", why];
const todo = (why = "Not built yet"): Chip["live"] => () => ["todo", why];
const doc = (why = "Kept as a document, not a feature"): Chip["live"] => () => ["offline", why];
const conn = (kind: string, label: string): Chip["live"] => ({ counts: c }) => {
  const k = n(c.connections, kind);
  return k ? ["live", `${plural(k, label)} connected`] : ["built", "Ready. No business has connected one yet"];
};
const activeBiz = (c: Counts) => n(c.tenants, "active");
const agent = (id: string): Chip["live"] => ({ counts: c, agentMode }) => {
  const calls = n(c.agentCalls, id);
  if (calls) return ["live", `${plural(calls, "call")} this week`];
  return ["built", agentMode === "mock" ? "Built. In practice mode" : "Built. No enquiries yet"];
};

const COLUMNS: { title: string; sub: string; flow?: boolean; layers: Layer[] }[] = [
  {
    title: "Use cases", sub: "What people want done, and which services each one draws on",
    layers: [
      { title: "Who it's for", chips: [
        { name: "Sole traders", sub: "Target, juggle apps", kind: "later", live: ({ counts: c }) => activeBiz(c) ? ["live", `${biz(activeBiz(c))} switched on`] : ["built", `${biz(n(c.tenants, "onboarding"))} being set up`] },
        { name: "Small teams", sub: "Target, admin juggles", kind: "later", live: () => ["built", "Owner and staff roles are built"] },
        { name: "Larger SMBs", sub: "Use Zendesk already", kind: "later", live: later("Not targeting yet") },
        { name: "Families", sub: "Learning and family admin", kind: "later", live: later("Stays in NanoClaw for now") },
      ] },
      { title: "Run the front office", one: true, chips: [
        { name: "Answer enquiries", tag: "Pilot", kind: "use", sub: "Triage every incoming message: answer, draft a reply or hand to a person",
          uses: "Inbound channels, unified inbox, triage, drafting and reviewer agents, industry pack",
          live: ({ counts: c }) => {
            const runs = sum(c.runs); const on = n(c.useCases, "answer_enquiries");
            return runs ? ["live", `${plural(runs, "enquiry", "enquiries")} handled this week`] : on ? ["built", `On for ${biz(on)}. No enquiries yet`] : ["built", "Built. Not switched on anywhere yet"];
          } },
        { name: "Manage bookings", tag: "Next", kind: "use", sub: "Offer slots, move or cancel appointments, send reminders",
          uses: "Booking agent, booking systems, industry pack",
          live: ({ counts: c }) => {
            const h = sum(c.holds);
            return h ? ["live", `${plural(h, "time")} offered this week, ${n(c.holds, "confirmed")} confirmed`] : ["built", `Offering and holding times is built, on for ${biz(n(c.useCases, "book_appointments"))}. Moving, cancelling and reminders aren't built yet`];
          } },
        { name: "Chase quotes", tag: "Added", kind: "use", sub: "One polite follow-up after three quiet days",
          uses: "Drafting and reviewer agents, outbound replies",
          live: ({ counts: c }) => ["built", `On for ${biz(n(c.useCases, "chase_quotes"))}`] },
      ] },
      { title: "Grow the business", one: true, chips: [
        { name: "Find new customers", tag: "Later", kind: "use", sub: "Map companies, find the right people, research a reason to get in touch, draft a personal note, quality check, send, book a meeting",
          uses: "Research sources, lead generation tools, research, drafting and reviewer agents, outbound channels, CRM", live: later() },
      ] },
      { title: "Learn and keep up to date", one: true, chips: [
        { name: "Keep up with regulation", tag: "Next", kind: "use", sub: "Spot rule changes (ICO, HCPC, PECR, sector bodies), explain what they mean, update the pack rules",
          uses: "Regulation watcher agent, research sources, industry packs", live: todo() },
        { name: "Learn a topic", tag: "Later", kind: "use", sub: "Research, build a curriculum, short lessons, quizzes and spaced review", uses: "Tutor agent, research sources, learner progress", live: later() },
        { name: "Teach a child", tag: "Later", kind: "use", sub: "Age-appropriate activities and stories for a parent to run, tracked by the parent", uses: "Tutor agent, family pack, learner progress", live: later() },
        { name: "Train staff", tag: "Later", kind: "later", sub: "Onboarding courses built from the business's own documents", uses: "Tutor agent, files", live: later() },
      ] },
      { title: "Run the household", one: true, chips: [
        { name: "Family admin", tag: "Later", kind: "use", sub: "Family calendar, school admin, meal plans", uses: "Family pack, files and calendar", live: later("Stays in NanoClaw for now") },
      ] },
    ],
  },
  {
    title: "Services", sub: "The building blocks, in the order a message flows through them", flow: true,
    layers: [
      { title: "Inbound channels", chips: [
        { name: "Email", sub: "Gmail, Outlook", kind: "ready", live: (d) => { const [s, t] = conn("gmail", "Gmail inbox")(d); return [s, `${t}. Outlook not built yet`]; } },
        { name: "WhatsApp", sub: "Own number, coexistence", kind: "ready", live: (d) => !d.keys.whatsapp ? ["built", "Built. Waiting for the platform's WhatsApp keys"] : conn("whatsapp", "number")(d) },
        { name: "Web forms", sub: "Wix, Shopify", kind: "ready", live: conn("web_form", "form") },
        { name: "Social DMs", sub: "Instagram, Facebook", kind: "ready", live: todo() },
        { name: "SMS", sub: "Outbound only; inbound needs a dedicated line", kind: "limited", live: todo() },
        { name: "Lead-site alerts", sub: "Checkatrade", kind: "ready", tag: "Added", live: conn("checkatrade_webhook", "Checkatrade link") },
      ] },
      { title: "Unified inbox", note: "Chatwoot or Respond.io", chips: [
        { name: "One view of every message", sub: "Every channel in one standard format, linked to the right customer", kind: "core", wide: true,
          live: ({ counts: c }) => ["different", `Our own Inbox page, plus approvals on the owner's WhatsApp. No Chatwoot. ${plural(sum(c.messagesIn), "message")} this week`] },
      ] },
      { title: "Agent orchestrator", note: "Picks the right specialist", chips: [
        { name: "Triage", sub: "Topic, urgency, clinical flags", kind: "core", live: agent("triage") },
        { name: "Drafting", sub: "Replies and outreach", kind: "core", live: agent("drafting") },
        { name: "Reviewer", sub: "Scores tone, clarity, authenticity", kind: "core", live: agent("reviewer") },
        { name: "Booking", sub: "Calendar only", kind: "core", live: agent("booking") },
        { name: "Research", sub: "Companies, people, reasons to get in touch", kind: "core", live: later() },
        { name: "Tutor", sub: "Curricula, lessons, quizzes", kind: "core", live: later() },
        { name: "Regulation watcher", sub: "Rule changes and what they mean", kind: "core", live: todo() },
      ] },
      { title: "Industry packs", note: "Tools, knowledge and rules per sector", chips: [
        { name: "Practitioners", sub: "Cliniko, Halaxy · clinical guardrails", kind: "pack", live: ({ counts: c }) => n(c.packs, "practitioner") ? ["live", `Guardrails written, ${biz(n(c.packs, "practitioner"))}. Cliniko and Halaxy not connected`] : ["built", "Guardrails written. Cliniko and Halaxy not connected"] },
        { name: "Trades", sub: "Tradify, Jobber · quotes, job routing", kind: "pack", live: ({ counts: c }) => n(c.packs, "trades", "flooring") ? ["live", `${biz(n(c.packs, "trades", "flooring"))}. Tradify and Jobber not connected`] : ["built", "Trades and flooring packs written. Tradify and Jobber not connected"] },
        { name: "Beauty", sub: "Fresha, Phorest · rebooking, no-shows", kind: "pack", live: later() },
        { name: "Hospitality", sub: "ResDiary · table bookings", kind: "pack", live: later() },
        { name: "HR and recruitment", sub: "Bullhorn, Vincere, Workable", kind: "pack", live: later() },
        { name: "Family automation", sub: "Parent-led, children's data rules", kind: "pack", live: later() },
      ] },
      { title: "Outbound channels", chips: [
        { name: "Replies", sub: "Back through the channel the customer used", kind: "ready", tag: "Added", live: ({ counts: c }) => n(c.drafts, "sent") ? ["live", `${plural(n(c.drafts, "sent"), "reply", "replies")} sent this week`] : ["built", "Nothing sent yet"] },
        { name: "LinkedIn", sub: "Browser agent in a signed-in session", kind: "limited", live: later() },
        { name: "Email outreach", sub: "Gmail, Outlook, Lemlist, Instantly, with opt-out", kind: "ready", live: later() },
        { name: "Meeting booking", sub: "Google Calendar, Outlook, Calendly", kind: "ready", live: (d) => { const [s, t] = conn("google_calendar", "Google calendar")(d); return [s, `${t}. Outlook and Calendly not built`]; } },
      ] },
      { title: "Shared business systems", chips: [
        { name: "Files, calendar", sub: "Google, Microsoft", kind: "later", live: ({ counts: c }) => n(c.connections, "google_calendar") ? ["live", "Google Calendar in use. Files not yet"] : ["built", "Google Calendar built. Files not yet"] },
        ...([["Bookings", "Calendly, Acuity"], ["Payments", "Stripe, SumUp"], ["Accounting", "Xero, QuickBooks"], ["CRM", "HubSpot, Pipedrive"],
          ["Lead generation", "Apollo, Clay, Sales Navigator"], ["Research sources", "Web, Companies House, news"], ["Email marketing", "Mailchimp, Klaviyo"],
          ["Reviews", "Google Business Profile"], ["Team chat", "Slack, Teams"]] as const).map(([name, sub]): Chip => ({ name, sub, kind: "later", live: later() })),
      ] },
      { title: "Guardrails across everything", chips: [
        { name: "Shared memory", sub: "Client context, docs", kind: "core", live: () => ["live", "Conversation history and each business's settings, in our own database"] },
        { name: "Human spot checks", sub: "First batch, then 1 in every X, plus anything flagged", kind: "core", live: ({ counts: c }) => {
          const decided = n(c.drafts, "sent", "approved", "rejected");
          return ["different", decided ? `Stricter for now: the owner approves every reply. ${decided} decided this week, ${c.edited} edited` : "Stricter for now: the owner approves every reply"];
        } },
        { name: "Audit and security", sub: "Logs, permissions, GDPR, PECR", kind: "core", live: ({ counts: c }) => ["live", `${plural(c.audit7d, "log entry", "log entries")} this week`] },
        { name: "Data assurance", sub: "Every client can see what's held and ask for it to be removed", kind: "core", live: ({ counts: c }) => ["live", c.dataRequests ? `${plural(c.dataRequests, "request")} handled` : "Data requests page"] },
      ] },
    ],
  },
  {
    title: "Infrastructure", sub: "What runs underneath, shared by every business", flow: true,
    layers: [
      { title: "Tenant layer", note: "The foundation", serves: "every customer: each business is a separate tenant", chips: [
        { name: "Per-tenant settings", sub: "Channels, pack, tone, escalation contacts", kind: "infra", live: () => ["live", "Settings page for each business"] },
        { name: "Database with isolation", sub: "Supabase, London, row-level security", kind: "infra", live: ({ counts: c }) => ["live", `${biz(sum(c.tenants))}, each walled off`] },
        { name: "Secrets vault", sub: "Sign-in tokens encrypted per tenant. Never passwords", kind: "infra", live: ({ keys }) => {
          const k = Object.values(keys).filter(Boolean).length;
          return [k === 3 ? "live" : "built", `Business tokens encrypted. Platform keys in Bitwarden: ${k} of 3 services`];
        } },
      ] },
      { title: "Integration layer", serves: "inbound and outbound channels and shared business systems", chips: [
        { name: "Connector service", sub: "Nango, Composio or MCP servers", kind: "infra", live: () => ["different", "Google and WhatsApp sign-in built directly, no connector service"] },
        { name: "Webhook intake", sub: "Every inbound message in one standard format", kind: "infra", live: ({ counts: c }) => sum(c.messagesIn) ? ["live", `${plural(sum(c.messagesIn), "message")} in this week`] : ["built", "No messages yet"] },
      ] },
      { title: "Workflow engine", note: "The part people skip", serves: "outbound pacing, spot checks and learning schedules", chips: [
        { name: "Durable job queue", sub: "Retries, pauses for approval and resumes, schedules follow-ups", kind: "infra", wide: true, live: () => ["different", "Runs inside the database (graphile-worker) instead of Inngest. Same job, one less service"] },
      ] },
      { title: "Agent runtime", serves: "the orchestrator and industry packs", chips: [
        { name: "Claude API + Agent SDK", sub: "Orchestrator calls each specialist agent", kind: "infra", live: ({ keys, agentMode }) =>
          agentMode === "mock" ? ["built", "Practice mode: agents don't call Claude"] : keys.claude ? ["different", "Claude API directly, no Agent SDK. Test the key on the Keys page"] : ["todo", "No Claude key yet"] },
        { name: "Agent definitions", sub: "Instructions, tools, model, permissions, versioned", kind: "infra", live: ({ counts: c }) => ["live", `${plural(sum(c.agentVersions), "version")} published`] },
        { name: "Model routing", sub: "Cheaper models classify, stronger ones review", kind: "infra", live: () => ["live", "Haiku for three agents, Sonnet reviews"] },
      ] },
      { title: "Knowledge and memory", serves: "shared memory, industry packs and the learning use cases", chips: [
        { name: "Pack knowledge", sub: "Sector rules, shared by every tenant in that sector", kind: "infra", live: () => ["live", "In each pack"] },
        { name: "Tenant knowledge", sub: "Services, prices, FAQs and past replies", kind: "infra", live: () => ["live", "From each business's settings"] },
        { name: "Vector search", sub: "pgvector, in the same database", kind: "infra", live: later("Not needed yet: FAQs fit in the prompt") },
        { name: "Learner progress", sub: "Curricula, what's covered, what's due", kind: "later", live: later() },
      ] },
      { title: "Human review interface", serves: "the unified inbox and spot checks", chips: [
        { name: "Chatwoot, self-hosted", sub: "One inbox per client; drafts appear as notes to approve", kind: "later", wide: true, live: ({ keys }) => ["different", keys.whatsapp ? "Drafts go to the owner on WhatsApp and to the Inbox page here" : "Inbox page here. WhatsApp approvals once the keys are in"] },
      ] },
      { title: "Observability and quality", serves: "the reviewer agent and audit", chips: [
        { name: "Tracing every run", sub: "Inputs, tool calls, outputs, cost (e.g. Langfuse)", kind: "infra", live: () => ["different", "Our own: each run's steps, tokens and timings in Activity"] },
        { name: "Tests per pack", sub: "Replay real past messages before a change", kind: "later", live: () => ["different", "Automated tests cover the flow. Replaying real messages not yet"] },
        { name: "Cost per tenant", sub: "Needed for pricing", kind: "later", live: () => ["built", "Cost per enquiry on the Agents page. Per business not yet"] },
      ] },
      { title: "Data assurance and GDPR", note: "Built in, not bolted on", serves: "audit and security, data assurance and regulation watch", chips: [
        { name: "Data map", sub: "What's processed per tenant, why, lawful basis", kind: "infra", live: doc() },
        { name: "Classify and minimise", sub: "Health data tagged; personal details masked before a model sees them", kind: "infra", live: () => ["live", "On every message"] },
        { name: "Consent and opt-outs", sub: "Suppression list checked before any send", kind: "infra", live: ({ counts: c }) => ["built", `Suppression list: ${c.suppressed}`] },
        { name: "Retention and deletion", sub: "Automatic deletion per data type and tenant", kind: "infra", live: ({ counts: c }) => ["live", c.retentionRuns ? `Ran ${plural(c.retentionRuns, "time")}` : "Runs daily. Nothing old enough yet"] },
        { name: "People's rights", sub: "Find, export or erase one person's data", kind: "infra", live: ({ counts: c }) => ["live", c.dataRequests ? `${plural(c.dataRequests, "request")} handled` : "Data requests page"] },
        { name: "Suppliers and transfers", sub: "Sub-processors, DPAs, UK or EU hosting", kind: "infra", live: doc("Hosting is in London. The register is a document") },
        { name: "Processor contract", sub: "You process data for each client", kind: "infra", live: doc() },
        { name: "Assessments", sub: "DPIA per pack; health data needs one first", kind: "infra", live: doc() },
        { name: "Breach response", sub: "Detect, log, report to the ICO in 72 hours", kind: "infra", live: todo() },
        { name: "AI transparency", sub: "People are told they're dealing with AI", kind: "infra", live: todo("Not in replies yet") },
        { name: "Certifications", sub: "Cyber Essentials first, ISO 27001 later", kind: "later", live: later() },
      ] },
      { title: "Commercial plumbing", note: "From customer two", chips: [
        { name: "Onboarding", sub: "Clients connect their accounts and pick a pack", kind: "later", live: () => ["live", "Built early: add a business, sign-in links, setup checklist"] },
        { name: "Billing", sub: "Stripe", kind: "later", live: later() },
      ] },
    ],
  },
];

export function WorkforceMap() {
  const { data, error } = useLoad<Data>(() => get("/map"), []);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  const c = data.counts;
  const flow = [
    { cls: "ready", title: "Lead arrives", body: "Gmail, WhatsApp, web form, Checkatrade", stat: sum(c.messagesIn), unit: "messages" },
    { cls: "core", title: "Agents read it", body: "Triage with the pack and the business's own prices", stat: sum(c.runs), unit: "handled" },
    { cls: "ready", title: "Checks the diary", body: "Free times from Google Calendar, held", stat: sum(c.holds), unit: "times offered" },
    { cls: "core", title: "Draft to the owner", body: "On WhatsApp, or the Inbox here", stat: sum(c.drafts), unit: "drafts" },
    { cls: "core", title: "Owner taps yes", body: "Or edits, or rejects", stat: n(c.drafts, "sent", "approved"), unit: `approved${c.edited ? `, ${c.edited} edited` : ""}` },
    { cls: "ready", title: "Sent and booked", body: "Same channel; calendar updated", stat: n(c.drafts, "sent"), unit: `sent, ${n(c.holds, "confirmed")} booked` },
  ];
  const all = COLUMNS.flatMap((col) => col.layers.flatMap((l) => l.chips)).map((ch) => ch.live(data)[0]);
  const tally = (s: State) => all.filter((x) => x === s).length;

  return (
    <section className="map">
      <div className="map-head">
        <div className="eyebrow">Agents as a Service · live map</div>
        <h1>Agent workforce map</h1>
        <p className="lead">Left: what people want done. Middle: the services that do it, in the order a message flows through them. Right: the infrastructure underneath, shared by every business. The colour is the block's role on the map; the line under each block is what's running today, across every business over the last 7 days.</p>
        <div className="legend">
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <span key={k}><i className={`sw ${k}`} />{KIND_LABEL[k]}</span>)}
          <span className="legend-gap" />
          {(["live", "built", "different", "todo", "parked", "offline"] as State[]).map((s) => <span key={s}><i className={`dot ${s}`} />{STATE_LABEL[s]} ({tally(s)})</span>)}
        </div>
      </div>

      <div className="mpanel">
        <h2>How one enquiry flows <small>this week</small></h2>
        <ol className="mflow">
          {flow.map((f) => (
            <li key={f.title} className={`mstep ${f.cls}`}>
              <b>{f.title}</b><span>{f.body}</span>
              <div className="mstat"><strong>{f.stat}</strong> {f.unit}</div>
            </li>
          ))}
        </ol>
        <p className="muted small">Green steps use other people's systems; purple steps are ours, and they're the product. {!sum(c.messagesIn) && <>Nothing has come through yet: <Link to="/">connect a business</Link> and send a test enquiry to watch it light up.</>}</p>
      </div>

      <div className="mcols">
        {COLUMNS.map((col) => (
          <div key={col.title} className="mcol">
            <div className="mcolhead"><h2>{col.title}</h2><p>{col.sub}</p></div>
            {col.layers.map((l, i) => (
              <div key={l.title}>
                {i > 0 && <div className={col.flow ? "marrow" : "mgap"} aria-hidden />}
                <div className="mlayer">
                  <h3>{l.title}{l.note && <small>{l.note}</small>}</h3>
                  {l.serves && <p className="serves">Supports <b>{l.serves}</b></p>}
                  <div className={`mgrid${l.one ? " one" : ""}`}>
                    {l.chips.map((ch) => { const [st, text] = ch.live(data); return (
                      <div key={ch.name} className={`mchip ${ch.kind}${ch.wide ? " wide" : ""}${st === "parked" ? " dim" : ""}`}>
                        {ch.tag && <span className="tag">{ch.tag}</span>}
                        <b>{ch.name}</b>
                        {ch.sub && <span>{ch.sub}</span>}
                        {ch.uses && <span className="uses">Uses: {ch.uses}</span>}
                        <span className="now" title={STATE_LABEL[st]}><i className={`dot ${st}`} />{text}</span>
                      </div>
                    ); })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="mnotes">
        <p><b>The pilot is "Answer enquiries".</b> It needs the blue infrastructure in its simplest form. Chatwoot and billing are skipped for now, and every record carries the business it belongs to from day one.</p>
        <p><b>Where the build differs from the map:</b> our own Inbox page and WhatsApp approvals instead of Chatwoot, a job queue inside the database instead of Inngest, direct Google and WhatsApp sign-in instead of a connector service, and our own run tracing instead of Langfuse. Each is smaller and cheaper for 2 or 3 businesses, and can be swapped later.</p>
        <p><b>Blocks marked "Added"</b> aren't on the original map but are built: chasing quotes, Checkatrade lead alerts and sending replies back through the customer's own channel.</p>
        <p><b>Not yet on the map: phone calls.</b> Most competitors start with voice, so it belongs here eventually.</p>
      </div>
    </section>
  );
}
