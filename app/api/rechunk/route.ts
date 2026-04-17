import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function splitTextIntoChunks(text: string, chunkSize = 1000, overlap = 200): string[] {
  const chunks: string[] = [];
  if (!text?.trim()) return chunks;
  const step = Math.max(1, chunkSize - overlap);
  for (let i = 0; i < text.length; i += step) {
    const chunk = text.slice(i, i + chunkSize).trim();
    if (chunk.length > 50) chunks.push(chunk);
  }
  return chunks;
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const body = await request.json();
  const document_id = body?.document_id as string | undefined;
  if (!document_id) {
    return NextResponse.json({ error: "document_id is required" }, { status: 400 });
  }

  const { data: doc, error: docErr } = await supabase
    .from("documents")
    .select("id,file_url,notes")
    .eq("id", document_id)
    .single();
  if (docErr || !doc?.file_url) {
    return NextResponse.json({ error: docErr?.message ?? "Document not found" }, { status: 404 });
  }

  const fileResponse = await fetch(doc.file_url);
  if (!fileResponse.ok) {
    return NextResponse.json({ error: "Unable to fetch PDF by file_url" }, { status: 400 });
  }
  const buffer = Buffer.from(await fileResponse.arrayBuffer());

  const pdfParse = (await import("pdf-parse")).default as any;
  const parsedPdf = await pdfParse(buffer);
  const extractedText = parsedPdf.text?.trim() || "";

  await supabase.from("document_chunks").delete().eq("document_id", document_id);

  if (extractedText.length < 50) {
    const existingNotes = (doc.notes as string | null) ?? null;
    const marker = "[СКАН: текст не извлечён, требуется OCR]";
    const nextNotes =
      existingNotes && existingNotes.includes(marker)
        ? existingNotes
        : (existingNotes ? existingNotes + "\n" : "") + marker;

    await supabase
      .from("documents")
      .update({ extracted_text: "", notes: nextNotes })
      .eq("id", document_id);

    return NextResponse.json({
      success: true,
      warning: "PDF является сканом — текст не извлечён",
      chunks_created: 0
    });
  }

  const chunks = splitTextIntoChunks(extractedText, 1000, 200);
  if (chunks.length) {
    await supabase.from("document_chunks").insert(
      chunks.map((chunk, index) => ({
        document_id,
        content: chunk,
        chunk_index: index,
        metadata: { total_chunks: chunks.length, pages: parsedPdf.numpages }
      }))
    );
  }

  await supabase
    .from("documents")
    .update({ extracted_text: extractedText.slice(0, 10000) })
    .eq("id", document_id);

  return NextResponse.json({
    success: true,
    chunks_created: chunks.length
  });
}

