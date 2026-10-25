// Découpe le texte d'un reçu ou d'une commande en ligne (PDF) en lignes d'achat.
// Fonction pure, testée dans tests/pdfparse.test.mjs. Aucun service externe.

const MOIS_FR = { janv: 1, janvier: 1, fev: 2, fevr: 2, fevrier: 2, mars: 3, avr: 4, avril: 4, mai: 5, juin: 6, juil: 7, juillet: 7, aout: 8, sept: 9, septembre: 9, oct: 10, octobre: 10, nov: 11, novembre: 11, dec: 12, decembre: 12 };
const MOIS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const STORES = [
  [/lufa/i, 'Fermes Lufa'], [/super\s?c\b/i, 'Super C'], [/\bmaxi\b/i, 'Maxi'], [/\biga\b/i, 'IGA'],
  [/provigo/i, 'Provigo'], [/\bmetro\b/i, 'Metro'], [/adonis/i, 'Adonis'], [/costco/i, 'Costco'],
  [/walmart/i, 'Walmart'], [/jean coutu/i, 'Jean Coutu'], [/pharmaprix/i, 'Pharmaprix'], [/marché tau|tau\b/i, 'Marché Tau'],
];

const MONEY = /(-?\d{1,4}(?:[  ]?\d{3})*[,.]\d{2})\s*\$?/g;
const SKIP = /(sous[- ]?total|^total|\btotal\b|\btps\b|\btvq\b|\bhst\b|\bgst\b|\bqst\b|taxe|\btax\b|livraison|frais|pourboire|paiement|visa|mastercard|amex|interac|débit|crédit|credit|solde|monnaie|change\b|économi|points?\b|consigne|subtotal|delivery|shipping|\btip\b|montant|balance|remboursement|carte cadeau|n° de commande|commande n|order #)/i;
const DISCOUNT = /(rabais|escompte|promo|coupon|discount|réduction|reduction|économie)/i;

const num = (s) => parseFloat(String(s).replace(/[  ]/g, '').replace(',', '.'));
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pad = (n) => String(n).padStart(2, '0');

export function findDate(text) {
  let m = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = norm(text);
  m = t.match(/\b(\d{1,2})(?:er)?\s+(janv|janvier|fevr|fevrier|fev|mars|avr|avril|mai|juin|juil|juillet|aout|sept|septembre|oct|octobre|nov|novembre|dec|decembre)\.?\s+(20\d{2})\b/);
  if (m) return `${m[3]}-${pad(MOIS_FR[m[2]])}-${pad(m[1])}`;
  m = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/);
  if (m) return `${m[3]}-${pad(MOIS_EN.indexOf(m[1]) + 1)}-${pad(m[2])}`;
  m = text.match(/\b(\d{2})\/(\d{2})\/(20\d{2})\b/); // JJ/MM/AAAA, l'usage au Québec
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = text.match(/\b(20\d{2})\/(\d{2})\/(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

export function findStore(text) {
  for (const [re, name] of STORES) if (re.test(text)) return name;
  return '';
}

function sizeOf(name) {
  const m = name.match(/(\d+(?:[,.]\d+)?)\s?(kg|g|ml|l)\b/i);
  return m ? `${m[1].replace('.', ',')} ${m[2].toLowerCase() === 'l' ? 'L' : m[2].toLowerCase()}` : '';
}

function clean(name) {
  return name
    .replace(/\s+/g, ' ')
    .replace(/^[\s•·*\-–—]+/, '')
    .replace(/[\s:–—\-]+$/, '')
    .trim();
}

/**
 * @param {string[]} lines lignes de texte du document, dans l'ordre de lecture
 * @returns {{date: string|null, store: string, total: number|null, lines: Array}}
 */
export function parseReceiptText(lines) {
  const text = lines.join('\n');
  const out = { date: findDate(text), store: findStore(text), total: null, lines: [] };
  for (const rawLine of lines) {
    const raw = rawLine.replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    const prices = [...raw.matchAll(MONEY)];
    if (!prices.length) continue;
    const last = prices[prices.length - 1];
    // Le montant de la ligne est le dernier prix en fin de ligne.
    if (raw.slice(last.index + last[0].length).replace(/[\s$]/g, '').length > 2) continue;
    const amount = num(last[1]);
    if (/^\s*total\b/i.test(raw) || /\btotal\b/i.test(raw) && !/sous/i.test(raw)) {
      if (!/sous|sub/i.test(raw)) out.total = Math.abs(amount);
      continue;
    }
    if (DISCOUNT.test(raw) || amount < 0) {
      const prev = out.lines[out.lines.length - 1];
      if (prev) {
        const before = prev.amount;
        prev.amount = Math.round((prev.amount - Math.abs(amount)) * 100) / 100;
        prev.regularPrice = Math.round((before / prev.qty) * 100) / 100;
      }
      continue;
    }
    if (SKIP.test(raw)) continue;

    // Colonnes en fin de ligne : [quantité] [prix unitaire] montant ; le nom est tout ce qui précède.
    let end = last.index;
    let qty = 1;
    if (prices.length >= 2) {
      const prev = prices[prices.length - 2];
      if (!raw.slice(prev.index + prev[0].length, last.index).trim()) {
        end = prev.index;
        const qcol = raw.slice(0, end).match(/\s(\d{1,3})\s*$/);
        if (qcol) { qty = Number(qcol[1]); end = qcol.index; }
      }
    }
    let name = raw.slice(0, end);
    // « 2 x Pommes » ou « Pommes x2 »
    let qm = name.match(/^\s*(\d{1,3})\s*[x×]\s+/i);
    if (qm) { qty = Number(qm[1]); name = name.slice(qm[0].length); }
    qm = name.match(/\s[x×]\s?(\d{1,3})\s*$/i);
    if (qm) { qty = Number(qm[1]); name = name.slice(0, qm.index); }
    // « 0,532 kg @ 4,99 $/kg »
    const kg = raw.match(/(\d+[,.]\d{1,3})\s?kg\s*(?:@|à|x)/i);
    if (kg) {
      qty = num(kg[1]);
      name = name.replace(kg[0], '').replace(/\d+[,.]\d{2}\s*\$?\s*\/\s*kg/i, '');
    }

    name = clean(name);
    if (name.length < 2 || /^\d+$/.test(name)) continue;
    out.lines.push({ raw, name, qty, amount, size: sizeOf(name), unit: kg ? 'kg' : 'unité' });
  }
  return out;
}
