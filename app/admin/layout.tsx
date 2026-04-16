import Link from "next/link";
import type { Route } from "next";
import type { ReactNode } from "react";

const menu: Array<{ href: Route; label: string }> = [
  { href: "/admin/products", label: "Продукты" },
  { href: "/admin/manufacturers", label: "Производители" },
  { href: "/admin/documents", label: "Документы" },
  { href: "/admin/notes", label: "Заметки" },
  { href: "/admin/prices", label: "Цены" },
  { href: "/admin/certificates", label: "Сертификаты" },
  { href: "/admin/changelog", label: "История изменений" },
  { href: "/admin/rules", label: "Правила подбора" }
];

export const dynamic = "force-dynamic";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-100">
      <div className="mx-auto grid max-w-7xl grid-cols-[260px_1fr] gap-4 p-4">
        <aside className="rounded-xl bg-white p-4 shadow">
          <h2 className="mb-4 text-lg font-semibold">Admin</h2>
          <nav className="space-y-2">
            {menu.map((item) => (
              <Link key={item.href} href={item.href} className="block rounded-md px-3 py-2 text-sm hover:bg-slate-100">
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>
        <main className="rounded-xl bg-white p-5 shadow">{children}</main>
      </div>
    </div>
  );
}
