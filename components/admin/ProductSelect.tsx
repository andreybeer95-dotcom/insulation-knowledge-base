"use client";

import { useEffect, useMemo, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase";

type ProductRow = {
  id: string;
  kod_1c?: string | null;
  name: string;
  coating?: string | null;
  density?: number | null;
  thickness?: number | null;
  manufacturers?: { name_ru?: string | null } | { name_ru?: string | null }[] | null;
};

type ProductSelectProps = {
  value: string | null;
  onChange: (productId: string | null) => void;
  manufacturerId?: string;
};

function manufacturerName(m: ProductRow["manufacturers"]): string {
  if (!m) return "-";
  if (Array.isArray(m)) return m[0]?.name_ru ?? "-";
  return m.name_ru ?? "-";
}

export default function ProductSelect({ value, onChange, manufacturerId }: ProductSelectProps) {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<ProductRow[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    onChange(null);
    setSearch("");
    setItems([]);
  }, [manufacturerId, onChange]);

  useEffect(() => {
    const run = async () => {
      if (search.trim().length < 2) {
        setItems([]);
        return;
      }

      const supabase = getBrowserSupabase();
      if (!supabase) return;

      setLoading(true);
      let query = supabase
        .from("products")
        .select("id, kod_1c, name, coating, density, thickness, manufacturers(name_ru)")
        .or(`name.ilike.%${search}%,kod_1c.ilike.%${search}%`)
        .eq("in_stock", true)
        .limit(20);

      if (manufacturerId) {
        query = query.eq("manufacturer_id", manufacturerId);
      }

      const { data } = await query;
      setItems((data ?? []) as ProductRow[]);
      setLoading(false);
    };

    run();
  }, [search, manufacturerId]);

  const selectedLabel = useMemo(() => {
    const selected = items.find((i) => i.id === value);
    if (!selected) return "";
    return `${selected.name} | ${selected.kod_1c ?? "-"} | ${selected.coating ?? "-"} ${
      selected.density ?? "-"
    }кг/м³ | ${manufacturerName(selected.manufacturers)}`;
  }, [items, value]);

  return (
    <div className="relative">
      <input
        value={selectedLabel || search}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
          if (value) onChange(null);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Поиск продукта (название или код 1С)"
        className="w-full rounded border p-2"
      />
      {open && (
        <div className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded border bg-white shadow">
          {loading && <div className="p-2 text-sm text-slate-500">Поиск...</div>}
          {!loading && items.length === 0 && (
            <div className="p-2 text-sm text-slate-500">Введите минимум 2 символа</div>
          )}
          {!loading &&
            items.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onChange(p.id);
                  setSearch("");
                  setOpen(false);
                }}
                className="block w-full border-b p-2 text-left text-sm hover:bg-slate-50"
              >
                {p.name} | {p.kod_1c ?? "-"} | {p.coating ?? "-"} {p.density ?? "-"}кг/м³ |{" "}
                {manufacturerName(p.manufacturers)}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

