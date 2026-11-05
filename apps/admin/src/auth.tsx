import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

async function getClient(): Promise<SupabaseClient> {
  if (client) return client;
  const res = await fetch("/admin/config.json");
  const cfg = await res.json();
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) throw new Error("Sign-in isn't set up on this server yet.");
  client = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true } });
  return client;
}

export async function getAccessToken(): Promise<string | undefined> {
  const { data } = await (await getClient()).auth.getSession();
  return data.session?.access_token;
}

interface AuthState {
  ready: boolean;
  signedIn: boolean;
  error?: string;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** Two-factor (TOTP) */
  enrolFactor(): Promise<{ id: string; qr: string; secret: string }>;
  verifyFactor(factorId: string, code: string): Promise<void>;
  factors(): Promise<{ id: string; status: string }[]>;
  refresh(): Promise<void>;
}

const Ctx = createContext<AuthState>(null as never);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let unsubscribe = () => {};
    getClient().then(async (c) => {
      const { data } = await c.auth.getSession();
      setSignedIn(!!data.session);
      setReady(true);
      unsubscribe = c.auth.onAuthStateChange((_e, s) => setSignedIn(!!s)).data.subscription.unsubscribe;
    }).catch((e) => { setError(e.message); setReady(true); });
    return () => unsubscribe();
  }, []);

  const value: AuthState = {
    ready, signedIn, error,
    async signIn(email, password) {
      const { error } = await (await getClient()).auth.signInWithPassword({ email, password });
      if (error) throw new Error("That email and password don't match.");
    },
    async signOut() { await (await getClient()).auth.signOut(); },
    async enrolFactor() {
      const c = await getClient();
      const { data, error } = await c.auth.mfa.enroll({ factorType: "totp" });
      if (error) throw new Error(error.message);
      return { id: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
    },
    async verifyFactor(factorId, code) {
      const c = await getClient();
      const ch = await c.auth.mfa.challenge({ factorId });
      if (ch.error) throw new Error(ch.error.message);
      const v = await c.auth.mfa.verify({ factorId, challengeId: ch.data.id, code: code.trim() });
      if (v.error) throw new Error("That code isn't right. Try the latest one.");
    },
    async factors() {
      const { data } = await (await getClient()).auth.mfa.listFactors();
      return (data?.totp ?? []).map((f) => ({ id: f.id, status: f.status }));
    },
    async refresh() { await (await getClient()).auth.refreshSession(); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
