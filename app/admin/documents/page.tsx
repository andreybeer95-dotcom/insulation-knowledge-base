"use client";

import { useCallback, useEffect, useState } from "react";
import { useDropzone } from "react-dropzone";

export const dynamic = "force-dynamic";

export default function DocumentsPage() {
  const [docs, setDocs] = useState<any[]>([]);
  const [manufacturers, setManufacturers] = useState<any[]>([]);
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("техлист");
  const [manufacturerId, setManufacturerId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>("");

  const load = async () => {
    const r = await fetch("/api/documents");
    const d = await r.json();
    setDocs(d.documents ?? []);
  };
  useEffect(() => {
    load();
    fetch("/api/manufacturers")
      .then((r) => r.json())
      .then((d) => setManufacturers(d.items ?? []));
  }, []);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;
    setBusy(true);
    setError("");
    const form = new FormData();
    form.append("file", file);
    form.append("title", title || file.name);
    form.append("doc_type", docType);
    if (manufacturerId) form.append("manufacturer_id", manufacturerId);
    const res = await fetch("/api/documents", { method: "POST", body: form });
    const doc = await res.json();
    if (!res.ok) {
      setError(doc?.error ?? "Ошибка загрузки");
      setBusy(false);
      return;
    }
    await load();
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
            <th className="p-2">Создан</th>
            <th className="p-2">Действия</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id} className="border-b">
              <td className="p-2">{d.doc_type}</td>
              <td className="p-2">{d.title}</td>
              <td className="p-2">{d.manufacturers?.name_ru ?? "-"}</td>
              <td className="p-2 text-center">{fmtSize(d.file_size)}</td>
              <td className="p-2 text-center">{d.pages_count ?? "-"}</td>
              <td className="p-2 text-center">
                <a href={d.file_url} target="_blank" className="text-blue-600">
                  Открыть
                </a>
              </td>
              <td className="p-2 text-center">{new Date(d.created_at).toLocaleDateString()}</td>
              <td className="p-2 text-center">
                <button
                  onClick={() => remove(d.id)}
                  className="text-red-600 disabled:opacity-50"
                  disabled={busy}
                >
                  Удалить
                </button>
              </td>
            </tr>
          ))}
          {docs.length === 0 && (
            <tr>
              <td className="p-4 text-center text-slate-500" colSpan={8}>
                Документов пока нет
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
