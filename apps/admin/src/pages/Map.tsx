import { useState } from "react";
import { Link } from "react-router-dom";
import { get } from "../api";
import { ErrorNote, Loading, useLoad } from "../ui";

// The workforce map (vision v2, 10 Nov 2026) with what is actually running today.
// Plan = the vision's decision for each block. State = what the platform shows right now, from /api/map.

type Plan = "build" | "rent" | "plug" | "new" | "park";
type State = "live" | "built" | "different" | "todo" | "parked" | "offline";
type Counts = any;
interface Data { counts: Counts; keys: { claude: boolean; google: boolean; whatsapp: boolean }; agentMode: string }
interface Chip { name: string; sub?: string; plan: Plan; tag?: string; live: (d: Data) => [State, string] }

const PLAN_LABEL: Record<Plan, string> = { build: "Build", rent: "Rent", plug: "Plug in", new: "New", park: "Parked" };
const STATE_LABEL: Record<State, string> = {
  live: "Running", built: "Built, not in use yet", different: "Built differently", todo: "Not built yet", parked: "Parked", offline: "Outside the app",
};

const n = (o: Record<string, number> | undefined, ...keys: string[]) => keys.reduce((s, k) => s + (o?.[k] ?? 0), 0);
const sum = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
const plural = (x: number, one: string, many = one + "s") => `${x} ${x === 1 ? one : many}`;
const parked = (why = "Not now"): Chip["live"] => () => ["parked", why];
const conn = (kind: string, label: string): Chip["live"] => ({ counts: c }) => {
  const k = n(c.connections, kind);
  return k ? ["live", `${plural(k, label)} connected`] : ["built", "Ready. No business has connected one yet"];
};
const activeBiz = (c: Counts) => n(c.tenants, "active");

