import { NextRequest, NextResponse } from "next/server";

import { getServerSupabase, getServiceSupabase } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

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

  const filePath = `${Date.now()}-${file.name}`;
  const arrayBuffer = await file.arrayBuffer();
  const { error: uploadError } = await supabase.storage
    .from("documents")
    .upload(filePath, arrayBuffer, { contentType: file.type || "application/octet-stream", upsert: true });
  if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 400 });

  const { data: urlData } = supabase.storage.from("documents").getPublicUrl(filePath);
  const { data, error } = await supabase
    .from("documents")
    .insert({
      product_id,
      manufacturer_id,
      doc_type,
      title,
      file_url: urlData.publicUrl,
      file_name: file.name,
      uploaded_by
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data, { status: 201 });
}
