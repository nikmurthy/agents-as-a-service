import { useState, type FormEvent } from "react";
import { Navigate, NavLink, Outlet, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "./auth";
import { get } from "./api";
import { ErrorNote, Loading, useAction, useLoad } from "./ui";
import { Businesses } from "./pages/Businesses";
import { Overview } from "./pages/Overview";
import { Inbox, Conversation } from "./pages/Inbox";
import { Settings } from "./pages/Settings";
import { UseCases } from "./pages/UseCases";
import { Connections } from "./pages/Connections";
import { People } from "./pages/People";
import { Bookings } from "./pages/Bookings";
import { Activity, RunDetail } from "./pages/Activity";
import { DataRequests } from "./pages/DataRequests";
import { Agents } from "./pages/Agents";

export interface Me {
  email: string;
  isAdmin: boolean;
  adminNeedsTwoFactor: boolean;
  businesses: { id: string; name: string; slug: string; status: string; role: "owner" | "staff" | "admin" }[];
}

export function App() {
  const auth = useAuth();
  if (!auth.ready) return <div className="centre"><Loading /></div>;
  if (auth.error) return <div className="centre"><ErrorNote message={auth.error} /></div>;
  if (!auth.signedIn) return <SignIn />;
  return <Signed />;
}

function SignIn() {
  const auth = useAuth();
  const { busy, error, run } = useAction();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); run(() => auth.signIn(email, password)); };
  return (
    <div className="centre">
      <form className="card narrow" onSubmit={submit}>
        <h1>Sign in</h1>
        <label className="field"><span className="label">Email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field"><span className="label">Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <ErrorNote message={error} />
        <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}

function Signed() {
  const auth = useAuth();
  const { data: me, error, reload } = useLoad<Me>(() => get("/me"), []);
  if (error) return <div className="centre"><ErrorNote message={error} /><button onClick={auth.signOut}>Sign out</button></div>;
  if (!me) return <div className="centre"><Loading /></div>;
  if (me.adminNeedsTwoFactor) return <TwoFactor onDone={async () => { await auth.refresh(); reload(); }} />;
  if (!me.isAdmin && !me.businesses.length) {
    return (
      <div className="centre"><div className="card narrow">
        <h1>No business yet</h1>
        <p>{me.email} isn't linked to a business. Ask whoever set up your account to add this email address.</p>
        <button onClick={auth.signOut}>Sign out</button>
      </div></div>
    );
  }
  return (
    <Routes>
      <Route element={<Shell me={me} />}>
        <Route index element={<Home me={me} />} />
        <Route path="agents" element={<Agents />} />
        <Route path="b/:id" element={<BusinessFrame me={me} />}>
          <Route index element={<Overview />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="inbox/:convId" element={<Conversation />} />
          <Route path="settings" element={<Settings />} />
          <Route path="use-cases" element={<UseCases />} />
          <Route path="connections" element={<Connections />} />
          <Route path="people" element={<People />} />
          <Route path="bookings" element={<Bookings />} />
          <Route path="activity" element={<Activity />} />
          <Route path="activity/:runId" element={<RunDetail />} />
          <Route path="data" element={<DataRequests />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function Home({ me }: { me: Me }) {
  if (!me.isAdmin && me.businesses.length === 1) return <Navigate to={`/b/${me.businesses[0].id}`} replace />;
  return <Businesses me={me} />;
}

function Shell({ me }: { me: Me }) {
  const auth = useAuth();
  return (
    <div className="shell">
      <header className="top">
        <NavLink to="/" className="brand">Admin</NavLink>
        {me.isAdmin && <NavLink to="/agents">Agents</NavLink>}
        <span className="spacer" />
        <span className="muted who">{me.email}</span>
        <button onClick={auth.signOut}>Sign out</button>
      </header>
      <main><Outlet /></main>
    </div>
  );
}

function BusinessFrame({ me }: { me: Me }) {
  const { id } = useParams();
  const { data, error } = useLoad(() => get(`/businesses/${id}`), [id]);
  const mine = me.businesses.find((b) => b.id === id);
  const canManage = me.isAdmin || mine?.role === "owner";
  const tabs: [string, string][] = [
    ["", "Overview"], ["inbox", "Inbox"], ["bookings", "Bookings"], ["activity", "Activity"], ["settings", "Settings"],
    ["use-cases", "Use cases"], ["connections", "Connections"], ["people", "People"], ...(canManage ? [["data", "Data requests"] as [string, string]] : []),
  ];
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return (
    <>
      <div className="biz-head">
        <h1>{data.business.name}</h1>
        <span className={`pill ${data.business.status === "active" ? "good" : "warn"}`}>{data.business.status}</span>
      </div>
      <nav className="tabs" aria-label="Business sections">
        {tabs.map(([to, label]) => <NavLink key={to} end={to === ""} to={`/b/${id}${to ? "/" + to : ""}`}>{label}</NavLink>)}
      </nav>
      <Outlet context={{ id: id!, business: data.business, canManage, isAdmin: me.isAdmin }} />
    </>
  );
}

function TwoFactor({ onDone }: { onDone: () => void }) {
  const auth = useAuth();
  const nav = useNavigate();
  const { busy, error, run } = useAction();
  const [code, setCode] = useState("");
  const [enrol, setEnrol] = useState<{ id: string; qr: string; secret: string }>();
  const { data: factors } = useLoad(() => auth.factors(), []);
  const verified = factors?.find((f) => f.status === "verified");
  if (!factors) return <div className="centre"><Loading /></div>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => { await auth.verifyFactor((verified?.id ?? enrol!.id), code); nav("/"); onDone(); });
  };
  return (
    <div className="centre">
      <form className="card narrow" onSubmit={submit}>
        <h1>Two-factor check</h1>
        <p>Platform admin accounts need a code from your authenticator app.</p>
        {!verified && !enrol && <button type="button" className="primary" onClick={() => run(async () => setEnrol(await auth.enrolFactor()))}>Set up authenticator</button>}
        {enrol && (<>
          <img src={enrol.qr} alt="QR code to scan with your authenticator app" width={180} height={180} />
          <p className="hint">Or type this key in: <code>{enrol.secret}</code></p>
        </>)}
        {(verified || enrol) && (<>
          <label className="field"><span className="label">6-digit code</span>
            <input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <button className="primary" disabled={busy}>Confirm</button>
        </>)}
        <ErrorNote message={error} />
        <button type="button" onClick={auth.signOut}>Sign out</button>
      </form>
    </div>
  );
}
