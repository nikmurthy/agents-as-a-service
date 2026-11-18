import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { get, post } from "../api";
import { useBiz } from "../ctx";
import { Card, Empty, ErrorNote, Loading, Page, Status, useAction, useLoad, when } from "../ui";

const ROUTE: Record<string, string> = { whatsapp: "WhatsApp", email: "email", checkatrade_message: "Checkatrade (paste in)", sms: "text (send yourself)", phone: "phone call" };

export function Inbox() {
  const { id } = useBiz();
  const [params, setParams] = useSearchParams();
  const waiting = params.get("waiting") === "1";
  const { data, error, loading } = useLoad(() => get(`/businesses/${id}/conversations${waiting ? "?waiting=1" : ""}`), [id, waiting]);
  return (
    <Page title="Inbox" actions={
      <label className="check"><input type="checkbox" checked={waiting} onChange={(e) => setParams(e.target.checked ? { waiting: "1" } : {})} /> Only waiting for approval</label>}>
      <ErrorNote message={error} />
      {loading && !data && <Loading />}
      {data && !data.conversations.length && <Empty>{waiting ? "No replies are waiting." : "No conversations yet."}</Empty>}
      <div className="list">
        {data?.conversations.map((c: any) => (
          <Link key={c.id} to={`/b/${id}/inbox/${c.id}`} className="row">
            <div><strong>{c.name ?? "Unknown"}</strong><div className="muted clip">{c.preview}</div></div>
            <div className="row-meta">
              {c.needs_attention && <span className="pill bad">check</span>}
              {c.drafts_waiting > 0 && <span className="pill warn">reply waiting</span>}
              <span className="muted">{when(c.last_activity_at)}</span>
            </div>
          </Link>
        ))}
      </div>
    </Page>
  );
}

export function Conversation() {
  const { id } = useBiz();
  const { convId } = useParams();
  const { data, error, reload } = useLoad(() => get(`/businesses/${id}/conversations/${convId}`), [id, convId]);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return (
    <Page title={data.conversation.name ?? "Conversation"} actions={<Link to={`/b/${id}/inbox`}>Back to inbox</Link>}>
      <div className="thread">
        {data.messages.map((m: any) => (
          <div key={m.id} className={`bubble ${m.direction}`}>
            <div className="muted small">{m.direction === "in" ? (m.from_name ?? "Customer") : "Sent"} · {m.channel.replace("_", " ")} · {when(m.received_at)}</div>
            {m.subject && <strong>{m.subject}</strong>}
            <p>{m.body ?? <em className="muted">Removed</em>}</p>
          </div>
        ))}
      </div>
      <Quote conv={data.conversation} bizId={id} onChange={reload} />
      {data.drafts.map((d: any) => <Draft key={d.id} draft={d} bizId={id} onChange={reload} />)}
    </Page>
  );
}

function Quote({ conv, bizId, onChange }: { conv: any; bizId: string; onChange: () => void }) {
  const { busy, error, run } = useAction();
  const set = (sent: boolean) => run(async () => { await post(`/businesses/${bizId}/conversations/${conv.id}/quote`, { sent }); onChange(); });
  return (
    <Card title="Quote">
      {conv.quoted_at
        ? <p className="muted">Marked as sent {when(conv.quoted_at)}.{conv.chased_at ? " A follow-up has been drafted." : " If they go quiet, a follow-up will be drafted for you to approve (when \"Chase quotes\" is on)."}</p>
        : <p className="muted">Sent this customer a quote? Mark it and the assistant can nudge them if they go quiet.</p>}
      <ErrorNote message={error} />
      <div className="buttons">
        {conv.quoted_at
          ? <button disabled={busy} onClick={() => set(false)}>Not sent after all</button>
          : <button disabled={busy} onClick={() => set(true)}>Mark quote as sent</button>}
      </div>
    </Card>
  );
}

function Draft({ draft, bizId, onChange }: { draft: any; bizId: string; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.body);
  const { busy, error, run } = useAction();
  const pending = draft.status === "pending_approval";
  const act = (verb: string, body?: unknown) => run(async () => { await post(`/businesses/${bizId}/drafts/${draft.id}/${verb}`, body); setEditing(false); onChange(); });
  return (
    <Card title={`${draft.kind === "chase" ? "Quote follow-up" : "Reply"} by ${ROUTE[draft.reply_route] ?? draft.reply_route}`}>
      <div className="row-meta"><Status value={draft.status} />{draft.edited && <span className="pill muted">edited</span>}<span className="muted">{when(draft.created_at)}</span></div>
      {draft.needs_attention && <p className="note error">{draft.attention_reason}</p>}
      {editing ? <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} aria-label="Reply wording" /> : <p className="draft-body">{draft.body}</p>}
      <ErrorNote message={error} />
      {pending && (
        <div className="buttons">
          {editing ? (<>
            <button className="primary" disabled={busy || !text.trim()} onClick={() => act("edit", { body: text })}>Send my version</button>
            <button disabled={busy} onClick={() => { setEditing(false); setText(draft.body); }}>Cancel</button>
          </>) : (<>
            <button className="primary" disabled={busy} onClick={() => act("approve")}>Approve and send</button>
            <button disabled={busy} onClick={() => setEditing(true)}>Edit</button>
            <button className="danger" disabled={busy} onClick={() => act("reject")}>Reject</button>
          </>)}
        </div>
      )}
      {draft.status === "manual" && <p className="muted">This one needs you to send it yourself.</p>}
    </Card>
  );
}
