/**
 * Generates a branded, story-format (9:16) PNG of the verdict — the
 * shareable "viral card" iterated on with the product owner. Drawn on an
 * offscreen canvas so it works without adding an image-rendering library.
 *
 * Colors/layout intentionally mirror RevealScreen.tsx so the shared image
 * never contradicts what the app itself shows.
 */

export type ShareCardVerdict = "good" | "fair" | "bad";

export interface ShareCardParams {
  lang: "ar" | "en";
  verdict: ShareCardVerdict;
  productName: string;
  offeredPrice: number;
  fairPrice: number | null; // marketFairPriceMin, same number RevealScreen shows
  currencyShort: string;
  pctLabel: string | null; // e.g. "+132%" or "-18%", already formatted
  copy: {
    tagline: string;
    hookLine: string;
    verdictLabel: string; // goodDeal / fairDeal / revealNotGoodDeal
    offeredLabel: string;
    fairLabel: string; // revealFairPriceFrom
    pctPrefix: string | null; // shareCardPctOverpriced / shareCardPctCheaper
    lockedTitle: string;
    lockedDesc: string;
    ctaLabel: string;
    shareLabel: string;
    footerCta: string;
    brand: string; // appName
  };
}

const W = 1080;
const H = 1920;

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws the full card and resolves with a PNG Blob (or null on failure). */
export async function generateShareCard(p: ShareCardParams): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const isBad = p.verdict === "bad";
  const c1 = isBad ? "#FF4D4D" : "#34D399";
  const c2 = isBad ? "#B91C1C" : "#059669";
  const gold1 = "#F5C451";
  const gold2 = "#D4AF37";

  ctx.direction = p.lang === "ar" ? "rtl" : "ltr";
  const fontFamily = "'Segoe UI', Tahoma, Arial, sans-serif";
  const cx = W / 2;

  // ---- background ----
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createRadialGradient(cx, 0, 0, cx, 0, H * 0.55);
  grad.addColorStop(0, isBad ? "rgba(185,28,28,0.35)" : "rgba(5,150,105,0.35)");
  grad.addColorStop(1, "rgba(11,11,15,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#0B0B0F";
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "source-over";

  // ---- brand row ----
  const brandGrad = ctx.createLinearGradient(70, 60, 130, 120);
  brandGrad.addColorStop(0, gold1);
  brandGrad.addColorStop(1, gold2);
  ctx.fillStyle = brandGrad;
  roundRect(ctx, 70, 60, 56, 56, 16);
  ctx.fill();
  ctx.fillStyle = "#17130A";
  ctx.font = `26px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("✦", 98, 90);

  ctx.fillStyle = gold1;
  ctx.font = `bold 34px Georgia, 'Times New Roman', serif`;
  ctx.textAlign = "left";
  ctx.fillText(p.copy.brand, 142, 96);

  // tagline chip, top-right
  ctx.font = `bold 22px ${fontFamily}`;
  const chipText = p.copy.tagline;
  const chipW = ctx.measureText(chipText).width + 44;
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  roundRect(ctx, W - 70 - chipW, 68, chipW, 44, 22);
  ctx.fill();
  ctx.fillStyle = "#c9c9d2";
  ctx.textAlign = "center";
  ctx.fillText(chipText, W - 70 - chipW / 2, 90);

  // ---- hook line ----
  ctx.font = `bold 33px ${fontFamily}`;
  ctx.fillStyle = "#e6e6ea";
  ctx.textAlign = "center";
  const hookLines = wrapText(ctx, p.copy.hookLine, W - 220);
  let y = 210;
  for (const line of hookLines) {
    ctx.fillText(line, cx, y);
    y += 44;
  }

  // ---- verdict stamp ----
  y += 46;
  ctx.save();
  ctx.translate(cx, y);
  ctx.rotate((-3 * Math.PI) / 180);
  ctx.font = `900 46px ${fontFamily}`;
  const stampText = `${isBad ? "🚫" : "✅"} ${p.copy.verdictLabel}`;
  const stampW = ctx.measureText(stampText).width + 90;
  const stampGrad = ctx.createLinearGradient(-stampW / 2, 0, stampW / 2, 0);
  stampGrad.addColorStop(0, c2);
  stampGrad.addColorStop(1, c1);
  ctx.fillStyle = stampGrad;
  roundRect(ctx, -stampW / 2, -42, stampW, 84, 20);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(stampText, 0, 4);
  ctx.restore();
  y += 90;

  // ---- product name ----
  y += 60;
  ctx.font = `bold 36px ${fontFamily}`;
  ctx.fillStyle = "#F0F0F5";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const nameLines = wrapText(ctx, p.productName, W - 200).slice(0, 2);
  for (const line of nameLines) {
    ctx.fillText(line, cx, y);
    y += 46;
  }

  // ---- percentage badge ----
  if (p.pctLabel && p.copy.pctPrefix) {
    y += 30;
    const pctText = `${p.copy.pctPrefix} ${p.pctLabel}`;
    ctx.font = `900 28px ${fontFamily}`;
    const pctW = ctx.measureText(pctText).width + 56;
    ctx.strokeStyle = isBad ? "rgba(255,77,77,0.5)" : "rgba(52,211,153,0.5)";
    ctx.fillStyle = isBad ? "rgba(255,77,77,0.08)" : "rgba(52,211,153,0.08)";
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    roundRect(ctx, cx - pctW / 2, y - 34, pctW, 56, 28);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = isBad ? c1 : c1;
    ctx.fillText(pctText, cx, y + 4);
    y += 50;
  }

  // ---- price comparison ----
  y += 70;
  const colGap = 90;
  const leftX = cx - colGap;
  const rightX = cx + colGap;
  ctx.font = `24px ${fontFamily}`;
  ctx.fillStyle = "#75757e";
  ctx.textAlign = "center";
  ctx.fillText(p.copy.offeredLabel, leftX, y);
  ctx.fillText(p.copy.fairLabel, rightX, y);

  ctx.font = `900 56px ${fontFamily}`;
  ctx.fillStyle = "#e6e6ea";
  const offeredStr = Math.round(p.offeredPrice).toLocaleString();
  ctx.fillText(offeredStr, leftX, y + 60);

  ctx.font = `40px ${fontFamily}`;
  ctx.fillStyle = "#4a4a52";
  ctx.textBaseline = "middle";
  ctx.fillText("⇄", cx, y + 40);
  ctx.textBaseline = "alphabetic";

  ctx.font = `900 56px ${fontFamily}`;
  ctx.fillStyle = isBad ? c1 : c1;
  const fairStr =
    p.fairPrice === null ? (p.lang === "ar" ? "—" : "N/A") : Math.round(p.fairPrice).toLocaleString();
  ctx.fillText(fairStr, rightX, y + 60);

  ctx.font = `bold 20px ${fontFamily}`;
  ctx.fillStyle = "#75757e";
  ctx.fillText("🔒", rightX, y + 100);

  // ---- locked / unlock box ----
  y += 170;
  const boxW = W - 160;
  const boxX = cx - boxW / 2;
  const boxH = 240;
  ctx.strokeStyle = "rgba(212,175,55,0.35)";
  ctx.fillStyle = "rgba(212,175,55,0.05)";
  ctx.lineWidth = 2;
  roundRect(ctx, boxX, y, boxW, boxH, 22);
  ctx.fill();
  ctx.stroke();

  ctx.font = `40px ${fontFamily}`;
  ctx.fillStyle = "#F5C451";
  ctx.textAlign = "center";
  ctx.fillText("🔒", cx, y + 60);

  ctx.font = `bold 32px ${fontFamily}`;
  ctx.fillStyle = "#F2E7C9";
  ctx.fillText(p.copy.lockedTitle, cx, y + 108);

  ctx.font = `22px ${fontFamily}`;
  ctx.fillStyle = "#9A9AA5";
  const descLines = wrapText(ctx, p.copy.lockedDesc, boxW - 80);
  let dy = y + 148;
  for (const line of descLines) {
    ctx.fillText(line, cx, dy);
    dy += 30;
  }

  y += boxH + 30;

  // ---- CTA button ----
  const ctaH = 96;
  const ctaGrad = ctx.createLinearGradient(boxX, 0, boxX + boxW, 0);
  ctaGrad.addColorStop(0, gold1);
  ctaGrad.addColorStop(0.5, gold2);
  ctaGrad.addColorStop(1, "#B8860B");
  ctx.fillStyle = ctaGrad;
  roundRect(ctx, boxX, y, boxW, ctaH, 20);
  ctx.fill();
  ctx.font = `900 30px ${fontFamily}`;
  ctx.fillStyle = "#17130A";
  ctx.fillText(`⚡ ${p.copy.ctaLabel}`, cx, y + ctaH / 2 + 10);
  y += ctaH + 34;

  // ---- share label ----
  ctx.font = `600 24px ${fontFamily}`;
  ctx.fillStyle = "#9A9AA5";
  ctx.fillText(`🔗 ${p.copy.shareLabel}`, cx, y);
  y += 70;

  // ---- footer CTA ----
  ctx.font = `bold 24px ${fontFamily}`;
  ctx.fillStyle = "#c9c9d2";
  const footerLines = wrapText(ctx, p.copy.footerCta, W - 200);
  for (const line of footerLines) {
    ctx.fillText(line, cx, y);
    y += 32;
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png", 0.95);
  });
}
