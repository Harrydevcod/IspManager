/**
 * Gera a marca da app — SVG, PNG e .ico — a partir de uma só descrição
 * geométrica. Corre à mão quando o desenho muda:
 *
 *   node scripts/make-icons.mjs
 *
 * Porquê rasterizar aqui em vez de pedir a um browser: a marca são discos,
 * anéis e segmentos, e a cobertura de cada um resolve-se com uma distância.
 * Isso são cem linhas determinísticas, sem GUI, sem dependência nova, e — o que
 * importa mais — deixa o SVG e o PNG a saírem da mesma fonte, por isso nunca
 * podem divergir.
 */
import { PNG } from 'pngjs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PLATE = '#191b1f'; // grafite ≈ oklch(20% 0.006 260), nunca preto
const GOLD = '#e0b578'; // dourado heritage ≈ oklch(80% 0.112 76)
const BOX = 64; // todas as coordenadas vivem nesta grelha

/**
 * A cadeia: origem em cima, dois ramos, os clientes em baixo. A assimetria
 * (dois clientes num ramo, um no outro) é intencional — lê-se como uma rede
 * real e não como um ornamento.
 */
const FULL = [
  { kind: 'plate', r: 14, fill: PLATE },
  // Da origem direto aos ramos: um troço vertical intermédio fazia três topos
  // redondos a sobreporem-se e nascia ali um ponto que ninguém desenhou.
  { kind: 'link', from: [32, 21], to: [21, 30], w: 2, alpha: 0.52 },
  { kind: 'link', from: [32, 21], to: [43, 30], w: 2, alpha: 0.52 },
  { kind: 'link', from: [19, 38], to: [14, 44], w: 2, alpha: 0.52 },
  { kind: 'link', from: [21, 38], to: [27, 44], w: 2, alpha: 0.52 },
  { kind: 'link', from: [45, 38], to: [50, 44], w: 2, alpha: 0.52 },
  { kind: 'ring', at: [20, 34], r: 3.4, w: 2.4, alpha: 1 },
  { kind: 'ring', at: [44, 34], r: 3.4, w: 2.4, alpha: 1 },
  { kind: 'disc', at: [32, 15], r: 5, alpha: 1 },
  { kind: 'disc', at: [13, 47], r: 2.6, alpha: 0.72 },
  { kind: 'disc', at: [28, 47], r: 2.6, alpha: 0.72 },
  { kind: 'disc', at: [50, 47], r: 2.6, alpha: 0.72 }
];

/** Aos 16px os nós pequenos viram lama: larga os clientes e engrossa tudo. */
const SMALL = [
  { kind: 'plate', r: 14, fill: PLATE },
  { kind: 'link', from: [32, 24], to: [32, 30], w: 4, alpha: 0.62 },
  { kind: 'link', from: [32, 30], to: [19, 38], w: 4, alpha: 0.62 },
  { kind: 'link', from: [32, 30], to: [45, 38], w: 4, alpha: 0.62 },
  { kind: 'disc', at: [32, 17], r: 7, alpha: 1 },
  { kind: 'disc', at: [17, 43], r: 5.5, alpha: 1 },
  { kind: 'disc', at: [47, 43], r: 5.5, alpha: 1 }
];

// ---------------------------------------------------------------- geometria

