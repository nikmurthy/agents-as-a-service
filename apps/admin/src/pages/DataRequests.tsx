import { useState, type FormEvent } from "react";
import { get, post } from "../api";
import { useBiz } from "../ctx";
import { Card, Empty, ErrorNote, Field, Page, useAction, useLoad, when } from "../ui";

export function DataRequests() {
  const { id, business, canManage } = useBiz();
  const { data, reload } = useLoad(() => get(`/businesses/${id}/data-requests`), [id]);
  const [who, setWho] = useState({ email: "", phone: "" });
  const [confirmSlug, setConfirm] = useState("");
  const [exported, setExported] = useState<string>();
  const { busy, error, done, run } = useAction();
  if (!canManage) return <Page title="Data requests"><p className="note">Only owners can do this.</p></Page>;

  const person = () => ({ email: who.email || undefined, phone: who.phone || undefined, confirm: confirmSlug });
  const act = (verb: "export" | "erase" | "suppress", ok: string) => (e: FormEvent | React.MouseEvent) => {
    e.preventDefault();
    if (verb === "erase" && !confirm("Erasing removes this person's messages and cancels their bookings. This can't be undone. Continue?")) return;
    run(async () => {
      const r = await post(`/businesses/${id}/data/${verb}`, person());
      setExported(verb === "export" ? JSON.stringify(r, null, 2) : undefined);
      reload();
    }, ok);
  };
  return (
    <Page title="Data requests">
      <Card title="Someone has asked about their data">
        <form onSubmit={act("export", "Export ready below.")}>
          <p className="muted">Give an email address or a phone number, not both.</p>
          <div className="grid two">
            <Field label="Email"><input type="email" value={who.email} onChange={(e) => setWho({ email: e.target.value, phone: "" })} /></Field>
            <Field label="Phone"><input inputMode="tel" value={who.phone} onChange={(e) => setWho({ phone: e.target.value, email: "" })} /></Field>
          </div>
          <Field label={`Type "${business.slug}" to confirm`}><input value={confirmSlug} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" /></Field>
          <ErrorNote message={error} />
          {done && <p className="note good" role="status">{done}</p>}
          <div className="buttons">
            <button className="primary" disabled={busy}>Export their data</button>
            <button type="button" className="danger" disabled={busy} onClick={act("erase", "Their details have been erased.")}>Erase them</button>
            <button type="button" disabled={busy} onClick={act("suppress", "They won't be contacted again.")}>Never contact again</button>
          </div>
        </form>
        {exported && <><pre className="export">{exported}</pre>
          <button onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([exported], { type: "application/json" })); a.download = "export.json"; a.click(); }}>Download</button></>}
      </Card>
      <Card title="Past requests">
        {!data?.requests.length ? <Empty>None yet.</Empty> : (
          <table><thead><tr><th>When</th><th>What</th><th>By</th></tr></thead>
            <tbody>{data.requests.map((r: any) => <tr key={r.id}><td>{when(r.created_at)}</td><td>{r.kind}</td><td>{r.requested_by}</td></tr>)}</tbody></table>
        )}
      </Card>
    </Page>
  );
}
