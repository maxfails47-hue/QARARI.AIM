// Normalizes free-typed Egyptian/MENA-style price input into a number.
//
// Fixes a real bug: the price field used to be a raw type="number" input
// parsed with plain parseFloat(), which silently breaks for:
//   - Arabic-Indic digits (٠-٩) that many Arabic-locale keyboards emit by
//     default, even inside a type="number" field
//   - thousands separators ("50,000") — type="number" often rejects the
//     comma keystroke entirely, or silently clears a pasted/autofilled value
//   - casual word-form shorthand ("50 الف", "٥٠ألف", "1.5 مليون") — can't
//     even be typed into a type="number" field since it rejects any
//     non-digit/non-decimal character
//
// Returns null (never 0) when nothing valid could be parsed, so callers
// (and the existing offeredPrice <= 0 validation) can tell "empty/invalid"
// apart from a genuine zero price instead of silently analyzing a 0.

const ARABIC_INDIC_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};
const PERSIAN_DIGITS: Record<string, string> = {
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

function convertDigits(input: string): string {
  return input
    .split("")
    .map((ch) => ARABIC_INDIC_DIGITS[ch] ?? PERSIAN_DIGITS[ch] ?? ch)
    .join("");
}

// "thousand": ألف / الف (Arabic) or a standalone "k"/"K" (Latin, word-bounded
// so it doesn't accidentally match inside another word).
const THOUSAND_WORD = /(ألف|الف|\bk\b)/i;
// "million": مليون (Arabic) or a standalone "m"/"M" (Latin).
const MILLION_WORD = /(مليون|\bm\b)/i;

/**
 * Parse a casually-typed price string into a number.
 * Examples: "50000" -> 50000, "٥٠,٠٠٠" -> 50000, "50 الف" -> 50000,
 * "٥٠ألف" -> 50000, "1.5 مليون" -> 1500000, "" / "abc" -> null.
 */
export function parsePrice(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  let str = convertDigits(String(raw)).trim();
  if (!str) return null;

  // Determine multiplier from a unit word, then strip it out.
  let multiplier = 1;
  if (THOUSAND_WORD.test(str)) {
    multiplier = 1_000;
    str = str.replace(THOUSAND_WORD, "");
  } else if (MILLION_WORD.test(str)) {
    multiplier = 1_000_000;
    str = str.replace(MILLION_WORD, "");
  }

  // Normalize the Arabic decimal separator, then strip thousands
  // separators (commas, the Arabic thousands separator ٬, and any
  // grouping/leftover whitespace).
  str = str
    .replace(/٫/g, ".")
    .replace(/٬/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, "");

  // Keep only digits and a single decimal point.
  str = str.replace(/[^0-9.]/g, "");
  if (!str) return null;

  const n = parseFloat(str);
  if (Number.isNaN(n)) return null;

  return n * multiplier;
}

/** True if the raw string is non-empty but doesn't parse to a usable price. */
export function isPriceInvalid(raw: string): boolean {
  return raw.trim().length > 0 && (parsePrice(raw) === null || (parsePrice(raw) as number) <= 0);
}
