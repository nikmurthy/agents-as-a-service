import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { get, post } from "../api";
import type { Me } from "../App";
import { Card, Empty, ErrorNote, Field, Loading, Page, Status, useAction, useLoad, when } from "../ui";

export function Businesses({ me }: { me: Me }) {
  const { data, error, loading, reload } = useLoad(() => get("/businesses"), []);
  const [adding, setAdding] = useState(false);
  return (
    <Page title="Businesses" actions={me.isAdmin && <button className="primary" onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "Add a business"}</button>}>
      {adding && <NewBusiness onDone={() => { setAdding(false); reload(); }} />}
      <ErrorNote message={error} />
      {loading && !data && <Loading />}
      {data && !data.businesses.length && <Empty>No businesses yet.</Empty>}
      <div className="list">
        {data?.businesses.map((b: any) => (
          <Link key={b.id} to={`/b/${b.id}`} className="row">
            <div><strong>{b.name}</strong><div className="muted">{b.slug}</div></div>
            <div className="row-meta">
              {b.drafts_waiting > 0 && <span className="pill warn">{b.drafts_waiting} waiting</span>}
              {b.connection_problems > 0 && <span className="pill bad">connection problem</span>}
              <Status value={b.status} />
              {b.last_message_at && <span className="muted">{when(b.last_message_at)}</span>}
            </div>
          </Link>
        ))}
      </div>
    </Page>
  );
}

function NewBusiness({ onDone }: { onDone: () => void }) {
  const { busy, error, field, run } = useAction();
  const [f, setF] = useState({ slug: "", name: "", pack: "trades", ownerName: "", ownerWhatsapp: "", ownerEmail: "" });
  const [link, setLink] = useState<string>();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await post("/businesses", { slug: f.slug, name: f.name, pack: f.pack, owner: { name: f.ownerName, whatsapp: f.ownerWhatsapp, email: f.ownerEmail || undefined } });
      setLink(r.googleLink);
    });
  };
  if (link) {
    return (
      <Card title="Business created">
        <p>Send the owner this link so they can connect Gmail and Google Calendar. It expires, and you can make a new one from Connections.</p>
        <p><code className="wrap">{link}</code></p>
        <button onClick={onDone}>Done</button>
      </Card>
    );
  }
  return (
    <Card title="New business">
      <form onSubmit={submit} className="grid">
        <Field label="Business name"><input required value={f.name} onChange={set("name")} /></Field>
        <Field label="Short web address" hint="3 to 40 lowercase letters, numbers or hyphens. Can't be changed later."><input required value={f.slug} onChange={set("slug")} /></Field>
        <Field label="Type of business">
          <select value={f.pack} onChange={set("pack")}>
            <option value="trades">Trades</option><option value="flooring">Flooring</option><option value="practitioner">Practitioner</option>
          </select>
        </Field>
        <Field label="Owner's name"><input required value={f.ownerName} onChange={set("ownerName")} /></Field>
        <Field label="Owner's WhatsApp number" hint="Approvals are sent here."><input required inputMode="tel" value={f.ownerWhatsapp} onChange={set("ownerWhatsapp")} /></Field>
        <Field label="Owner's email" hint="They sign in with this address."><input type="email" value={f.ownerEmail} onChange={set("ownerEmail")} /></Field>
        <ErrorNote message={error ? (field ? `${error} (${field})` : error) : undefined} />
        <button className="primary" disabled={busy}>Create business</button>
      </form>
    </Card>
  );
}
