import { get, post } from "../api";
import { useBiz } from "../ctx";
import { Empty, ErrorNote, Loading, Page, Status, useAction, useLoad } from "../ui";

const fmt = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function Bookings() {
  const { id } = useBiz();
  const { data, error, reload } = useLoad(() => get(`/businesses/${id}/bookings`), [id]);
  const act = useAction();
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return (
    <Page title="Bookings">
      <p className="muted">"Held" times are offered to a customer and kept free for a while. Cancelling frees the time in your calendar.</p>
      <ErrorNote message={act.error} />
      {!data.bookings.length && <Empty>No bookings yet.</Empty>}
      <div className="list">
        {data.bookings.map((b: any) => (
          <div key={b.id} className="row">
            <div><strong>{b.customer ?? "Customer"}</strong>{b.service && ` · ${b.service}`}<div className="muted">{fmt(b.start_at)}</div></div>
            <div className="row-meta">
              <Status value={b.status} />
              {["held", "confirmed"].includes(b.status) && (
                <button className="danger" disabled={act.busy} onClick={() => confirm("Cancel this time?") && act.run(async () => { await post(`/businesses/${id}/bookings/${b.id}/cancel`); reload(); })}>Cancel</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </Page>
  );
}
