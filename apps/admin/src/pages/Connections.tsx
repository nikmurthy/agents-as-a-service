import { useState, type FormEvent } from "react";
import { get, post } from "../api";
import { useBiz } from "../ctx";
import { Card, Empty, ErrorNote, Field, Loading, Page, Status, useAction, useLoad, when } from "../ui";

const KIND: Record<string, string> = { gmail: "Gmail", google_calendar: "Google Calendar", whatsapp: "WhatsApp number", web_form: "Website form link", checkatrade_webhook: "Checkatrade leads link" };

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
              <div><strong>{KIND[c.kind] ?? c.kind}</strong><div className="muted">{c.connectedAs ?? c.label}</div></div>
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
        <WhatsApp id={id} onDone={reload} />
        <Card title="Add a link for a website form or Checkatrade">
          <div className="buttons">
            <button disabled={act.busy} onClick={() => act.run(async () => { await post(`/businesses/${id}/connections/webhook`, { kind: "web_form" }); reload(); })}>Website form</button>
            <button disabled={act.busy} onClick={() => act.run(async () => { await post(`/businesses/${id}/connections/webhook`, { kind: "checkatrade_webhook" }); reload(); })}>Checkatrade</button>
          </div>
        </Card>
      </>)}
      {data.connections.some((c: any) => c.status === "disconnected") && <p className="muted small">Disconnected items are hidden. Last change {when(data.connections.at(-1)?.created_at)}.</p>}
    </Page>
  );
}

function WhatsApp({ id, onDone }: { id: string; onDone: () => void }) {
  const [phoneNumberId, setP] = useState("");
  const [accessToken, setT] = useState("");
  const { busy, error, done, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => { await post(`/businesses/${id}/connections/whatsapp`, { phoneNumberId, accessToken }); setP(""); setT(""); onDone(); }, "WhatsApp connected.");
  };
  return (
    <Card title="WhatsApp number">
      <form onSubmit={submit}>
        <Field label="Phone number ID" hint="From the WhatsApp section in Meta."><input required inputMode="numeric" value={phoneNumberId} onChange={(e) => setP(e.target.value)} /></Field>
        <Field label="Access token" hint="Stored encrypted. It can't be viewed again once saved; paste a new one to replace it."><input required type="password" autoComplete="off" value={accessToken} onChange={(e) => setT(e.target.value)} /></Field>
        <ErrorNote message={error} />
        {done && <p className="note good" role="status">{done}</p>}
        <button className="primary" disabled={busy}>Save</button>
      </form>
    </Card>
  );
}
