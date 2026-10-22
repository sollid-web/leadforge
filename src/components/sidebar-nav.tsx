import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Overview", icon: "🏠" },
  { href: "/dashboard/leads", label: "Leads", icon: "📋" },
  { href: "/dashboard/automations", label: "Automations", icon: "⚙️" },
  { href: "/dashboard/follow-ups", label: "Follow-ups", icon: "📬" },
  { href: "/dashboard/settings", label: "Settings", icon: "⚙️" },
];

export function SidebarNav({
  className,
}: {
  className?: string;
}) {
  const pathname = usePathname();

  return (
    <aside
      className={`border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex-shrink-0 h-screen ${className}`}
    >
      <nav className="p-4 space-y-1">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? "bg-indigo-600 text-white"
                  : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
              }`}
            >
              <span>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
