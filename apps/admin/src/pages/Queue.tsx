import { useState } from "react";
import { Link } from "react-router-dom";
import { get, post, put } from "../api";
import { useBiz } from "../ctx";
import { ErrorNote, useAction, useLoad, when } from "../ui";

// Replies waiting, one at a time (GOV.UK "one thing per page"): one reply, big, with what the customer said above it.
// Deciding moves straight on to the next. The ones that need a closer look come first.

const BY: Record<string, string> = { whatsapp: "WhatsApp", email: "email", checkatrade_message: "Checkatrade (you paste it)", sms: "text (you send it)", phone: "phone (you call)" };
const FROM: Record<string, string> = { whatsapp: "on WhatsApp", email: "by email", web_form: "on your website form", checkatrade: "on Checkatrade", sms: "by text" };
const KIND: Record<string, string> = { answer_question: "Answering a question", offer_times: "Offering times", confirm_booking: "Confirming a booking", quote_followup: "Quote follow-up", feedback_request: "Feedback request" };

export function ReplyQueue() {
  const { id, canManage } = useBiz();
  const { data, reload } = useLoad(() => get(`/businesses/${id}/waiting`), [id]);
  const [skip, setSkip] = useState<string[]>([]);
  const [done, setDone] = useState(0);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [note, setNote] = useState<{ text: string; offer?: string } | null>(null);
  const a = useAction();
  if (!data) return null;
  const list = data.waiting.filter((d: any) => !skip.includes(d.id));
  if (!data.waiting.length && !done) return null;

  if (!list.length) {
    return (
      <section className="queue empty-queue" aria-live="polite">
        <h2>All caught up</h2>
        <p className="muted">{done ? `You decided on ${done} ${done === 1 ? "reply" : "replies"}. Nothing else is waiting for you.` : "Nothing is waiting for you."}</p>
        {note && <Offer note={note} canManage={canManage} setNote={setNote} />}
      </section>
    );
  }
  const d = list[0];
  const total = list.length + done;
  const position = done + 1;
  const act = (verb: string, body?: unknown) => a.run(async () => {
    const r = await post(`/businesses/${id}/drafts/${d.id}/${verb}`, body);
    setNote(r?.automation ?? null); setEditing(false); setDone(done + 1); setSkip([...skip, d.id]);
  });
  const said = d.said ?? {};
  const closer = d.needs_attention || !d.review_pass;
  return (
    <section className="queue" aria-labelledby="queue-title">
      <div className="queue-head">
        <h2 id="queue-title">Replies waiting for you</h2>
        <span className="count" aria-label={`Reply ${position} of ${total}`}>{position} of {total}</span>
      </div>
      {note && <Offer note={note} canManage={canManage} setNote={setNote} />}
      <div className="said">
        <div className="muted small">{d.name ?? "Customer"} wrote {FROM[said.channel] ?? ""}{said.at ? `, ${when(said.at)}` : ""}</div>
        {said.subject && <strong>{said.subject}</strong>}
        <p>{said.body ?? <em className="muted">Message text no longer kept</em>}</p>
      </div>
      <div className={`ours ${closer ? "closer" : ""}`}>
        <div className="ours-head">
          <span className="muted small">Our reply, by {BY[d.reply_route] ?? d.reply_route}</span>
          {d.category && <span className="pill">{KIND[d.category]}</span>}
          {d.held > 0 && <span className="pill">{d.held} {d.held === 1 ? "time" : "times"} pencilled in</span>}
          {closer ? <span className="pill bad">Have a closer look</span> : <span className="pill good">Looks good</span>}
        </div>
        {closer && d.attention_reason && <p className="note error">{d.attention_reason}</p>}
        {!closer && d.attention_reason && <p className="note">🔎 {d.attention_reason}</p>}
        {editing
          ? <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} aria-label="Your version of the reply" />
          : <p className="draft-body">{d.body}</p>}
      </div>
      <ErrorNote message={a.error} />
      <div className="dock">
        {editing ? (<>
          <button className="primary" disabled={a.busy || !text.trim()} onClick={() => act("edit", { body: text })}>Send my version</button>
          <button disabled={a.busy} onClick={() => setEditing(false)}>Cancel</button>
        </>) : (<>
          <button className="primary" disabled={a.busy} onClick={() => act("approve")}>{d.lead_pending ? "Interested" : "Approve"}</button>
          <button disabled={a.busy} onClick={() => { setText(d.body); setEditing(true); }}>Edit</button>
          <button className="danger" disabled={a.busy} onClick={() => act("reject")}>{d.lead_pending ? "Not for me" : "Reject"}</button>
        </>)}
      </div>
      <div className="queue-foot">
        <Link to={`/b/${id}/inbox/${d.conversation_id}`}>See the whole conversation</Link>
        {list.length > 1 && <button className="link" onClick={() => { setSkip([...skip, d.id]); setNote(null); }}>Skip for now</button>}
        <button className="link" onClick={() => { setSkip([]); setDone(0); setNote(null); reload(); }}>Refresh</button>
      </div>
    </section>
  );
}

function Offer({ note, canManage, setNote }: { note: { text: string; offer?: string }; canManage: boolean; setNote: (n: { text: string; offer?: string } | null) => void }) {
  const { id } = useBiz();
  const a = useAction();
  const answer = (on: boolean) => a.run(async () => { const r = await put(`/businesses/${id}/automations/${note.offer}`, { on }); setNote({ text: r.message }); });
  return (
    <div className={`note ${note.offer ? "" : "good"}`} role="status">
      <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{note.text}</p>
      {note.offer && (canManage ? (
        <div className="buttons">
          <button className="primary" disabled={a.busy} onClick={() => answer(true)}>Yes, automate</button>
          <button disabled={a.busy} onClick={() => answer(false)}>Keep asking me</button>
        </div>
      ) : <p className="small">The business owner can switch this on in Flows.</p>)}
      <ErrorNote message={a.error} />
    </div>
  );
}