function distToSegment(px, py, [x1, y1], [x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0
    ? 0
    : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Distância assinada: negativa dentro da forma, positiva fora. */
function signedDistance(shape, x, y) {
  if (shape.kind === 'plate') {
    const r = shape.r;
    const dx = Math.abs(x - BOX / 2) - (BOX / 2 - r);
    const dy = Math.abs(y - BOX / 2) - (BOX / 2 - r);
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    return outside + Math.min(Math.max(dx, dy), 0) - r;
  }
  if (shape.kind === 'disc') return Math.hypot(x - shape.at[0], y - shape.at[1]) - shape.r;
  if (shape.kind === 'ring') {
    return Math.abs(Math.hypot(x - shape.at[0], y - shape.at[1]) - shape.r) - shape.w / 2;
  }
  return distToSegment(x, y, shape.from, shape.to) - shape.w / 2;
}

function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

// -------------------------------------------------------------- rasterizador

const SAMPLES = 4; // 4×4 por pixel: anti-aliasing sem custo notório

function render(shapes, size) {
  const png = new PNG({ width: size, height: size });
  const scale = BOX / size;
  const step = 1 / SAMPLES;
  const gold = hexToRgb(GOLD);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = (px + (sx + 0.5) * step) * scale;
          const y = (py + (sy + 0.5) * step) * scale;
          let sr = 0;
          let sg = 0;
          let sb = 0;
          let sa = 0;
          for (const shape of shapes) {
            // Cobertura por distância: meio pixel de transição em cada bordo.
            const edge = scale / 2;
            const d = signedDistance(shape, x, y);
            const coverage = Math.max(0, Math.min(1, 0.5 - d / (2 * edge)));
            if (coverage <= 0) continue;
            const alpha = coverage * (shape.alpha ?? 1);
            const [cr, cg, cb] = shape.fill ? hexToRgb(shape.fill) : gold;
            sr = cr * alpha + sr * (1 - alpha);
            sg = cg * alpha + sg * (1 - alpha);
            sb = cb * alpha + sb * (1 - alpha);
            sa = alpha + sa * (1 - alpha);
          }
          r += sr;
          g += sg;
          b += sb;
          a += sa;
        }
      }
      const total = SAMPLES * SAMPLES;
      const index = (py * size + px) << 2;
      png.data[index] = Math.round(r / total);
      png.data[index + 1] = Math.round(g / total);
      png.data[index + 2] = Math.round(b / total);
      png.data[index + 3] = Math.round((a / total) * 255);
    }
  }
  return PNG.sync.write(png);
}

// --------------------------------------------------------------------- saída

function toSvg(shapes, label) {
  const body = shapes.map((shape) => {
    if (shape.kind === 'plate') {
      return `  <rect width="64" height="64" rx="${shape.r}" fill="${shape.fill}" />`;
    }
    if (shape.kind === 'disc') {
      return `  <circle cx="${shape.at[0]}" cy="${shape.at[1]}" r="${shape.r}"`
        + ` fill="${GOLD}" opacity="${shape.alpha}" />`;
    }
    if (shape.kind === 'ring') {
      return `  <circle cx="${shape.at[0]}" cy="${shape.at[1]}" r="${shape.r}" fill="none"`
        + ` stroke="${GOLD}" stroke-width="${shape.w}" opacity="${shape.alpha}" />`;
    }
    return `  <path d="M${shape.from[0]} ${shape.from[1]}L${shape.to[0]} ${shape.to[1]}"`
      + ` fill="none" stroke="${GOLD}" stroke-width="${shape.w}"`
      + ` stroke-linecap="round" opacity="${shape.alpha}" />`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img"`
    + ` aria-label="${label}">\n`
    + `  <!-- Gerado por scripts/make-icons.mjs. Editar a geometria lá, não aqui. -->\n`
    + `${body}\n</svg>\n`;
}

function packIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // 1 = ícone
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const directory = entries.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // 0 significa 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // planos
    entry.writeUInt16LE(32, 6); // bits por pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...directory, ...entries.map((e) => e.png)]);
}

const write = (file, data) => {
  writeFileSync(path.join(root, file), data);
  console.log(file);
};

write('src/renderer/public/favicon.svg', toSvg(FULL, 'ISPM'));
write('assets/icon-small.svg', toSvg(SMALL, 'ISPM'));

/** Abaixo de 48px a marca completa não sobrevive; usa-se a geometria curta. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
write('assets/icon.ico', packIco(ICO_SIZES.map((size) => ({
  size,
  png: render(size <= 32 ? SMALL : FULL, size)
}))));

write('assets/icon-512.png', render(FULL, 512));
write('assets/icon.png', render(FULL, 256));
write('src/renderer/public/favicon.png', render(FULL, 256));
