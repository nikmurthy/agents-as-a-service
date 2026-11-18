import { get } from "../api";
import { Card, ErrorNote, Loading, Page, useLoad, when } from "../ui";

export function Agents() {
  const { data, error } = useLoad(() => get("/agents"), []);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return (
    <Page title="Agents">
      <Card title="Published versions">
        <table>
          <thead><tr><th>Agent</th><th>Version</th><th>Model</th><th>Published</th></tr></thead>
          <tbody>{data.versions.map((v: any) => <tr key={`${v.agent_key}${v.version}`}><td>{v.agent_key}</td><td>{v.version}</td><td>{v.model}</td><td>{when(v.created_at)}</td></tr>)}</tbody>
        </table>
        <p className="muted small">New versions are published from the repository with <code>npm run agents:sync</code>.</p>
      </Card>
      <Card title="Businesses on pinned versions">
        {data.pinned.filter((t: any) => t.pinned).length === 0 ? <p className="muted">Every business is on the latest version.</p> : (
          <table><thead><tr><th>Business</th><th>Pinned</th></tr></thead>
            <tbody>{data.pinned.filter((t: any) => t.pinned).map((t: any) => <tr key={t.id}><td>{t.name}</td><td>{JSON.stringify(t.pinned)}</td></tr>)}</tbody></table>
        )}
      </Card>
    </Page>
  );
}
