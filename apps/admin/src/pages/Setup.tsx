import { Link } from "react-router-dom";
import { get } from "../api";
import { useBiz } from "../ctx";
import { Card, useLoad } from "../ui";

// Setup as a task list (GOV.UK "Complete multiple tasks"), with what you'll need to have to hand first (LEGO's "what's in the box").
const STATUS: Record<string, [string, string]> = { done: ["Done", "good"], todo: ["To do", "info"], blocked: ["Can't start yet", "muted"] };

export function SetupChecklist() {
  const { id, isAdmin } = useBiz();
  const { data } = useLoad(() => get(`/businesses/${id}/setup`), [id]);
  if (!data || data.complete) return null;
  const done = data.steps.filter((s: any) => s.done).length;
  return (
    <Card title={`Get set up: ${done} of ${data.steps.length} done`}>
      {data.needs?.length > 0 && (<>
        <h3>What you'll need</h3>
        <ul className="needs">{data.needs.map((n: string) => <li key={n}>{n}</li>)}</ul>
      </>)}
      <ol className="tasklist">
        {data.steps.map((s: any) => {
          const href = s.fix.startsWith("/") ? s.fix : `/b/${id}${s.fix ? "/" + s.fix : ""}`;
          const canFix = s.status === "todo" && s.fix && (!s.admin || isAdmin);
          const [word, tone] = STATUS[s.status] ?? STATUS.todo;
          return (
            <li key={s.key} className={s.status}>
              <div>
                {canFix ? <Link to={href}><strong>{s.label}</strong></Link> : <strong>{s.label}</strong>}
                {s.optional && !s.done && <span className="muted small"> (optional)</span>}
                {!s.done && <div className="muted small">{s.why}{s.admin && !isAdmin ? " The platform team sorts this out." : ""}{s.key === "active" && s.status === "todo" ? " Use the switch below." : ""}</div>}
              </div>
              <span className={`pill ${tone}`}>{word}</span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
