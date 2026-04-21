"use client";

import { useCallback, useEffect, useState } from "react";
import { useDropzone } from "react-dropzone";
import ProductSelect from "@/components/admin/ProductSelect";
import ProductLinker from "@/components/admin/ProductLinker";

export const dynamic = "force-dynamic";

export default function DocumentsPage() {
  const DOC_TYPE_OPTIONS: Array<{ value: string; label: string; priority: number }> = [
    { value: "tds", label: "Техлист / TDS", priority: 8 },
    { value: "script", label: "Скрипт продаж", priority: 10 },
    { value: "compare", label: "Сравнительная таблица", priority: 9 },
    { value: "norm", label: "Норматив (ГОСТ, СП, ТУ)", priority: 7 },
    { value: "install", label: "Инструкция по монтажу", priority: 6 },
    { value: "price", label: "Прайс-лист", priority: 3 }
  ];
  const INTENT_OPTIONS: Array<{ value: string; label: string }> = [
    { value: "selection", label: "Подбор товара" },
    { value: "objection", label: "Работа с возражением / конкурент" },
    { value: "technical", label: "Технический вопрос" },
    { value: "compliance", label: "Нормативное соответствие" },
    { value: "install", label: "Монтаж" },
    { value: "pricing", label: "Вопрос о цене" }
  ];

  const [docs, setDocs] = useState<any[]>([]);
  const [manufacturers, setManufacturers] = useState<any[]>([]);
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("tds");
  const [priorityWeight, setPriorityWeight] = useState(8);
  const [intentTags, setIntentTags] = useState<string[]>([]);
  const [manufacturerId, setManufacturerId] = useState<string>("");
  const [productId, setProductId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [uploadQueue, setUploadQueue] = useState<Array<{
    name: string;
    status: "pending" | "uploading" | "success" | "scan" | "error";
    chunks?: number;
    error?: string;
  }>>([]);
  const [uploadStatus, setUploadStatus] = useState("");
  const [manualTextDocId, setManualTextDocId] = useState<string | null>(null);
  const [manualText, setManualText] = useState("");
  const [manualBusy, setManualBusy] = useState(false);

  const fetchDocuments = useCallback(async () => {
    const r = await fetch("/api/documents");
    const d = await r.json();
    setDocs(d.documents ?? []);
  }, []);
  useEffect(() => {
    fetchDocuments();
    fetch("/api/manufacturers")
      .then((r) => r.json())
      .then((d) => setManufacturers(d.items ?? []));
  }, []);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) return;
    console.log("onDrop вызван, файлов:", acceptedFiles.length, acceptedFiles.map(f => f.name));

    // Показываем очередь файлов
    const queue = acceptedFiles.map(f => ({
      name: f.name,
      status: "pending" as "pending" | "uploading" | "success" | "scan" | "error",
      chunks: undefined as number | undefined,
      error: undefined as string | undefined,
    }));
    setUploadQueue([...queue]);

    for (let i = 0; i < acceptedFiles.length; i++) {
      const file = acceptedFiles[i];

      queue[i].status = "uploading";
      setUploadQueue([...queue]);
      setUploadStatus(`⏳ Загружается ${i + 1} из ${acceptedFiles.length}: ${file.name}`);

      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("title", title || file.name);
        formData.append("doc_type", docType);
        formData.append("priority_weight", String(priorityWeight));
        formData.append("intent_tags", JSON.stringify(intentTags));
        if (manufacturerId) formData.append("manufacturer_id", manufacturerId);
        if (productId) formData.append("product_id", productId);
        console.log(`Отправляю файл ${i + 1}/${acceptedFiles.length}:`, file.name, file.size);

        const res = await fetch("/api/documents", {
          method: "POST",
          body: formData,
        });
        const responseText = await res.text();
        console.log(`Ответ для ${file.name}:`, res.status, responseText.slice(0, 200));

        let data: any = null;
        try {
          data = JSON.parse(responseText);
        } catch {
          data = null;
        }

        if (res.status === 409) {
          queue[i].status = "error";
          queue[i].error = data?.warning ?? "Файл уже загружен";
          continue;
        }

        if (!res.ok) {
          throw new Error(`Сервер вернул ${res.status}: ${responseText.slice(0, 150)}`);
        }

        if (!data) {
          throw new Error(`Невалидный JSON от сервера: ${responseText.slice(0, 100)}`);
        }

        if (data.warning || data.chunks_created === 0) {
          queue[i].status = "scan";
          queue[i].chunks = 0;
        } else {
          queue[i].status = "success";
          queue[i].chunks = data.chunks_created ?? 0;
        }
      } catch (err) {
        queue[i].status = "error";
        queue[i].error = err instanceof Error ? err.message : String(err);
        console.error(`Ошибка: ${file.name}`, err);
      }

      setUploadQueue([...queue]);
      
      // Пауза 300мс между файлами
      if (i < acceptedFiles.length - 1) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    const ok = queue.filter(q => q.status === "success").length;
    const scan = queue.filter(q => q.status === "scan").length;
    const err = queue.filter(q => q.status === "error").length;
    setUploadStatus(`✅ ${ok} загружено  ⚠️ ${scan} сканов  ❌ ${err} ошибок`);
    
    await fetchDocuments();
  }, [fetchDocuments, title, docType, priorityWeight, intentTags, manufacturerId, productId]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    multiple: true,
    maxFiles: 20,
    maxSize: 50 * 1024 * 1024,
  });

  const remove = async (id: string) => {
    if (!confirm("Удалить документ?")) return;
    setBusy(true);
    setError("");
    const res = await fetch(`/api/documents?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const payload = await res.json();
    if (!res.ok) {
      setError(payload?.error ?? "Ошибка удаления");
    } else {
      await fetchDocuments();
    }
    setBusy(false);
  };

  const fmtSize = (bytes?: number | null) => {
    if (!bytes) return "-";
    const mb = bytes / (1024 * 1024);
    if (mb >= 1) return `${mb.toFixed(2)} MB`;
    const kb = bytes / 1024;
    return `${kb.toFixed(1)} KB`;
  };

  const getChunkStatus = (doc: any) => {
    const count = Number(doc?.chunks_count ?? 0);
    const notes = String(doc?.notes ?? "");
    if (count > 0) return { type: "ok", label: `✓ ${count} чанков`, className: "bg-green-100 text-green-700" };
    if (notes.includes("СКАН")) return { type: "scan", label: "⚠ Скан PDF", className: "bg-yellow-100 text-yellow-700" };
    return { type: "none", label: "✗ Нет чанков", className: "bg-red-100 text-red-700" };
  };

  const rechunk = async (id: string) => {
    setBusy(true);
    setError("");
    const res = await fetch("/api/rechunk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_id: id })
    });
    const payload = await res.json();
    if (!res.ok) {
      setError(payload?.error ?? "Ошибка перенарезки");
    } else if (payload?.warning) {
      setError(payload.warning);
    }
    await fetchDocuments();
    setBusy(false);
  };

  const saveManualText = async (id: string) => {
    if (manualText.trim().length < 50) {
      setError("Текст слишком короткий (минимум 50 символов)");
      return;
    }
    setManualBusy(true);
    setError("");
    const res = await fetch(`/api/documents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manual_text: manualText })
    });
    const payload = await res.json();
    if (!res.ok) {
      setError(payload?.error ?? "Ошибка сохранения текста");
      setManualBusy(false);
      return;
    }
    setManualText("");
    setManualTextDocId(null);
    await fetchDocuments();
    setManualBusy(false);
  };

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Документы</h1>
      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Название документа (опционально)"
          className="rounded border p-2"
        />
        <select
          value={docType}
          onChange={(e) => {
            const nextType = e.target.value;
            setDocType(nextType);
            const found = DOC_TYPE_OPTIONS.find((o) => o.value === nextType);
            if (found) setPriorityWeight(found.priority);
          }}
          className="rounded border p-2"
        >
          {DOC_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <select
          value={manufacturerId}
          onChange={(e) => {
            setManufacturerId(e.target.value);
            setProductId(null);
          }}
          className="rounded border p-2"
        >
          <option value="">Производитель (необязательно)</option>
          {manufacturers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name_ru}
            </option>
          ))}
        </select>
        <ProductSelect value={productId} onChange={setProductId} manufacturerId={manufacturerId} />
        <input
          value={priorityWeight}
          onChange={(e) => setPriorityWeight(Number(e.target.value) || 0)}
          type="number"
          className="rounded border p-2"
          placeholder="priority_weight"
        />
        <div className="rounded border p-2">
          <p className="mb-2 text-sm font-medium">Intent tags</p>
          <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
            {INTENT_OPTIONS.map((option) => (
              <label key={option.value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={intentTags.includes(option.value)}
                  onChange={(e) => {
                    setIntentTags((prev) =>
                      e.target.checked
                        ? [...prev, option.value]
                        : prev.filter((v) => v !== option.value)
                    );
                  }}
                />
                {option.label}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div
        {...getRootProps()}
        className={`mb-2 cursor-pointer rounded border-2 border-dashed p-8 text-center ${
          busy ? "opacity-60" : ""
        }`}
      >
        <input {...getInputProps()} disabled={busy} />
        {isDragActive ? "Отпустите файл для загрузки" : "Перетащите PDF сюда или кликните для выбора"}
      </div>
      {/* Статус загрузки */}
      {uploadStatus && (
        <p className="mt-2 text-sm font-medium text-gray-700">{uploadStatus}</p>
      )}

      {/* Очередь файлов */}
      {uploadQueue.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {uploadQueue.map((item, idx) => (
            <li key={idx} className="flex items-center gap-2">
              {item.status === "pending"   && <span className="text-gray-400">⏳</span>}
              {item.status === "uploading" && <span className="text-blue-500 animate-pulse">🔄</span>}
              {item.status === "success"   && <span className="text-green-600">✅</span>}
              {item.status === "scan"      && <span className="text-yellow-500">⚠️</span>}
              {item.status === "error"     && <span className="text-red-500">❌</span>}
              <span className={
                item.status === "error" ? "text-red-600" :
                item.status === "success" ? "text-green-700" :
                item.status === "scan" ? "text-yellow-700" : "text-gray-600"
              }>
                {item.name}
                {item.status === "success" && ` — ${item.chunks} чанков`}
                {item.status === "scan" && " — Скан PDF"}
                {item.status === "error" && ` — ${item.error}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {uploadQueue.length > 0 && (
        <p className="mb-3 text-sm text-slate-600">После загрузки привяжи документы к продуктам в списке ниже</p>
      )}
      {busy && <p className="mb-3 text-sm text-slate-600">Загрузка/обработка...</p>}
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <table className="min-w-full text-sm">
        <thead>
          <tr className="bg-slate-100">
            <th className="p-2 text-left">Тип</th>
            <th className="p-2 text-left">Название</th>
            <th className="p-2 text-left">Производитель</th>
            <th className="p-2">Размер</th>
            <th className="p-2">Страниц</th>
            <th className="p-2">Файл</th>
            <th className="p-2">Статус</th>
            <th className="p-2">Продукты</th>
            <th className="p-2">Создан</th>
            <th className="p-2">Действия</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => {
            const status = getChunkStatus(d);
            return (
            <>
            <tr key={d.id} className="border-b">
              <td className="p-2">{d.doc_type ?? "-"}</td>
              <td className="p-2">{d.title ?? "-"}</td>
              <td className="p-2">{d.manufacturers?.name_ru ?? "-"}</td>
              <td className="p-2 text-center">{fmtSize(d.file_size)}</td>
              <td className="p-2 text-center">{d.pages_count ?? "-"}</td>
              <td className="p-2 text-center">
                <a href={d.file_url} target="_blank" className="text-blue-600">
                  Открыть
                </a>
              </td>
              <td className="p-2 text-center">
                <span className={`inline-block rounded px-2 py-1 text-xs ${status.className}`}>
                  {status.label}
                </span>
                {status.type === "scan" && (
                  <div className="mt-2">
                    <button
                      onClick={() => {
                        setManualTextDocId((prev) => (prev === d.id ? null : d.id));
                        setManualText("");
                      }}
                      className="text-xs text-blue-600 underline disabled:opacity-50"
                      disabled={busy || manualBusy}
                    >
                      Загрузить текст вручную
                    </button>
                  </div>
                )}
              </td>
              <td className="p-2">
                <ProductLinker documentId={d.id} manufacturerId={d.manufacturer_id} />
              </td>
              <td className="p-2 text-center">{new Date(d.created_at).toLocaleDateString()}</td>
              <td className="p-2 text-center">
                {status.type === "none" && (
                  <button
                    onClick={() => rechunk(d.id)}
                    className="mr-2 text-blue-600 disabled:opacity-50"
                    disabled={busy}
                  >
                    Перенарезать
                  </button>
                )}
                <button
                  onClick={() => remove(d.id)}
                  className="text-red-600 disabled:opacity-50"
                  disabled={busy}
                >
                  Удалить
                </button>
              </td>
            </tr>
            {manualTextDocId === d.id && (
              <tr className="border-b bg-slate-50">
                <td className="p-2" colSpan={10}>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Вставьте текст из скана</p>
                    <textarea
                      value={manualText}
                      onChange={(e) => setManualText(e.target.value)}
                      rows={6}
                      className="w-full rounded border p-2 text-sm"
                      placeholder="Вставьте извлечённый текст (OCR)..."
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => saveManualText(d.id)}
                        className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
                        disabled={manualBusy}
                      >
                        Сохранить и нарезать
                      </button>
                      <button
                        onClick={() => {
                          setManualTextDocId(null);
                          setManualText("");
                        }}
                        className="rounded border px-3 py-1 text-sm disabled:opacity-50"
                        disabled={manualBusy}
                      >
                        Отмена
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
            )}
            </>
            );
          })}
          {docs.length === 0 && (
            <tr>
              <td className="p-4 text-center text-slate-500" colSpan={10}>
                Документов пока нет
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
