import { useState, type FormEvent } from "react";
import { get, post, put } from "../api";
import { useBiz } from "../ctx";
import { Card, Empty, ErrorNote, Field, Loading, Page, Status, useAction, useLoad, when } from "../ui";

const KIND: Record<string, string> = { gmail: "Gmail", google_calendar: "Google Calendar", whatsapp: "WhatsApp number", web_form: "Website form link", checkatrade_webhook: "Checkatrade leads link", sms_relay: "Text messages from a Mac" };

export function Connections() {
  const { id, canManage } = useBiz();
  const { data, error, reload } = useLoad(() => get(`/businesses/${id}/connections`), [id]);
  const act = useAction();
  const [google, setGoogle] = useState<string>();
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  const live = data.connections.filter((c: any) => c.status !== "disconnected");
  return (
    <Page title="Connections">
      <ErrorNote message={act.error} />
      {!live.length && <Empty>Nothing is connected yet.</Empty>}
      <div className="list">
        {live.map((c: any) => (
          <div key={c.id} className="row stack">
            <div className="row-top">
              <div><strong>{c.kind === "whatsapp" && c.coexistence ? "WhatsApp Business number (shared with your app)" : KIND[c.kind] ?? c.kind}</strong><div className="muted">{c.kind === "whatsapp" && c.label ? c.label : c.connectedAs ?? c.label}</div></div>
              <div className="row-meta">
                <Status value={c.status} />
                {canManage && <button disabled={act.busy} onClick={() => confirm("Disconnect this? Messages from it will stop arriving.") && act.run(async () => { await post(`/businesses/${id}/connections/${c.id}/disable`); reload(); })}>Disconnect</button>}
              </div>
            </div>
            {c.last_error && <p className="note error">{c.last_error}</p>}
            {c.url && <p><code className="wrap">{c.url}</code> <button type="button" onClick={() => navigator.clipboard.writeText(c.url)}>Copy</button></p>}
          </div>
        ))}
      </div>
      {canManage && (<>
        <Card title="Gmail and Google Calendar">
          <p className="muted">Make a one-time link for the owner to sign in to Google. We never see their password.</p>
          <button disabled={act.busy} onClick={() => act.run(async () => setGoogle((await get(`/businesses/${id}/connections/google-link`)).url))}>Make a connect link</button>
          {google && <p><code className="wrap">{google}</code> <button type="button" onClick={() => navigator.clipboard.writeText(google)}>Copy</button></p>}
        </Card>
        <WhatsAppBusiness id={id} ready={data.whatsappSignupReady} />
        {live.some((c: any) => c.kind === "whatsapp" && c.coexistence) && <WhoToAnswer id={id} value={data.whatsappPeople} onDone={reload} />}
        <WhatsApp id={id} onDone={reload} />
        <Card title="Add a link for a website form, Checkatrade or texts">
          <div className="buttons">
            <button disabled={act.busy} onClick={() => act.run(async () => { await post(`/businesses/${id}/connections/webhook`, { kind: "web_form" }); reload(); })}>Website form</button>
            <button disabled={act.busy} onClick={() => act.run(async () => { await post(`/businesses/${id}/connections/webhook`, { kind: "checkatrade_webhook" }); reload(); })}>Checkatrade</button>
            <button disabled={act.busy} onClick={() => act.run(async () => { await post(`/businesses/${id}/connections/webhook`, { kind: "sms_relay" }); reload(); })}>Text messages from a Mac</button>
          </div>
          <p className="muted small">Texts from a Mac: the business's iPhone forwards texts to their Mac, and a small relay there sends new ones here. Give them the link and the steps in <code>tools/mac-sms-relay/README.md</code>.</p>
        </Card>
      </>)}
      {data.connections.some((c: any) => c.status === "disconnected") && <p className="muted small">Disconnected items are hidden. Last change {when(data.connections.at(-1)?.created_at)}.</p>}
    </Page>
  );
}

