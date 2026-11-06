import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";

let clientInstance: SupabaseClient<Database> | null = null;

/**
 * Creates or retrieves the singleton Supabase browser client.
 * AGENTS.md Rule 12: Throws a safe configuration error if environment variables are missing.
 */
export function createClient(): SupabaseClient<Database> {
  if (clientInstance) {
    return clientInstance;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Supabase browser client configuration is missing. Please set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }

  clientInstance = createBrowserClient<Database>(supabaseUrl, supabaseAnonKey);
  return clientInstance;
}
