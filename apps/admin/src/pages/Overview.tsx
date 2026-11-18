import { Link } from "react-router-dom";
import { get, put } from "../api";
import { useBiz } from "../ctx";
import { Card, Empty, ErrorNote, Loading, Page, useAction, useLoad, when } from "../ui";

export function Overview() {
  const { id, business, canManage } = useBiz();
  const { data, error } = useLoad(() => get(`/businesses/${id}`), [id]);
  const pause = useAction();
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  const n = data.numbers, a = data.attention;
  const nothing = !a.failedSends.length && !a.flaggedDrafts.length && !a.brokenConnections.length && !a.failedRuns.length;
  const paused = business.status === "paused";
  return (
    <Page title="Overview">
      <div className="stats">
        <Stat label="Messages in today" value={n.messages_today} />
        <Stat label="Replies waiting for you" value={n.drafts_waiting} to={`/b/${id}/inbox?waiting=1`} />
        <Stat label="Replies sent today" value={n.replies_sent_today} />
        <Stat label="Times being held" value={n.times_held} to={`/b/${id}/bookings`} />
        <Stat label="Upcoming bookings" value={n.upcoming_bookings} to={`/b/${id}/bookings`} />
      </div>
      <Card title="Needs attention">
        {nothing && <Empty>Nothing needs attention.</Empty>}
        {a.flaggedDrafts.map((d: any) => <Item key={d.id} to={`/b/${id}/inbox/${d.conversation_id}`} text={`Reply flagged: ${d.attention_reason}`} at={d.created_at} />)}
        {a.failedSends.map((d: any) => <Item key={d.id} to={`/b/${id}/inbox/${d.conversation_id}`} text="A reply failed to send" at={d.created_at} bad />)}
        {a.brokenConnections.map((c: any) => <Item key={c.id} to={`/b/${id}/connections`} text={`${c.kind.replace("_", " ")} connection problem: ${c.last_error ?? "unknown error"}`} bad />)}
        {a.failedRuns.map((r: any) => <Item key={r.id} to={`/b/${id}/activity/${r.id}`} text="A message couldn't be processed" at={r.created_at} bad />)}
      </Card>
      {canManage && business.status !== "closed" && (
        <Card title={paused ? "Paused" : "Pause this business"}>
          <p className="muted">{paused ? "Messages are being kept but no replies are drafted." : "Stops drafting replies. Incoming messages are kept and nothing is lost."}</p>
          <ErrorNote message={pause.error} />
          <button disabled={pause.busy} onClick={() => pause.run(async () => { await put(`/businesses/${id}/status`, { status: paused ? "active" : "paused" }); location.reload(); })}>
            {paused ? "Resume" : "Pause"}
          </button>
        </Card>
      )}
    </Page>
  );
}

const Stat = ({ label, value, to }: { label: string; value: number; to?: string }) => {
  const inner = <><div className="stat-n">{value}</div><div className="muted">{label}</div></>;
  return to ? <Link to={to} className="stat">{inner}</Link> : <div className="stat">{inner}</div>;
};
const Item = ({ to, text, at, bad }: { to: string; text: string; at?: string; bad?: boolean }) => (
  <Link to={to} className="row"><span className={bad ? "bad-text" : ""}>{text}</span>{at && <span className="muted">{when(at)}</span>}</Link>
);
