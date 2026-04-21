"use client";

import { useEffect, useMemo, useState } from "react";

type Product = {
  id: string;
  name: string;
  coating?: string | null;
  flammability?: string | null;
  manufacturer_id?: string | null;
};

type LinkedItem = {
  product_id: string;
  products?: Product | Product[] | null;
};

interface Props {
  documentId: string;
  manufacturerId?: string | null;
}

function asProduct(p: Product | Product[] | null | undefined): Product | null {
  if (!p) return null;
  return Array.isArray(p) ? p[0] ?? null : p;
}

export default function ProductLinker({ documentId, manufacturerId }: Props) {
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [linked, setLinked] = useState<Product[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [linksRes, productsRes] = await Promise.all([
      fetch(`/api/document-products?document_id=${encodeURIComponent(documentId)}`),
      fetch("/api/products")
    ]);
    const linksJson = await linksRes.json();
    const productsJson = await productsRes.json();

    const linkRows = (linksJson.items ?? []) as LinkedItem[];
    const linkedProducts = linkRows
      .map((row) => asProduct(row.products))
      .filter((p): p is Product => Boolean(p));

    setLinked(linkedProducts);
    setSelectedIds(linkedProducts.map((p) => p.id));
    setAllProducts((productsJson.items ?? []) as Product[]);
  };

  useEffect(() => {
    load();
  }, [documentId]);

  const filteredProducts = useMemo(() => {
    return allProducts.filter((p) => {
      if (manufacturerId && p.manufacturer_id && p.manufacturer_id !== manufacturerId) return false;
      if (query.trim().length < 1) return true;
      return p.name.toLowerCase().includes(query.toLowerCase());
    });
  }, [allProducts, manufacturerId, query]);

  const save = async () => {
    setBusy(true);
    const res = await fetch("/api/document-products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_id: documentId, product_ids: selectedIds })
    });
    setBusy(false);
    if (!res.ok) return;
    setOpen(false);
    await load();
  };

  const removeLinked = async (productId: string) => {
    const next = selectedIds.filter((id) => id !== productId);
    setSelectedIds(next);
    await fetch("/api/document-products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_id: documentId, product_ids: next })
    });
    await load();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {linked.length === 0 && <span className="text-xs text-slate-500">Нет привязок</span>}
        {linked.map((p) => (
          <span key={p.id} className="inline-flex items-center rounded bg-slate-100 px-2 py-1 text-xs">
            {p.name}
            <button className="ml-1 text-red-600" onClick={() => removeLinked(p.id)}>
              ×
            </button>
          </span>
        ))}
      </div>

      <button className="text-xs text-blue-600 underline" onClick={() => setOpen(true)}>
        Привязать продукты
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-2xl rounded bg-white p-4 shadow-lg">
            <h3 className="mb-3 text-lg font-semibold">Привязка продуктов</h3>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Поиск по названию продукта"
              className="mb-3 w-full rounded border p-2"
            />
            <div className="max-h-80 overflow-auto rounded border">
              {filteredProducts.map((p) => (
                <label key={p.id} className="flex items-center gap-2 border-b p-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(p.id)}
                    onChange={(e) =>
                      setSelectedIds((prev) =>
                        e.target.checked ? [...prev, p.id] : prev.filter((id) => id !== p.id)
                      )
                    }
                  />
                  <span>
                    {p.name} | {p.coating ?? "-"} | {p.flammability ?? "-"}
                  </span>
                </label>
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded border px-3 py-1" onClick={() => setOpen(false)}>
                Отмена
              </button>
              <button
                className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
                disabled={busy}
                onClick={save}
              >
                Сохранить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

