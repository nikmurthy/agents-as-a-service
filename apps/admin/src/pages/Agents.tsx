import { get } from "../api";
import { Card, ErrorNote, Loading, Page, useLoad, when } from "../ui";

// Plain-English explanations. The definitions themselves (model, instructions, tools) come from the API.
const ABOUT: Record<string, { name: string; job: string; does: string[]; never: string[] }> = {
  triage: {
    name: "Triage",
    job: "Reads every new message and decides what it is.",
    does: ["Works out what the person wants and how urgent it is", "Picks the next step: book, answer, pass to you, or ignore", "Flags anything a person should handle (complaints, emergencies, health questions)"],
    never: ["Replies to anyone", "Sees email addresses or phone numbers"],
  },
  booking: {
    name: "Booking",
    job: "Finds real free times in your calendar.",
    does: ["Checks your Google Calendar and working hours", "Suggests a few times and holds them while the customer decides", "Confirms the time they pick, or moves an existing booking"],
    never: ["Offers a time the calendar check rejects (the code double-checks every slot)", "Confirms anything without your approval"],
  },
  drafting: {
    name: "Drafting",
    job: "Writes the reply in your tone of voice.",
    does: ["Uses your services, prices, tone and sign-off from Settings", "Fits the reply to the channel (shorter for WhatsApp)", "Says when it thinks you should look before sending"],
    never: ["Sends anything", "Makes up prices or services you haven't listed"],
  },
  reviewer: {
    name: "Reviewer",
    job: "A second, stronger model checks every draft.",
    does: ["Scores the draft for accuracy, tone and safety", "Blocks anything unsafe or wrong", "Flags drafts below your pass score so you look closely"],
    never: ["Rewrites the reply", "Sends anything"],
  },
};
const ORDER = ["triage", "booking", "drafting", "reviewer"];

const money = (n: number | null) => (n == null ? "–" : n < 0.01 ? "under 1¢" : `$${n.toFixed(n < 1 ? 3 : 2)}`);
const modelName = (m: string) => m.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/^\w/, (x) => x.toUpperCase());

export function Agents() {
  const { data, error } = useLoad(() => get("/agents"), []);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  const agents = [...data.agents].sort((a: any, b: any) => (ORDER.indexOf(a.id) + 99) % 99 - (ORDER.indexOf(b.id) + 99) % 99);
  const total = agents.reduce((s: number, a: any) => s + (a.usage.perRunUsd ?? 0), 0);
  const pinned = data.pinned.filter((t: any) => t.pinned);
  return (
    <Page title="Agents">
      <p className="lead">Four agents work on every enquiry, one after another. They judge; the code decides. Nothing reaches a customer until a person approves it.</p>

      <Card title="How an enquiry is handled">
        <ol className="flow">
          <li className="flow-step in"><strong>Message arrives</strong><span>Gmail, WhatsApp, website form or Checkatrade</span></li>
          <li className="flow-step"><strong>Triage</strong><span>What is it? How urgent?</span><em>Spam stops here. Emergencies and complaints go straight to you.</em></li>
          <li className="flow-step"><strong>Booking</strong><span>Free times from your calendar</span><em>Only when they want an appointment.</em></li>
          <li className="flow-step"><strong>Drafting</strong><span>Writes the reply</span></li>
          <li className="flow-step"><strong>Reviewer</strong><span>Checks and scores it</span><em>Low scores are flagged for you.</em></li>
          <li className="flow-step you"><strong>You approve</strong><span>On WhatsApp or in the Inbox. Edit or reject if you like.</span></li>
          <li className="flow-step out"><strong>Sent</strong><span>Through the channel it came in on</span></li>
        </ol>
      </Card>

      <div className="agent-grid">
        {agents.map((a: any) => {
          const about = ABOUT[a.id];
          return (
            <div key={a.id} className="card agent">
              <div className="agent-head">
                <h2>{about?.name ?? a.id}</h2>
                <span className="pill">{modelName(a.model)}{a.effort ? ` · ${a.effort} effort` : ""}</span>
              </div>
              <p>{about?.job ?? a.description}</p>
              {about && (
                <div className="grid two">
                  <div><h3>Does</h3><ul>{about.does.map((d) => <li key={d}>{d}</li>)}</ul></div>
                  <div><h3>Never</h3><ul>{about.never.map((d) => <li key={d}>{d}</li>)}</ul></div>
                </div>
              )}
              <dl className="facts">
                <div><dt>Version</dt><dd>{a.version}</dd></div>
                <div><dt>Tools it can use</dt><dd>{a.tools.length ? a.tools.map((t: any) => typeof t === "string" ? t : t.name).join(", ").replace(/_/g, " ") : "none"}</dd></div>
                <div><dt>Cost per enquiry</dt><dd>{a.usage.runs ? `${money(a.usage.perRunUsd)} (last 30 days, ${a.usage.runs} runs)` : "Not run yet"}</dd></div>
              </dl>
              <details>
                <summary>Show its full instructions</summary>
                <pre className="instructions">{a.instructions}</pre>
              </details>
            </div>
          );
        })}
      </div>

      <Card title="Running costs">
        <p>{total ? <>About <strong>{money(total)}</strong> per enquiry across all four agents, from the last 30 days.</> : "Costs show here once enquiries have been handled."} The monthly spending limit is set in the Claude Console.</p>
      </Card>

      <Card title="Versions">
        <p className="muted small">Agents are changed in the code and published as a new version. Every business uses the latest unless it's pinned below.</p>
        <table>
          <thead><tr><th>Agent</th><th>Version</th><th>Model</th><th>Published</th></tr></thead>
          <tbody>{data.versions.map((v: any) => <tr key={`${v.agent_key}${v.version}`}><td>{ABOUT[v.agent_key]?.name ?? v.agent_key}</td><td>{v.version}</td><td>{modelName(v.model)}</td><td>{when(v.created_at)}</td></tr>)}</tbody>
        </table>
        {pinned.length > 0 && (
          <table><thead><tr><th>Business</th><th>Pinned to</th></tr></thead>
            <tbody>{pinned.map((t: any) => <tr key={t.id}><td>{t.name}</td><td>{Object.entries(t.pinned).map(([k, v]) => `${k} ${v}`).join(", ")}</td></tr>)}</tbody></table>
        )}
      </Card>
    </Page>
  );
}
