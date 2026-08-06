/**
 * Device Fingerprint helper for guest scan-quota tracking.
 *
 * The primary identifier (see getCachedFingerprint below) is now a random ID
 * persisted in localStorage on first use — this is what's actually sent to
 * the server as `deviceFingerprint`.
 *
 * getDeviceFingerprint() below (canvas/WebGL/screen/timezone/etc.) is kept
 * only as a fallback for the rare case localStorage is unavailable. It is
 * NOT reliably stable across separate launches of an installed PWA /
 * home-screen shortcut — some browsers (notably iOS Safari/WebKit) add
 * randomized per-session noise to canvas readback specifically to defeat
 * this kind of fingerprinting, which used to make every shortcut relaunch
 * look like a brand-new device to the server.
 *
 * This uses a combination of:
 * - Canvas fingerprint (unique per GPU/driver combination)
 * - WebGL fingerprint
 * - Screen resolution
 * - Timezone offset
 * - Language
 * - Platform
 * - Do-not-track setting
 * - Hardware concurrency
 * - Device memory
 */

export async function getDeviceFingerprint(): Promise<string> {
  const components: string[] = [];

  // 1. Canvas fingerprint
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 50;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      // Draw text with specific styling to create unique rendering
      ctx.textBaseline = "top";
      ctx.font = "14px 'Arial'";
      ctx.fillStyle = "#f60";
      ctx.fillRect(100, 1, 62, 20);
      ctx.fillStyle = "#069";
      ctx.fillText("Shary.FP", 2, 2);
      ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
      ctx.fillText("Shary.FP", 4, 17);
      const dataUrl = canvas.toDataURL();
      components.push("canvas:" + simpleHash(dataUrl));
    }
  } catch {
    components.push("canvas:none");
  }

  // 2. WebGL fingerprint
  try {
    const gl = document.createElement("canvas").getContext("webgl") ||
              document.createElement("canvas").getContext("experimental-webgl");
    if (gl) {
      const debugInfo = (gl as WebGLRenderingContext).getExtension("WEBGL_debug_renderer_info");
      if (debugInfo) {
        const renderer = (gl as WebGLRenderingContext).getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        const vendor = (gl as WebGLRenderingContext).getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
        components.push("webgl:" + simpleHash(renderer + "|" + vendor));
      } else {
        components.push("webgl:generic");
      }
    }
  } catch {
    components.push("webgl:none");
  }

  // 3. Screen + viewport
  components.push("screen:" + screen.width + "x" + screen.height + ":" + screen.colorDepth);

  // 4. Timezone
  components.push("tz:" + new Date().getTimezoneOffset());

  // 5. Language
  components.push("lang:" + navigator.language);

  // 6. Platform
  components.push("platform:" + navigator.platform);

  // 7. Do Not Track
  components.push("dnt:" + (navigator.doNotTrack === "1" ? "1" : "0"));

  // 8. Hardware concurrency (CPU cores)
  components.push("cores:" + (navigator.hardwareConcurrency || "unknown"));

  // 9. Device memory
  components.push("mem:" + ((navigator as any).deviceMemory || "unknown"));

  // 10. Available plugins count
  components.push("plugins:" + navigator.plugins.length);

  // 11. Touch support
  components.push("touch:" + ("ontouchstart" in window ? "1" : "0"));

  // 12. Cookie enabled
  components.push("cookies:" + (navigator.cookieEnabled ? "1" : "0"));

  // Combine all components and hash
  const raw = components.join("|");
  return "fp_" + simpleHash(raw);
}

/**
 * Simple but effective hash function (djb2 variant)
 * Returns a hex string representation of the hash.
 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  // Convert to unsigned and hex
  const unsigned = hash >>> 0;
  return unsigned.toString(16).padStart(8, "0");
}

// Cache the fingerprint for the session (no need to recompute every time)
let cachedFingerprint: string | null = null;

const DEVICE_ID_KEY = "shary_device_id";

function generateRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers/WebViews without crypto.randomUUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * A random ID generated once and persisted in localStorage — this is what
 * actually stays stable across relaunches of an installed PWA / home-screen
 * shortcut. Returns null only if localStorage itself is unavailable (rare:
 * some strict-private-mode in-app browsers).
 */
function getOrCreatePersistedDeviceId(): string | null {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const fresh = "dev_" + generateRandomId();
    localStorage.setItem(DEVICE_ID_KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}

/**
 * Guest device identifier sent to the server for scan-quota tracking.
 *
 * IMPORTANT: this now PREFERS the localStorage-persisted ID over the raw
 * canvas/WebGL environmental fingerprint from getDeviceFingerprint(). That
 * environmental fingerprint is NOT reliably stable between separate launches
 * of an installed home-screen shortcut/PWA — several browsers (most notably
 * iOS Safari/WebKit) deliberately add randomized noise to canvas readback on
 * a per-session basis as an anti-fingerprinting measure, and a standalone
 * app relaunch is often treated as a brand-new session. That was silently
 * making every shortcut/app open look like a brand-new device to the
 * server, resetting the guest's scan quota to full each time even though
 * they hadn't actually gotten new scans.
 *
 * A localStorage-persisted random ID survives app relaunches (same storage,
 * read back as-is) even though the environmental fingerprint underneath it
 * does not, which is exactly what makes it a reliable quota key here.
 *
 * The old environmental fingerprint is kept only as a last-resort fallback
 * for the rare case localStorage itself isn't available.
 */
export async function getCachedFingerprint(): Promise<string> {
  if (cachedFingerprint) return cachedFingerprint;

  const persisted = getOrCreatePersistedDeviceId();
  if (persisted) {
    cachedFingerprint = persisted;
    return cachedFingerprint;
  }

  cachedFingerprint = await getDeviceFingerprint();
  return cachedFingerprint;
}
