"use client";

import { useCallback, useEffect, useState } from "react";
import { useDropzone } from "react-dropzone";

export const dynamic = "force-dynamic";

export default function DocumentsPage() {
  const [docs, setDocs] = useState<any[]>([]);
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("техлист");

  const load = async () => {
    const r = await fetch("/api/documents");
    const d = await r.json();
    setDocs(d.items ?? []);
  };
  useEffect(() => { load(); }, []);

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    form.append("title", title || file.name);
    form.append("doc_type", docType);
    const res = await fetch("/api/documents", { method: "POST", body: form });
    const doc = await res.json();
    if (file.type.includes("pdf") && doc.id) {
      await fetch("/api/documents/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_url: doc.file_url, document_id: doc.id })
      });
    }
    load();
  }, [title, docType]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ onDrop });

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Документы</h1>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Название документа" className="rounded border p-2" />
        <select value={docType} onChange={(e) => setDocType(e.target.value)} className="rounded border p-2">
          <option>техлист</option><option>сертификат</option><option>прайс</option><option>инструкция</option><option>дополнение</option>
        </select>
      </div>
      <div {...getRootProps()} className="mb-4 cursor-pointer rounded border-2 border-dashed p-8 text-center">
        <input {...getInputProps()} />
        {isDragActive ? "Отпустите файл для загрузки" : "Перетащите PDF/Excel/Word сюда или кликните для выбора"}
      </div>
      <table className="min-w-full text-sm">
        <thead><tr className="bg-slate-100"><th className="p-2 text-left">Тип</th><th className="p-2 text-left">Название</th><th className="p-2">Файл</th><th className="p-2">Создан</th></tr></thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id} className="border-b">
              <td className="p-2">{d.doc_type}</td>
              <td className="p-2">{d.title}</td>
              <td className="p-2 text-center"><a href={d.file_url} target="_blank" className="text-blue-600">Открыть</a></td>
              <td className="p-2 text-center">{new Date(d.created_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
