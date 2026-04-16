"use client";

import { useEffect, useState } from "react";

export const dynamic = "force-dynamic";

export default function NotesPage() {
  const [notes, setNotes] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ title: "", content: "", tags: "", category: "совет" });

  const load = async () => {
    const r = await fetch(`/api/notes${search ? `?search=${encodeURIComponent(search)}` : ""}`);
    const d = await r.json();
    setNotes(d.items ?? []);
  };
  useEffect(() => { load(); }, [search]);

  const add = async () => {
    await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean)
      })
    });
    setForm({ title: "", content: "", tags: "", category: "совет" });
    load();
  };

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Заметки</h1>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Поиск по тегам и тексту" className="mb-4 w-full rounded border p-2" />
      <div className="mb-4 grid grid-cols-2 gap-2 rounded border p-3">
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Заголовок" className="rounded border p-2" />
        <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="rounded border p-2">
          <option>правило</option><option>совет</option><option>скрипт продаж</option><option>FAQ</option><option>дополнение</option>
        </select>
        <textarea value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="Текст заметки" className="col-span-2 min-h-28 rounded border p-2" />
        <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="Теги через запятую" className="col-span-2 rounded border p-2" />
        <button onClick={add} className="col-span-2 rounded bg-slate-900 px-4 py-2 text-white">Добавить</button>
      </div>
      <div className="space-y-2">
        {notes.map((n) => (
          <div key={n.id} className="rounded border p-3">
            <p className="font-semibold">{n.title}</p>
            <p className="text-sm text-slate-600">{n.content}</p>
            <p className="mt-2 text-xs">{(n.tags || []).join(", ")}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
