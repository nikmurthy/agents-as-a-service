import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { get } from "../api";
import { useBiz } from "../ctx";
import { Card, Empty, ErrorNote, Loading, Page, Status, useLoad, when } from "../ui";

export function Activity() {
  const { id } = useBiz();
  const [tab, setTab] = useState<"runs" | "audit">("runs");
  return (
    <Page title="Activity" actions={
      <div className="seg" role="tablist">
        <button role="tab" aria-selected={tab === "runs"} onClick={() => setTab("runs")}>Runs</button>
        <button role="tab" aria-selected={tab === "audit"} onClick={() => setTab("audit")}>Audit log</button>
      </div>}>
      {tab === "runs" ? <Runs id={id} /> : <Audit id={id} />}
    </Page>
  );
}

function Runs({ id }: { id: string }) {
  const { data, error } = useLoad(() => get(`/businesses/${id}/runs`), [id]);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  if (!data.runs.length) return <Empty>Nothing has been processed yet.</Empty>;
  return (
    <div className="list">
      {data.runs.map((r: any) => (
        <Link key={r.id} to={`/b/${id}/activity/${r.id}`} className="row">
          <div><strong>{r.use_case.replace("_", " ")}</strong><div className="muted">{r.outcome ?? r.error ?? ""}{r.outcome_reason ? ` · ${r.outcome_reason}` : ""}</div></div>
          <div className="row-meta"><Status value={r.status} /><span className="muted">{(r.input_tokens + r.output_tokens).toLocaleString("en-GB")} tokens</span><span className="muted">{when(r.created_at)}</span></div>
        </Link>
      ))}
    </div>
  );
}

export function RunDetail() {
  const { id } = useBiz();
  const { runId } = useParams();
  const { data, error } = useLoad(() => get(`/businesses/${id}/runs/${runId}`), [id, runId]);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return (
    <Page title="Run" actions={<Link to={`/b/${id}/activity`}>Back</Link>}>
      <Card>
        <div className="row-meta"><Status value={data.run.status} /><span className="muted">{when(data.run.created_at)}</span></div>
        {data.run.error && <p className="note error">{data.run.error}</p>}
        {data.run.outcome && <p>Outcome: {data.run.outcome}{data.run.outcome_reason ? ` (${data.run.outcome_reason})` : ""}</p>}
      </Card>
      <Card title="Steps">
        <table>
          <thead><tr><th>Step</th><th>Agent</th><th>Tokens</th><th>Time</th></tr></thead>
          <tbody>{data.events.map((e: any, i: number) => (
            <tr key={i}><td>{e.step}{e.detail ? <div className="muted small">{e.detail}</div> : null}</td>
              <td>{e.agent ? `${e.agent} v${e.agent_version}` : ""}</td>
              <td>{e.input_tokens != null ? `${e.input_tokens} in / ${e.output_tokens} out` : ""}</td>
              <td>{e.ms != null ? `${e.ms} ms` : ""}</td></tr>
          ))}</tbody>
        </table>
      </Card>
    </Page>
  );
}

const FILTERS: [string, string][] = [["", "Everything"], ["draft.", "Reply decisions"], ["settings.", "Settings"], ["member.", "People"], ["connection.", "Connections"], ["data.", "Data requests"]];

function Audit({ id }: { id: string }) {
  const [prefix, setPrefix] = useState("");
  const { data, error } = useLoad(() => get(`/businesses/${id}/audit?action=${encodeURIComponent(prefix)}`), [id, prefix]);
  return (
    <>
      <label className="field"><span className="label">Show</span>
        <select value={prefix} onChange={(e) => setPrefix(e.target.value)}>{FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      <ErrorNote message={error} />
      {!data ? <Loading /> : !data.entries.length ? <Empty>Nothing recorded.</Empty> : (
        <table>
          <thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead>
          <tbody>{data.entries.map((e: any) => (
            <tr key={e.id}><td>{when(e.at)}</td><td>{e.actor}</td><td>{e.action}</td></tr>
          ))}</tbody>
        </table>
      )}
    </>
  );
}
