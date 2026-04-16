import { NextRequest, NextResponse } from "next/server";

import { getServerSupabase } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = getServerSupabase();
  const duRaw = new URL(request.url).searchParams.get("du");
  const du = Number(duRaw);
  if (!duRaw || Number.isNaN(du)) {
    return NextResponse.json({ error: "du must be a number" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("diameter_conversion")
    .select("du,outer_diameter_steel,insulation_diameter_mineral")
    .eq("du", du)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 404 });
  return NextResponse.json(data);
}
