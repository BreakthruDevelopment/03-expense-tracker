/**
 * Dev-only: draws the synthetic demo receipts into public/demo-receipts (PNG, each under 150 KB).
 *   pnpm demo:receipts
 * The PNGs are committed; this only needs running when src/lib/demo-receipt-data.ts changes.
 * Text is drawn with a system monospace font (DejaVu Sans Mono), so install it on other machines.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { DEMO_RECEIPTS, type DemoReceiptSpec } from "../src/lib/demo-receipt-data";

const OUT = path.join(process.cwd(), "public", "demo-receipts");
const W = 420;
const MAX_BYTES = 150 * 1024;
const FONT = "DejaVu Sans Mono";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (symbol: string, n: number) => `${symbol}${n.toFixed(2)}`;

function receiptSvg(r: DemoReceiptSpec): string {
  const rows: string[] = [];
  let y = 56;
  const text = (s: string, o: { size?: number; anchor?: "start" | "middle" | "end"; x?: number; weight?: string; fill?: string } = {}) => {
    const anchor = o.anchor ?? "start";
    const x = o.x ?? (anchor === "middle" ? W / 2 : anchor === "end" ? W - 32 : 32);
    rows.push(`<text x="${x}" y="${y}" font-family="${FONT}" font-size="${o.size ?? 15}" font-weight="${o.weight ?? "normal"}" fill="${o.fill ?? "#222"}" text-anchor="${anchor}">${esc(s)}</text>`);
  };
  const row = (left: string, right: string, weight = "normal") => {
    text(left, { weight });
    text(right, { anchor: "end", weight });
    y += 26;
  };
  const rule = () => {
    rows.push(`<line x1="32" y1="${y - 14}" x2="${W - 32}" y2="${y - 14}" stroke="#999" stroke-dasharray="4 3"/>`);
    y += 8;
  };

  text(r.title, { anchor: "middle", size: 22, weight: "bold" });
  y += 24;
  text(r.address, { anchor: "middle", size: 12, fill: "#555" });
  y += 22;
  text(`Date: ${r.date}`, { anchor: "middle", size: 13 });
  y += 30;
  rule();
  for (const li of r.lines) row(li.description.slice(0, 26), money(r.symbol, li.amount));
  rule();
  if (r.tax !== null) row("Tax", money(r.symbol, r.tax));
  row("TOTAL", `${r.currency} ${r.total.toFixed(2)}`, "bold");
  y += 4;
  for (const f of r.footer) {
    text(f, { anchor: "middle", size: 12, fill: "#555" });
    y += 20;
  }
  if (r.injectedText) {
    y += 14;
    const top = y - 24;
    const height = r.injectedText.length * 22 + 20;
    rows.push(`<rect x="24" y="${top}" width="${W - 48}" height="${height}" fill="#fff4cc" stroke="#c00" stroke-width="2"/>`);
    for (const line of r.injectedText) {
      text(line, { anchor: "middle", size: 14, weight: "bold", fill: "#a00000" });
      y += 22;
    }
    y += 10;
  }
  const H = y + 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fdfcf7"/>${rows.join("")}</svg>`;
}

/** A plain landscape with no text: the evals expect `isReceipt: false` for it. */
function landscapeSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6fb1e8"/><stop offset="1" stop-color="#e6f2fb"/></linearGradient></defs>
<rect width="480" height="320" fill="url(#sky)"/>
<circle cx="370" cy="70" r="34" fill="#ffd54a"/>
<polygon points="0,260 110,120 200,230 290,110 400,240 480,170 480,320 0,320" fill="#5d7f5a"/>
<polygon points="0,290 130,200 240,270 350,210 480,280 480,320 0,320" fill="#3f6140"/>
<ellipse cx="120" cy="60" rx="46" ry="14" fill="#fff" opacity="0.9"/>
<ellipse cx="150" cy="52" rx="30" ry="12" fill="#fff" opacity="0.9"/>
</svg>`;
}

function render(svg: string, width: number): Buffer {
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: true, defaultFontFamily: FONT },
  }).render();
  return Buffer.from(png.asPng());
}

await mkdir(OUT, { recursive: true });
const files: [string, Buffer][] = DEMO_RECEIPTS.map((r) => [r.file, render(receiptSvg(r), W * 2)]);
files.push(["landscape.png", render(landscapeSvg(), 640)]);
for (const [name, bytes] of files) {
  if (bytes.length > MAX_BYTES) throw new Error(`${name} is ${bytes.length} bytes; the limit is ${MAX_BYTES}`);
  await writeFile(path.join(OUT, name), bytes);
  console.log(`${name}: ${bytes.length} bytes`);
}
