import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth";
import { productSchema } from "@/lib/schemas";
import { getServerSupabase, getServiceSupabase } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = getServerSupabase();
  const { searchParams } = new URL(request.url);
  const manufacturer_id = searchParams.get("manufacturer_id");

  let query = supabase
    .from("products")
    .select("id, name, coating, density, kod_1c, manufacturer_id, temp_max")
    .order("name", { ascending: true });

  if (manufacturer_id) query = query.eq("manufacturer_id", manufacturer_id);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  const supabase = getServiceSupabase();
  const body = await request.json();
  const parsed = productSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { data, error } = await supabase
    .from("products")
    .insert(parsed.data)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data, { status: 201 });
}
