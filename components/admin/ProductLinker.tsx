"use client";

import { useEffect, useMemo, useState } from "react";

type Product = {
  id: string;
  name: string;
  coating?: string | null;
  density?: number | null;
  kod_1c?: string | null;
  manufacturer_id?: string | null;
};

type LinkedProductRow = {
  product_id: string;
  products?: Product | Product[] | null;
};

interface Props {
  documentId: string;
  manufacturerId?: string | null;
}

function unwrapProduct(p: Product | Product[] | null | undefined): Product | null {
  if (!p) return null;
  return Array.isArray(p) ? p[0] ?? null : p;
}

export default function ProductLinker({ documentId, manufacturerId }: Props) {
  const [linkedProducts, setLinkedProducts] = useState<Product[]>([]);
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const loadData = async () => {
    const [linksRes, productsRes] = await Promise.all([
      fetch(`/api/document-products?document_id=${encodeURIComponent(documentId)}`),
      fetch("/api/products")
    ]);
    const linksJson = await linksRes.json();
    const productsJson = await productsRes.json();

    const linkedRows = (linksJson.linked_products ?? []) as LinkedProductRow[];
    const linked = linkedRows
      .map((row) => unwrapProduct(row.products))
      .filter((p): p is Product => Boolean(p));

    setLinkedProducts(linked);
    setSelectedIds(linked.map((p) => p.id));
    setAllProducts((productsJson.items ?? []) as Product[]);
  };

  useEffect(() => {
    loadData();
  }, [documentId]);

  const filteredProducts = useMemo(() => {
    return allProducts.filter((p) => {
      if (manufacturerId && p.manufacturer_id !== manufacturerId) return false;
      if (!query.trim()) return true;
      return p.name.toLowerCase().includes(query.toLowerCase());
    });
  }, [allProducts, manufacturerId, query]);

  const saveLinks = async () => {
    setSaving(true);
    const res = await fetch("/api/document-products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_id: documentId, product_ids: selectedIds })
    });
    setSaving(false);
    if (!res.ok) return;
    setOpen(false);
    await loadData();
  };

  const removeLinked = async (id: string) => {
    const next = selectedIds.filter((x) => x !== id);
    setSelectedIds(next);
    await fetch("/api/document-products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_id: documentId, product_ids: next })
    });
    await loadData();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {linkedProducts.length === 0 && <span className="text-xs text-slate-500">Нет привязок</span>}
        {linkedProducts.map((p) => (
          <span key={p.id} className="inline-flex items-center rounded bg-slate-100 px-2 py-1 text-xs">
            {p.name}
            <button className="ml-1 text-red-600" onClick={() => removeLinked(p.id)}>
              ×
            </button>
          </span>
        ))}
      </div>

      <button type="button" className="text-xs text-blue-600 underline" onClick={() => setOpen(true)}>
        Привязать продукты
      </button>

      {open && (
        <div className="mt-2 rounded border bg-white p-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск продукта"
            className="mb-2 w-full rounded border p-2 text-sm"
          />
          <div className="max-h-56 overflow-auto rounded border">
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
                  {p.name} | {p.kod_1c ?? "—"} | {p.coating ?? "-"} | {p.density ?? "-"}кг/м³
                </span>
              </label>
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="rounded border px-3 py-1 text-sm" onClick={() => setOpen(false)}>
              Отмена
            </button>
            <button
              type="button"
              className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
              disabled={saving}
              onClick={saveLinks}
            >
              Сохранить
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

