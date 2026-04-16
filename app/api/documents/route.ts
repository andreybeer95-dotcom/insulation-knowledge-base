import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, doc_type, file_url, file_name, manufacturer_id, created_at, manufacturers(name_ru)")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ documents: data });
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file") as File;
    const title = (formData.get("title") || formData.get("name") || "") as string;
    const manufacturer_id = formData.get("manufacturer_id") as string | null;
    const doc_type = (formData.get("doc_type") || "дополнение") as string;

    if (!file) return NextResponse.json({ error: "Файл не передан" }, { status: 400 });

    const fileName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { error: storageError } = await supabase.storage
      .from("documents")
      .upload(fileName, buffer, { contentType: "application/pdf", upsert: false });

    if (storageError) {
      return NextResponse.json({ error: "Ошибка Storage: " + storageError.message }, { status: 500 });
    }

    const { data: urlData } = supabase.storage.from("documents").getPublicUrl(fileName);

    const { data: doc, error: dbError } = await supabase
      .from("documents")
      .insert({
        title: title || file.name.replace(".pdf", ""),
        file_name: fileName,
        file_url: urlData.publicUrl,
        manufacturer_id: manufacturer_id || null,
        doc_type
      })
      .select("*, manufacturers(name_ru)")
      .single();

    if (dbError) {
      await supabase.storage.from("documents").remove([fileName]);
      return NextResponse.json({ error: "Ошибка БД: " + dbError.message }, { status: 500 });
    }

    extractAndChunk(doc.id, buffer).catch(console.error);

    return NextResponse.json({ document: doc }, { status: 201 });
  }

  const body = await request.json();
  const { data, error } = await supabase
    .from("documents")
    .insert(body)
    .select("*, manufacturers(name_ru)")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ document: data }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const supabase = createClient();
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id обязателен" }, { status: 400 });

  const { data: doc } = await supabase.from("documents").select("file_url, file_name").eq("id", id).single();

  if (doc?.file_name) {
    await supabase.storage.from("documents").remove([doc.file_name]);
  }

  const { error } = await supabase.from("documents").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

async function extractAndChunk(documentId: string, buffer: Buffer) {
  try {
    const supabase = createClient();
    const pdfParse = (await import("pdf-parse")).default as any;
    const pdfData = await pdfParse(buffer);
    const text = pdfData.text as string;

    const chunkSize = 800;
    const overlap = 100;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += chunkSize - overlap) {
      const chunk = text.slice(i, i + chunkSize).trim();
      if (chunk.length > 50) chunks.push(chunk);
    }

    if (chunks.length > 0) {
      await supabase.from("document_chunks").insert(
        chunks.map((chunk, index) => ({
          document_id: documentId,
          content: chunk,
          chunk_index: index,
          metadata: { total_chunks: chunks.length, pages: pdfData.numpages }
        }))
      );
    }

    await supabase.from("documents").update({ extracted_text: text.slice(0, 10000) }).eq("id", documentId);

    console.log(`✅ PDF обработан: ${documentId}, страниц: ${pdfData.numpages}, чанков: ${chunks.length}`);
  } catch (e) {
    console.error(`❌ Ошибка обработки PDF ${documentId}:`, e);
  }
}
