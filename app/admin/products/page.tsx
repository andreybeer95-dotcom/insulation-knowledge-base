"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

export const dynamic = "force-dynamic";

export default function AdminProductsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [manufacturers, setManufacturers] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [manufacturer, setManufacturer] = useState("");
  const [flammability, setFlammability] = useState("");
  const [coating, setCoating] = useState("");

  const load = async () => {
    const q = new URLSearchParams();
    if (search) q.set("search", search);
    if (manufacturer) q.set("manufacturer_id", manufacturer);
    if (flammability) q.set("flammability", flammability);
    if (coating) q.set("coating", coating);
    const res = await fetch(`/api/products?${q.toString()}`);
    const data = await res.json();
    setItems(data.items ?? []);
  };

  useEffect(() => {
    load();
    fetch("/api/manufacturers").then((r) => r.json()).then((d) => setManufacturers(d.items ?? []));
  }, []);

  const rows = useMemo(() => items, [items]);

  const remove = async (id: string) => {
    if (!confirm("Удалить продукт?")) return;
    const res = await fetch(`/api/products/${id}`, { method: "DELETE" });
    if (res.ok) load();
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold">Продукты</h1>
        <Link href="/admin/products/new" className="rounded bg-slate-900 px-4 py-2 text-white">Добавить</Link>
      </div>
      <div className="mb-4 grid grid-cols-4 gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск" className="rounded border p-2" />
        <select value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} className="rounded border p-2">
          <option value="">Все производители</option>
          {manufacturers.map((m) => <option key={m.id} value={m.id}>{m.name_ru}</option>)}
        </select>
        <select value={flammability} onChange={(e) => setFlammability(e.target.value)} className="rounded border p-2">
          <option value="">Любая горючесть</option><option value="НГ">НГ</option><option value="Г1">Г1</option><option value="КМ0">КМ0</option>
        </select>
        <input value={coating} onChange={(e) => setCoating(e.target.value)} placeholder="Покрытие" className="rounded border p-2" />
      </div>
      <button onClick={load} className="mb-4 rounded border px-3 py-2">Применить фильтры</button>
      <div className="overflow-auto">
        <table className="min-w-full text-sm">
          <thead><tr className="bg-slate-100"><th className="p-2 text-left">Производитель</th><th className="p-2 text-left">Название</th><th className="p-2">Тип</th><th className="p-2">Покрытие</th><th className="p-2">Горючесть</th><th className="p-2">Плотность</th><th className="p-2">Температура</th><th className="p-2">Статус</th><th className="p-2">Действия</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b">
                <td className="p-2">{r.manufacturers?.name_ru ?? "-"}</td>
                <td className="p-2">{r.name}</td>
                <td className="p-2 text-center">{r.product_type}</td>
                <td className="p-2 text-center">{r.coating}</td>
                <td className="p-2 text-center">{r.flammability}</td>
                <td className="p-2 text-center">{r.density_min ?? "-"}-{r.density_max ?? "-"}</td>
                <td className="p-2 text-center">{r.temp_min ?? "-"}..{r.temp_max ?? "-"}</td>
                <td className="p-2 text-center">{r.is_active ? "Активен" : "Скрыт"}</td>
                <td className="p-2 text-center">
                  <Link href={`/admin/products/edit/${r.id}`} className="mr-2 text-blue-600">Редактировать</Link>
                  <button onClick={() => remove(r.id)} className="text-red-600">Удалить</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
