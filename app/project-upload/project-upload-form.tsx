"use client";

import { ChangeEvent, FormEvent, useMemo, useState } from "react";

type EstimateResponse = {
  ok: boolean;
  error?: string;
  projectEstimateLogId?: string | null;
  fileName?: string;
  chars?: number;
  pages?: number;
  direction?: string;
  projectQuery?: string;
  area?: {
    value: number | null;
    source: string;
    confidence: string;
    note: string;
  };
  detectedLayers?: Array<{
    role: string;
    material: string;
    quantityType: string;
    areaOverride?: number | null;
    unitCount?: number | null;
    note: string | null;
  }>;
  aiExtraction?: {
    status: "disabled" | "skipped" | "failed" | "ok";
    reason?: string;
    provider?: string;
    model?: string;
    roofAreaM2?: number | null;
    layers?: Array<unknown>;
    warnings?: string[];
  };
  invoiceItems?: Array<{
    role: string;
    material: string;
    requestedLayer: string;
    code: string;
    brand: string | null;
    calculation: string;
    note: string | null;
    alternatives: Array<{ code: string | null; name: string | null; brand: string | null }>;
  }>;
  quoteItems?: Array<{
    no: number;
    code: string | null;
    material: string | null;
    unit: string;
    quantity: string;
    calculation: string;
    role: string;
    note: string | null;
  }>;
  quoteDraft?: string;
  projectOnly?: Array<{
    role: string;
    material: string;
    note: string;
  }>;
  notFound?: Array<{
    role: string;
    requestedLayer: string;
    calculation: string;
    note: string;
    searchTerms: string[];
    code?: string | null;
    material?: string | null;
    brand?: string | null;
    alternatives?: Array<{ code: string | null; name: string | null; brand: string | null }>;
  }>;
  textPreview?: string;
};

type SelectionResponse = {
  ok: boolean;
  status?: string;
  message?: string;
};

function sourceLabel(source?: string) {
  switch (source) {
    case "manager_input":
      return "указана менеджером";
    case "pdf_text":
      return "найдена в PDF";
    case "axes_estimate":
      return "оценка по осям";
    default:
      return "не найдена";
  }
}

function aiStatusLabel(ai?: EstimateResponse["aiExtraction"]) {
  if (!ai) return null;
  if (ai.status === "ok") {
    return `AI-экстрактор использован: ${ai.layers?.length ?? 0} слоёв${ai.roofAreaM2 ? `, площадь ${ai.roofAreaM2} м2` : ""}.`;
  }
  if (ai.status === "skipped") return "AI-экстрактор не запускался: обычный парсер дал достаточный результат.";
  if (ai.status === "disabled") return "AI-экстрактор не подключён: нет ключа/провайдера в окружении.";
  return `AI-экстрактор не сработал: ${ai.reason ?? "ошибка модели"}.`;
}

