import { createClient } from "@supabase/supabase-js";
import { logEnvPresence } from "./_logger.js";

// Server-side ONLY. Uses the service role key, which bypasses Row Level
// Security — this file must never be imported into any client/browser code.
// It is only ever imported from files inside /api.
export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL as string;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY as string;

  if (!url || !serviceKey) {
    console.error("[SupabaseAdmin] Missing required env vars");
    logEnvPresence({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: serviceKey });
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars");
  }

  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Verifies the request's Authorization: Bearer <token> header against
// Supabase Auth and returns the authenticated user, or null for a guest.
export async function getAuthedUser(req: { headers: Record<string, string | string[] | undefined> }) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  const token = typeof authHeader === "string" ? authHeader.replace("Bearer ", "") : null;
  if (!token) {
    console.log("[SupabaseAdmin] No Authorization header — treating as guest");
    return null;
  }

  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data.user) {
      console.warn("[SupabaseAdmin] Token present but auth.getUser failed:", error?.message);
      return null;
    }
    return data.user;
  } catch (error: any) {
    console.error("[SupabaseAdmin] getAuthedUser threw:");
    console.error(error);
    console.error(error?.stack);
    throw error;
  }
}
