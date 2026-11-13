import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client authenticated with the SECRET key.
 *
 * The secret key bypasses Row Level Security, so this module must never be
 * bundled for the browser. The `server-only` import above turns any accidental
 * import from a Client Component into a build error.
 *
 * The client is created lazily on first use so that scripts can load `.env`
 * before anything reads `process.env`.
 */
let client: SupabaseClient | undefined;

export function getSupabase(): SupabaseClient {
  if (client) return client;

  const url = requireEnv("SUPABASE_URL");
  const secretKey = requireEnv("SUPABASE_SECRET_KEY");

  if (!/^https:\/\/[^/]+$/.test(url.replace(/\/+$/, ""))) {
    throw new Error(
      "SUPABASE_URL must be the bare project URL, e.g. https://<project-ref>.supabase.co " +
        "(no /rest/v1 suffix, not the dashboard URL).",
    );
  }

  client = createClient(url, secretKey, {
    auth: {
      // No end-user sessions on the server: never persist or refresh tokens.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return client;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}
