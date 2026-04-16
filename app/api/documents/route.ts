import { NextRequest, NextResponse } from "next/server";

import { getServerSupabase, getServiceSupabase } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

function chunkText(text: string, maxChars = 1800) {
  const cleaned = text.replace(/\r/g, "").trim();
  if (!cleaned) return [];
  const chunks: string[] = [];
  for (let i = 0; i < cleaned.length; i += maxChars) {
    chunks.push(cleaned.slice(i, i + maxChars));
  }
  return chunks;
}

export async function GET() {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("documents")
    .select("*, manufacturers(name_ru), products(name)")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = getServiceSupabase();
  const form = await request.formData();
  const file = form.get("file") as File | null;
  const title = String(form.get("title") || "");
  const doc_type = String(form.get("doc_type") || "дополнение");
  const product_id = (form.get("product_id") as string) || null;
  const manufacturer_id = (form.get("manufacturer_id") as string) || null;
  const uploaded_by = (form.get("uploaded_by") as string) || "admin";
  if (!file || !title) {
    return NextResponse.json({ error: "file and title are required" }, { status: 400 });
  }

  const filePath = `${Date.now()}-${file.name}`.replaceAll("\\", "_");
  const arrayBuffer = await file.arrayBuffer();
  const fileSize = arrayBuffer.byteLength;
  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(filePath, arrayBuffer, { contentType: file.type || "application/octet-stream", upsert: true });
  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 400 });

  const { data: urlData } = supabase.storage.from("documents").getPublicUrl(filePath);

  let extracted_text: string | null = null;
  let pages_count: number | null = null;
  if ((file.type || "").toLowerCase().includes("pdf") || file.name.toLowerCase().endsWith(".pdf")) {
    try {
      const pdf = (await import("pdf-parse")).default as any;
      const parsed = await pdf(Buffer.from(arrayBuffer));
      extracted_text = parsed?.text ?? null;
      pages_count = parsed?.numpages ?? null;
    } catch (e: any) {
      // Non-fatal: store without extracted text
      extracted_text = null;
      pages_count = null;
    }
  }

  const { data, error } = await supabase
    .from("documents")
    .insert({
      product_id,
      manufacturer_id,
      doc_type,
      title,
      file_url: urlData.publicUrl,
      file_name: file.name,
      uploaded_by,
      storage_path: filePath,
      file_size: fileSize,
      pages_count,
      extracted_text
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  if (extracted_text) {
    const chunks = chunkText(extracted_text);
    if (chunks.length) {
      const rows = chunks.map((content, idx) => ({
        document_id: data.id,
        chunk_index: idx,
        content
      }));
      await supabase.from("document_chunks").insert(rows);
    }
  }

  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const supabase = getServiceSupabase();
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const { data: doc, error: fetchError } = await supabase
    .from("documents")
    .select("id, storage_path")
    .eq("id", id)
    .single();
  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 400 });

  if (doc?.storage_path) {
    await supabase.storage.from("documents").remove([doc.storage_path]);
  }

  const { error } = await supabase.from("documents").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
