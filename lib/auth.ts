import { NextRequest } from "next/server";

import { getServerSupabase } from "./server-supabase";

export async function requireAuth(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return { ok: false as const, error: "Authorization Bearer token is required" };
  const supabase = getServerSupabase();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return { ok: false as const, error: "Unauthorized" };
  return { ok: true as const, user: data.user };
}
