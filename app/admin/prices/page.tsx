"use client";

import { useEffect, useState } from "react";

export const dynamic = "force-dynamic";

export default function PricesPage() {
  const [prices, setPrices] = useState<any[]>([]);
  useEffect(() => {
    fetch("/api/prices").then((r) => r.json()).then((d) => setPrices(d.items ?? []));
  }, []);

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Цены</h1>
      <table className="min-w-full text-sm">
        <thead><tr className="bg-slate-100"><th className="p-2 text-left">Продукт</th><th className="p-2">Цена</th><th className="p-2">Поставщик</th><th className="p-2">Актуальность</th></tr></thead>
        <tbody>
          {prices.map((p) => (
            <tr key={p.id} className="border-b">
              <td className="p-2">{p.products?.name ?? p.product_id}</td>
              <td className="p-2 text-center">{p.price} {p.currency}/{p.unit}</td>
              <td className="p-2 text-center">{p.supplier ?? "-"}</td>
              <td className="p-2 text-center">{p.valid_until ? `до ${p.valid_until}` : "актуальна"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
