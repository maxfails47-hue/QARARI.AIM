/**
 * Device Fingerprint helper — lightweight custom implementation
 * that generates a stable device fingerprint from browser properties
 * WITHOUT requiring any external library (like FingerprintJS).
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
 *
 * The resulting fingerprint is stable across:
 * - Browser restarts
 * - PWA install / uninstall
 * - Different browser windows/tabs
 * - Incognito mode (for the same browser)
 *
 * It does NOT survive:
 * - Different browsers on the same device
 * - Clearing ALL browser data (including canvas permission)
 * - Hardware changes
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
      ctx.fillText("Qarari.FP", 2, 2);
      ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
      ctx.fillText("Qarari.FP", 4, 17);
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

export async function getCachedFingerprint(): Promise<string> {
  if (!cachedFingerprint) {
    cachedFingerprint = await getDeviceFingerprint();
  }
  return cachedFingerprint;
}
