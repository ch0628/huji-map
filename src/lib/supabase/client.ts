import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

let clientInstance: SupabaseClient<Database> | null = null;
let cachedKeySignature: string | null = null;

/**
 * Creates or retrieves the singleton Supabase browser client.
 * Prioritizes NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY with fallback to NEXT_PUBLIC_SUPABASE_ANON_KEY.
 * AGENTS.md Rule 12: Throws a safe configuration error if environment variables are missing.
 */
export function createClient(): SupabaseClient<Database> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabasePublishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error(
      "Supabase browser client configuration is missing. Please set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY)."
    );
  }

  const signature = `${supabaseUrl}::${supabasePublishableKey}`;
  if (clientInstance && cachedKeySignature === signature) {
    return clientInstance;
  }

  clientInstance = createBrowserClient<Database>(supabaseUrl, supabasePublishableKey);
  cachedKeySignature = signature;
  return clientInstance;
}
