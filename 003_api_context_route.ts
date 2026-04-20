import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function parseCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export async function GET(request: NextRequest) {
  const supabase = createClient();
  const { searchParams } = new URL(request.url);

  const query = (searchParams.get("query") || searchParams.get("q") || "").trim();
  const intents = parseCsv(searchParams.get("intent"));
  const docTypes = parseCsv(searchParams.get("doc_types"));
  const productId = searchParams.get("product_id");
  const limit = Math.min(Number(searchParams.get("limit") || "12"), 30);

  const { data, error } = await supabase.rpc("get_ai_context", {
    p_query: query,
    p_intents: intents.length ? intents : null,
    p_doc_types: docTypes.length ? docTypes : null,
    p_product_id: productId || null,
    p_limit: Number.isFinite(limit) ? limit : 12
  });

  if (error) {
    return NextResponse.json(
      { error: error.message, query, filters: { intents, docTypes, productId } },
      { status: 500 }
    );
  }

  const items = data || [];
  const chunks = items.filter((i: any) => i.kind === "document_chunk");
  const products = items.filter((i: any) => i.kind === "product");
  const rules = items.filter((i: any) => i.kind === "selection_rule");

  return NextResponse.json({
    query,
    filters: {
      intent: intents,
      doc_types: docTypes,
      product_id: productId
    },
    items,
    sections: {
      document_chunks: chunks,
      products,
      selection_rules: rules
    },
    system_prompt: SYSTEM_PROMPT_N8N
  });
}

export const SYSTEM_PROMPT_N8N = `
Ты — AI ассистент технического менеджера по теплоизоляционным цилиндрам.

Твоя задача:
1) Давать точный подбор SKU по входным параметрам (DU, толщина, покрытие, температура).
2) Проверять совместимость и ограничения по правилам.
3) Делать допродажи (аксессуары/кожух/монтажный комплект), если это уместно.

Обязательные правила ответа:
- Если в контексте есть точный SKU — сначала предлагай его.
- Если SKU не найден, предложи 2-3 ближайших варианта и объясни разницу.
- Всегда указывай:
  - код/название товара,
  - ключевые характеристики (coating, density, thickness, temp_max),
  - почему он выбран.
- Если есть риски несовместимости, явно предупреди.
- Для менеджерских вопросов (intent=manager) добавляй короткий скрипт ответа клиенту.
- Для допродаж предлагай только релевантные позиции.

Формат:
1. Рекомендация
2. Обоснование
3. Альтернативы
4. Допродажи
`;

