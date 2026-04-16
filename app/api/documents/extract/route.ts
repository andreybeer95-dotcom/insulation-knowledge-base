import { NextRequest, NextResponse } from "next/server";

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

  const response = await fetch(file_url);
  if (!response.ok) {
    return NextResponse.json({ error: "Unable to fetch file" }, { status: 400 });
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const pdf = (await import("pdf-parse")).default;
  const parsed = await pdf(buffer);

  const { error } = await supabase
    .from("documents")
    .update({ extracted_text: parsed.text })
    .eq("id", document_id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, chars: parsed.text.length });
}
