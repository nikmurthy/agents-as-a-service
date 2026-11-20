import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { get, put } from "../api";
import { useBiz } from "../ctx";
import { Card, ErrorNote, Loading, Page, useAction, useLoad } from "../ui";

// Each flow is a row of steps. Tap a step to see what it does and, where there's a choice, to change it.
// The choices are settings the code enforces (not instructions to the AI), so they are always followed.

type Step = { key: string; title: string; sub: string; tone?: "in" | "you" | "out"; setting?: boolean };

const CONNECTED: Record<string, string> = {
  gmail: "Gmail", whatsapp: "WhatsApp", web_form: "Website form", checkatrade_webhook: "Checkatrade (webhook)", sms_relay: "Texts from a Mac", google_calendar: "Google Calendar",
};
const DAYS = [[0, "The same day"], [1, "The next day"], [2, "2 days later"], [3, "3 days later"], [7, "A week later"]] as const;

export function Flows() {
  const { id, canManage } = useBiz();
  const { data, error, reload } = useLoad(() => get(`/businesses/${id}/flows`), [id]);
  const [params, setParams] = useSearchParams();
  const flow = params.get("flow") === "quotes" ? "quotes" : "enquiry";
  const step = params.get("step") ?? (flow === "quotes" ? "wait" : "approve");
  const go = (f: string, s: string, scroll = false) => {
    setParams({ flow: f, step: s }, { replace: true });
    // On a phone the details are below the steps: bring them into view.
    if (scroll && window.innerWidth < 720) setTimeout(() => document.getElementById("step-details")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  const a = useAction();
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;

  const uc = data.useCases;
  const calendar = data.connected.includes("google_calendar");
  const offersTimes = uc.book_appointments.enabled;
  const save = (key: string, body: object) => a.run(async () => { await put(`/businesses/${id}/flows/${key}`, body); reload(); });
  const ro = !canManage || a.busy;

  const enquirySteps: Step[] = [
    { key: "arrive", title: "Message arrives", sub: "Email, WhatsApp, form, Checkatrade, texts", tone: "in" },
    { key: "triage", title: "Triage", sub: "What is it? How urgent?" },
    { key: "booking", title: "Booking", sub: offersTimes && calendar ? "Offers free times" : "You arrange the time", setting: true },
    { key: "reply", title: "Reply", sub: "Written in your voice, then checked" },
    { key: "approve", title: "You approve", sub: data.learnAfter === 0 ? "Always asks you" : `Learns: offers to automate after ${data.learnAfter}`, tone: "you", setting: true },
    { key: "sent", title: "Sent", sub: "By email or WhatsApp, or you send it", tone: "out" },
    { key: "feedback", title: "Feedback", sub: uc.ask_feedback.enabled ? `Asks how it went, ${dayWord(uc.ask_feedback.config.afterDays ?? data.defaults.feedbackAfterDays)}` : "Off", setting: true },
  ];
  const quoteSteps: Step[] = [
    { key: "marked", title: "Quote sent", sub: "You mark it in the Inbox", tone: "in" },
    { key: "wait", title: "Wait", sub: uc.chase_quotes.enabled ? `${uc.chase_quotes.config.afterDays ?? data.defaults.chaseAfterDays} quiet days` : "Off", setting: true },
    { key: "nudge", title: "Follow-up", sub: "One polite nudge" },
    { key: "approve", title: "You approve", sub: kindState(data, "quote_followup"), tone: "you", setting: true },
    { key: "sent", title: "Sent", sub: "Once only", tone: "out" },
  ];
  const steps = flow === "quotes" ? quoteSteps : enquirySteps;
  const current = steps.find((s) => s.key === step) ?? steps[0];

  return (
    <Page title="Flows">
      <p className="lead">How the assistant handles work for you, step by step. Tap a step to see what it does. Steps marked ⚙ have choices.</p>
      <div className="seg" role="tablist" aria-label="Flows" style={{ marginBottom: "1rem" }}>
        <button role="tab" aria-selected={flow === "enquiry"} onClick={() => go("enquiry", "approve")}>Enquiry flow</button>
        <button role="tab" aria-selected={flow === "quotes"} onClick={() => go("quotes", "wait")}>Chasing quotes</button>
      </div>
      <ol className={`flow flow-${steps.length}`}>
        {steps.map((s) => (
          <li key={s.key}>
            <button className={`flow-step ${s.tone ?? ""} ${s.key === current.key ? "selected" : ""}`} aria-pressed={s.key === current.key} onClick={() => go(flow, s.key, true)}>
              <strong>{s.title}{s.setting ? " ⚙" : ""}</strong><span>{s.sub}</span>
            </button>
          </li>
        ))}
      </ol>
      <div id="step-details" />
      <ErrorNote message={a.error} />
      {!canManage && <p className="note">Only owners can change these.</p>}

      {flow === "enquiry" && current.key === "arrive" && (
        <Card title="Message arrives">
          <p>Every new message becomes an enquiry in your Inbox, wherever it came from.</p>
          <h3>Connected now</h3>
          {data.connected.filter((k: string) => k !== "google_calendar").length
            ? <ul>{data.connected.filter((k: string) => k !== "google_calendar").map((k: string) => <li key={k}>{CONNECTED[k] ?? k}</li>)}</ul>
            : <p className="muted">Nothing yet.</p>}
          <Link to="../connections">Connections →</Link>
        </Card>
      )}

      {flow === "enquiry" && current.key === "triage" && (
        <Card title="Triage">
          <p>Reads the message and works out what the person wants, how urgent it is, and what should happen next.</p>
          <Always items={["Spam is ignored", "Emergencies, complaints and health questions go straight to you, and are never sent automatically",
            "New Checkatrade leads get a suggestion: I'm interested, or Not for me", "It never sees customers' email addresses or phone numbers"]} />
        </Card>
      )}

      {flow === "enquiry" && current.key === "booking" && (
        <Card title="Booking: when someone wants an appointment">
          <Choice name="booking" disabled={ro} value={offersTimes ? "offer" : "owner"} onChange={(v) => save("book_appointments", { enabled: v === "offer" })} options={[
            { value: "offer", label: "Offer free times from my calendar", hint: "Up to three times are held in your calendar. The one they pick is booked when you approve the reply." },
            { value: "owner", label: "Don't offer times: I'll arrange it myself", hint: "The reply says you'll be in touch to arrange a time. Nothing goes in your calendar." },
          ]} />
          {offersTimes && !calendar && <p className="note">Google Calendar isn't connected, so for now replies will say you'll arrange the time. <Link to="../connections">Connect it →</Link></p>}
          <Always items={["Every time offered is checked against your calendar and working hours first", "Nothing is booked until the customer picks a time and you approve the reply",
            "Times the customer doesn't pick are released", "Moving a booking always comes to you"]} />
        </Card>
      )}

      {flow === "enquiry" && current.key === "reply" && (
        <Card title="Reply">
          <p>Written in your tone of voice, using your services, prices and sign-off. A second, stronger model then checks it for accuracy, tone and safety.</p>
          <Always items={["Never makes up prices or services you haven't listed", "Drafts that score low are flagged for you to look at closely", "Never sends anything by itself: that's the next step"]} />
          <Link to="../settings">Your tone, services and prices are in Settings →</Link>
        </Card>
      )}

      {current.key === "approve" && <Approve data={data} canManage={canManage} save={save} busy={a.busy} reload={reload} only={flow === "quotes" ? "quote_followup" : undefined} />}

      {flow === "enquiry" && current.key === "sent" && (
        <Card title="Sent">
          <p>Once approved, email and WhatsApp replies are sent for you. For Checkatrade, texts and phone calls you get the final wording on WhatsApp to send yourself.</p>
          <p className="muted small">WhatsApp only allows a reply within 24 hours of the customer's last message, so after that the reply goes by email if we have their address.</p>
          <Link to="../settings">Which way to reply first is in Settings →</Link>
        </Card>
      )}

      {flow === "enquiry" && current.key === "feedback" && <Feedback data={data} save={save} disabled={ro} />}

      {flow === "quotes" && current.key === "marked" && (
        <Card title="Quote sent">
          <p>When you've sent someone a quote, open their conversation in the Inbox and press <strong>Mark quote as sent</strong>.</p>
          <Link to="../inbox">Inbox →</Link>
        </Card>
      )}
      {flow === "quotes" && current.key === "wait" && (
        <Card title="Chasing quotes">
          <Toggle label="Chase quotes that go quiet" checked={uc.chase_quotes.enabled} disabled={ro} onChange={(on) => save("chase_quotes", { enabled: on })} />
          <label className="field"><span className="label">Wait this long before following up</span>
            <select value={uc.chase_quotes.config.afterDays ?? data.defaults.chaseAfterDays} disabled={ro || !uc.chase_quotes.enabled}
              onChange={(e) => save("chase_quotes", { config: { afterDays: Number(e.target.value) } })}>
              {[2, 3, 5, 7, 14].map((d) => <option key={d} value={d}>{d} days with no reply</option>)}
            </select></label>
          <Always items={["Only once per quote", "Not if the customer has replied since", "Not if they've asked not to be contacted"]} />
        </Card>
      )}
      {flow === "quotes" && current.key === "nudge" && (
        <Card title="Follow-up">
          <p>A short, friendly message asking if they've had a chance to look at the quote and offering to answer questions. Signed with your sign-off.</p>
        </Card>
      )}
      {flow === "quotes" && current.key === "sent" && (
        <Card title="Sent"><p>Sent the same way as a reply: email or WhatsApp automatically, otherwise you get the wording to send.</p></Card>
      )}
    </Page>
  );
}

function Approve({ data, canManage, save, busy, reload, only }: { data: any; canManage: boolean; save: (k: string, b: object) => void; busy: boolean; reload: () => void; only?: string }) {
  const { id } = useBiz();
  const a = useAction();
  const [msg, setMsg] = useState<string>();
  const learning = data.learnAfter > 0;
  const n = data.learnAfter || data.defaults.learnAfter;
  const kinds = data.kinds.filter((k: any) => !only || k.key === only);
  const setAuto = (key: string, on: boolean) => a.run(async () => { const r = await put(`/businesses/${id}/automations/${key}`, { on }); setMsg(r.message); reload(); });
  const ro = !canManage || busy || a.busy;
  return (
    <Card title="You approve">
      <Choice name="learn" disabled={ro} value={learning ? "learn" : "always"} onChange={(v) => save("answer_enquiries", { config: { learnAfter: v === "learn" ? data.defaults.learnAfter : 0 } })} options={[
        { value: "always", label: "Always ask me before anything is sent" },
        { value: "learn", label: "Learn, then offer to automate", hint: "After you approve replies of the same kind without changing them, you're asked if that kind can send automatically. Nothing changes until you say yes." },
      ]} />
      {learning && (
        <label className="field"><span className="label">Offer after</span>
          <select value={n} disabled={ro} onChange={(e) => save("answer_enquiries", { config: { learnAfter: Number(e.target.value) } })}>
            {[3, 5, 10, 20].map((x) => <option key={x} value={x}>{x} unchanged approvals in a row</option>)}
          </select></label>
      )}
      <h3>Kinds of reply</h3>
      <div className="list">
        {kinds.map((k: any) => (
          <div key={k.key} className="row">
            <div style={{ flex: "1 1 14rem" }}>
              <strong>{k.label}</strong>
              <div className="muted small">{k.example}</div>
              <div className="small">{k.state === "on" ? <span className="pill good">Automatic</span>
                : k.state === "offered" ? <span className="pill warn">Offered: waiting for your answer</span>
                : learning ? <span className="muted">{Math.min(k.streak, n)} of {n} approved unchanged in a row{k.state === "declined" ? " · you said keep asking" : ""}</span>
                : <span className="muted">Always asks you</span>}
                {k.sentAutomatically > 0 && <span className="muted"> · {k.sentAutomatically} sent automatically so far</span>}</div>
            </div>
            <label className="row-meta switch"><span className="small">{k.state === "on" ? "Automatic" : "Ask me"}</span>
              <input type="checkbox" role="switch" aria-label={`Send ${k.label.toLowerCase()} automatically`} checked={k.state === "on"} disabled={ro || !learning}
                onChange={(e) => setAuto(k.key, e.target.checked)} /></label>
          </div>
        ))}
      </div>
      <ErrorNote message={a.error} />
      {msg && <p className="note good">{msg}</p>}
      <Always items={[
        `Spot checks: even when automatic, ${data.spotCheckEvery <= 1 ? "every one" : `every ${ordinal(data.spotCheckEvery)} one`} still comes to you (change this in Settings). If you change or reject one, that kind goes back to asking you.`,
        "You're told on WhatsApp every time something is sent automatically",
        "Never automatic: complaints, emergencies, health questions, flagged drafts, new Checkatrade leads, moving a booking, and anything sent by text, phone or Checkatrade",
      ]} />
    </Card>
  );
}

function Feedback({ data, save, disabled }: { data: any; save: (k: string, b: object) => void; disabled: boolean }) {
  const fb = data.useCases.ask_feedback;
  const [link, setLink] = useState<string>(fb.config.reviewLink ?? "");
  return (
    <Card title="Feedback: once the job is done">
      <Toggle label="Ask customers how it went" checked={fb.enabled} disabled={disabled} onChange={(on) => save("ask_feedback", { enabled: on })} />
      <p className="muted small">A job is done when its booked appointment has ended, or when you press <strong>Job done</strong> on the conversation in the Inbox. Each customer is asked once.</p>
      <fieldset disabled={disabled || !fb.enabled}>
        <label className="field"><span className="label">When to ask</span>
          <select value={fb.config.afterDays ?? data.defaults.feedbackAfterDays} onChange={(e) => save("ask_feedback", { config: { afterDays: Number(e.target.value) } })}>
            {DAYS.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
          </select></label>
        <label className="field"><span className="label">Review link (optional)</span>
          <span className="hint">Your Google, Checkatrade or Trustpilot review page. Without one, customers are asked to reply with their thoughts.</span>
          <div className="row-meta" style={{ flexWrap: "nowrap" }}>
            <input type="url" inputMode="url" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} />
            <button onClick={() => save("ask_feedback", { config: { reviewLink: link.trim() } })} disabled={link.trim() === (fb.config.reviewLink ?? "")}>Save</button>
          </div></label>
      </fieldset>
      <h3>What they'll get (you approve it first)</h3>
      <p className="draft-body">{data.feedbackPreview}</p>
      <Always items={["Everyone is asked the same way: we never pick only happy customers to ask for a review", "Not sent to anyone who has asked not to be contacted", "Comes to you to approve, unless you've made feedback requests automatic"]} />
    </Card>
  );
}

function Choice({ name, value, options, onChange, disabled }: { name: string; value: string; options: { value: string; label: string; hint?: string }[]; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <fieldset className="choices" disabled={disabled}>
      {options.map((o) => (
        <label key={o.value} className={`choice ${value === o.value ? "on" : ""}`}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span><strong>{o.label}</strong>{o.hint && <span className="hint">{o.hint}</span>}</span>
        </label>
      ))}
    </fieldset>
  );
}

const Toggle = ({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean }) => (
  <label className="row switch toggle"><strong>{label}</strong>
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /></label>
);

const Always = ({ items }: { items: ReactNode[] }) => (
  <><h3>Always</h3><ul className="always">{items.map((x, i) => <li key={i}>{x}</li>)}</ul></>
);

function kindState(data: any, key: string) {
  const k = data.kinds.find((x: any) => x.key === key);
  return k?.state === "on" ? "Automatic, with spot checks" : data.learnAfter === 0 ? "Always asks you" : "Asks you, learning";
}
const dayWord = (d: number) => (d === 0 ? "the same day" : d === 1 ? "the next day" : `${d} days later`);
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
