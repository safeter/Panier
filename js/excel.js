// Export Excel (SheetJS chargé à la demande) et sauvegarde JSON.
import { CAT } from './categories.js';
import { unitPrice } from './calc.js';

function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('Impossible de charger le module Excel (connexion requise).'));
    document.head.append(s);
  });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Deux catégories : fiable (validé ou prix cohérent) / à confirmer (format, poids, unité douteux)
const fiab = (t, p) => (!t ? (p.category === 'hors' ? 'hors épicerie' : 'exclu')
  : t.tier === 'fiable' ? (t.validated ? 'validé' : 'fiable') : `à confirmer : ${t.why}`);

export function exportJSON(data) {
  const blob = new Blob([JSON.stringify({ app: 'panier', version: 1, exported: new Date().toISOString(), ...data }, null, 1)], { type: 'application/json' });
  download(blob, `panier-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`);
}

export async function exportExcel(data, { series, alerts, trust = new Map() }) {
  const XLSX = await loadSheetJS();
  const P = new Map(data.products.map((p) => [p.id, p]));
  const R = new Map(data.receipts.map((r) => [r.id, r]));
  const S = new Map(data.stores.map((s) => [s.id, s]));
  const achats = data.lines.map((l) => {
    const p = P.get(l.productId) || {};
    const r = R.get(l.receiptId) || {};
    return {
      Date: r.date, Magasin: S.get(r.storeId)?.name || '', Produit: p.name, Unité: p.unit,
      'Catégorie IPC': CAT[p.category]?.name || '', Quantité: l.qty, 'Montant ($)': l.amount,
      'Prix unitaire ($)': Math.round(unitPrice(l) * 100) / 100, 'Prix régulier ($)': l.regularPrice ?? '',
      Format: l.sizeQty ? `${l.sizeQty} ${l.sizeUnit}` : '', Source: r.source || '',
      Fiabilité: fiab(trust.get(l.id), p),
    };
  }).sort((a, b) => String(a.Date).localeCompare(String(b.Date)));
  const produits = data.products.map((p) => ({ Produit: p.name, Unité: p.unit, 'Catégorie IPC': CAT[p.category]?.name || '' }));
  const indice = series.map((s) => ({
    Mois: s.month, Indice: Math.round(s.index * 10) / 10, 'Produits communs': s.matched ?? '',
    'Mois sautés': s.gap, Fiable: s.reliable ? 'oui' : 'non',
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(achats), 'Achats');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(produits), 'Produits');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(indice), 'Indice mensuel');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(alerts.length ? alerts : [{ Alerte: 'Aucune' }]), 'Alertes');
  XLSX.writeFile(wb, `panier-${new Date().toISOString().slice(0, 10)}.xlsx`);
}