export default function ProjectUploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [direction, setDirection] = useState("кровля");
  const [area, setArea] = useState("");
  const [question, setQuestion] = useState("Посчитай материалы по проекту и дай коды 1С.");
  const [result, setResult] = useState<EstimateResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSendingSelection, setIsSendingSelection] = useState(false);
  const [selectionStatus, setSelectionStatus] = useState<SelectionResponse | null>(null);
  const [copyStatus, setCopyStatus] = useState("");

  const canSubmit = useMemo(() => Boolean(file) && !isLoading, [file, isLoading]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setResult(null);
    setCopyStatus("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;

    setIsLoading(true);
    setResult(null);
    setSelectionStatus(null);
    setCopyStatus("");

    const body = new FormData();
    body.append("file", file);
    body.append("direction", direction);
    body.append("question", question);
    if (area.trim()) body.append("area", area.trim());

    try {
      const response = await fetch("/api/project-estimate", {
        method: "POST",
        body,
      });
      const data = (await response.json()) as EstimateResponse;
      setResult(data);
    } catch (error) {
      setResult({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSendToSelection() {
    if (!result?.ok) return;

    setIsSendingSelection(true);
    setSelectionStatus(null);

    try {
      const response = await fetch("/api/project-selection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          comment: question,
          estimate: result,
        }),
      });
      const data = (await response.json()) as SelectionResponse;
      setSelectionStatus(data);
    } catch (error) {
      setSelectionStatus({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsSendingSelection(false);
    }
  }

  async function handleCopyQuoteDraft() {
    const text = result?.quoteDraft?.trim();
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("Скопировано");
    } catch {
      setCopyStatus("Не удалось скопировать");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-5 py-6">
      <header className="flex flex-col gap-1">
        <p className="text-sm font-medium text-slate-500">ТСТН · подбор материалов по проекту</p>
        <h1 className="text-2xl font-semibold text-slate-950">Загрузка PDF проекта</h1>
      </header>

      <section className="grid gap-5 lg:grid-cols-[420px_1fr]">
        <form onSubmit={handleSubmit} className="h-fit rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="grid gap-4">
            <label className="grid gap-2">
              <span className="text-sm font-medium text-slate-700">PDF проекта</span>
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={handleFileChange}
                className="block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white"
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-slate-700">Направление</span>
              <select
                value={direction}
                onChange={(event) => setDirection(event.target.value)}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="кровля">Кровля</option>
                <option value="фасад">Фасад</option>
                <option value="фундамент">Фундамент</option>
                <option value="техническая изоляция">Техническая изоляция</option>
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-slate-700">Площадь, м2</span>
              <input
                value={area}
                onChange={(event) => setArea(event.target.value)}
                inputMode="decimal"
                placeholder="Можно оставить пустым"
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              />
            </label>

            <label className="grid gap-2">
              <span className="text-sm font-medium text-slate-700">Задача менеджера</span>
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                rows={4}
                className="resize-none rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              />
            </label>

            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-md bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {isLoading ? "Читаю PDF..." : "Рассчитать по базе"}
            </button>
          </div>
        </form>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          {!result && (
            <div className="grid min-h-[520px] place-items-center text-center text-slate-500">
              <div>
                <p className="text-base font-medium text-slate-700">Загрузите PDF проекта</p>
                <p className="mt-2 max-w-md text-sm">
                  Сервис извлечет текст, найдет кровельные слои и сверит материалы с номенклатурой 1С.
                </p>
              </div>
            </div>
          )}

          {result?.error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              {result.error}
            </div>
          )}

          {result?.ok && (
            <div className="grid gap-6">
              <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-4">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">{result.fileName}</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {result.pages} стр. · {result.chars} символов · площадь:{" "}
                    <span className="font-medium text-slate-800">
                      {result.area?.value ? `${result.area.value} м2` : "не найдена"}
                    </span>{" "}
                    ({sourceLabel(result.area?.source)})
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={handleCopyQuoteDraft}
                    disabled={!result.quoteDraft}
                    className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400"
                  >
                    {copyStatus || "Скопировать КП"}
                  </button>
                  <button
                    type="button"
                    onClick={handleSendToSelection}
                    disabled={isSendingSelection}
                    className="rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {isSendingSelection ? "Отправляю..." : "Отправить в подбор"}
                  </button>
                </div>
              </div>

              {selectionStatus && (
                <div
                  className={`rounded-md border p-3 text-sm ${
                    selectionStatus.ok
                      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                      : "border-amber-200 bg-amber-50 text-amber-900"
                  }`}
                >
                  {selectionStatus.message ?? "Заявка обработана."}
                </div>
              )}

              {result.area?.note && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  {result.area.note}
                </div>
              )}

              {result.aiExtraction && (
                <div
                  className={`rounded-md border p-3 text-sm ${
                    result.aiExtraction.status === "ok"
                      ? "border-blue-200 bg-blue-50 text-blue-900"
                      : result.aiExtraction.status === "failed"
                        ? "border-amber-200 bg-amber-50 text-amber-900"
                        : "border-slate-200 bg-slate-50 text-slate-600"
                  }`}
                >
                  {aiStatusLabel(result.aiExtraction)}
                </div>
              )}

              {result.projectEstimateLogId && (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                  Расчет сохранен в журнал проектов: {result.projectEstimateLogId}
                </div>
              )}

              {result.quoteDraft && (
                <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
                  <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
                    Черновик КП без цен
                  </h3>
                  <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-700">
                    {result.quoteDraft}
                  </pre>
                </div>
              )}

              <div>
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
                  Таблица для КП
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[920px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-slate-500">
                        <th className="py-2 pr-3 font-medium">№</th>
                        <th className="py-2 pr-3 font-medium">Код 1С</th>
                        <th className="py-2 pr-3 font-medium">Наименование</th>
                        <th className="py-2 pr-3 font-medium">Кол-во</th>
                        <th className="py-2 pr-3 font-medium">Ед.</th>
                        <th className="py-2 pr-3 font-medium">Расчет</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(result.quoteItems ?? []).map((item) => (
                        <tr key={`${item.no}-${item.code}-${item.role}`} className="border-b border-slate-100 align-top">
                          <td className="py-3 pr-3 text-slate-500">{item.no}</td>
                          <td className="py-3 pr-3 font-semibold text-slate-950">{item.code}</td>
                          <td className="py-3 pr-3">
                            <div className="font-medium text-slate-950">{item.material}</div>
                            <div className="mt-1 text-xs text-slate-500">{item.role}</div>
                            {item.note && <div className="mt-1 text-xs text-amber-700">{item.note}</div>}
                          </td>
                          <td className="py-3 pr-3 font-semibold text-slate-950">{item.quantity}</td>
                          <td className="py-3 pr-3 text-slate-700">{item.unit}</td>
                          <td className="py-3 pr-3 text-slate-700">{item.calculation}</td>
                        </tr>
                      ))}
                      {!result.quoteItems?.length && (
                        <tr>
                          <td colSpan={6} className="py-5 text-center text-slate-500">
                            Автоматически счетные позиции с кодами 1С не найдены.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
                    Проектные слои
                  </h3>
                  <div className="grid gap-2">
                    {(result.projectOnly ?? []).map((item) => (
                      <div key={`${item.role}-${item.material}`} className="rounded-md bg-slate-50 p-3 text-sm">
                        <div className="font-medium text-slate-800">{item.material}</div>
                        <div className="text-slate-500">{item.role}</div>
                        <div className="mt-1 text-xs text-slate-500">{item.note}</div>
                      </div>
                    ))}
                    {!result.projectOnly?.length && <p className="text-sm text-slate-500">Не выделены.</p>}
                  </div>
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
                    Требует проверки
                  </h3>
                  <div className="grid gap-2">
                    {(result.notFound ?? []).map((item) => {
                      const calculation = item.calculation?.replace(/\.$/, "");
                      const note = item.note?.replace(/\.$/, "");
                      const showNote = note && !calculation?.includes(note);

                      return (
                        <div key={`${item.role}-${item.requestedLayer}`} className="rounded-md bg-slate-50 p-3 text-sm">
                          <div className="font-medium text-slate-800">{item.requestedLayer}</div>
                          <div className="text-slate-500">{item.role}</div>
                          {item.code && (
                            <div className="mt-1 text-xs font-semibold text-slate-900">
                              Код 1С: {item.code}
                            </div>
                          )}
                          {item.material && item.material !== item.requestedLayer && (
                            <div className="mt-1 text-xs text-slate-600">{item.material}</div>
                          )}
                          <div className="mt-1 text-xs text-slate-500">{item.calculation}</div>
                          {showNote && <div className="mt-1 text-xs text-amber-700">{item.note}</div>}
                        </div>
                      );
                    })}
                    {!result.notFound?.length && <p className="text-sm text-slate-500">Хвостов нет.</p>}
                  </div>
                </div>
              </div>

              <details className="rounded-md border border-slate-200 p-3">
                <summary className="cursor-pointer text-sm font-medium text-slate-700">
                  Что отправлено на подбор
                </summary>
                <pre className="mt-3 whitespace-pre-wrap text-xs text-slate-600">{result.projectQuery}</pre>
              </details>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
