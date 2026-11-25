import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 Proxy: refreshes Supabase SSR auth cookies on page navigations/reloads
 * when an existing Supabase auth cookie (`sb-*`) is present, preventing SSR refresh-token
 * rotation loss across page reloads. Never blocks guest/public routes or adds latency
 * when no auth cookie is present.
 */
export async function proxy(request: NextRequest) {
  const hasSupabaseAuthCookie = request.cookies
    .getAll()
    .some((cookie) => cookie.name.startsWith("sb-") && cookie.value.length > 0);

  if (!hasSupabaseAuthCookie) {
    return NextResponse.next();
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabasePublishableKey = (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  )?.trim();

  if (!supabaseUrl || !supabasePublishableKey) {
    return NextResponse.next();
  }

  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  try {
    const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });
          response = NextResponse.next({
            request: {
              headers: request.headers,
            },
          });
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    });

    await supabase.auth.getUser();
  } catch {
    // Non-blocking fallback: route-level guards remain authoritative
  }

  return response;
}

export const config = {
  matcher: [
    "/",
    "/map",
    "/admin/:path*",
    "/merchant/:path*",
    "/my/:path*",
    "/login",
    "/signup",
  ],
};
