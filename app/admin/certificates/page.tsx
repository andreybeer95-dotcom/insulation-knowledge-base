"use client";

import { useEffect, useState } from "react";

export const dynamic = "force-dynamic";

const statusClass: Record<string, string> = {
  active: "bg-green-100",
  expiring_soon: "bg-yellow-100",
  expired: "bg-red-100"
};

export default function CertificatesPage() {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => {
    fetch("/api/certificates").then((r) => r.json()).then((d) => setItems(d.items ?? []));
  }, []);

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Сертификаты</h1>
      <table className="min-w-full text-sm">
        <thead><tr className="bg-slate-100"><th className="p-2 text-left">Тип</th><th className="p-2 text-left">Номер</th><th className="p-2">Действует до</th><th className="p-2">Статус</th></tr></thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id} className={`border-b ${statusClass[c.status] ?? ""}`}>
              <td className="p-2">{c.cert_type}</td>
              <td className="p-2">{c.cert_number}</td>
              <td className="p-2 text-center">{c.valid_until ?? "-"}</td>
              <td className="p-2 text-center">{c.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
