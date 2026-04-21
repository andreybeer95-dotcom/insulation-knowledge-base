import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = createClient();
  const { searchParams } = new URL(request.url);
  const document_id = searchParams.get("document_id");

  if (!document_id) {
    return NextResponse.json({ error: "document_id is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("document_products")
    .select("document_id, product_id, products(id, name, coating, flammability)")
    .eq("document_id", document_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ items: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const body = await request.json();
  const document_id = body?.document_id as string | undefined;
  const product_ids = Array.isArray(body?.product_ids) ? (body.product_ids as string[]) : [];

  if (!document_id) {
    return NextResponse.json({ error: "document_id is required" }, { status: 400 });
  }

  const { error: deleteError } = await supabase
    .from("document_products")
    .delete()
    .eq("document_id", document_id);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 400 });
  }

  if (product_ids.length === 0) {
    return NextResponse.json({ success: true, linked: 0 });
  }

  const { error: insertError } = await supabase.from("document_products").insert(
    product_ids.map((product_id) => ({
      document_id,
      product_id
    }))
  );

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 400 });
  }

  return NextResponse.json({ success: true, linked: product_ids.length });
}

