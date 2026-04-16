import { NextRequest, NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth";
import { productSchema } from "@/lib/schemas";
import { getServerSupabase, getServiceSupabase } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

function parseBool(v: string | null) {
  if (v == null) return undefined;
  return v === "true";
}

export async function GET(request: NextRequest) {
  const supabase = getServerSupabase();
  const { searchParams } = new URL(request.url);
  const manufacturer_id = searchParams.get("manufacturer_id");
  const flammability = searchParams.get("flammability");
  const coating = searchParams.get("coating");
  const temp_max = searchParams.get("temp_max");
  const diameter = searchParams.get("diameter");
  const outdoor_use = parseBool(searchParams.get("outdoor_use"));
  const search = searchParams.get("search");

  let query = supabase
    .from("products")
    .select("*, manufacturers(id,name_ru,name_en,synonyms)")
    .order("created_at", { ascending: false });

  if (manufacturer_id) query = query.eq("manufacturer_id", manufacturer_id);
  if (flammability) query = query.eq("flammability", flammability);
  if (coating) query = query.eq("coating", coating);
  if (temp_max) query = query.gte("temp_max", Number(temp_max));
  if (outdoor_use !== undefined) query = query.eq("outdoor_use", outdoor_use);
  if (diameter) {
    const d = Number(diameter);
    query = query.lte("diameter_min", d).gte("diameter_max", d);
  }
  if (search) {
    query = query.or(`name.ilike.%${search}%,application_notes.ilike.%${search}%`);
  }

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