/** The sole trader's one number: the one they already use in the WhatsApp Business app (Meta Embedded Signup). */
function WhatsAppBusiness({ id, ready }: { id: string; ready: boolean }) {
  const [link, setLink] = useState<string>();
  const { busy, error, run } = useAction();
  return (
    <Card title="Your WhatsApp Business number">
      <p>Use the number customers already message. You keep using the WhatsApp Business app exactly as now: you'll see every chat, and replies you approve are sent from your number.</p>
      <ul className="muted small">
        <li>People saved in your phone are left alone, unless they're already customers.</li>
        <li>If you answer a customer yourself in the app, the reply waiting here is dropped, so nobody gets two.</li>
        <li>Approval requests come from our number as a separate chat, or you approve in this app.</li>
      </ul>
      {ready ? (<>
        <p className="muted">Make a one-time link for the owner. They sign in to Facebook in Meta's own window; we never see their password.</p>
        <button disabled={busy} onClick={() => run(async () => setLink((await get(`/businesses/${id}/connections/whatsapp-link`)).url))}>Make a connect link</button>
        {link && <p><code className="wrap">{link}</code> <button type="button" onClick={() => navigator.clipboard.writeText(link)}>Copy</button></p>}
      </>) : <p className="note">Waiting for Meta to approve the platform. Until then, test with a Meta test number below.</p>}
      <ErrorNote message={error} />
    </Card>
  );
}

function WhoToAnswer({ id, value, onDone }: { id: string; value: string; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const set = (people: string) => run(async () => { await put(`/businesses/${id}/whatsapp-people`, { people }); onDone(); });
  return (
    <Card title="Who gets an answer on WhatsApp">
      <fieldset disabled={busy}>
        <legend className="sr-only">Who gets an answer on WhatsApp</legend>
        <label className="choice"><input type="radio" name="people" checked={value !== "everyone"} onChange={() => set("new_and_customers")} />
          <span><strong>New people and customers</strong><br /><span className="muted small">People saved in your phone are left alone, unless they're already customers. Best if this is also your personal number.</span></span></label>
        <label className="choice"><input type="radio" name="people" checked={value === "everyone"} onChange={() => set("everyone")} />
          <span><strong>Everyone</strong><br /><span className="muted small">For a number used only for work.</span></span></label>
      </fieldset>
      <p className="muted small">Personal chats that slip through are set aside by the "Read and sort" step, and you can tap "Not a customer? Ignore" on any reply.</p>
      <ErrorNote message={error} />
    </Card>
  );
}

function WhatsApp({ id, onDone }: { id: string; onDone: () => void }) {
  const [phoneNumberId, setP] = useState("");
  const [accessToken, setT] = useState("");
  const [wabaId, setW] = useState("");
  const { busy, error, run } = useAction();
  const [connected, setConnected] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setConnected(undefined);
    run(async () => {
      const r = await post<{ display?: string }>(`/businesses/${id}/connections/whatsapp`, { phoneNumberId, wabaId, accessToken });
      setP(""); setW(""); setT(""); setConnected(r?.display ?? "the number"); onDone();
    });
  };
  return (
    <Card title="Connect a number by its ID (Meta test numbers)">
      <form onSubmit={submit}>
        <Field label="Phone number ID" hint="In Meta: WhatsApp → API Setup, under the number. A long number, not the phone number itself."><input required inputMode="numeric" value={phoneNumberId} onChange={(e) => setP(e.target.value)} /></Field>
        <Field label="WhatsApp Business Account ID" hint="Same page, the other long number. Used to ask Meta to send this number's messages here."><input required inputMode="numeric" value={wabaId} onChange={(e) => setW(e.target.value)} /></Field>
        <Field label="Access token" hint="Stored encrypted. It can't be viewed again once saved; paste a new one to replace it."><input required type="password" autoComplete="off" value={accessToken} onChange={(e) => setT(e.target.value)} /></Field>
        <ErrorNote message={error} />
        {connected && <p className="note good" role="status">Connected {connected}. Messages to it now come here.</p>}
        <button className="primary" disabled={busy}>Save</button>
      </form>
    </Card>
  );
}
