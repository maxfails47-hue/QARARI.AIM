const STORAGE_KEY = "shary-admin-creds";

export interface AdminCreds {
  username: string;
  password: string;
}

export function getStoredCreds(): AdminCreds | null {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function storeCreds(creds: AdminCreds) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
}

export function clearCreds() {
  sessionStorage.removeItem(STORAGE_KEY);
}

// Every admin API call re-sends the username/password as headers (Section 15's
// simple single-admin gate) — a 401 here always means "log in again", most
// often because the stored password in this browser tab's sessionStorage no
// longer matches ADMIN_PASSWORD on the server (e.g. it was rotated, or these
// are leftover creds from an earlier, since-invalidated login). Previously
// this surfaced only as "unauthorized" inside whichever tab happened to be
// open, with no obvious next step — now we clear the stale creds and tell
// the shell to drop back to the login screen automatically.
export async function adminFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const creds = getStoredCreds();
  if (!creds) throw new Error("not_authenticated");

  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-admin-username": creds.username,
      "x-admin-password": creds.password,
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    clearCreds();
    window.dispatchEvent(new Event("admin-unauthorized"));
  }

  return res;
}
