import { NextResponse } from "next/server";

import { getServerSupabase } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

function statusFromDate(date: string | null): "active" | "expiring_soon" | "expired" {
  if (!date) return "active";
  const now = new Date();
  const valid = new Date(date);
  if (valid < now) return "expired";
  const days = (valid.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (days <= 90) return "expiring_soon";
  return "active";
}

export async function GET() {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from("certificates")
    .select("*, products(id,name,manufacturer_id)")
    .order("valid_until", { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  const items = (data ?? []).map((item: any) => ({
    ...item,
    status: statusFromDate(item.valid_until)
  }));
  return NextResponse.json({ items });
}
