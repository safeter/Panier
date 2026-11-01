// Lecture d'une photo de reçu sur l'appareil (Tesseract.js intégré à l'app, rien n'est envoyé ailleurs).
import { cleanOcrLines } from './ocrclean.js';

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

// Réduit la photo (reçus étroits et longs : 1600 px de large suffisent) et la passe en niveaux de gris contrastés.
async function prepare(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 1600 / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = y; if (y < lo) lo = y; if (y > hi) hi = y;
  }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  bmp.close?.();
  return c;
}

/** Retourne les lignes de texte de la photo. onProgress reçoit un nombre entre 0 et 1. */
export async function photoToLines(file, onProgress = () => {}) {
  const T = await loadLib();
  const canvas = await prepare(file);
  const worker = await T.createWorker('fra', 1, {
    workerPath: base + 'worker.min.js',
    corePath: base,
    langPath: base,
    gzip: true,
    logger: (m) => { if (m.status === 'recognizing text') onProgress(m.progress); },
  });
  try {
    await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '6' });
    const { data } = await worker.recognize(canvas);
    return cleanOcrLines(data.text);
  } finally {
    await worker.terminate();
  }
}
