// Lecture du texte d'un PDF sur l'appareil (pdf.js intégré à l'app, rien n'est envoyé ailleurs).
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      return lib;
    });
  }
  return pdfjsPromise;
}

/** Retourne les lignes de texte du PDF, page par page, de haut en bas et de gauche à droite. */
export async function pdfToLines(file) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines = [];
  for (let p = 1; p <= Math.min(doc.numPages, 20); p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    // Regroupe les fragments par hauteur (tolérance de 3 points), puis trie de gauche à droite.
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const y = it.transform[5];
      const x = it.transform[4];
      let row = rows.find((r) => Math.abs(r.y - y) <= 3);
      if (!row) { row = { y, parts: [] }; rows.push(row); }
      row.parts.push({ x, s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) lines.push(r.parts.sort((a, b) => a.x - b.x).map((q) => q.s.trim()).join(' '));
  }
  return lines;
}
