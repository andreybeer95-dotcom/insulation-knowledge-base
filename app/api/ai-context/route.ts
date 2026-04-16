import { NextRequest, NextResponse } from "next/server";

import { getServerSupabase } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

const KEYWORDS = ["НГ", "Г1", "котельная", "улица", "ИТП", "ЦТП", "помещение", "оцинковка", "DN", "ДУ"];

function extractDuValues(query: string): number[] {
  const matches = query.matchAll(/(?:ду|dn)\s*([0-9]{1,4})/gi);
  return Array.from(matches).map((m) => Number(m[1])).filter((n) => !Number.isNaN(n));
}

export async function GET(request: NextRequest) {
  const supabase = getServerSupabase();
  const query = new URL(request.url).searchParams.get("query");
  if (!query) return NextResponse.json({ error: "query is required" }, { status: 400 });

  const [manufacturersRes, rulesRes, notesRes] = await Promise.all([
    supabase.from("manufacturers").select("id,name_ru,synonyms"),
    supabase.from("selection_rules").select("*").order("priority", { ascending: true }),
    supabase
      .from("knowledge_notes")
      .select("id,title,content,tags")
      .textSearch("search_vector", query, { type: "websearch", config: "russian" })
      .limit(10)
  ]);

  const low = query.toLowerCase();
  const manufacturers = (manufacturersRes.data ?? []).filter((m: any) => {
    const names = [m.name_ru, ...(m.synonyms ?? [])].map((s: string) => s.toLowerCase());
    return names.some((n) => low.includes(n));
  });

  const duValues = extractDuValues(query);
  const keywordMatches = KEYWORDS.filter((kw) => low.includes(kw.toLowerCase()));

  const { data: conversions } = duValues.length
    ? await supabase
        .from("diameter_conversion")
        .select("du,outer_diameter_steel")
        .in("du", duValues)
    : { data: [] as any[] };

  let productsQuery = supabase
    .from("products")
    .select("id,name,flammability,coating,temp_max,diameter_min,diameter_max,outdoor_use,manufacturer_id");

  if (manufacturers.length > 0) {
    productsQuery = productsQuery.in(
      "manufacturer_id",
      manufacturers.map((m: any) => m.id)
    );
  }
  if (keywordMatches.includes("НГ")) productsQuery = productsQuery.eq("flammability", "НГ");
  if (keywordMatches.includes("Г1")) productsQuery = productsQuery.eq("flammability", "Г1");

  const { data: relevantProducts } = await productsQuery.limit(20);

  const applicableRules = (rulesRes.data ?? []).filter((r: any) => {
    const haystack = `${r.condition} ${r.rule_name} ${r.rule_text}`.toLowerCase();
    return keywordMatches.some((kw) => haystack.includes(kw.toLowerCase()));
  });

  const productIds = (relevantProducts ?? []).map((p: any) => p.id);
  const { data: currentPrices } = productIds.length
    ? await supabase
        .from("prices")
        .select("*")
        .in("product_id", productIds)
        .or("valid_until.is.null,valid_until.gt." + new Date().toISOString().slice(0, 10))
        .limit(30)
    : { data: [] as any[] };

  const formattedContext = [
    "=== БАЗА ЗНАНИЙ ===",
    `Запрос: ${query}`,
    `Производители: ${manufacturers.map((m: any) => m.name_ru).join(", ") || "не найдены"}`,
    `ДУ/DN: ${duValues.join(", ") || "не указаны"}`,
    "Конвертация:",
    ...(conversions ?? []).map((d: any) => `- ДУ${d.du} -> ${d.outer_diameter_steel} мм`),
    "Релевантные продукты:",
    ...(relevantProducts ?? []).map((p: any) => `- ${p.name} [${p.flammability}, ${p.coating}]`),
    "Применимые правила:",
    ...applicableRules.map((r: any) => `- (${r.priority}) ${r.rule_name}: ${r.rule_text}`),
    "Релевантные заметки:",
    ...((notesRes.data ?? []).map((n: any) => `- ${n.title}: ${n.content?.slice(0, 180)}...`) as string[]),
    "Актуальные цены:",
    ...((currentPrices ?? []).map((p: any) => `- ${p.product_id}: ${p.price} ${p.currency}/${p.unit}`) as string[])
  ].join("\n");

  return NextResponse.json({
    query,
    detected: {
      manufacturers: manufacturers.map((m: any) => m.name_ru),
      du_values: duValues,
      converted_diameters: (conversions ?? []).map((d: any) => ({ du: d.du, outer_mm: d.outer_diameter_steel })),
      keywords: keywordMatches
    },
    relevant_products: relevantProducts ?? [],
    applicable_rules: applicableRules,
    relevant_notes: notesRes.data ?? [],
    current_prices: currentPrices ?? [],
    formatted_context: formattedContext
  });
}
