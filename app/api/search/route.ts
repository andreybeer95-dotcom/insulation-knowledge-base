import { NextRequest, NextResponse } from "next/server";

import { getServerSupabase } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

function snippet(text: string, maxLen = 260) {
  const cleaned = (text || "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + "…";
}

function formatContext(params: {
  query: string;
  products: any[];
  notes: any[];
  documentChunks: any[];
}) {
  const lines: string[] = [];
  lines.push("## Search context");
  lines.push(`**Query:** ${params.query}`);
  lines.push("");

  lines.push("### Products");
  if (!params.products.length) {
    lines.push("_No matching products._");
  } else {
    for (const p of params.products.slice(0, 10)) {
      lines.push(`- **${p.name}** (${p.flammability ?? "—"}, ${p.coating ?? "—"})`);
      if (p.application_notes) lines.push(`  - ${snippet(p.application_notes, 180)}`);
    }
  }
  lines.push("");

  lines.push("### Knowledge notes");
  if (!params.notes.length) {
    lines.push("_No matching notes._");
  } else {
    for (const n of params.notes.slice(0, 6)) {
      lines.push(`- **${n.title}**`);
      lines.push(`  - ${snippet(n.content, 220)}`);
      if (n.tags?.length) lines.push(`  - tags: ${n.tags.join(", ")}`);
    }
  }
  lines.push("");

  lines.push("### Documents (PDF content matches)");
  if (!params.documentChunks.length) {
    lines.push("_No matching PDF chunks._");
  } else {
    // Group by document
    const byDoc = new Map<string, { doc: any; chunks: any[] }>();
    for (const row of params.documentChunks) {
      const docId = row.document_id;
      const doc = row.documents;
      if (!byDoc.has(docId)) byDoc.set(docId, { doc, chunks: [] });
      byDoc.get(docId)!.chunks.push(row);
    }
    for (const [docId, group] of Array.from(byDoc.entries()).slice(0, 8)) {
      lines.push(`- **${group.doc?.title ?? "Document"}** (${group.doc?.doc_type ?? "—"})`);
      if (group.doc?.file_url) lines.push(`  - url: ${group.doc.file_url}`);
      for (const c of group.chunks.slice(0, 2)) {
        lines.push(`  - chunk #${c.chunk_index}: ${snippet(c.content, 240)}`);
      }
      lines.push(`  - document_id: ${docId}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

export async function GET(request: NextRequest) {
  const supabase = getServerSupabase();
  const q = new URL(request.url).searchParams.get("q");
  if (!q) return NextResponse.json({ error: "q is required" }, { status: 400 });

  const [productsRes, notesRes, docsRes, chunksRes] = await Promise.all([
    supabase
      .from("products")
      .select("id,name,application_notes,manufacturer_id,flammability,coating")
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
    ,
    supabase
      .from("document_chunks")
      .select("document_id,chunk_index,content, documents(title,file_url,doc_type)")
      .textSearch("search_vector", q, { type: "websearch", config: "russian" })
      .order("chunk_index", { ascending: true })
      .limit(25)
  ]);

  let documentChunks = chunksRes.data ?? [];
  // Fallback: if FTS returns nothing, try ILIKE
  if (!documentChunks.length) {
    const fallback = await supabase
      .from("document_chunks")
      .select("document_id,chunk_index,content, documents(title,file_url,doc_type)")
      .ilike("content", `%${q}%`)
      .order("chunk_index", { ascending: true })
      .limit(25);
    documentChunks = fallback.data ?? [];
  }

  const formatted_context = formatContext({
    query: q,
    products: productsRes.data ?? [],
    notes: notesRes.data ?? [],
    documentChunks
  });

  return NextResponse.json({
    query: q,
    products: productsRes.data ?? [],
    notes: notesRes.data ?? [],
    documents: docsRes.data ?? [],
    document_chunks: documentChunks,
    formatted_context
  });
}
