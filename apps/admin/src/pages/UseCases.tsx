import { get, put } from "../api";
import { useBiz } from "../ctx";
import { ErrorNote, Loading, Page, useAction, useLoad } from "../ui";

const INFO: Record<string, [string, string]> = {
  answer_enquiries: ["Answer enquiries", "Drafts replies to new messages for you to approve."],
  book_appointments: ["Book appointments", "Offers free times from your calendar and holds them while the customer decides."],
};

export function UseCases() {
  const { id, canManage } = useBiz();
  const { data, error, reload } = useLoad(() => get(`/businesses/${id}/use-cases`), [id]);
  const a = useAction();
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return (
    <Page title="What the assistant does">
      <ErrorNote message={a.error} />
      <div className="list">
        {data.useCases.map((u: any) => (
          <label key={u.key} className="row switch">
            <div><strong>{INFO[u.key]?.[0] ?? u.key}</strong><div className="muted">{INFO[u.key]?.[1]}</div></div>
            <input type="checkbox" role="switch" checked={u.enabled} disabled={!canManage || a.busy}
              onChange={(e) => a.run(async () => { await put(`/businesses/${id}/use-cases/${u.key}`, { enabled: e.target.checked }); reload(); })} />
          </label>
        ))}
      </div>
      {!canManage && <p className="note">Only owners can change this.</p>}
    </Page>
  );
}
