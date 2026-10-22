"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const nav = [
  { href: "/dashboard", label: "Overview", icon: "◈" },
  { href: "/dashboard/leads", label: "Leads", icon: "◎", count: "1,284" },
  { href: "/dashboard/follow-ups", label: "Follow-ups", icon: "↗", count: "7" },
  { href: "/dashboard/automations", label: "Automations", icon: "⌁" },
];

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/dashboard" className="brand"><span className="brand-mark">L</span><span>lead<span>forge</span></span></Link>
        <div className="workspace-switcher"><span className="workspace-avatar">HB</span><span><b>Harbor & Brick</b><small>Agency workspace</small></span><span className="chevron">⌄</span></div>
        <p className="nav-label">Workspace</p>
        <nav className="side-nav">{nav.map((item) => <Link key={item.href} href={item.href} className={pathname === item.href ? "active" : ""}><span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.count && <em>{item.count}</em>}</Link>)}</nav>
        <p className="nav-label">Manage</p>
        <nav className="side-nav"><Link href="/dashboard/settings" className={pathname === "/dashboard/settings" ? "active" : ""}><span className="nav-icon">◌</span><span>Settings</span></Link><Link href="/dashboard/settings"><span className="nav-icon">?</span><span>Help centre</span></Link></nav>
        <div className="sidebar-bottom"><div className="plan-card"><div className="plan-top"><span>Current plan</span><strong>Starter</strong></div><div className="plan-meter"><span /></div><small>1,284 of 2,000 leads</small><button>Manage plan <span>→</span></button></div><div className="user-row"><span className="user-avatar">TO</span><span><b>Tobi Okafor</b><small>Owner</small></span><span className="more">•••</span></div></div>
      </aside>
      <main className="main-content"><header className="topbar"><div className="mobile-brand"><span className="brand-mark">L</span> leadforge</div><div className="breadcrumbs"><span>Workspace</span><b>/</b><strong>{pathname === "/dashboard" ? "Overview" : pathname.split("/").pop()?.replace("-", " ")}</strong></div><div className="top-actions"><span className="demo-pill"><i /> Demo data</span><button className="icon-button" aria-label="Notifications">♧<i className="notification-dot" /></button><span className="top-avatar">TO</span></div></header><div className="page-content">{children}</div></main>
    </div>
  );
}

export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "green" | "amber" | "purple" | "blue" | "neutral" }) { return <span className={`status-pill ${tone}`}>{children}</span>; }
export function ScoreBadge({ score }: { score: number }) { return <span className={`score-badge ${score >= 80 ? "hot" : score >= 60 ? "warm" : "cool"}`}>{score}</span>; }
