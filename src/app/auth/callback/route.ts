import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const next = requestUrl.searchParams.get("next") || "/dashboard";
  const supabase = await getSupabaseServerClient();
  if (supabase && code) await supabase.auth.exchangeCodeForSession(code);
  return NextResponse.redirect(new URL(next.startsWith("/") ? next : "/dashboard", requestUrl.origin));
}
