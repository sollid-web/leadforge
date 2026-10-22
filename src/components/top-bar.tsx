import Link from "next/link";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview", icon: "🏠" },
  { href: "/dashboard/leads", label: "Leads", icon: "📋" },
  { href: "/dashboard/automations", label: "Automations", icon: "⚙️" },
  { href: "/dashboard/follow-ups", label: "Follow-ups", icon: "📬" },
  { href: "/dashboard/settings", label: "Settings", icon: "⚙️" },
];

export function TopBar({
  className,
}: {
  className?: string;
}) {
  return (
    <header
      className={`border-b border-gray-200 dark:border-gray-800 flex items-center h-16 px-6 ${className}`}
    >
      <nav className="flex-1 flex items-center gap-4">
        <Link
          href="/dashboard"
          className={`flex items-center gap-2 text-sm font-medium transition-colors hover:text-indigo-600 dark:hover:text-indigo-400`}
        >
          <span>LeadForge</span>
        </Link>
      </nav>
      <div className="flex items-center gap-3">
        {NAV_ITEMS.map((item) => {
          const active = item.href === "/dashboard";
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex h-10 w-10 items-center justify-center rounded-full border border-solid border-gray-200/50 ${
                active
                  ? "bg-indigo-600/10 text-indigo-600"
                  : "text-gray-400 hover:bg-gray-100/50 dark:text-gray-500 dark:hover:bg-gray-800/50"
              }`}
            >
              <span>{item.icon}</span>
            </Link>
          );
        })}
      </div>
    </header>
  );
}