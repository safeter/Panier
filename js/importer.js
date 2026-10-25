// Import de reçus préparés hors de l'app (ex. lus par Claude dans le projet Panier).
// Format : voir FORMAT-IMPORT.md. Fonction pure, testée dans tests/importer.test.mjs.
import { CAT, isTaxLabel } from './categories.js';
import { nameKey } from './similar.js';

const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const n = (v) => {
  if (typeof v === 'number') return v;
  const x = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(x) ? x : null;
};

function parseSize(s) {
  const m = String(s ?? '').trim().toLowerCase().replace(',', '.').match(/^([\d.]+)\s*(kg|g|l|ml|un|u)?$/);
  if (!m) return null;
  let q = parseFloat(m[1]);
  let unit = m[2] || 'un';
  if (unit === 'kg') { q *= 1000; unit = 'g'; }
  if (unit === 'l') { q *= 1000; unit = 'ml'; }
  if (unit === 'u') unit = 'un';
  return { qty: q, unit };
}

/**
 * Fusionne des reçus importés dans les données existantes, sans rien écraser.
 * Un reçu déjà présent (même date, même magasin, même total à 1 cent près) est ignoré.
 * Retourne uniquement les nouveaux enregistrements à écrire, plus un résumé.
 */
export function planImport(data, payload, makeId) {
  const list = Array.isArray(payload) ? payload : payload?.receipts;
  if (!Array.isArray(list) || !list.length) throw new Error('Ce fichier ne contient aucun reçu à importer.');

  const stores = new Map(data.stores.map((s) => [slug(s.name), s]));
  const products = new Map();
  for (const p of data.products) {
    const k = slug(p.name);
    if (!products.has(k)) products.set(k, []);
    products.get(k).push(p);
  }
  const byKey = new Map();
  for (const p of data.products) {
    const k = nameKey(p.name);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(p);
  }
  const existingTotals = new Map();
  for (const l of data.lines) existingTotals.set(l.receiptId, (existingTotals.get(l.receiptId) || 0) + l.amount);
  const existingKeys = new Set(data.receipts.map((r) => `${r.date}|${r.storeId}|${Math.round((existingTotals.get(r.id) || 0) * 100)}`));

  const out = { stores: [], products: [], receipts: [], lines: [], skipped: [], taxesIgnored: 0 };
  for (const r of list) {
    const date = String(r.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Date invalide dans un reçu : « ${r.date} ». Format attendu : AAAA-MM-JJ.`);
    const storeName = String(r.store || '').trim() || 'Magasin inconnu';
    let store = stores.get(slug(storeName));
    if (!store) {
      store = { id: slug(storeName), name: storeName };
      stores.set(slug(storeName), store);
      out.stores.push(store);
    }
    const all = (r.lines || []).filter((l) => String(l.name || '').trim() && n(l.amount) > 0);
    const lines = all.filter((l) => !isTaxLabel(l.name));
    out.taxesIgnored = (out.taxesIgnored || 0) + (all.length - lines.length);
    const sum = lines.reduce((a, l) => a + n(l.amount), 0);
    const key = `${date}|${store.id}|${Math.round(sum * 100)}`;
    if (existingKeys.has(key)) { out.skipped.push({ date, store: storeName, total: sum }); continue; }
    existingKeys.add(key);

    const receipt = { id: makeId('r'), date, storeId: store.id, source: r.source || 'import', total: n(r.total), createdAt: new Date().toISOString() };
    out.receipts.push(receipt);
    for (const l of lines) {
      const name = String(l.name).trim();
      const unit = String(l.unit || 'unité').trim();
      // Même produit = même nom ET même unité ; « Pommes au kg » et « Pommes en sac » sont deux séries de prix.
      const cands = products.get(slug(name)) || [];
      // Sinon, même nom à la casse, aux accents, au pluriel ou au format près (« Bleuets 170g » = « Bleuets »).
      let p = cands.find((x) => x.unit === unit) || (byKey.get(nameKey(name)) || []).find((x) => x.unit === unit);
      if (!p) {
        p = { id: `${slug(name)}--${slug(unit)}`, name, unit, category: CAT[l.category] ? l.category : (cands[0]?.category || 'autres'), type: slug(name) };
        products.set(slug(name), [...cands, p]);
        byKey.set(nameKey(name), [...(byKey.get(nameKey(name)) || []), p]);
        out.products.push(p);
      }
      const size = parseSize(l.size);
      out.lines.push({
        id: makeId('l'), receiptId: receipt.id, productId: p.id,
        qty: n(l.qty) > 0 ? n(l.qty) : 1, amount: Math.round(n(l.amount) * 100) / 100,
        regularPrice: n(l.regularPrice), sizeQty: size?.qty ?? null, sizeUnit: size?.unit ?? null,
      });
    }
  }
  return out;
}
