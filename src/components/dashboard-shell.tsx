"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

const nav = [
  { href: "/dashboard", label: "Overview", icon: "◈" },
  { href: "/dashboard/prospects", label: "Business prospects", icon: "⌕" },
  { href: "/dashboard/leads", label: "Opportunities", icon: "◎" },
  { href: "/dashboard/follow-ups", label: "Interest review", icon: "↗" },
  { href: "/dashboard/automations", label: "Automations", icon: "⌁" },
];

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [supabaseConfigured, setSupabaseConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/setup-status").then(async (response) => {
      if (!response.ok) throw new Error("Unable to load setup status");
      const body = await response.json();
      setSupabaseConfigured(Boolean(body.integrations?.supabase));
    }).catch(() => setSupabaseConfigured(false));
  }, []);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/dashboard" className="brand"><span className="brand-mark">L</span><span>lead<span>forge</span></span></Link>
        <div className="workspace-switcher"><span className="workspace-avatar">LF</span><span><b>Organization workspace</b><small>Real estate operations</small></span><span className="chevron">⌄</span></div>
        <p className="nav-label">Workspace</p>
        <nav className="side-nav">{nav.map((item) => <Link key={item.href} href={item.href} className={pathname === item.href ? "active" : ""}><span className="nav-icon">{item.icon}</span><span>{item.label}</span></Link>)}</nav>
        <p className="nav-label">Manage</p>
        <nav className="side-nav"><Link href="/dashboard/settings" className={pathname === "/dashboard/settings" ? "active" : ""}><span className="nav-icon">◌</span><span>Settings</span></Link><Link href="/dashboard/settings"><span className="nav-icon">?</span><span>Help centre</span></Link></nav>
        <div className="sidebar-bottom"><div className="plan-card"><div className="plan-top"><span>Workspace status</span><strong>{supabaseConfigured === null ? "Checking" : supabaseConfigured ? "Connected" : "Setup needed"}</strong></div><p>Connect Supabase to store listings, agent profiles, and approval records.</p><Link href="/dashboard/settings">View setup <span>→</span></Link></div><div className="user-row"><span className="user-avatar">U</span><span><b>Signed-in user</b><small>Organization member</small></span></div></div>
      </aside>
      <main className="main-content"><header className="topbar"><div className="mobile-brand"><span className="brand-mark">L</span> leadforge</div><div className="breadcrumbs"><span>Workspace</span><b>/</b><strong>{pathname === "/dashboard" ? "Overview" : pathname.split("/").pop()?.replace("-", " ")}</strong></div><div className="top-actions"><span className={`demo-pill ${supabaseConfigured ? "connected" : ""}`}><i />{supabaseConfigured === null ? "Checking setup" : supabaseConfigured ? "Supabase configured" : "Setup required"}</span><Link className="icon-button" href="/dashboard/follow-ups" aria-label="Interest review">♧</Link><span className="top-avatar">U</span></div></header><div className="page-content">{children}</div></main>
    </div>
  );
}

export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "green" | "amber" | "purple" | "blue" | "neutral" }) { return <span className={`status-pill ${tone}`}>{children}</span>; }
export function ScoreBadge({ score }: { score: number }) { return <span className={`score-badge ${score >= 80 ? "hot" : score >= 60 ? "warm" : "cool"}`}>{score}</span>; }
