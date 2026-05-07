"use client";

import { useCallback, useEffect, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

type CoverageRow = {
  id: string;
  brand: string;
  series: string | null;
  status: string | null;
  priority: number | null;
  notes: string | null;
};

const nomenclature_gaps: Array<{
  brand: string;
  product: string;
  positions_1c: number;
  priority: number;
}> = [
  { brand: "K-FLEX", product: "K-FLEX ST трубки/рулоны", positions_1c: 6432, priority: 1 },
  { brand: "ПЕНОПЛЭКС", product: "Комфорт / Фундамент / Основа", positions_1c: 131, priority: 1 },
  { brand: "КРОЗ", product: "ВБОР / Firestill", positions_1c: 419, priority: 1 },
  { brand: "КНАУФ", product: "KNAUF INSULATION TS/AS", positions_1c: 509, priority: 1 },
  { brand: "PRO-МБОР", product: "МБОР 5/8/10/13/16", positions_1c: 80, priority: 1 },
  { brand: "BASWOOL", product: "ECOROCK / ФЛОР", positions_1c: 24, priority: 2 },
  { brand: "ISOVER", product: "Каталог продукции", positions_1c: 84, priority: 2 },
  { brand: "ИЗОБОКС", product: "Каталог продукции", positions_1c: 49, priority: 2 },
  { brand: "ПАРОК", product: "Каталог продукции", positions_1c: 49, priority: 3 },
];

const priorityIcon = (p: number | null): string => {
  if (p === 1) return "🔴";
  if (p === 2) return "🟡";
  if (p === 3) return "🟢";
  return "⚪";
};

const priorityFullLabel = (p: number): string => {
  if (p === 1) return "🔴 Высокий";
  if (p === 2) return "🟡 Средний";
  if (p === 3) return "🟢 Низкий";
  return "⚪";
};

export default function CoveragePage() {
  const [rows, setRows] = useState<CoverageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string>("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const supabase = getBrowserSupabase();
    if (!supabase) {
      setError("Supabase недоступен (нет переменных окружения)");
      setLoading(false);
      return;
    }
    const { data, error: err } = await supabase
      .from("document_coverage")
      .select("id, brand, series, status, priority, notes")
      .order("brand", { ascending: true });
    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }
    setRows((data ?? []) as unknown as CoverageRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const markLoaded = async (id: string) => {
    const supabase = getBrowserSupabase();
    if (!supabase) {
      setError("Supabase недоступен");
      return;
    }
    setBusyId(id);
    setError("");
    const { error: err } = await supabase
      .from("document_coverage")
      .update({ status: "loaded" })
      .eq("id", id);
    setBusyId(null);
    if (err) {
      setError(err.message);
      return;
    }
    await load();
  };

  const byBrand = rows.reduce<Record<string, CoverageRow[]>>((acc, row) => {
    (acc[row.brand] ??= []).push(row);
    return acc;
  }, {});

  const summary = Object.entries(byBrand)
    .map(([brand, items]) => {
      const total = items.length;
      const loaded = items.filter((i) => i.status === "loaded").length;
      const pct = total === 0 ? 0 : Math.round((loaded / total) * 100);
      return { brand, total, loaded, missing: total - loaded, pct };
    })
    .sort((a, b) => a.brand.localeCompare(b.brand, "ru"));

  const missing = rows
    .filter((r) => r.status !== "loaded")
    .sort((a, b) => {
      const pa = a.priority ?? 99;
      const pb = b.priority ?? 99;
      if (pa !== pb) return pa - pb;
      return a.brand.localeCompare(b.brand, "ru");
    });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Покрытие документов</h1>
        <p className="mt-1 text-sm text-slate-600">
          Статус загрузки PDF и техдокументов по брендам и сериям.
        </p>
      </div>

      {error && (
        <p className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {loading && <p className="text-sm text-slate-600">Загрузка...</p>}

      {!loading && summary.length === 0 && !error && (
        <p className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          В таблице <code>document_coverage</code> пока нет записей.
        </p>
      )}

      {summary.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Сводка по брендам</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {summary.map((s) => {
              const barColor =
                s.pct >= 100 ? "bg-green-500" : s.pct > 50 ? "bg-yellow-500" : "bg-red-500";
              const cardColor =
                s.pct >= 100
                  ? "border-green-200 bg-green-50"
                  : s.pct > 50
                    ? "border-yellow-200 bg-yellow-50"
                    : "border-red-200 bg-red-50";
              return (
                <div key={s.brand} className={`rounded-lg border p-3 shadow-sm ${cardColor}`}>
                  <div className="mb-2 flex items-center justify-between">
                    <p className="font-semibold">{s.brand}</p>
                    <span className="text-sm text-slate-600">{s.pct}%</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded bg-slate-200">
                    <div className={`h-full ${barColor}`} style={{ width: `${s.pct}%` }} />
                  </div>
                  <div className="mt-2 flex justify-between text-xs text-slate-700">
                    <span>✅ {s.loaded} загружено</span>
                    <span>❌ {s.missing} не хватает</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">Всего: {s.total}</p>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {missing.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">
            Что осталось загрузить{" "}
            <span className="text-sm font-normal text-slate-500">({missing.length})</span>
          </h2>
          <div className="overflow-x-auto rounded border">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-slate-100 text-left">
                  <th className="p-2">Бренд</th>
                  <th className="p-2">Серия / Продукт</th>
                  <th className="p-2">Приоритет</th>
                  <th className="p-2">Статус</th>
                  <th className="p-2">Действие</th>
                </tr>
              </thead>
              <tbody>
                {missing.map((item) => (
                  <tr key={item.id} className="border-t">
                    <td className="p-2 font-medium">{item.brand}</td>
                    <td className="p-2">
                      <div>{item.series ?? "—"}</div>
                      {item.notes && (
                        <div className="text-xs text-slate-500">{item.notes}</div>
                      )}
                    </td>
                    <td className="p-2 text-center">
                      <span title={item.priority != null ? `priority=${item.priority}` : undefined}>
                        {priorityIcon(item.priority)}
                      </span>
                    </td>
                    <td className="p-2">
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs">
                        {item.status ?? "—"}
                      </span>
                    </td>
                    <td className="p-2">
                      <button
                        onClick={() => markLoaded(item.id)}
                        disabled={busyId === item.id}
                        className="rounded bg-slate-900 px-3 py-1 text-xs text-white hover:bg-slate-700 disabled:opacity-50"
                      >
                        {busyId === item.id ? "Сохранение..." : "Отметить как загружено"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">Номенклатура 1С без документов</h2>
        <p className="mb-2 text-sm text-slate-600">
          Бренды и продукты с большим количеством позиций в 1С, для которых ещё не загружены TDS/каталоги.
        </p>
        <div className="overflow-x-auto rounded border">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-slate-100 text-left">
                <th className="p-2">Бренд</th>
                <th className="p-2">Продукт</th>
                <th className="p-2">Позиций в 1С</th>
                <th className="p-2">Приоритет</th>
              </tr>
            </thead>
            <tbody>
              {nomenclature_gaps.map((g, idx) => (
                <tr key={`${g.brand}-${idx}`} className="border-t">
                  <td className="p-2 font-medium">{g.brand}</td>
                  <td className="p-2">{g.product}</td>
                  <td className="p-2 tabular-nums">
                    {g.positions_1c.toLocaleString("ru-RU")}
                  </td>
                  <td className="p-2">{priorityFullLabel(g.priority)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