const COLUMNS: { title: string; sub: string; layers: { title: string; note?: string; chips: Chip[] }[] }[] = [
  {
    title: "Use cases", sub: "What the assistant does for a business",
    layers: [
      { title: "Who it's for", chips: [
        { name: "Sole traders", sub: "Target, one sector first", plan: "build", live: ({ counts: c }) => activeBiz(c) ? ["live", `${plural(activeBiz(c), "business", "businesses")} switched on`] : ["built", `${plural(n(c.tenants, "onboarding"), "business", "businesses")} being set up`] },
        { name: "Small teams", sub: "Same sector, once sole traders work", plan: "build", live: () => ["built", "Owners and staff roles are built"] },
        { name: "Larger SMBs", plan: "park", live: parked("Already on Zendesk") },
        { name: "Families", plan: "park", live: parked("Stays in NanoClaw") },
      ] },
      { title: "Run the front office", chips: [
        { name: "Answer enquiries", sub: "Triage, draft, owner approves", plan: "build", tag: "The product", live: ({ counts: c }) => {
          const runs = sum(c.runs); const on = n(c.useCases, "answer_enquiries");
          return runs ? ["live", `${plural(runs, "enquiry", "enquiries")} handled this week`] : on ? ["built", `On for ${plural(on, "business", "businesses")}. No enquiries yet`] : ["built", "Built. Not switched on anywhere yet"];
        } },
        { name: "Manage bookings", sub: "Offer real slots, hold, confirm, move", plan: "build", tag: "Next", live: ({ counts: c }) => {
          const h = sum(c.holds); return h ? ["live", `${plural(h, "time")} offered this week, ${n(c.holds, "confirmed")} confirmed`] : ["built", `On for ${plural(n(c.useCases, "book_appointments"), "business", "businesses")}`];
        } },
        { name: "Chase quotes", sub: "One polite follow-up after three quiet days", plan: "new", live: ({ counts: c }) => ["built", `On for ${plural(n(c.useCases, "chase_quotes"), "business", "businesses")}`] },
      ] },
      { title: "Grow the business", chips: [{ name: "Find new customers", plan: "park", live: parked("Different product, different risks (LinkedIn, PECR)") }] },
      { title: "Learn and keep up to date", chips: [
        { name: "Keep up with regulation", sub: "Internal job that keeps the pack current", plan: "build", live: () => ["todo", "Not built yet"] },
        { name: "Learn a topic", plan: "park", live: parked() }, { name: "Teach a child", plan: "park", live: parked() }, { name: "Train staff", plan: "park", live: parked() },
      ] },
      { title: "Run the household", chips: [{ name: "Family admin", plan: "park", live: parked("Lives in NanoClaw") }] },
    ],
  },
  {
    title: "Services", sub: "In the order a message flows through them",
    layers: [
      { title: "Inbound channels", chips: [
        { name: "Email", sub: "Gmail (Outlook later)", plan: "plug", live: conn("gmail", "inbox") },
        { name: "WhatsApp", sub: "The business's own number", plan: "plug", live: ({ counts: c, keys }) => !keys.whatsapp ? ["todo", "Waiting for the platform's WhatsApp keys"] : conn("whatsapp", "number")({ counts: c } as Data) },
        { name: "Web forms", sub: "A link any website form can post to", plan: "plug", live: conn("web_form", "form") },
        { name: "Lead-site alerts", sub: "Checkatrade leads", plan: "new", live: conn("checkatrade_webhook", "Checkatrade link") },
        { name: "Social DMs", plan: "park", live: parked("Meta's agent covers these") },
        { name: "SMS", plan: "park", live: parked() },
        { name: "Phone calls", sub: "Rent a voice service later", plan: "new", live: () => ["todo", "Later"] },
      ] },
      { title: "Inbox", note: "was Chatwoot", chips: [
        { name: "The owner's WhatsApp is the inbox", sub: "Each draft arrives as a message: approve, edit or reject", plan: "new", live: ({ counts: c, keys }) =>
          !keys.whatsapp ? ["built", "Built. Needs WhatsApp keys; the Inbox page here works meanwhile"] : c.approvers ? ["live", `${plural(c.approvers, "approver")} on WhatsApp`] : ["built", "No approvers with a WhatsApp number yet"] },
      ] },
      { title: "Agents", note: "vision: one coordinator", chips: [
        ...(["triage", "drafting", "reviewer", "booking"] as const).map((id): Chip => ({
          name: id[0].toUpperCase() + id.slice(1),
          sub: { triage: "What is it, how urgent", drafting: "Writes the reply", reviewer: "Scores and blocks", booking: "Calendar slots" }[id],
          plan: "build", tag: "Merge later",
          live: ({ counts: c }) => {
            const calls = n(c.agentCalls, id);
            return calls ? ["different", `Separate agent for now. ${plural(calls, "call")} this week`] : ["different", "Separate agent for now. Merge when traces say so"];
          },
        })),
        { name: "Regulation watcher", sub: "Scheduled, not live", plan: "build", live: () => ["todo", "Not built yet"] },
        { name: "Research", plan: "park", live: parked() }, { name: "Tutor", plan: "park", live: parked() },
      ] },
      { title: "Industry packs", note: "your real IP", chips: [
        { name: "Practitioners", sub: "Clinical guardrails, careful wording", plan: "build", tag: "First", live: ({ counts: c }) => n(c.packs, "practitioner") ? ["live", `${plural(n(c.packs, "practitioner"), "business", "businesses")}`] : ["built", "Pack written"] },
        { name: "Trades", sub: "Flooring and general trades", plan: "build", live: ({ counts: c }) => n(c.packs, "trades", "flooring") ? ["live", `${plural(n(c.packs, "trades", "flooring"), "business", "businesses")}`] : ["built", "Packs written"] },
        { name: "Beauty", plan: "park", live: parked() }, { name: "Hospitality", plan: "park", live: parked() }, { name: "HR and recruitment", plan: "park", live: parked() },
      ] },
      { title: "Outbound", chips: [
        { name: "Replies", sub: "Back through the channel the customer used", plan: "new", live: ({ counts: c }) => n(c.drafts, "sent") ? ["live", `${plural(n(c.drafts, "sent"), "reply", "replies")} sent this week`] : ["built", "Nothing sent yet"] },
        { name: "Meeting booking", sub: "Google Calendar", plan: "plug", live: conn("google_calendar", "calendar") },
        { name: "LinkedIn", plan: "park", live: parked() }, { name: "Email outreach", plan: "park", live: parked() },
      ] },
      { title: "Guardrails", chips: [
        { name: "Owner approval", sub: "Every reply approved before it goes", plan: "build", live: ({ counts: c }) => {
          const decided = n(c.drafts, "sent", "approved", "rejected"); return decided ? ["live", `${decided} decided this week, ${c.edited} edited first`] : ["built", "Every reply needs a yes. Auto-send isn't built"];
        } },
        { name: "Audit and security", sub: "Every decision and send logged", plan: "build", live: ({ counts: c }) => ["live", `${plural(c.audit7d, "entry", "entries")} this week`] },
        { name: "Shared memory", sub: "Conversation history", plan: "rent", live: () => ["different", "Kept in our own database"] },
      ] },
    ],
  },
  {
    title: "Infrastructure", sub: "Mostly rented",
    layers: [
      { title: "Tenant layer", chips: [
        { name: "Database with isolation", sub: "Supabase, London, row-level security", plan: "rent", live: () => ["live", "Every query limited to one business"] },
        { name: "Secrets vault", sub: "Bitwarden", plan: "rent", live: ({ keys }) => { const k = Object.values(keys).filter(Boolean).length; return [k === 3 ? "live" : "built", `${k} of 3 services have keys`]; } },
        { name: "Per-business settings", sub: "Tone, services, hours, reply routes", plan: "build", live: () => ["live", "Settings page"] },
      ] },
      { title: "Integration layer", chips: [
        { name: "Connector service", sub: "Composio or Nango", plan: "rent", live: () => ["different", "Google and WhatsApp sign-in built directly"] },
        { name: "Webhook intake", sub: "Every channel becomes one standard message", plan: "build", live: ({ counts: c }) => sum(c.messagesIn) ? ["live", `${plural(sum(c.messagesIn), "message")} in this week`] : ["built", "No messages yet"] },
      ] },
      { title: "Workflow engine", chips: [
        { name: "Durable job queue", sub: "Wait for the yes, retry, remind", plan: "rent", live: () => ["different", "Runs inside the database (graphile-worker), no extra service"] },
      ] },
      { title: "Agent runtime", chips: [
        { name: "Claude API", plan: "rent", live: ({ keys, agentMode }) => agentMode === "mock" ? ["built", "Practice mode"] : keys.claude ? ["live", "Key set. Test it on the Keys page"] : ["todo", "No key yet"] },
        { name: "Agent definitions", sub: "Versioned", plan: "build", live: ({ counts: c }) => ["live", `${plural(sum(c.agentVersions), "version")} published`] },
        { name: "Model routing", sub: "Cheap model for most, stronger for review", plan: "park", tag: "Done early", live: () => ["live", "Haiku for three agents, Sonnet reviews"] },
      ] },
      { title: "Knowledge", chips: [
        { name: "Pack knowledge", sub: "Sector rules, safe wording", plan: "build", live: () => ["live", "In each pack"] },
        { name: "Business knowledge", sub: "Prices, services, FAQs", plan: "build", live: () => ["live", "From each business's settings"] },
        { name: "Vector search", plan: "park", live: parked("FAQs fit in the prompt") },
      ] },
      { title: "Observability and quality", chips: [
        { name: "Tracing every run", sub: "Langfuse", plan: "rent", live: () => ["different", "Each run's steps, tokens and timings shown in Activity"] },
        { name: "Tests", sub: "Replay real enquiries before prompt changes", plan: "build", live: () => ["different", "Automated tests cover the flow; replaying real enquiries not yet"] },
        { name: "Cost per business", plan: "park", tag: "Partly done", live: () => ["live", "Cost per enquiry on the Agents page"] },
      ] },
      { title: "Data protection and GDPR", chips: [
        { name: "Classify and minimise", sub: "Health data tagged; agents never see emails or phone numbers", plan: "build", live: () => ["live", "On every message"] },
        { name: "Retention and deletion", plan: "build", live: ({ counts: c }) => ["live", c.retentionRuns ? `Ran ${plural(c.retentionRuns, "time")}` : "Runs daily, nothing old enough yet"] },
        { name: "People's rights", sub: "Find, export or erase one person", plan: "build", live: ({ counts: c }) => ["live", c.dataRequests ? `${plural(c.dataRequests, "request")} handled` : "Data requests page"] },
        { name: "Opt-outs", plan: "park", tag: "Early", live: ({ counts: c }) => ["built", `Suppression list: ${c.suppressed}`] },
        { name: "AI transparency", sub: "Customers told it's AI-assisted", plan: "build", live: () => ["todo", "Not in replies yet"] },
        { name: "Breach response", plan: "build", live: () => ["todo", "Not built yet"] },
        { name: "Data map, contracts, DPIA", sub: "Documents, not features", plan: "build", live: () => ["offline", "Kept as documents"] },
      ] },
      { title: "Commercial", chips: [
        { name: "Onboarding", sub: "You set each business up", plan: "build", live: () => ["live", "Add a business, connect links, setup checklist"] },
        { name: "Billing", plan: "park", live: parked("Stripe link at 5+ customers") },
      ] },
    ],
  },
];

