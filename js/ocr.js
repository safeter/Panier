// Lecture d'une photo de reçu sur l'appareil (Tesseract.js intégré à l'app, rien n'est envoyé ailleurs).
import { cleanOcrLines, rowsFromFragments } from './ocrclean.js';
import { parseReceiptText } from './pdfparse.js';

const base = new URL('../vendor/tesseract/', import.meta.url).href;
let libPromise = null;

function loadLib() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!libPromise) {
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = base + 'tesseract.min.js';
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => { libPromise = null; reject(new Error('moteur de lecture introuvable')); };
      document.head.appendChild(s);
    });
  }
  return libPromise;
}

// Prépare la photo : mise à l'échelle, niveaux de gris, puis correction de l'éclairage
// (ombre du téléphone, papier froissé) en divisant chaque pixel par la luminosité locale du papier.
export const DEFAULTS = { maxW: 1600, minW: 0, norm: true, block: 24 };
// Deuxième lecture, à une autre échelle, si la somme des lignes ne concorde pas avec le sous-total imprimé.
const PASSES = [{ maxW: 1600 }, { maxW: 2200, minW: 1400 }];

async function prepare(file, opts) {
  const o = { ...DEFAULTS, ...opts };
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  // Les petites photos sont agrandies : Tesseract lit mieux des caractères d'au moins 25 px de haut.
  const scale = bmp.width < o.minW ? o.minW / bmp.width : Math.min(1, o.maxW / bmp.width);
  const c = document.createElement('canvas');
  const w = (c.width = Math.round(bmp.width * scale));
  const h = (c.height = Math.round(bmp.height * scale));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const Y = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; j < Y.length; i += 4, j++) Y[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  const out = o.norm ? flatten(Y, w, h, o.block) : stretch(Y);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) d[i] = d[i + 1] = d[i + 2] = out[j];
  g.putImageData(img, 0, 0);
  return c;
}

function stretch(Y) {
  let lo = 255, hi = 0;
  for (const v of Y) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(1, hi - lo);
  return Y.map((v) => ((v - lo) * 255) / span);
}

// Fond estimé par blocs (maximum local = papier), lissé, puis interpolé : le texte devient noir sur blanc uniforme.
export function flatten(Y, w, h, B) {
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  let bg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    // 2e plus grande valeur d'un échantillon : résiste aux reflets ponctuels
    let m1 = 0, m2 = 0;
    for (let y = by * B; y < Math.min(h, by * B + B); y += 2) for (let x = bx * B; x < Math.min(w, bx * B + B); x += 2) {
      const v = Y[y * w + x];
      if (v > m1) { m2 = m1; m1 = v; } else if (v > m2) m2 = v;
    }
    bg[by * bw + bx] = m2;
  }
  // Maximum 3×3 (un bloc couvert de texte prend le papier voisin), puis deux flous 3×3.
  const pass = (src, f) => {
    const dst = new Float32Array(src.length);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      let acc = f === 'max' ? 0 : 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || xx < 0 || yy >= bh || xx >= bw) continue;
        const v = src[yy * bw + xx];
        if (f === 'max') acc = Math.max(acc, v); else { acc += v; n++; }
      }
      dst[y * bw + x] = f === 'max' ? acc : acc / n;
    }
    return dst;
  };
  bg = pass(pass(pass(bg, 'max'), 'avg'), 'avg');
  // Niveau du papier : une zone bien plus sombre que lui (table, fond) devient blanche.
  const sorted = Float32Array.from(bg).sort();
  const paper = sorted[Math.floor(sorted.length * 0.9)] || 255;
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, y / B - 0.5)), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, x / B - 0.5)), x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
      const b = (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx) * (1 - ty) + (bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx) * ty;
      if (b < paper * 0.35) { out[y * w + x] = 255; continue; }
      const r = Y[y * w + x] / Math.max(1, b); // 1 = papier, < 1 = encre
      out[y * w + x] = r >= 0.92 ? 255 : Math.max(0, (r - 0.35) / 0.57) * 255;
    }
  }
  return out;
}

/** Somme des lignes comparée au sous-total (ou au total) du reçu : plus le score est haut, meilleure est la lecture. */
export function scoreRead(lines) {
  const p = parseReceiptText(lines);
  const sum = p.lines.reduce((a, l) => a + l.amount, 0);
  const target = p.subtotal ?? p.total;
  const gap = target ? Math.abs(sum - target) : null;
  return { score: p.lines.length - (gap == null ? 0 : Math.min(10, gap)), exact: gap != null && gap <= 0.05 };
}

/**
 * Retourne les lignes de texte de la photo, prêtes pour parseReceiptText.
 * onProgress(fraction, numéro de lecture) ; une 2e lecture n'a lieu que si la 1re ne boucle pas avec le total.
 */
export async function photoToLines(file, onProgress = () => {}, opts = {}) {
  const T = await loadLib();
  let pass = 0;
  const worker = await T.createWorker('fra', 1, {
    workerPath: base + 'worker.min.js',
    corePath: base,
    langPath: base,
    gzip: true,
    logger: (m) => { if (m.status === 'recognizing text') onProgress(m.progress, pass + 1); },
  });
  try {
    const passes = opts.single || opts.raw ? [{}] : PASSES;
    let best = null;
    for (pass = 0; pass < passes.length; pass++) {
      const lines = await readOnce(T, worker, file, { ...opts, ...passes[pass], ...(opts.single ? opts : {}) });
      if (opts.raw) return lines;
      const s = scoreRead(lines);
      if (!best || s.score > best.score) best = { ...s, lines };
      if (s.exact) break;
    }
    return best.lines;
  } finally {
    await worker.terminate();
  }
}

async function readOnce(T, worker, file, opts) {
  const canvas = await prepare(file, opts);
  if (opts.debug) window.__ocrCanvas = canvas;
  // Mode « texte épars » (11) : chaque fragment est lu seul, sans supposer des lignes droites ;
  // les lignes sont ensuite reconstituées d'après la position des fragments.
  const psm = opts.psm || '11';
  await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: psm });
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  let lines = data.text.split('\n');
  if (psm === '11' || psm === '12') {
    const frags = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) {
      const bl = l.baseline;
      const slope = bl && bl.x1 > bl.x0 ? (bl.y1 - bl.y0) / (bl.x1 - bl.x0) : NaN;
      frags.push({ text: l.text, ...l.bbox, slope });
    }
    if (frags.length) lines = rowsFromFragments(frags);
  }
  return opts.raw ? lines : cleanOcrLines(lines.join('\n'));
}
