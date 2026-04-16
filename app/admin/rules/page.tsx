"use client";

import { useEffect, useState } from "react";

export const dynamic = "force-dynamic";

export default function RulesPage() {
  const [items, setItems] = useState<any[]>([]);
  const [form, setForm] = useState({ rule_name: "", condition: "", rule_text: "", priority: 3, is_prohibition: false });

  const load = async () => {
    const r = await fetch("/api/rules");
    const d = await r.json();
    setItems(d.items ?? []);
  };
  useEffect(() => { load(); }, []);

  const add = async () => {
    await fetch("/api/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    });
    setForm({ rule_name: "", condition: "", rule_text: "", priority: 3, is_prohibition: false });
    load();
  };

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Правила подбора</h1>
      <div className="mb-4 grid grid-cols-2 gap-2 rounded border p-3">
        <input value={form.rule_name} onChange={(e) => setForm({ ...form, rule_name: e.target.value })} placeholder="Название правила" className="rounded border p-2" />
        <input value={form.condition} onChange={(e) => setForm({ ...form, condition: e.target.value })} placeholder="Условие" className="rounded border p-2" />
        <textarea value={form.rule_text} onChange={(e) => setForm({ ...form, rule_text: e.target.value })} placeholder="Текст правила" className="col-span-2 min-h-20 rounded border p-2" />
        <input value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} type="number" className="rounded border p-2" />
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.is_prohibition} onChange={(e) => setForm({ ...form, is_prohibition: e.target.checked })} /> Запрет</label>
        <button onClick={add} className="col-span-2 rounded bg-slate-900 px-4 py-2 text-white">Добавить правило</button>
      </div>
      <div className="space-y-2">
        {items.map((r) => (
          <div key={r.id} className="rounded border p-3">
            <div className="flex items-center gap-2">
              <p className="font-semibold">{r.rule_name}</p>
              {r.is_prohibition && <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">ЗАПРЕТ</span>}
            </div>
            <p className="text-sm text-slate-700">{r.rule_text}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