const SHIFTS: { from: string; to: string; state: (d: Data) => [State, string] }[] = [
  { from: "Nine layers built in-house", to: "Build three things, rent the rest", state: () => ["different", "Mostly rented. Job queue and Google sign-in built directly, both small"] },
  { from: "Seven specialists and an orchestrator", to: "One coordinator agent", state: () => ["different", "Four agents today. Merge when the traces show it's safe"] },
  { from: "Chatwoot for review", to: "The owner's WhatsApp is the inbox", state: ({ keys }) => keys.whatsapp ? ["live", "Approvals go to WhatsApp"] : ["built", "Built. Waiting for WhatsApp keys"] },
  { from: "Six packs", to: "One sector, done properly", state: ({ counts: c }) => ["built", `Practitioners first: ${plural(n(c.packs, "practitioner"), "business", "businesses")}`] },
  { from: "Sell to anyone", to: "2 or 3 real businesses", state: ({ counts: c }) => [activeBiz(c) >= 2 ? "live" : "built", `${activeBiz(c)} of 3 live`] },
];

export function WorkforceMap() {
  const { data, error } = useLoad<Data>(() => get("/map"), []);
  const [showParked, setShowParked] = useState(false);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  const c = data.counts;
  const flow = [
    { cls: "plug", title: "Lead arrives", body: "Gmail, WhatsApp, web form, Checkatrade", stat: sum(c.messagesIn), unit: "messages" },
    { cls: "keep", title: "Agents read it", body: "Triage with the pack and the business's own prices", stat: sum(c.runs), unit: "handled" },
    { cls: "plug", title: "Checks the diary", body: "Free times from Google Calendar, held", stat: sum(c.holds), unit: "times offered" },
    { cls: "keep", title: "Draft to the owner", body: "On WhatsApp, or the Inbox here", stat: sum(c.drafts), unit: "drafts" },
    { cls: "keep", title: "Owner taps yes", body: "Or edits, or rejects", stat: n(c.drafts, "sent", "approved"), unit: `approved${c.edited ? `, ${c.edited} edited` : ""}` },
    { cls: "plug", title: "Sent and booked", body: "Same channel; calendar updated", stat: n(c.drafts, "sent"), unit: `sent, ${n(c.holds, "confirmed")} booked` },
  ];
  const all = COLUMNS.flatMap((col) => col.layers.flatMap((l) => l.chips)).map((ch) => ch.live(data)[0]);
  const tally = (s: State) => all.filter((x) => x === s).length;

  return (
    <section className="map">
      <div className="map-head">
        <div className="eyebrow">Agents as a Service · live map</div>
        <h1>The agent workforce, as it runs today</h1>
        <p className="lead">Your vision map, with what's actually running. The colour is the plan: build it, rent it, plug into someone else's, or park it. The dot is today: running, built and waiting, built a different way, or still to do. Numbers are the last 7 days across every business.</p>
        <div className="legend">
          {(["build", "rent", "plug", "new", "park"] as Plan[]).map((p) => <span key={p}><i className={`sw ${p}`} />{PLAN_LABEL[p]}</span>)}
          <span className="legend-gap" />
          {(["live", "built", "different", "todo"] as State[]).map((s) => <span key={s}><i className={`dot ${s}`} />{STATE_LABEL[s]} ({tally(s)})</span>)}
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
        <p className="muted small">Green steps use other people's systems; purple steps are yours. The purple steps are the product. {!sum(c.messagesIn) && <>Nothing has come through yet: <Link to="/">connect a business</Link> and send a test enquiry to watch it light up.</>}</p>
      </div>

      <div className="mpanel">
        <h2>The five big changes</h2>
        <div className="shifts">
          {SHIFTS.map((s) => { const [st, text] = s.state(data); return (
            <div key={s.to} className="shift">
              <span className="from">{s.from}</span><span className="to">{s.to}</span>
              <span className="now"><i className={`dot ${st}`} />{text}</span>
            </div>
          ); })}
        </div>
      </div>

      <div className="map-tools">
        <label className="check"><input type="checkbox" checked={showParked} onChange={(e) => setShowParked(e.target.checked)} />Show parked items</label>
      </div>

      <div className="mcols">
        {COLUMNS.map((col) => (
          <div key={col.title} className="mcol">
            <div className="mcolhead"><h2>{col.title}</h2><p>{col.sub}</p></div>
            {col.layers.map((l) => {
              const chips = l.chips.filter((ch) => showParked || ch.plan !== "park" || ch.live(data)[0] !== "parked");
              if (!chips.length) return null;
              return (
                <div key={l.title} className="mlayer">
                  <h3>{l.title}{l.note && <small>{l.note}</small>}</h3>
                  <div className="mgrid">
                    {chips.map((ch) => { const [st, text] = ch.live(data); return (
                      <div key={ch.name} className={`mchip ${ch.plan}`}>
                        <span className="tag">{PLAN_LABEL[ch.plan]}{ch.tag ? ` · ${ch.tag}` : ""}</span>
                        <b>{ch.name}</b>
                        {ch.sub && <span>{ch.sub}</span>}
                        <span className="now" title={STATE_LABEL[st]}><i className={`dot ${st}`} />{text}</span>
                      </div>
                    ); })}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="muted small">Open decisions from the vision: when routine replies can go without approval, and whether to try Meta's own agent alongside ours on the same WhatsApp number.</p>
    </section>
  );
}
