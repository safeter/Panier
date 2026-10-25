// Mise à jour du catalogue (renommages, fusions, suppressions) décrite par un fichier de data/patches/.
// Fonction pure, testée dans tests/catalogue.test.mjs. Rejouer le même fichier ne change plus rien.

const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Clé d'une paire de produits déclarés différents (même format que similarProducts). */
export const pairKey = (a, b) => [a, b].sort().join('|');

/**
 * @returns {{putProducts, delProducts, putLines, delLines, delReceipts, aliases, notSame, summary}}
 *   aliases : ancien nom (slug) -> id du produit, pour reconnaître les anciens noms aux prochains imports.
 *   delReceipts : reçus dont tous les articles ont été supprimés.
 *   notSame : paires « idA|idB » à ne plus proposer comme doublons.
 */
export function planCatalogue(data, patch) {
  const products = new Map(data.products.map((p) => [p.id, { ...p }]));
  const lines = data.lines.map((l) => ({ ...l }));
  const putProducts = new Map();
  const delProducts = new Set();
  const putLines = new Map();
  const delLines = new Set();
  const aliases = {};
  const summary = { renamed: 0, merged: 0, deleted: 0, linesMoved: 0, linesDeleted: 0 };

  for (const [id, name] of Object.entries(patch.rename || {})) {
    const p = products.get(id);
    if (!p || p.name === name) continue;
    aliases[slug(p.name)] = id;
    p.name = name;
    putProducts.set(id, p);
    summary.renamed++;
  }
  for (const [from, to] of patch.merge || []) {
    const a = products.get(from);
    const b = products.get(to);
    if (!a || !b || from === to) continue;
    for (const l of lines) {
      if (l.productId === from) { l.productId = to; putLines.set(l.id, l); summary.linesMoved++; }
    }
    aliases[slug(a.name)] = to;
    for (const [k, v] of Object.entries(aliases)) if (v === from) aliases[k] = to;
    products.delete(from);
    putProducts.delete(from);
    delProducts.add(from);
    summary.merged++;
  }
  for (const id of patch.delete || []) {
    if (!products.has(id)) continue;
    for (const l of lines) {
      if (l.productId === id) { delLines.add(l.id); putLines.delete(l.id); summary.linesDeleted++; }
    }
    for (const [k, v] of Object.entries(aliases)) if (v === id) delete aliases[k];
    products.delete(id);
    putProducts.delete(id);
    delProducts.add(id);
    summary.deleted++;
  }
  // Reçus vidés par les suppressions (ex. une facture d'assurance importée par erreur)
  const left = new Set(lines.filter((l) => !delLines.has(l.id)).map((l) => l.receiptId));
  const touched = new Set(lines.filter((l) => delLines.has(l.id)).map((l) => l.receiptId));
  const delReceipts = [...touched].filter((id) => !left.has(id));
  const notSame = (patch.notSame || []).filter(([a, b]) => products.has(a) && products.has(b)).map(([a, b]) => pairKey(a, b));
  return {
    putProducts: [...putProducts.values()], delProducts: [...delProducts],
    putLines: [...putLines.values()], delLines: lines.filter((l) => delLines.has(l.id)),
    delReceipts, aliases, notSame, summary,
  };
}
