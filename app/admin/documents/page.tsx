"use client";

import { useCallback, useEffect, useState } from "react";
import { useDropzone } from "react-dropzone";

export const dynamic = "force-dynamic";

export default function DocumentsPage() {
  type UploadItem = {
    name: string;
    status: "pending" | "uploading" | "success" | "error" | "scan";
    chunks?: number;
    error?: string;
  };

  const [docs, setDocs] = useState<any[]>([]);
  const [manufacturers, setManufacturers] = useState<any[]>([]);
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("техлист");
  const [manufacturerId, setManufacturerId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");
  const [uploadStatus, setUploadStatus] = useState<string>("");
  const [uploadQueue, setUploadQueue] = useState<UploadItem[]>([]);

  const fetchDocuments = async () => {
    const r = await fetch("/api/documents");
    const d = await r.json();
    setDocs(d.documents ?? []);
  };
  useEffect(() => {
    fetchDocuments();
    fetch("/api/manufacturers")
      .then((r) => r.json())
      .then((d) => setManufacturers(d.items ?? []));
  }, []);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    if (!acceptedFiles.length) return;
    setBusy(true);
    setError("");
    setUploadStatus(`Подготовка к загрузке: ${acceptedFiles.length} файлов`);
    setUploadQueue(acceptedFiles.map((file) => ({ name: file.name, status: "pending" })));
    const results: Array<{ file: string; success: boolean; chunks?: number; error?: string }> = [];

    for (let i = 0; i < acceptedFiles.length; i++) {
      const file = acceptedFiles[i];
      setUploadStatus(`Загружается ${i + 1} из ${acceptedFiles.length}: ${file.name}`);
      setUploadQueue((prev) => prev.map((item) => (item.name === file.name ? { ...item, status: "uploading" } : item)));
      try {
        const form = new FormData();
        form.append("file", file);
        form.append("title", title || file.name);
        form.append("doc_type", docType);
        if (manufacturerId) form.append("manufacturer_id", manufacturerId);

        const res = await fetch("/api/documents", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) {
          results.push({ file: file.name, success: false, error: data?.error ?? "Ошибка загрузки" });
          setUploadQueue((prev) =>
            prev.map((item) =>
              item.name === file.name
                ? { ...item, status: "error", error: data?.error ?? "Ошибка загрузки" }
                : item
            )
          );
          continue;
        }
        const isScan = Boolean(data?.warning) || Number(data?.chunks_created ?? 0) === 0;
        const chunks = Number(data?.chunks_created ?? 0);
        results.push({ file: file.name, success: true, chunks });
        setUploadQueue((prev) =>
          prev.map((item) =>
            item.name === file.name
              ? {
                  ...item,
                  status: isScan ? "scan" : "success",
                  chunks
                }
              : item
          )
        );
      } catch (e) {
        const errText = String(e);
        results.push({ file: file.name, success: false, error: errText });
        setUploadQueue((prev) =>
          prev.map((item) => (item.name === file.name ? { ...item, status: "error", error: errText } : item))
        );
      }
    }

    const successCount = results.filter((r) => r.success).length;
    setUploadStatus(`Готово: ${successCount} из ${acceptedFiles.length} файлов`);
    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      setError(`Не удалось загрузить ${failed.length} файл(ов). См. консоль.`);
    }
    console.log("Результаты загрузки:", results);
    await fetchDocuments();
    setBusy(false);
  }, [title, docType, manufacturerId]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop });

  const remove = async (id: string) => {
    if (!confirm("Удалить документ?")) return;
    setBusy(true);
    setError("");
    const res = await fetch(`/api/documents?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const payload = await res.json();
    if (!res.ok) {
      setError(payload?.error ?? "Ошибка удаления");
    } else {
      await load();
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
    await load();
    setBusy(false);
  };

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Документы</h1>
      <div className="mb-3 grid grid-cols-3 gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Название документа (опционально)"
          className="rounded border p-2"
        />
        <select value={docType} onChange={(e) => setDocType(e.target.value)} className="rounded border p-2">
          <option value="техлист">техлист</option>
          <option value="сертификат">сертификат</option>
          <option value="прайс">прайс</option>
          <option value="инструкция">инструкция</option>
          <option value="дополнение">дополнение</option>
        </select>
        <select
          value={manufacturerId}
          onChange={(e) => setManufacturerId(e.target.value)}
          className="rounded border p-2"
        >
          <option value="">Производитель (необязательно)</option>
          {manufacturers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name_ru}
            </option>
          ))}
        </select>
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
      {busy && <p className="mb-3 text-sm text-slate-600">Загрузка/обработка...</p>}
      {uploadStatus && <p className="mb-3 text-sm text-slate-600">{uploadStatus}</p>}
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      {uploadQueue.length > 0 && (
        <ul className="mb-4 space-y-1 text-sm">
          {uploadQueue.map((item, idx) => {
            if (item.status === "pending") {
              return (
                <li key={`${item.name}-${idx}`} className="text-slate-500">
                  ⏳ {item.name} — ожидает
                </li>
              );
            }
            if (item.status === "uploading") {
              return (
                <li key={`${item.name}-${idx}`} className="animate-pulse text-blue-600">
                  🔄 {item.name} — загружается
                </li>
              );
            }
            if (item.status === "success") {
              return (
                <li key={`${item.name}-${idx}`} className="text-green-600">
                  ✅ {item.name} — чанков: {item.chunks ?? 0}
                </li>
              );
            }
            if (item.status === "scan") {
              return (
                <li key={`${item.name}-${idx}`} className="text-yellow-700">
                  ⚠️ {item.name} — Скан PDF — OCR не выполнен
                </li>
              );
            }
            return (
              <li key={`${item.name}-${idx}`} className="text-red-600">
                ❌ {item.name} — {item.error ?? "Ошибка загрузки"}
              </li>
            );
          })}
        </ul>
      )}

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
            <th className="p-2">Создан</th>
            <th className="p-2">Действия</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => {
            const status = getChunkStatus(d);
            return (
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
            );
          })}
          {docs.length === 0 && (
            <tr>
              <td className="p-4 text-center text-slate-500" colSpan={9}>
                Документов пока нет
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
