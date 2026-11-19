import { Link } from "react-router-dom";
import { get } from "../api";
import { useBiz } from "../ctx";
import { Card, useLoad } from "../ui";

// Checklist shown on a business's Overview until everything needed is in place.
export function SetupChecklist() {
  const { id, isAdmin } = useBiz();
  const { data } = useLoad(() => get(`/businesses/${id}/setup`), [id]);
  if (!data || data.complete) return null;
  const done = data.steps.filter((s: any) => s.done).length;
  return (
    <Card title={`Setup: ${done} of ${data.steps.length} done`}>
      <ol className="checklist">
        {data.steps.map((s: any) => {
          const href = s.fix.startsWith("/") ? s.fix : `/b/${id}${s.fix ? "/" + s.fix : ""}`;
          const canFix = !s.done && s.fix && (!s.admin || isAdmin);
          return (
            <li key={s.key} className={s.done ? "done" : ""}>
              <span className={s.done ? "tick" : "todo"} aria-hidden>{s.done ? "✓" : "○"}</span>
              <div>
                <strong>{s.label}</strong>{s.optional && !s.done && <span className="muted small"> (optional for now)</span>}
                {!s.done && <div className="muted small">{s.why}{s.admin && !isAdmin ? " The platform team sorts this out." : ""}</div>}
              </div>
              {canFix && <Link to={href} className="fix">Fix</Link>}
              {!s.done && s.key === "active" && <span className="muted small fix">Use the switch below</span>}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
