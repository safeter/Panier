// Remet en forme le texte brut d'une photo de reçu (OCR) avant le découpage en lignes d'achat.
// Fonction pure, testée dans tests/ocrclean.test.mjs.
//
// Ce que font les reçus d'épicerie québécois (Provigo, Maxi, IGA, Metro, Super C) :
//  - code-barres ou code PLU devant le nom : « 06038301714 MANDARIN FM MRJ 6.25 », « 4011 BANANES »
//  - code de taxe collé au nom (MRJ, FP, T…) ;
//  - quantité, poids ou offre sur la ligne suivante, avec le montant :
//      « COURONNE BROCOLI MRJ » puis « 2 @ $2.00      4.00 »
//      « BANANES » puis « 1.475 kg @ $1.96/kg      2.89 »
//      « SN CHED MRBRE LG » puis « $5.99 ch ou 2/$11.00 KB » puis « 2 @ 2/$11.00      11.00 »
//  - l'OCR confond « @ » avec 6, & ou a, et « $ » avec S, s, 5 ou 8.
// Le montant d'une ligne « quantité @ prix » est recalculé ; s'il ne concorde pas avec le montant lu,
// le calcul l'emporte (deux nombres lus valent mieux qu'un).

const MONEY = '\\d{1,4}[,.]\\d{2}';
const DOLLAR = '[$Ss58]?';
const AT = '(?:@|©|®|&|6|a|e)';
// Ligne de quantité : « 2 @ … », « 1.475 kg @ … », « 3 6 3/84.98 » (6 = @ mal lu)
const QTY_LINE = new RegExp(`^(\\d+(?:[,.]\\d{1,3})?)\\s*(k[gq9a]|lb)?\\s*${AT}\\s*(.*)$`, 'i');
const INFO_LINE = /\bch\.?\s+ou\b|\bchacun\b|\bea\b\s+or|prix\s+r[ée]g|^[$Ss]?\s*\d+[,.]\d{2}\s*(?:ch|ea)\b/i; // « $5.99 ch ou 2/$11.00 »
const SECTION = /^\d{1,3}\s*-\s*([A-ZÉÈÀÇ][A-ZÉÈÀÇ '&-]{3,})\s*$/;
const PRICE_END = new RegExp(`(-?${MONEY})\\s*\\$?\\s*[A-Z*]{0,4}\\W*$`);
const ONLY_PRICE = new RegExp(`^${DOLLAR}(-?${MONEY})\\s*[A-Z*]{0,4}\\W*$`);

const num = (s) => parseFloat(String(s).replace(',', '.'));
const fmt = (n) => n.toFixed(2).replace('.', ',');
const round = (n) => Math.round(n * 100) / 100;

/** Nettoyage caractère par caractère d'une ligne. */
export function cleanLine(l) {
  return l
    .replace(/[|¦_~`"“”‘’»«…—]+/g, ' ')
    .replace(/(\d)\s*[,.]\s+(\d{2})\b/g, '$1,$2')               // « 4, 99 » -> « 4,99 »
    .replace(/(\d)\s+[,.](\d{2})\b/g, '$1,$2')                  // « 4 ,99 » -> « 4,99 »
    .replace(/(\d[,.])[OoD](\d)/g, '$10$2').replace(/(\d[,.]\d)[OoD]\b/g, '$10') // « 4,O9 » -> « 4,09 »
    .replace(/(\d)\s?S\b/g, '$1 $')                             // « 4,99 S » -> « 4,99 $ »
    .replace(/\s+/g, ' ')
    .trim();
}

/** Retire codes-barres, codes PLU, codes de taxe et débris en tête de ligne. */
export function cleanName(s) {
  return s
    .replace(/^[^A-Za-z0-9À-ÿ(]+/, '')
    .replace(/^\S{1,2}\s+(?=\(?\d{4,})/, '')                   // débris « sc », « È » devant un code
    .replace(/^\(\d{1,2}\)\s*/, '')                              // « (2)0333… »
    .replace(/^\d{4,14}\s+(?=\S*[A-Za-zÀ-ÿ])/, '')              // code-barres ou PLU
    .replace(/\s+M[RAH][A-Za-z1]?\b\.?/g, '')                    // MRJ, MRy, MRI (taxe Provigo/Maxi)
    .replace(/\s+(?:KB|FP|HMRJ)\b/g, '')
    .replace(/[\s.,:;'\-–]+$/, '')
    .trim();
}

function dealAmount(rest, qty, weighed) {
  // Retourne les montants calculables d'après l'offre, et le montant imprimé en fin de ligne s'il y en a un.
  const cands = [];
  let used = 0;
  const alt = (p) => { // « $4.98 » lu « 84.98 » ou « 54.98 » : on garde aussi la version sans le 1er chiffre
    const out = [num(p)];
    if (/^[58]\d/.test(p)) out.push(num(p.slice(1)));
    return out;
  };
  let m = rest.match(new RegExp(`^\\s*(\\d+)\\s*/\\s*${DOLLAR}\\s*(${MONEY})`));
  if (m) {
    for (const p of alt(m[2])) cands.push(round((qty / Number(m[1])) * p));
    used = m[0].length;
  } else if ((m = rest.match(new RegExp(`^\\s*${DOLLAR}\\s*(${MONEY})\\s*(?:\\/\\s*k\\S*|ch|ea)?`, 'i')))) {
    for (const p of alt(m[1])) cands.push(round(qty * p));
    used = m[0].length;
  }
  const tail = rest.slice(used);
  const pm = tail.match(PRICE_END);
  const printed = pm ? num(pm[1]) : null;
  return { cands, printed, weighed };
}

function pickAmount({ cands, printed }) {
  if (!cands.length) return printed;
  if (printed != null) {
    if (cands.some((c) => Math.abs(c - printed) <= 0.02)) return printed;
    return cands.reduce((a, b) => (Math.abs(b - printed) < Math.abs(a - printed) ? b : a));
  }
  return cands[0];
}

/**
 * @param {string} text sortie brute de l'OCR
 * @returns {string[]} lignes au format attendu par parseReceiptText
 *   (« 2 x NOM 4,00 », « NOM 1,475 kg @ 1,96 $/kg 2,89 », « NOM 6,25 », « [Section] FRUITS ET LEGUMES »)
 */
export function cleanOcrLines(text) {
  const raw = String(text || '').split(/\r?\n/).map(cleanLine).filter((l) => l.length > 1);
  const out = [];
  let pending = null; // ligne de produit sans prix, en attente de sa ligne de quantité
  const flush = () => { if (pending) out.push(pending); pending = null; };

  for (const line of raw) {
    const sec = line.match(SECTION);
    if (sec) { flush(); out.push(`[Section] ${sec[1].trim()}`); continue; }

    if (INFO_LINE.test(line)) continue; // « $5.99 ch ou 2/$11.00 » : le montant vient à la ligne suivante

    const q = pending && line.match(QTY_LINE);
    if (q) {
      const qty = num(q[1]);
      const weighed = !!q[2];
      const amount = pickAmount(dealAmount(q[3], qty, weighed));
      if (amount != null && amount > 0 && amount < 1000) {
        const name = cleanName(pending);
        if (weighed) {
          const unit = q[3].match(new RegExp(`${DOLLAR}\\s*(${MONEY})`));
          out.push(`${name} ${String(qty).replace('.', ',')} kg @ ${unit ? fmt(num(unit[1])) : ''} $/kg ${fmt(amount)}`);
        } else {
          out.push(`${qty > 1 ? `${qty} x ` : ''}${name} ${fmt(amount)}`);
        }
        pending = null;
        continue;
      }
    }

    const op = pending && line.match(ONLY_PRICE);
    if (op) { out.push(`${cleanName(pending)} ${op[1]}`); pending = null; continue; }

    const hasPrice = PRICE_END.test(line);
    // Débris sans lettres ni prix (pli du papier, ombre) : on garde le produit en attente.
    if (pending && !hasPrice && (line.match(/[A-Za-z0-9À-ÿ]/g) || []).length < 5) continue;
    flush();
    const name = cleanName(line);
    if (hasPrice) { out.push(/[A-Za-zÀ-ÿ]{2}/.test(name) ? name : line); continue; }
    // Ligne sans prix : nom de produit possible si elle contient des lettres
    if (/[A-Za-zÀ-ÿ]{3}/.test(name)) pending = name; else out.push(line);
  }
  flush();
  return out;
}

/**
 * Reconstitue les lignes du reçu à partir des fragments lus un à un (mode « texte épars » de Tesseract).
 * Un reçu froissé ou photographié de biais a des lignes courbes : le prix, à droite, n'est pas à la même
 * hauteur que le nom, à gauche. On prolonge la pente de chaque ligne pour rattacher le fragment voisin.
 * @param {{text:string, x0:number, y0:number, x1:number, y1:number, slope?:number}[]} frags
 * @returns {string[]}
 */
export function rowsFromFragments(frags) {
  const F = frags
    .map((f) => ({ ...f, text: f.text.replace(/\s+/g, ' ').trim(), h: f.y1 - f.y0, cy: (f.y0 + f.y1) / 2 }))
    .filter((f) => f.text && f.h > 0);
  if (!F.length) return [];
  const hs = F.map((f) => f.h).sort((a, b) => a - b);
  const H = hs[Math.floor(hs.length / 2)];
  const slopes = F.filter((f) => f.x1 - f.x0 > 6 * H && Number.isFinite(f.slope)).map((f) => f.slope).sort((a, b) => a - b);
  const S = slopes.length ? slopes[Math.floor(slopes.length / 2)] : 0;
  const rows = [];
  for (const f of [...F].sort((a, b) => a.x0 - b.x0)) {
    let best = null, bestD = Infinity;
    for (const r of rows) {
      const last = r[r.length - 1];
      if (last.x1 > f.x0 + H) continue; // chevauchement : pas sur la même ligne
      const head = r.reduce((a, b) => (b.x1 - b.x0 > a.x1 - a.x0 ? b : a));
      const s = head.x1 - head.x0 > 6 * H && Number.isFinite(head.slope) ? (head.slope + S) / 2 : S;
      const predicted = last.cy + s * ((f.x0 + f.x1) / 2 - (last.x0 + last.x1) / 2);
      const d = Math.abs(f.cy - predicted);
      if (d < bestD) { bestD = d; best = r; }
    }
    if (best && bestD < 0.6 * H) best.push(f); else rows.push([f]);
  }
  return rows
    .sort((a, b) => a[0].cy - b[0].cy)
    .map((r) => r.map((f) => f.text).join(' '));
}
