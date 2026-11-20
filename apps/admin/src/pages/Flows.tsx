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
  const bk = uc.book_appointments.config ?? {};
  const bookingMode = offersTimes ? "offer" : bk.mode === "link" && bk.link ? "link" : "owner";
  const save = (key: string, body: object) => a.run(async () => { await put(`/businesses/${id}/flows/${key}`, body); reload(); });
  const ro = !canManage || a.busy;

  const enquirySteps: Step[] = [
    { key: "arrive", title: "Message arrives", sub: "Email, WhatsApp, form, Checkatrade, texts", tone: "in" },
    { key: "triage", title: "Triage", sub: "What is it? How urgent?" },
    { key: "booking", title: "Booking", sub: bookingMode === "link" ? `Sends your ${systemName(bk.system)} booking link` : offersTimes && calendar ? "Offers free times" : "You arrange the time", setting: true },
    { key: "reply", title: "Reply", sub: `${PRESETS.find((p) => p.key === data.reply.style.preset)?.label ?? "Your tone of voice"}, then checked`, setting: true },
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

      {flow === "enquiry" && current.key === "booking" && <Booking mode={bookingMode} config={bk} calendar={calendar} save={save} disabled={ro} />}

      {flow === "enquiry" && current.key === "reply" && <Reply reply={data.reply} disabled={ro} onSaved={reload} />}

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

const SYSTEMS: [string, string][] = [["halaxy", "Halaxy"], ["cliniko", "Cliniko"], ["jane", "Jane"], ["fresha", "Fresha"], ["timely", "Timely"],
  ["setmore", "Setmore"], ["calendly", "Calendly"], ["acuity", "Acuity"], ["simplybook", "SimplyBook.me"], ["other", "Another system"]];
const systemName = (k?: string) => (k && k !== "other" ? SYSTEMS.find(([v]) => v === k)?.[1] : undefined) ?? "online";

function Booking({ mode, config, calendar, save, disabled }: { mode: string; config: any; calendar: boolean; save: (k: string, b: object) => void; disabled: boolean }) {
  const [system, setSystem] = useState<string>(config.system ?? "halaxy");
  const [link, setLink] = useState<string>(config.link ?? "");
  const [picked, setPicked] = useState(mode);
  const choose = (v: string) => {
    setPicked(v);
    if (v === "offer") save("book_appointments", { enabled: true });
    if (v === "owner") save("book_appointments", { enabled: false, config: { mode: "owner" } });
    if (v === "link" && config.link) save("book_appointments", { enabled: false, config: { mode: "link" } });
  };
  const saveLink = () => save("book_appointments", { enabled: false, config: { mode: "link", system, link: link.trim() } });
  return (
    <Card title="Booking: when someone wants an appointment">
      <Choice name="booking" disabled={disabled} value={picked} onChange={choose} options={[
        { value: "offer", label: "Offer free times from my calendar", hint: "Up to three times are held in your Google Calendar. The one they pick is booked when you approve the reply." },
        { value: "link", label: "Send them my online booking link", hint: "For Halaxy, Cliniko, Fresha and other booking systems: the customer books themselves, so your diary stays where it is." },
        { value: "owner", label: "Don't offer times: I'll arrange it myself", hint: "The reply says you'll be in touch to arrange a time. Nothing goes in your calendar." },
      ]} />
      {picked === "link" && (
        <fieldset disabled={disabled}>
          <div className="grid two">
            <label className="field"><span className="label">Booking system</span>
              <select value={system} onChange={(e) => setSystem(e.target.value)}>{SYSTEMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="field"><span className="label">Your booking page link</span>
              <input type="url" inputMode="url" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} /></label>
          </div>
          <p className="hint">Open your {system === "other" ? "" : systemName(system) + " "}booking page as a customer would see it, and copy its web address.</p>
          <div className="buttons"><button className="primary" disabled={!link.trim() || (link.trim() === config.link && system === config.system && mode === "link")} onClick={saveLink}>Save and use this link</button></div>
          {mode !== "link" && <p className="note">Not in use until you save a link.</p>}
        </fieldset>
      )}
      {picked === "offer" && !calendar && <p className="note">Google Calendar isn't connected, so for now replies will say you'll arrange the time. <Link to="../connections">Connect it →</Link></p>}
      <Always items={picked === "link"
        ? ["Every reply to someone who wants an appointment includes your booking link, even if the AI leaves it out", "No times are suggested: your booking system shows what's free", "Moving a booking always comes to you"]
        : ["Every time offered is checked against your calendar and working hours first", "Nothing is booked until the customer picks a time and you approve the reply",
          "Times the customer doesn't pick are released", "Moving a booking always comes to you"]} />
    </Card>
  );
}
// Three ready-made tones, each with an example so the owner can hear the difference.
const PRESETS = [
  { key: "friendly", label: "Warm and friendly", tone: "Warm, friendly and personal, like a helpful local business. Conversational, short sentences, no jargon.",
    trade: "Hi Sam, thanks for getting in touch! Happy to help with your kitchen floor. Could you send a couple of photos and rough room sizes? Then I can give you a price guide and pop round to measure up.",
    practice: "Hi Sam, thanks so much for reaching out! I'd love to help. Could you tell me a little about what you're hoping to work on? Then I can suggest the best place to start." },
  { key: "professional", label: "Professional and polished", tone: "Polite, professional and reassuring. Clear and well structured. Courteous, never casual.",
    trade: "Hello Sam, thank you for your enquiry about your kitchen floor. So that we can give you an accurate quote, could you send a few photos and the approximate room dimensions? We can then arrange a free measure-up at a time that suits you.",
    practice: "Hello Sam, thank you for your enquiry. To make sure an initial consultation is right for you, could you share a brief outline of what you would like support with? I will then explain the next steps." },
  { key: "brief", label: "Short and to the point", tone: "Brief and direct. As few words as possible while still being friendly. No small talk.",
    trade: "Hi Sam, thanks. Can you send photos and room sizes? I'll then give you a price and a time to measure up.",
    practice: "Hi Sam, thanks for getting in touch. What would you like help with? I'll then suggest next steps." },
] as const;

function Reply({ reply, disabled, onSaved }: { reply: any; disabled: boolean; onSaved: () => void }) {
  const { id } = useBiz();
  const st = reply.style ?? {};
  const [preset, setPreset] = useState<string>(st.preset ?? (PRESETS.find((p) => p.tone === reply.tone)?.key ?? "custom"));
  const [tone, setTone] = useState<string>(reply.tone);
  const [greeting, setGreeting] = useState<string>(st.greeting ?? "");
  const [length, setLength] = useState<string>(st.length ?? "");
  const [emoji, setEmoji] = useState<string>(st.emoji ?? "");
  const [spelling, setSpelling] = useState<string>(st.spelling ?? "british");
  const [avoid, setAvoid] = useState<string>(st.avoid ?? "");
  const [examples, setExamples] = useState<string[]>(() => { const e = [...(st.examples ?? [])]; while (e.length < 3) e.push(""); return e; });
  const a = useAction();
  const sample = reply.pack === "practitioner" ? "practice" : "trade";
  const sign = reply.signOff && !reply.signOff.includes("[") ? reply.signOff : "Your name";
  const pick = (k: string) => { setPreset(k); const p = PRESETS.find((x) => x.key === k); if (p) setTone(p.tone); };
  const save = () => a.run(async () => {
    const style: any = { preset, spelling, avoid: avoid.trim() || undefined, examples: examples.map((e) => e.trim()).filter(Boolean) };
    if (greeting) style.greeting = greeting; if (length) style.length = length; if (emoji) style.emoji = emoji;
    const r = await put(`/businesses/${id}/reply-style`, { tone: tone.trim(), style });
    setExamples(() => { const e = [...(r.style.examples ?? [])]; while (e.length < 3) e.push(""); return e; });
    onSaved();
  }, "Saved. New replies will be written this way.");
  return (
    <Card title="Reply: how it sounds">
      <p className="muted small">Each reply is written in your voice, using your services, prices and sign-off from <Link to="../settings">Settings</Link>, then a second, stronger model checks it for accuracy, tone and safety.</p>
      <fieldset disabled={disabled || a.busy}>
        <h3>1. Pick a tone</h3>
        <div className="choices">
          {PRESETS.map((p) => (
            <label key={p.key} className={`choice ${preset === p.key ? "on" : ""}`}>
              <input type="radio" name="tone" checked={preset === p.key} onChange={() => pick(p.key)} />
              <span><strong>{p.label}</strong><span className="example">"{p[sample]} {sign}"</span></span>
            </label>
          ))}
          <label className={`choice ${preset === "custom" ? "on" : ""}`}>
            <input type="radio" name="tone" checked={preset === "custom"} onChange={() => setPreset("custom")} />
            <span><strong>Describe it in my own words</strong><span className="hint">For example "Chatty and upbeat, like talking to a neighbour".</span></span>
          </label>
        </div>
        {preset === "custom" && <label className="field"><span className="label">Your tone of voice</span><textarea rows={3} value={tone} onChange={(e) => setTone(e.target.value)} /></label>}

        <h3>2. The details</h3>
        <div className="grid two">
          <label className="field"><span className="label">Greeting</span>
            <select value={greeting} onChange={(e) => setGreeting(e.target.value)}>
              <option value="">Whatever fits</option><option value="hi">Hi Sam,</option><option value="hello">Hello Sam,</option><option value="dear">Dear Sam,</option>
            </select></label>
          <label className="field"><span className="label">Length</span>
            <select value={length} onChange={(e) => setLength(e.target.value)}>
              <option value="">Whatever fits</option><option value="short">Short: a few sentences</option><option value="medium">Medium: a paragraph or two</option><option value="detailed">Detailed: answer everything</option>
            </select></label>
          <label className="field"><span className="label">Emoji</span>
            <select value={emoji} onChange={(e) => setEmoji(e.target.value)}>
              <option value="">Whatever fits</option><option value="never">Never</option><option value="sometimes">Now and then on WhatsApp and texts</option>
            </select></label>
          <label className="field"><span className="label">Spelling</span>
            <select value={spelling} onChange={(e) => setSpelling(e.target.value)}>
              <option value="british">British (colour, organise)</option><option value="american">American (color, organize)</option>
            </select></label>
        </div>
        <label className="field"><span className="label">Words or phrases never to use</span>
          <span className="hint">Optional. For example "cheap, no worries, ASAP".</span>
          <input value={avoid} onChange={(e) => setAvoid(e.target.value)} maxLength={500} /></label>

        <h3>3. Write like me (optional)</h3>
        <p className="hint">Paste up to three replies you've sent that sound like you. The assistant copies your style, not the content. Email addresses and phone numbers are removed when you save; take out customers' names too.</p>
        {examples.slice(0, Math.min(3, examples.filter((x) => x.trim()).length + 1)).map((e, i) => (
          <label key={i} className="field"><span className="label">Example {i + 1}</span>
            <textarea rows={4} maxLength={1500} value={e} placeholder={i === 0 ? "Paste a reply you've written…" : ""}
              onChange={(ev) => setExamples(examples.map((x, j) => (j === i ? ev.target.value : x)))} /></label>
        ))}
        <div className="buttons"><button className="primary" disabled={!tone.trim()} onClick={save}>Save how replies sound</button></div>
      </fieldset>
      <ErrorNote message={a.error} />
      {a.done && <p className="note good">{a.done}</p>}
      <Always items={["Never makes up prices or services you haven't listed", "Drafts that score low are flagged for you to look at closely", "Never sends anything by itself: that's the next step"]} />
    </Card>
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
