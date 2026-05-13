import { NextRequest, NextResponse } from "next/server";

import { extractTextWithOCR } from "@/lib/ocr";
import { getServiceSupabase } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const supabase = getServiceSupabase();
  const body = await request.json();
  const file_url = body.file_url as string | undefined;
  const document_id = body.document_id as string | undefined;
  if (!file_url || !document_id) {
    return NextResponse.json({ error: "file_url and document_id are required" }, { status: 400 });
  }

  const response = await fetch(file_url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "application/pdf,*/*",
      "Accept-Language": "ru-RU,ru;q=0.9",
      Referer: "https://rwl.ru/",
    },
  });
  if (!response.ok) {
    return NextResponse.json({ error: "Unable to fetch file" }, { status: 400 });
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const pdf = (await import("pdf-parse")).default;
  const parsed = await pdf(buffer);

  let extractedText = parsed.text;

  if (extractedText.trim().length < 100) {
    try {
      console.log("Text too short, trying Google Vision OCR...");
      extractedText = await extractTextWithOCR(buffer);
      console.log("Vision OCR result:", extractedText.length, "chars");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.log("Vision OCR failed:", message);
      /* keep pdf-parse result */
    }
  }

  const { error } = await supabase
    .from("documents")
    .update({ extracted_text: extractedText })
    .eq("id", document_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, chars: extractedText.length });
}
