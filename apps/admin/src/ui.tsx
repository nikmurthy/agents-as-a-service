import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "./api";

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const run = useCallback(() => {
    setLoading(true);
    load().then((d) => { setData(d); setError(undefined); }).catch((e) => setError(e.message)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  return { data, error, loading, reload: run };
}

export function Page({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section>
      <div className="page-head"><h1>{title}</h1>{actions}</div>
      {children}
    </section>
  );
}

export const Loading = () => <p className="muted">Loading…</p>;
export const ErrorNote = ({ message }: { message?: string }) => (message ? <p className="note error" role="alert">{message}</p> : null);
export const Empty = ({ children }: { children: ReactNode }) => <p className="muted empty">{children}</p>;

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return <div className="card">{title && <h2>{title}</h2>}{children}</div>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
      {error && <span className="note error">{error}</span>}
    </label>
  );
}

/** Runs an action, showing a busy state and any error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [field, setField] = useState<string>();
  const [done, setDone] = useState<string>();
  async function run<T>(fn: () => Promise<T>, okMessage?: string): Promise<T | undefined> {
    setBusy(true); setError(undefined); setField(undefined); setDone(undefined);
    try {
      const r = await fn();
      if (okMessage) setDone(okMessage);
      return r;
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError) setField(e.field);
    } finally { setBusy(false); }
  }
  return { busy, error, field, done, run };
}

export function Status({ value }: { value: string }) {
  const tone = { active: "good", sent: "good", confirmed: "good", done: "good", paused: "warn", pending_approval: "warn", held: "warn", onboarding: "warn", running: "warn",
    failed: "bad", error: "bad", closed: "muted", rejected: "muted", cancelled: "muted", released: "muted", expired: "muted", disconnected: "muted" }[value] ?? "muted";
  return <span className={`pill ${tone}`}>{value.replace(/_/g, " ")}</span>;
}

export const when = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
