import type { VercelRequest } from "@vercel/node";

// Simple single-admin gate for MVP purposes (Section 15). The admin frontend
// stores the password in sessionStorage after a successful check and
// re-sends it as a header on every admin API call.
//
// This used to also check an ADMIN_USERNAME env var against a hardcoded
// "admin" sent by the frontend. That added no real security (there's only
// one admin, so a username adds nothing a password check doesn't already
// give you) but it DID create a failure mode: if ADMIN_USERNAME was ever
// set to anything other than "admin" in Vercel, the initial login (which
// only ever checked the password) would succeed, but every subsequent
// request would silently fail the username comparison and 401 — making it
// look like the password itself was being rejected on every follow-up
// call, in an endless loop back to the login screen. Password-only check
// removes that whole class of bug.
//
// ---- Brute-force throttle ----
// A single fixed password with zero rate limiting means anyone who finds
// this endpoint can script unlimited guesses. This is an in-memory
// per-IP throttle: after 10 failed attempts, that IP is locked out for 15
// minutes. It resets on a cold start (serverless instances aren't
// long-lived) so it's not a hard guarantee, but it removes the trivial
// "just script it" attack and meaningfully slows a real attempt.
const failedAttempts = new Map<string, { count: number; lockedUntil?: number }>();
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

function getClientIp(req: VercelRequest): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
}

export function isValidAdmin(req: VercelRequest): boolean {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = failedAttempts.get(ip);

  if (entry?.lockedUntil && now < entry.lockedUntil) {
    return false;
  }

  const password = req.headers["x-admin-password"];
  const envPass = process.env.ADMIN_PASSWORD;
  const ok = typeof password === "string" && !!envPass && password === envPass;

  if (ok) {
    failedAttempts.delete(ip);
    return true;
  }

  const next = { count: (entry?.count || 0) + 1, lockedUntil: entry?.lockedUntil };
  if (next.count >= MAX_ATTEMPTS) {
    next.lockedUntil = now + LOCKOUT_MS;
    next.count = 0;
    console.warn(`[admin auth] IP ${ip} locked out for 15min after ${MAX_ATTEMPTS} failed admin login attempts`);
  }
  failedAttempts.set(ip, next);
  return false;
}

