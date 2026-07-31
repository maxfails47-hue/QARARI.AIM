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
export function isValidAdmin(req: VercelRequest): boolean {
  const password = req.headers["x-admin-password"];
  const envPass = process.env.ADMIN_PASSWORD;

  return typeof password === "string" && !!envPass && password === envPass;
}
