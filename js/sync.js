// Envoi des achats vers le Google Sheet « Suivi_depenses_V2 » (script Apps Script, voir apps-script/).
// Les lignes non envoyées restent en file d'attente et repartent dès que le réseau revient.
import * as db from './db.js';
import { CAT } from './categories.js';
import { unitPrice } from './calc.js';

/** Lignes à envoyer : tout sauf l'historique migré (déjà dans le Sheet) et ce qui est déjà parti. */
export function pendingLines(data) {
  const R = new Map(data.receipts.map((r) => [r.id, r]));
  return data.lines.filter((l) => !l.syncedAt && R.get(l.receiptId) && R.get(l.receiptId).source !== 'migration');
}

export function toRows(data, lines) {
  const P = new Map(data.products.map((p) => [p.id, p]));
  const R = new Map(data.receipts.map((r) => [r.id, r]));
  const S = new Map(data.stores.map((s) => [s.id, s]));
  return lines.map((l) => {
    const p = P.get(l.productId) || {};
    const r = R.get(l.receiptId) || {};
    return {
      id: l.id, date: r.date, produit: p.name, categorie: p.legacyCategory || CAT[p.category]?.short || '',
      magasin: S.get(r.storeId)?.name || '', quantite: l.qty, unite: p.unit, montant: l.amount,
      prixUnitaire: Math.round(unitPrice(l) * 100) / 100, categorieIpc: CAT[p.category]?.name || '', source: r.source || '',
    };
  });
}

async function post(settings, body) {
  // text/plain évite la requête préalable CORS, que les scripts Google ne gèrent pas.
  const res = await fetch(settings.sheetUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: settings.sheetToken, ...body }),
  });
  const out = await res.json();
  if (!out.ok) throw new Error(out.erreur || 'Le Sheet a refusé l’envoi.');
  return out;
}

/** Envoie les lignes en attente. Retourne le nombre de lignes ajoutées au Sheet, ou null si non configuré. */
export async function pushPending(data, settings) {
  if (!settings.sheetUrl || !settings.sheetToken) return null;
  const lines = pendingLines(data);
  if (!lines.length) return 0;
  const out = await post(settings, { op: 'append', rows: toRows(data, lines) });
  const now = new Date().toISOString();
  await db.put('lines', lines.map((l) => ({ ...l, syncedAt: now })));
  return out.ajoutees;
}

/** Retire du Sheet les lignes d'un reçu supprimé dans l'app (seulement celles déjà envoyées). */
export async function pushDelete(lines, settings) {
  const ids = lines.filter((l) => l.syncedAt).map((l) => l.id);
  if (!settings.sheetUrl || !settings.sheetToken || !ids.length) return null;
  const out = await post(settings, { op: 'delete', ids });
  return out.supprimees;
}

export const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24);
