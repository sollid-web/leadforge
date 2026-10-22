"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function SignUpPage() {
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setMessage(""); const supabase = getSupabaseBrowserClient(); if (!supabase) { setMessage("Demo mode is active. Configure Supabase to enable account creation."); return; } setBusy(true); const { error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: name } } }); setBusy(false); setMessage(error ? error.message : "Account created. Check your email for a confirmation link."); }
  return <main className="auth-page"><div className="auth-card"><Link href="/" className="brand auth-brand"><span className="brand-mark">L</span><span>lead<span>forge</span></span></Link><div className="auth-heading"><p className="eyebrow">Start your workspace</p><h1>Create your account</h1><p>Bring your sources, scoring rules, and human-approved outreach into one place.</p></div><form onSubmit={submit} className="auth-form"><label>Your name<input value={name} onChange={(event) => setName(event.target.value)} required placeholder="Tobi Okafor" /></label><label>Work email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required placeholder="you@agency.com" /></label><label>Password<input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required placeholder="At least 8 characters" /></label>{message && <p className="auth-message">{message}</p>}<button className="primary-button auth-submit" disabled={busy}>{busy ? "Creating…" : "Create workspace"}</button></form><p className="auth-footer">Already have an account? <Link href="/sign-in">Sign in</Link></p></div></main>;
}
