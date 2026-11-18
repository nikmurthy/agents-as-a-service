import { useState, type FormEvent } from "react";
import { del, get, post, put } from "../api";
import { useBiz } from "../ctx";
import { Card, ErrorNote, Field, Loading, Page, useAction, useLoad } from "../ui";

type Draft = { name: string; email: string; role: "owner" | "staff"; whatsapp: string; isApprover: boolean };
const blank: Draft = { name: "", email: "", role: "staff", whatsapp: "", isApprover: false };

export function People() {
  const { id, canManage } = useBiz();
  const { data, error, reload } = useLoad(() => get(`/businesses/${id}/members`), [id]);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const act = useAction();
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return (
    <Page title="People" actions={canManage && <button className="primary" onClick={() => setEditing("new")}>Add someone</button>}>
      <p className="muted">Owners can change everything. Staff can read messages and approve replies. Approvers get replies to check on WhatsApp.</p>
      {editing === "new" && <Editor id={id} onDone={() => { setEditing(null); reload(); }} />}
      <ErrorNote message={act.error} />
      <div className="list">
        {data.members.map((m: any) => editing === m.id ? (
          <Editor key={m.id} id={id} member={m} onDone={() => { setEditing(null); reload(); }} />
        ) : (
          <div key={m.id} className="row">
            <div>
              <strong>{m.name}</strong> <span className="pill muted">{m.role}</span> {m.isApprover && <span className="pill good">approver</span>}
              <div className="muted">{[m.email, m.whatsapp].filter(Boolean).join(" · ")}{m.email && !m.hasLoggedIn ? " · hasn't signed in yet" : ""}</div>
            </div>
            {canManage && (
              <div className="row-meta">
                <button onClick={() => setEditing(m.id)}>Edit</button>
                <button className="danger" disabled={act.busy} onClick={() => confirm(`Remove ${m.name}?`) && act.run(async () => { await del(`/businesses/${id}/members/${m.id}`); reload(); })}>Remove</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Page>
  );
}

function Editor({ id, member, onDone }: { id: string; member?: any; onDone: () => void }) {
  const [f, setF] = useState<Draft>(member ? { name: member.name, email: member.email ?? "", role: member.role, whatsapp: member.whatsapp ?? "", isApprover: member.isApprover } : blank);
  const { busy, error, run } = useAction();
  const body = () => ({ name: f.name, email: f.email || undefined, role: f.role, whatsapp: f.whatsapp || undefined, isApprover: f.isApprover });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => { await (member ? put(`/businesses/${id}/members/${member.id}`, body()) : post(`/businesses/${id}/members`, body())); onDone(); });
  };
  return (
    <Card title={member ? `Edit ${member.name}` : "Add someone"}>
      <form onSubmit={submit} className="grid">
        <Field label="Name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Email" hint="They sign in with this address."><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Role">
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Draft["role"] })}><option value="staff">Staff</option><option value="owner">Owner</option></select>
        </Field>
        <Field label="WhatsApp number"><input inputMode="tel" value={f.whatsapp} onChange={(e) => setF({ ...f, whatsapp: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={f.isApprover} onChange={(e) => setF({ ...f, isApprover: e.target.checked })} /> Gets replies to approve on WhatsApp</label>
        <ErrorNote message={error} />
        <div className="buttons"><button className="primary" disabled={busy}>Save</button><button type="button" onClick={onDone}>Cancel</button></div>
      </form>
    </Card>
  );
}
