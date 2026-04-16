import { NextRequest, NextResponse } from "next/server";

import { priceSchema } from "@/lib/schemas";
import { getServerSupabase, getServiceSupabase } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = getServerSupabase();
  const product_id = new URL(request.url).searchParams.get("product_id");
  let query = supabase
    .from("prices")
    .select("*, products(name)")
    .or("valid_until.is.null,valid_until.gt." + new Date().toISOString().slice(0, 10))
    .order("valid_from", { ascending: false });
  if (product_id) query = query.eq("product_id", product_id);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = getServiceSupabase();
  const parsed = priceSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { data, error } = await supabase.from("prices").insert(parsed.data).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data, { status: 201 });
}
