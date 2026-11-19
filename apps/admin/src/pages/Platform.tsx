import { useState } from "react";
import { get, post } from "../api";
import { Card, ErrorNote, Loading, Page, useLoad } from "../ui";

// Status of the platform's keys. Values are never sent to the browser: only whether each is set and whether it works.
export function Platform() {
  const { data, error } = useLoad(() => get("/platform/status"), []);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return (
    <Page title="Keys and services">
      <p className="lead">The platform uses one key per service, shared by every business and every agent. Businesses never need these: they connect their own inbox and calendar by signing in.</p>
      {data.agentMode === "mock" && <p className="note">Agents are in practice mode: they don't call Claude.</p>}
      {data.services.map((s: any) => <ServiceCard key={s.id} s={s} />)}
      <Card title="Changing a key">
        <ol className="steps">
          <li>Open Bitwarden → Secrets Manager → project <strong>Agents-as-a-Service</strong>.</li>
          <li>Add or edit the secret. The name must match exactly, for example <code>ANTHROPIC_API_KEY</code>.</li>
          <li>In GitHub, run the <strong>Deploy production</strong> workflow. It copies the keys to the app.</li>
          <li>Come back here and press <strong>Test</strong>.</li>
        </ol>
        <p className="muted small">Keys aren't typed into this app on purpose: if someone got into the admin app, they still couldn't read or change them.</p>
      </Card>
    </Page>
  );
}

function ServiceCard({ s }: { s: any }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string }>();
  const [err, setErr] = useState<string>();
  const test = async () => {
    setBusy(true); setErr(undefined); setResult(undefined);
    try { setResult(await post(`/platform/test/${s.id}`)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="agent-head">
        <h2>{s.name}</h2>
        <span className={`pill ${s.ready ? "good" : "bad"}`}>{s.ready ? "Set" : "Missing"}</span>
      </div>
      <p>{s.purpose}</p>
      <ul className="keys">
        {s.keys.map((k: any) => <li key={k.name}><span className={k.set ? "tick" : "cross"} aria-hidden>{k.set ? "✓" : "✗"}</span><code>{k.name}</code> <span className="muted small">{k.set ? "set" : "not set"}</span></li>)}
      </ul>
      <p className="muted small">Where to find it: {s.where}</p>
      <div className="buttons">
        <button onClick={test} disabled={busy}>{busy ? "Testing…" : "Test"}</button>
      </div>
      {result && <p className={`note ${result.ok ? "good" : "error"}`} role="status">{result.detail}</p>}
      <ErrorNote message={err} />
    </div>
  );
}
