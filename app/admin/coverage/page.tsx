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

const priorityIcon = (p: number | null): string => {
  if (p === 1) return "🔴";
  if (p === 2) return "🟡";
  if (p === 3) return "🟢";
  return "⚪";
};

export default function CoveragePage() {
  const [rows, setRows] = useState<CoverageRow[]>([]);
  const [positionsCount, setPositionsCount] = useState<Record<string, number>>({});
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

    const [coverageRes, nomenclatureRes] = await Promise.all([
      supabase
        .from("document_coverage")
        .select("id, brand, series, status, priority, notes")
        .order("brand", { ascending: true }),
      supabase.rpc("get_nomenclature_counts"),
    ]);

    if (coverageRes.error) {
      setError(coverageRes.error.message);
      setLoading(false);
      return;
    }
    if (nomenclatureRes.error) {
      setError(nomenclatureRes.error.message);
      setLoading(false);
      return;
    }

    setRows((coverageRes.data ?? []) as unknown as CoverageRow[]);

    const positionsCount = Object.fromEntries(
      (nomenclatureRes.data || []).map((row: { brand: string; count: number }) => [row.brand, row.count]),
    );
    setPositionsCount(positionsCount);

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

  const totalPositions = Object.values(positionsCount).reduce((s, n) => s + n, 0);
  const positionsRows = Object.entries(positionsCount)
    .map(([brand, count]) => ({ brand, count }))
    .sort((a, b) => b.count - a.count);

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
              const positions = positionsCount[s.brand] || 0;
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
                  <p className="mt-1 text-xs text-slate-700">
                    Позиций в 1С:{" "}
                    <span className="font-semibold tabular-nums">
                      {positions.toLocaleString("ru-RU")}
                    </span>
                  </p>
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
        <h2 className="mb-3 text-lg font-semibold">
          Номенклатура 1С без документов{" "}
          <span className="text-sm font-normal text-slate-500">
            ({positionsRows.length} брендов · {totalPositions.toLocaleString("ru-RU")} позиций)
          </span>
        </h2>
        <p className="mb-2 text-sm text-slate-600">
          Реальные данные из таблицы <code>nomenclature_1c</code>, отсортированы по убыванию числа позиций.
        </p>
        <div className="overflow-x-auto rounded border">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="bg-slate-100 text-left">
                <th className="p-2">Бренд</th>
                <th className="p-2">Позиций в 1С</th>
              </tr>
            </thead>
            <tbody>
              {positionsRows.map((row) => (
                <tr key={row.brand} className="border-t">
                  <td className="p-2 font-medium">{row.brand}</td>
                  <td className="p-2 tabular-nums">{row.count.toLocaleString("ru-RU")}</td>
                </tr>
              ))}
              {positionsRows.length === 0 && !loading && (
                <tr>
                  <td className="p-3 text-center text-slate-500" colSpan={2}>
                    В таблице <code>nomenclature_1c</code> пока нет записей.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
