// Nettoie le texte brut d'une photo de reçu (OCR) avant le découpage en lignes d'achat.
// Fonction pure, testée dans tests/ocrclean.test.mjs.

/** @param {string} text sortie brute de l'OCR @returns {string[]} lignes prêtes pour parseReceiptText */
export function cleanOcrLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l
      .replace(/[|¦_~`]+/g, ' ')
      .replace(/(\d)\s*[,.]\s+(\d{2})\b/g, '$1,$2')          // « 4, 99 » -> « 4,99 »
      .replace(/(\d)\s+[,.](\d{2})\b/g, '$1,$2')             // « 4 ,99 » -> « 4,99 »
      .replace(/(?<=\d[,.])([OoD])(?=\d)|(?<=\d[,.]\d)([OoD])\b/g, '0') // « 4,O9 » -> « 4,09 »
      .replace(/(\d)\s?S\b/g, '$1 $')                        // « 4,99 S » -> « 4,99 $ »
      .replace(/\s+/g, ' ')
      .trim())
    .filter((l) => l.length > 1);
}
