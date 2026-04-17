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

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const id = params.id;
  const body = await request.json();
  const manualText = String(body?.manual_text ?? "").trim();

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (manualText.length <= 50) {
    return NextResponse.json({ error: "manual_text must be longer than 50 characters" }, { status: 400 });
  }

  const chunks = splitTextIntoChunks(manualText, 1000, 200);

  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("notes")
    .eq("id", id)
    .single();
  if (docError) {
    return NextResponse.json({ error: docError.message }, { status: 500 });
  }

  const notesRaw = String(doc?.notes ?? "");
  const notesClean = notesRaw
    .split("\n")
    .filter((line) => !line.includes("[СКАН: текст не извлечён, требуется OCR]"))
    .join("\n")
    .trim();

  const { error: updateError } = await supabase
    .from("documents")
    .update({ extracted_text: manualText.slice(0, 10000), notes: notesClean || null })
    .eq("id", id);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  const { error: deleteError } = await supabase.from("document_chunks").delete().eq("document_id", id);
  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  if (chunks.length > 0) {
    const { error: insertError } = await supabase.from("document_chunks").insert(
      chunks.map((chunk, index) => ({
        document_id: id,
        content: chunk,
        chunk_index: index,
        metadata: { total_chunks: chunks.length, source: "manual_text" }
      }))
    );
    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ success: true, chunks_created: chunks.length });
}

