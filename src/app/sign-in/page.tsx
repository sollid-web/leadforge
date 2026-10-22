"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const supabase = getSupabaseBrowserClient();
    if (!supabase) { setMessage("Demo mode is active. Configure Supabase to enable live sign-in."); return; }
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) { setMessage(error.message); return; }
    router.push("/dashboard");
  }

  return <main className="auth-page"><div className="auth-card"><Link href="/" className="brand auth-brand"><span className="brand-mark">L</span><span>lead<span>forge</span></span></Link><div className="auth-heading"><p className="eyebrow">Workspace access</p><h1>Welcome back</h1><p>Sign in to review your lead pipeline and approved follow-ups.</p></div><form onSubmit={submit} className="auth-form"><label>Email address<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="you@agency.com" /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required placeholder="••••••••" /></label><div className="auth-row"><label className="checkbox-label"><input type="checkbox" /> Remember me</label><Link href="/reset-password">Forgot password?</Link></div>{message && <p className="auth-message">{message}</p>}<button className="primary-button auth-submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button></form><p className="auth-footer">New to LeadForge? <Link href="/sign-up">Create an account</Link></p></div></main>;
}
