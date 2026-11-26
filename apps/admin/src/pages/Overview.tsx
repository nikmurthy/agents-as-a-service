import { Link } from "react-router-dom";
import { get, put } from "../api";
import { useBiz } from "../ctx";
import { SetupChecklist } from "./Setup";
import { ReplyQueue } from "./Queue";
import { Card, Empty, ErrorNote, Loading, Page, useAction, useLoad, when } from "../ui";

export function Overview() {
  const { id, business, canManage, isAdmin } = useBiz();
  const { data, error, reload } = useLoad(() => get(`/businesses/${id}`), [id]);
  const pause = useAction();
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  const n = data.numbers, a = data.attention;
  const nothing = !a.failedSends.length && !a.flaggedDrafts.length && !a.brokenConnections.length && !a.failedRuns.length;
  const paused = business.status === "paused";
  return (
    <Page title="Overview">
      <ReplyQueue />
      <SetupChecklist />
      <ThisWeek week={data.week} />
      <h2 className="section">Today</h2>
      <div className="stats">
        <Stat label="Messages in" value={n.messages_today} />
        <Stat label="Replies waiting for you" value={n.drafts_waiting} to={`/b/${id}/inbox?waiting=1`} />
        <Stat label="Replies sent" value={n.replies_sent_today} />
        <Stat label="Times pencilled in" value={n.times_held} to={`/b/${id}/bookings`} />
        <Stat label="Coming up" value={n.upcoming_bookings} to={`/b/${id}/bookings`} />
      </div>
      <Card title="Needs you">
        {nothing && <Empty>Nothing needs you right now.</Empty>}
        {a.flaggedDrafts.map((d: any) => <Item key={d.id} to={`/b/${id}/inbox/${d.conversation_id}`} text={`Have a closer look: ${d.attention_reason}`} at={d.created_at} />)}
        {a.failedSends.map((d: any) => <Item key={d.id} to={`/b/${id}/inbox/${d.conversation_id}`} text="A reply failed to send" at={d.created_at} bad />)}
        {a.brokenConnections.map((c: any) => <Item key={c.id} to={`/b/${id}/connections`} text={`${c.kind.replace("_", " ")} connection problem: ${c.last_error ?? "unknown error"}`} bad />)}
        {a.failedRuns.map((r: any) => <Item key={r.id} to={`/b/${id}/activity/${r.id}`} text="A message couldn't be processed" at={r.created_at} bad />)}
      </Card>
      {business.status === "onboarding" && (
        <Card title="Switch on">
          <p className="muted">This business is still being set up, so nothing is drafted yet. Switch it on once the checklist above is done.</p>
          <ErrorNote message={pause.error} />
          {isAdmin
            ? <button className="primary" disabled={pause.busy} onClick={() => pause.run(async () => { await put(`/businesses/${id}/status`, { status: "active" }); location.reload(); })}>Switch on</button>
            : <p className="note">The platform team switches new businesses on.</p>}
        </Card>
      )}
      {canManage && (business.status === "active" || business.status === "paused") && (
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

// A calm weekly "here's what I did": facts, no streaks, no guilt.
function ThisWeek({ week }: { week: any }) {
  if (!week) return null;
  const quiet = !week.messagesIn && !week.repliesSent && !week.booked;
  const mins = week.avgMinutesToReply;
  const speed = mins == null ? "–" : mins < 60 ? `${Math.max(1, mins)} min` : mins < 2880 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
  return (
    <Card title="This week">
      {quiet ? <p className="muted">Nothing yet this week. When messages come in, you'll see what got done here.</p> : (
        <dl className="week">
          <div><dt>Replies sent</dt><dd>{week.repliesSent}</dd></div>
          <div><dt>Average time to reply</dt><dd>{speed}</dd></div>
          <div><dt>Appointments booked</dt><dd>{week.booked}</dd></div>
          <div><dt>Quotes chased</dt><dd>{week.quotesChased}</dd></div>
          {week.feedbackAsked > 0 && <div><dt>Asked how it went</dt><dd>{week.feedbackAsked}</dd></div>}
          {week.sentAutomatically > 0 && <div><dt>Sent automatically</dt><dd>{week.sentAutomatically}</dd></div>}
        </dl>
      )}
      <p className="muted small">The last 7 days. {week.messagesIn} {week.messagesIn === 1 ? "message" : "messages"} came in.</p>
    </Card>
  );
}

const Stat = ({ label, value, to }: { label: string; value: number; to?: string }) => {
  const inner = <><div className="stat-n">{value}</div><div className="muted">{label}</div></>;
  return to ? <Link to={to} className="stat">{inner}</Link> : <div className="stat">{inner}</div>;
};
const Item = ({ to, text, at, bad }: { to: string; text: string; at?: string; bad?: boolean }) => (
  <Link to={to} className="row"><span className={bad ? "bad-text" : ""}>{text}</span>{at && <span className="muted">{when(at)}</span>}</Link>
);
