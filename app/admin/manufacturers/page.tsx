"use client";

import { useEffect, useState } from "react";

export const dynamic = "force-dynamic";

export default function ManufacturersPage() {
  const [items, setItems] = useState<any[]>([]);
  const [name, setName] = useState("");

  const load = async () => {
    const r = await fetch("/api/manufacturers");
    const d = await r.json();
    setItems(d.items ?? []);
  };
  useEffect(() => { load(); }, []);

  const add = async () => {
    await fetch("/api/manufacturers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name_ru: name, synonyms: [] })
    });
    setName("");
    load();
  };

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Производители</h1>
      <div className="mb-4 flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Название" className="w-full rounded border p-2" />
        <button onClick={add} className="rounded bg-slate-900 px-4 py-2 text-white">Добавить</button>
      </div>
      <ul className="space-y-2">
        {items.map((m) => (
          <li key={m.id} className="rounded border p-2">{m.name_ru}</li>
        ))}
      </ul>
    </div>
  );
}
