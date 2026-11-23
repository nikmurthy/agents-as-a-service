import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { get, put } from "../api";
import { Icon, type IconName } from "../icons";
import { useBiz } from "../ctx";
import { Card, Empty, ErrorNote, Loading, Page, Status, useAction, useLoad, when } from "../ui";

// "What happened": every action as a sentence that says what, to whom, and why (like a bank statement).
// The technical run log and audit log stay one tap away under "Details".
export function Activity() {
  const { id } = useBiz();
  const [tab, setTab] = useState<"feed" | "runs" | "audit">("feed");
  return (
    <Page title="What happened" actions={
      <div className="seg" role="tablist" aria-label="Show">
        <button role="tab" aria-selected={tab === "feed"} className={tab === "feed" ? "on" : ""} onClick={() => setTab("feed")}>In plain words</button>
        <button role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "on" : ""} onClick={() => setTab("runs")}>Details</button>
        <button role="tab" aria-selected={tab === "audit"} className={tab === "audit" ? "on" : ""} onClick={() => setTab("audit")}>Audit log</button>
      </div>}>
      {tab === "feed" ? <Feed id={id} /> : tab === "runs" ? <Runs id={id} /> : <Audit id={id} />}
    </Page>
  );
}

const WHO: Record<string, [IconName, string]> = { you: ["person", "You"], assistant: ["auto", "Assistant"], customer: ["mail", "Customer"], platform: ["list", "Platform"] };
const CAT: Record<string, string> = { answer_question: "Answering questions", offer_times: "Offering times", confirm_booking: "Confirming bookings", quote_followup: "Quote follow-ups", feedback_request: "Feedback requests" };

function Feed({ id }: { id: string }) {
  const { canManage } = useBiz();
  const [before, setBefore] = useState<number>();
  const [older, setOlder] = useState<any[]>([]);
  const { data, error, reload } = useLoad(() => get(`/businesses/${id}/feed${before ? `?before=${before}` : ""}`), [id, before]);
  const [switched, setSwitched] = useState<Record<string, string>>({});
  const a = useAction();
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  const items = [...older, ...data.items];
  if (!items.length) return <Empty>Nothing has happened yet. When messages come in, each step shows up here in plain words.</Empty>;
  const back = (cat: string) => a.run(async () => {
    const r = await put(`/businesses/${id}/automations/${cat}`, { on: false });
    setSwitched({ ...switched, [cat]: r.message }); reload();
  });
  let day = "";
  return (
    <div className="feed">
      <ErrorNote message={a.error} />
      {items.map((e: any) => {
        const d = new Date(e.at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
        const head = d !== day ? (day = d) : null;
        const [icon, who] = WHO[e.who] ?? WHO.assistant;
        return (
          <div key={e.id}>
            {head && <h3 className="feed-day">{head}</h3>}
            <div className={`ev ${e.who}`}>
              <span className="ev-icon" title={who}><Icon name={icon} size={18} /></span>
              <div className="ev-body">
                <div><span className="ev-time">{new Date(e.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span> {e.text}</div>
                {e.why && <div className="muted small">Why: {e.why}</div>}
                <div className="ev-links">
                  {e.conversationId && <Link to={`/b/${id}/inbox/${e.conversationId}`}>Open conversation</Link>}
                  {e.automatic && canManage && !switched[e.automatic] && (
                    <button className="link" disabled={a.busy} onClick={() => back(e.automatic)}>Switch {CAT[e.automatic]?.toLowerCase() ?? "these"} back to asking me</button>)}
                  {e.automatic && switched[e.automatic] && <span className="muted small">{switched[e.automatic]}</span>}
                </div>
              </div>
            </div>
          </div>
        );
      })}
      {data.items.length >= 60 && <button onClick={() => { setOlder(items); setBefore(items[items.length - 1].id); }}>Show older</button>}
    </div>
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
          <div><strong>{r.use_case.replace(/_/g, " ")}</strong><div className="muted">{r.outcome ?? r.error ?? ""}{r.outcome_reason ? ` · ${r.outcome_reason}` : ""}</div></div>
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
