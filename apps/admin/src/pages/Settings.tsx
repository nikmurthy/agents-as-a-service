import { useState, type FormEvent } from "react";
import { get, put } from "../api";
import { useBiz } from "../ctx";
import { Card, ErrorNote, Field, Loading, Page, useAction, useLoad } from "../ui";

const KNOWN = ["tone", "signOff", "timezone", "services", "priceGuide", "replyGuidance", "replyVia", "workingHours", "serviceArea", "escalationName",
  "spotCheckEvery", "reviewerPassScore", "checkatradeSenders", "retentionDays"];
const CHANNELS: [string, string][] = [["email", "Email enquiries"], ["whatsapp", "WhatsApp enquiries"], ["web_form", "Website form"], ["checkatrade", "Checkatrade"]];
const ROUTES: [string, string][] = [["whatsapp", "WhatsApp"], ["email", "Email"], ["checkatrade_message", "Checkatrade message"], ["sms", "Text"], ["phone", "Phone call"]];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function Settings() {
  const { id, canManage } = useBiz();
  const { data, error } = useLoad(() => get(`/businesses/${id}/settings`), [id]);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return <Form id={id} initial={data} canEdit={canManage} />;
}

function Form({ id, initial, canEdit }: { id: string; initial: any; canEdit: boolean }) {
  const [name, setName] = useState<string>(initial.name);
  const [s, setS] = useState<any>(() => structuredClone(initial.settings));
  const { busy, error, field, done, run } = useAction();
  const set = (k: string, v: unknown) => setS({ ...s, [k]: v });
  const num = (v: string) => (v === "" ? NaN : Number(v));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const settings = Object.fromEntries(Object.entries(s).filter(([k, v]) => KNOWN.includes(k) && v !== undefined));
    run(() => put(`/businesses/${id}/settings`, { name, settings }), "Saved.");
  };
  const wh = s.workingHours ?? { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };

  return (
    <Page title="Settings">
      {!canEdit && <p className="note">You can look at these settings. Only owners can change them.</p>}
      <form onSubmit={submit}>
        <fieldset disabled={!canEdit || busy}>
          <Card title="Business">
            <Field label="Business name"><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
            <Field label="Timezone" hint="For example Europe/London"><input value={s.timezone ?? ""} onChange={(e) => set("timezone", e.target.value)} /></Field>
            <Field label="Who gets flagged problems" hint="The name used when a reply needs a person's attention."><input value={s.escalationName ?? ""} onChange={(e) => set("escalationName", e.target.value)} /></Field>
          </Card>

          <Card title="How replies sound">
            <Field label="Tone of voice"><textarea rows={3} value={s.tone ?? ""} onChange={(e) => set("tone", e.target.value)} /></Field>
            <Field label="Sign-off"><input value={s.signOff ?? ""} onChange={(e) => set("signOff", e.target.value)} /></Field>
            <Field label="Anything else the assistant should know when replying" hint="Optional. Rules, policies, things never to say."><textarea rows={4} value={s.replyGuidance ?? ""} onChange={(e) => set("replyGuidance", e.target.value || undefined)} /></Field>
          </Card>

          <Card title="Working hours">
            <div className="days" role="group" aria-label="Working days">
              {DAYS.map((d, i) => (
                <label key={d} className="check"><input type="checkbox" checked={wh.days.includes(i + 1)}
                  onChange={(e) => set("workingHours", { ...wh, days: e.target.checked ? [...wh.days, i + 1].sort() : wh.days.filter((x: number) => x !== i + 1) })} />{d}</label>
              ))}
            </div>
            <div className="grid two">
              <Field label="Start"><input type="time" value={wh.start} onChange={(e) => set("workingHours", { ...wh, start: e.target.value })} /></Field>
              <Field label="End"><input type="time" value={wh.end} onChange={(e) => set("workingHours", { ...wh, end: e.target.value })} /></Field>
            </div>
            <Field label="Areas you cover" hint="Postcode starts separated by commas, e.g. SW1, SW2, KT1. Leave empty for anywhere.">
              <input value={(s.serviceArea ?? []).join(", ")} onChange={(e) => set("serviceArea", e.target.value.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean))} />
            </Field>
          </Card>

          <Card title="Services">
            {(s.services ?? []).map((sv: any, i: number) => (
              <div key={i} className="grid three">
                <Field label="Name"><input value={sv.name} onChange={(e) => set("services", s.services.map((x: any, j: number) => (j === i ? { ...x, name: e.target.value } : x)))} /></Field>
                <Field label="Minutes"><input type="number" min={5} value={sv.durationMinutes} onChange={(e) => set("services", s.services.map((x: any, j: number) => (j === i ? { ...x, durationMinutes: num(e.target.value) } : x)))} /></Field>
                <Field label="Price (optional)"><input value={sv.price ?? ""} onChange={(e) => set("services", s.services.map((x: any, j: number) => (j === i ? { ...x, price: e.target.value || undefined } : x)))} /></Field>
                <button type="button" onClick={() => set("services", s.services.filter((_: any, j: number) => j !== i))}>Remove</button>
              </div>
            ))}
            <button type="button" onClick={() => set("services", [...(s.services ?? []), { name: "", durationMinutes: 60 }])}>Add a service</button>
          </Card>

          <Card title="Price guide">
            <p className="muted">Rough prices the assistant may quote.</p>
            {(s.priceGuide ?? []).map((p: any, i: number) => (
              <div key={i} className="grid three">
                <Field label="Item"><input value={p.item} onChange={(e) => set("priceGuide", s.priceGuide.map((x: any, j: number) => (j === i ? { ...x, item: e.target.value } : x)))} /></Field>
                <Field label="Range"><input value={p.range} onChange={(e) => set("priceGuide", s.priceGuide.map((x: any, j: number) => (j === i ? { ...x, range: e.target.value } : x)))} /></Field>
                <button type="button" onClick={() => set("priceGuide", s.priceGuide.filter((_: any, j: number) => j !== i))}>Remove</button>
              </div>
            ))}
            <button type="button" onClick={() => set("priceGuide", [...(s.priceGuide ?? []), { item: "", range: "" }])}>Add a price</button>
          </Card>

          <Card title="How replies are sent">
            <p className="muted">Pick the first choice for each kind of enquiry, then a fallback if it isn't possible.</p>
            {CHANNELS.map(([ch, label]) => {
              const routes: string[] = s.replyVia?.[ch] ?? [];
              const pick = (idx: number, v: string) => {
                const next = [...routes]; if (v) next[idx] = v; else next.splice(idx, 1);
                set("replyVia", { ...s.replyVia, [ch]: next.filter(Boolean) });
              };
              return (
                <div key={ch} className="grid two">
                  <Field label={`${label}: first choice`}><RouteSelect value={routes[0]} onChange={(v) => pick(0, v)} required /></Field>
                  <Field label="Fallback"><RouteSelect value={routes[1]} onChange={(v) => pick(1, v)} disabled={!routes[0]} /></Field>
                </div>
              );
            })}
          </Card>

          <Card title="Checks and data">
            <Field label="Check every Nth reply closely" hint="1 means every reply gets the extra check.">
              <input type="number" min={1} value={s.spotCheckEvery ?? ""} onChange={(e) => set("spotCheckEvery", num(e.target.value))} /></Field>
            <Field label="Quality bar (1 to 5)">
              <input type="number" min={1} max={5} step={0.1} value={s.reviewerPassScore ?? ""} onChange={(e) => set("reviewerPassScore", num(e.target.value))} /></Field>
            <Field label="Keep customer messages for (days)" hint="After this, message text is removed.">
              <input type="number" min={7} value={s.retentionDays ?? ""} onChange={(e) => set("retentionDays", e.target.value === "" ? undefined : num(e.target.value))} /></Field>
            <Field label="Checkatrade sender addresses" hint="One per line. Emails from these addresses are treated as Checkatrade leads.">
              <textarea rows={3} value={(s.checkatradeSenders ?? []).join("\n")} onChange={(e) => set("checkatradeSenders", e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))} /></Field>
          </Card>
        </fieldset>
        <ErrorNote message={error ? `${error}${field ? ` (${field})` : ""}` : undefined} />
        {done && <p className="note good" role="status">{done}</p>}
        {canEdit && <div className="sticky"><button className="primary" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button></div>}
      </form>
    </Page>
  );
}

function RouteSelect({ value, onChange, disabled, required }: { value?: string; onChange: (v: string) => void; disabled?: boolean; required?: boolean }) {
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value)} disabled={disabled} required={required}>
      {!required && <option value="">None</option>}
      {required && !value && <option value="">Choose…</option>}
      {ROUTES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}
