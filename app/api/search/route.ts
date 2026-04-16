import { NextRequest, NextResponse } from "next/server";

import { getServerSupabase } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = getServerSupabase();
  const q = new URL(request.url).searchParams.get("q");
  if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });

  const [productsRes, notesRes, docsRes] = await Promise.all([
    supabase
      .from("products")
      .select("id,name,application_notes,manufacturer_id")
      .textSearch("search_vector", q, { type: "websearch", config: "russian" })
      .limit(15),
    supabase
      .from("knowledge_notes")
      .select("id,title,content,tags")
      .textSearch("search_vector", q, { type: "websearch", config: "russian" })
      .limit(15),
    supabase
      .from("documents")
      .select("id,title,file_url,doc_type,manufacturer_id,product_id")
      .textSearch("search_vector", q, { type: "websearch", config: "russian" })
      .limit(15)
  ]);

  return NextResponse.json({
    query: q,
    products: productsRes.data ?? [],
    notes: notesRes.data ?? [],
    documents: docsRes.data ?? []
  });
}
