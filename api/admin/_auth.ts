import type { VercelRequest } from "@vercel/node";

// Simple single-admin gate for MVP purposes (Section 15). The admin frontend
// stores the username/password in sessionStorage after a successful check
// and re-sends them as headers on every admin API call.
export function isValidAdmin(req: VercelRequest): boolean {
  const username = req.headers["x-admin-username"];
  const password = req.headers["x-admin-password"];
  
  // Section 15: Simplified admin entry. If ADMIN_USERNAME is set in env, we still check it
  // for backward compatibility, but if only password is provided we check that.
  const envUser = process.env.ADMIN_USERNAME || "admin";
  const envPass = process.env.ADMIN_PASSWORD;

  return (
    typeof password === "string" &&
    password === envPass &&
    (username ? username === envUser : true)
  );
}
