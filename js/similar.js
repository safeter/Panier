// Identification des produits d'après leur nom : repère les doublons probables du catalogue.
// Fonction pure, testée dans tests/similar.test.mjs.

const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const singular = (w) => (w.length > 3 ? w.replace(/(s|x)$/, '') : w);
// Précisions qui ne changent pas le produit (taille, présentation). « bio » n'en fait pas partie : c'est un autre produit.
const QUALIFIERS = new Set(['frais', 'fraiche', 'gros', 'grosse', 'grand', 'grande', 'petit', 'petite', 'moyen', 'moyenne',
  'multicolore', 'melange', 'melangee', 'assorti', 'assortie', 'classique', 'nature', 'original', 'originale', 'regulier', 'reguliere']);

function words(name, { keepParens = true } = {}) {
  const s = keepParens ? name : name.replace(/\(.*?\)/g, ' ');
  return s.split(/\s+/).filter(Boolean).map((orig) => {
    // Un pourcentage (crème 35 %, lait 3,25 %) distingue les produits : on le garde.
    const k = /%/.test(orig) ? `${norm(orig).replace(/[^0-9,.]/g, '')}pct` : singular(norm(orig).replace(/[^a-z0-9]+/g, ''));
    return { orig, k };
  }).filter((w) => w.k && !/^\d+(?:[.,]\d+)?(kg|g|ml|l|lb|oz)?$/.test(w.k));
}

/** Marque entre parenthèses (« Yogourt grec (Oikos) » → « oikos »), ou ''. */
const brandOf = (name) => norm((String(name).match(/\(([^)]*)\)/) || [])[1] || '').replace(/[^a-z0-9]+/g, '');

/** Clé de nom : minuscules, sans accents ni ponctuation ni format (500 g), pluriels au singulier. */
export function nameKey(name, opts) {
  return words(name, opts).map((w) => w.k).join(' ');
}

/** Les mots ajoutés ne sont-ils qu'une marque (majuscule) ou une précision de taille/présentation ? */
function onlyBrandOrQualifier(extra) {
  return extra.length > 0 && extra.every((w) => QUALIFIERS.has(w.k) || /^[A-ZÀ-Ý]/.test(w.orig));
}

/**
 * Paires de produits probablement identiques (même unité, même catégorie pour les variantes) :
 * - 'meme-nom' : même nom à la casse, aux accents, au pluriel ou au format près → fusion recommandée
 * - 'variante' : le nom long n'ajoute qu'une marque ou une précision → à confirmer
 * @param counts Map(productId -> nombre d'achats) ; @param dismissed Set de clés « idA|idB » déclarées différentes
 */
export function similarProducts(products, counts = new Map(), dismissed = new Set()) {
  const items = products.filter((p) => p.category !== 'hors' && (counts.get(p.id) || 0) > 0)
    .map((p) => ({ p, n: counts.get(p.id) || 0, full: nameKey(p.name), bare: nameKey(p.name, { keepParens: false }), w: words(p.name, { keepParens: false }), brand: brandOf(p.name) }))
    .filter((x) => x.full);
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.p.unit !== b.p.unit) continue;
      let kind = null;
      if (a.full === b.full) kind = 'meme-nom';
      // « Jus (Oasis) » et « Jus (Tropicana) » : deux marques, deux séries de prix.
      else if (a.brand && b.brand && a.brand !== b.brand) continue;
      else if (a.p.category === b.p.category) {
        if (a.bare === b.bare) kind = 'variante';
        else {
          const [s, l] = a.w.length <= b.w.length ? [a, b] : [b, a];
          const prefix = s.w.length >= 1 && s.bare.length >= 4 && s.w.every((w, k) => l.w[k]?.k === w.k);
          if (prefix && onlyBrandOrQualifier(l.w.slice(s.w.length))) kind = 'variante';
        }
      }
      if (!kind) continue;
      // On garde le produit le plus acheté ; à égalité, le nom le plus court.
      const [keep, drop] = a.n > b.n || (a.n === b.n && a.p.name.length <= b.p.name.length) ? [a, b] : [b, a];
      const key = [keep.p.id, drop.p.id].sort().join('|');
      if (dismissed.has(key)) continue;
      pairs.push({ kind, keep: keep.p, drop: drop.p, keepCount: keep.n, dropCount: drop.n, key });
    }
  }
  // Un produit à fusionner n'apparaît qu'une fois (dans sa meilleure paire).
  pairs.sort((x, y) => (x.kind === y.kind ? (y.keepCount + y.dropCount) - (x.keepCount + x.dropCount) : x.kind === 'meme-nom' ? -1 : 1));
  const seen = new Set();
  return pairs.filter((x) => (seen.has(x.drop.id) ? false : (seen.add(x.drop.id), true)));
}
