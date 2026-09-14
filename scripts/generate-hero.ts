// Generates the README hero base: a synthetic orders dashboard screenshot
// that the annotate pipeline then decorates for docs/README display.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp, { type OverlayOptions } from "sharp";

const fontPath = path.resolve("assets/fonts/NotoSansCJKsc-Regular.otf");
const W = 1280;
const H = 800;

function escapeMarkup(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function textOverlay(
  text: string,
  left: number,
  top: number,
  options: { size?: number; color?: string; width?: number } = {}
): Promise<OverlayOptions> {
  const size = options.size ?? 20;
  const buffer = await sharp({
    text: {
      text: `<span foreground="${options.color ?? "#263238"}">${escapeMarkup(text)}</span>`,
      font: `Noto Sans CJK SC ${size}`,
      fontfile: fontPath,
      width: options.width ?? 600,
      rgba: true
    }
  })
    .png()
    .toBuffer();
  return { input: buffer, left, top };
}

const svgBody = `
  <rect width="${W}" height="${H}" fill="#F1F5F9"/>
  <rect x="0" y="0" width="216" height="${H}" fill="#0F2540"/>
  <text x="0" y="0"> </text>
  <rect x="28" y="36" width="44" height="44" rx="10" fill="#2563EB"/>
  <rect x="28" y="132" width="160" height="40" rx="8" fill="#1D3A5F"/>
  <rect x="28" y="188" width="160" height="40" rx="8" fill="#16324F"/>
  <rect x="28" y="244" width="160" height="40" rx="8" fill="#16324F"/>
  <rect x="28" y="300" width="160" height="40" rx="8" fill="#16324F"/>
  <rect x="256" y="28" width="996" height="64" rx="12" fill="#FFFFFF" stroke="#D8DEE8" stroke-width="1.5"/>
  <circle cx="1236" cy="60" r="12" fill="#EF4444"/>
  <rect x="256" y="112" width="316" height="128" rx="14" fill="#FFFFFF" stroke="#D8DEE8" stroke-width="1.5"/>
  <rect x="596" y="112" width="316" height="128" rx="14" fill="#FFFFFF" stroke="#D8DEE8" stroke-width="1.5"/>
  <rect x="936" y="112" width="316" height="128" rx="14" fill="#FFFFFF" stroke="#D8DEE8" stroke-width="1.5"/>
  <rect x="596" y="300" width="656" height="330" rx="14" fill="#FFFFFF" stroke="#D8DEE8" stroke-width="1.5"/>
  <rect x="256" y="300" width="316" height="330" rx="14" fill="#FFFFFF" stroke="#D8DEE8" stroke-width="1.5"/>
  <rect x="288" y="352" width="252" height="34" rx="7" fill="#F1F5F9"/>
  <rect x="288" y="470" width="252" height="34" rx="7" fill="#FFF7ED" stroke="#FDBA74" stroke-width="1.5"/>
  <rect x="628" y="380" width="46" height="200" fill="#3B82F6"/>
  <rect x="694" y="330" width="46" height="250" fill="#60A5FA"/>
  <rect x="760" y="404" width="46" height="176" fill="#93C5FD"/>
  <rect x="826" y="356" width="46" height="224" fill="#3B82F6"/>
  <rect x="892" y="428" width="46" height="152" fill="#93C5FD"/>
  <rect x="958" y="386" width="46" height="194" fill="#60A5FA"/>
  <rect x="1024" y="344" width="46" height="236" fill="#2563EB"/>
  <rect x="1090" y="410" width="46" height="170" fill="#93C5FD"/>
  <rect x="288" y="676" width="380" height="40" rx="8" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="1.5"/>
  <rect x="968" y="668" width="156" height="56" rx="10" fill="#2563EB"/>
`;

async function main() {
  await mkdir("examples/hero", { recursive: true });
  const geometry = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svgBody}</svg>`
  );
  const overlays: OverlayOptions[] = [];
  overlays.push(await textOverlay("A", 40, 46, { size: 24, color: "#FFFFFF" }));
  overlays.push(await textOverlay("订单看板", 40, 148, { size: 17, color: "#E2E8F0", width: 160 }));
  overlays.push(await textOverlay("数据报表", 40, 204, { size: 17, color: "#94A3B8", width: 160 }));
  overlays.push(await textOverlay("异常告警", 40, 260, { size: 17, color: "#94A3B8", width: 160 }));
  overlays.push(await textOverlay("系统设置", 40, 316, { size: 17, color: "#94A3B8", width: 160 }));
  overlays.push(
    await textOverlay("运营看板 · Order Console", 292, 48, { size: 22, color: "#16324F" })
  );
  overlays.push(await textOverlay("近 30 天", 1148, 52, { size: 15, color: "#94A3B8", width: 90 }));
  overlays.push(await textOverlay("支付转化率", 292, 140, { size: 16, color: "#64748B" }));
  overlays.push(await textOverlay("2.41%", 292, 172, { size: 34, color: "#16324F" }));
  overlays.push(await textOverlay("客单价", 632, 140, { size: 16, color: "#64748B" }));
  overlays.push(await textOverlay("¥328", 632, 172, { size: 34, color: "#16324F" }));
  overlays.push(await textOverlay("异常订单", 972, 140, { size: 16, color: "#64748B" }));
  overlays.push(await textOverlay("17 笔", 972, 172, { size: 34, color: "#DC2626" }));
  overlays.push(await textOverlay("近 7 天订单量", 628, 330, { size: 17, color: "#475569" }));
  overlays.push(await textOverlay("待处理", 288, 322, { size: 16, color: "#475569" }));
  overlays.push(
    await textOverlay("订单 #20260914-0317  ·  ¥1,280", 300, 360, { size: 15, color: "#334155" })
  );
  overlays.push(
    await textOverlay("订单 #20260914-0298  ·  ¥860", 300, 390, { size: 15, color: "#334155" })
  );
  overlays.push(
    await textOverlay("风控提示：订单 #20260914-0281 支付信息异常", 300, 478, {
      size: 15,
      color: "#B45309"
    })
  );
  overlays.push(await textOverlay("API Token", 288, 648, { size: 16, color: "#475569" }));
  overlays.push(
    await textOverlay("sk-live-9f3kQ7mZx2Vb8Rw5Tn1LpYd4Ca6He0Gj", 300, 684, {
      size: 15,
      color: "#64748B"
    })
  );
  overlays.push(await textOverlay("保存更改", 1002, 684, { size: 18, color: "#FFFFFF" }));

  const image = await sharp(geometry).composite(overlays).png().toBuffer();
  await writeFile("examples/hero/hero.png", image);
  console.log("hero base written: examples/hero/hero.png");
}

void main();
