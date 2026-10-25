// Calculs purs de Panier : aucune dépendance au navigateur, testés dans tests/calc.test.mjs.
//
// Modèle d'entrée (tableaux simples) :
//   products : { id, name, unit, category, sizeQty?, sizeUnit? }
//   receipts : { id, date: 'YYYY-MM-DD', storeId }
//   lines    : { id, receiptId, productId, qty, amount, regularPrice? }

import { isTaxLabel } from './categories.js';

export const HORS = 'hors';
export const MIN_MATCHED = 5; // un lien chaîné avec moins de produits communs est peu fiable
// Un prix qui triple ou tombe au tiers d'un mois à l'autre est presque toujours une erreur
// d'unité (sac vs pièce, kg vs unité) : il est écarté du calcul et signalé.
export const MAX_RELATIVE = 3;
export const plausible = (ratio) => ratio <= MAX_RELATIVE && ratio >= 1 / MAX_RELATIVE;

export const monthOf = (date) => date.slice(0, 7);

export function monthsBetween(a, b) {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export function unitPrice(line) {
  const q = line.qty > 0 ? line.qty : 1;
  return line.amount / q;
}

/** Lignes enrichies (date, mois, magasin, produit), limitées au périmètre si demandé. */
export function joinLines({ products, receipts, lines }, { inScopeOnly = true } = {}) {
  const P = new Map(products.map((p) => [p.id, p]));
  const R = new Map(receipts.map((r) => [r.id, r]));
  const out = [];
  for (const l of lines) {
    const p = P.get(l.productId);
    const r = R.get(l.receiptId);
    if (!p || !r) continue;
    if (inScopeOnly && p.category === HORS) continue;
    if (isTaxLabel(p.name)) continue; // une taxe saisie par erreur ne compte jamais
    if (!(l.amount > 0)) continue;
    if (l.review === 'excluded') continue; // exclu par l'utilisateur à la vérification
    out.push({ ...l, product: p, date: r.date, month: monthOf(r.date), storeId: r.storeId });
  }
  return out;
}

/**
 * Agrège par mois et par produit : dépense, quantité, prix unitaire moyen (valeur unitaire).
 * Retourne une Map triée mois -> Map(productId -> {spend, qty, price, category})
 */
export function monthlyPanel(joined) {
  const m = new Map();
  for (const l of joined) {
    if (!m.has(l.month)) m.set(l.month, new Map());
    const row = m.get(l.month);
    const cur = row.get(l.productId) || { spend: 0, qty: 0, category: l.product.category };
    cur.spend += l.amount;
    cur.qty += l.qty > 0 ? l.qty : 1;
    row.set(l.productId, cur);
  }
  for (const row of m.values()) for (const v of row.values()) v.price = v.spend / v.qty;
  return new Map([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Fenêtres mobiles : pour chaque mois observé, les achats des `k` derniers mois civils regroupés
 * (dépense, quantité, valeur unitaire). Lisse les soldes et les paniers d'un mois à l'autre.
 * Chaque fenêtre porte `nMonths`, le nombre de mois réellement observés qu'elle contient.
 */
export const WINDOW = 6;
export function rollingPanel(panel, k = WINDOW) {
  const out = new Map();
  for (const mo of panel.keys()) {
    const acc = new Map();
    let nMonths = 0;
    for (const [m2, row] of panel) {
      if (m2 > mo || monthsBetween(m2, mo) >= k) continue;
      nMonths++;
      for (const [id, v] of row) {
        const c = acc.get(id) || { spend: 0, qty: 0, category: v.category };
        c.spend += v.spend;
        c.qty += v.qty;
        acc.set(id, c);
      }
    }
    for (const v of acc.values()) v.price = v.spend / v.qty;
    acc.nMonths = nMonths;
    out.set(mo, acc);
  }
  return out;
}

/** Série officielle en moyenne mobile sur les mêmes fenêtres que l'indice personnel (au moins `min` mois publiés). */
export function smoothOfficial(points, k = WINDOW, min = Math.ceil(k * 2 / 3)) {
  return points.map((p) => {
    const xs = points.filter((q) => q.month <= p.month && monthsBetween(q.month, p.month) < k);
    return xs.length >= min ? { month: p.month, value: xs.reduce((a, q) => a + q.value, 0) / xs.length } : null;
  }).filter(Boolean);
}

/**
 * Lien de Törnqvist entre deux mois : produits communs, pondérés par la part moyenne
 * de dépense sur les deux mois.
 */
export function tornqvistLink(row0, row1, filter = () => true) {
  const ids = [...row0.keys()].filter((id) => row1.has(id) && filter(row0.get(id), id)
    && plausible(row1.get(id).price / row0.get(id).price));
  if (ids.length === 0) return { link: null, matched: 0 };
  const s0 = ids.reduce((a, id) => a + row0.get(id).spend, 0);
  const s1 = ids.reduce((a, id) => a + row1.get(id).spend, 0);
  let logSum = 0;
  for (const id of ids) {
    const a = row0.get(id);
    const b = row1.get(id);
    const w = (a.spend / s0 + b.spend / s1) / 2;
    logSum += w * Math.log(b.price / a.price);
  }
  return { link: Math.exp(logSum), matched: ids.length };
}

/**
 * Indice chaîné, base 100 au premier mois observé. Chaque mois observé est relié au mois
 * observé précédent (les trous sont franchis directement). Un lien impossible (aucun produit
 * commun) reporte l'indice tel quel et est marqué non fiable.
 */
export function chainedIndex(panel, filter = () => true) {
  const months = [...panel.keys()].filter((mo) =>
    [...panel.get(mo).entries()].some(([id, v]) => filter(v, id)));
  const out = [];
  let level = 100;
  months.forEach((mo, i) => {
    if (i === 0) {
      out.push({ month: mo, index: 100, link: null, matched: null, gap: 0, reliable: true });
      return;
    }
    const prev = months[i - 1];
    const { link, matched } = tornqvistLink(panel.get(prev), panel.get(mo), filter);
    if (link !== null) level *= link;
    out.push({
      month: mo, index: level, link, matched, from: prev,
      gap: monthsBetween(prev, mo) - 1,
      reliable: link !== null && matched >= MIN_MATCHED,
    });
  });
  return out;
}

/**
 * Indice multilatéral (GEKS-Törnqvist, moindres carrés), base 100 au premier mois observé.
 *
 * Pourquoi pas le chaînage : avec des achats irréguliers (soldes, trous de plusieurs mois, paniers
 * qui changent), multiplier des liens mois à mois accumule l'erreur (« dérive de chaîne »).
 * Ici, chaque mois est comparé directement à tous les autres mois (Törnqvist bilatéral sur les
 * produits communs) et les niveaux sont ceux qui s'accordent le mieux avec toutes ces comparaisons,
 * chacune pondérée par son nombre de produits communs. Avec des données complètes, c'est exactement GEKS.
 *
 * Un mois sans aucun produit commun avec les autres reprend le niveau du mois précédent (non fiable).
 * reliable : au moins MIN_MATCHED produits en commun avec un autre mois.
 * from : le mois avec lequel il partage le plus de produits ; matched : ce nombre.
 */
export function multilateralIndex(panel, filter = () => true, { minPair = 2 } = {}) {
  const months = [...panel.keys()].filter((mo) =>
    [...panel.get(mo).entries()].some(([id, v]) => filter(v, id)));
  const n = months.length;
  if (!n) return [];
  const w = Array.from({ length: n }, () => new Array(n).fill(0));
  const d = Array.from({ length: n }, () => new Array(n).fill(0));
  const best = months.map(() => ({ matched: 0, with: null }));
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const { link, matched } = tornqvistLink(panel.get(months[a]), panel.get(months[b]), filter);
      for (const [x, y] of [[a, b], [b, a]]) {
        if (matched > best[x].matched || (matched === best[x].matched && matched > 0 && Math.abs(y - x) < Math.abs(best[x].with - x))) {
          best[x] = { matched, with: y };
        }
      }
      if (link === null || matched < minPair) continue;
      w[a][b] = w[b][a] = matched;
      d[a][b] = Math.log(link); // niveau(b) − niveau(a), en log
      d[b][a] = -d[a][b];
    }
  }
  // Plus grand groupe de mois reliés entre eux (directement ou de proche en proche) ; son premier mois sert d'ancre.
  let linked = new Set();
  const seen = new Set();
  for (let s0 = 0; s0 < n; s0++) {
    if (seen.has(s0)) continue;
    const comp = new Set([s0]);
    for (let queue = [s0]; queue.length;) {
      const a = queue.shift();
      for (let b = 0; b < n; b++) if (w[a][b] > 0 && !comp.has(b)) { comp.add(b); queue.push(b); }
    }
    comp.forEach((k) => seen.add(k));
    if (comp.size > linked.size) linked = comp;
  }
  const anchor = Math.min(...linked);
  // Moindres carrés pondérés : minimiser Σ w_ab (d_ab − (x_b − x_a))², avec x_ancre = 0.
  const idx = [...linked].filter((k) => k !== anchor).sort((p, q) => p - q);
  const pos = new Map(idx.map((k, i) => [k, i]));
  const m = idx.length;
  const A = Array.from({ length: m }, () => new Array(m + 1).fill(0));
  idx.forEach((k, i) => {
    for (let j = 0; j < n; j++) {
      if (!w[k][j] || !linked.has(j)) continue;
      A[i][i] += w[k][j];
      if (j !== anchor) A[i][pos.get(j)] -= w[k][j];
      A[i][m] += w[k][j] * d[j][k];
    }
  });
  for (let c = 0; c < m; c++) { // élimination de Gauss (matrice symétrique définie positive)
    let piv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < m; r++) {
      if (r === c || !A[r][c]) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= m; k++) A[r][k] -= f * A[c][k];
    }
  }
  const level = new Array(n).fill(null);
  level[anchor] = 0;
  idx.forEach((k, i) => { level[k] = A[i][m] / A[i][i]; });
  // Base 100 au premier mois relié ; les mois isolés reprennent le niveau voisin et sont marqués non fiables.
  const base = level.find((x) => x !== null);
  const out = [];
  months.forEach((mo, i) => {
    const carried = level[i] === null;
    if (carried) level[i] = i > 0 && level[i - 1] !== null ? level[i - 1] : base;
    out.push({
      month: mo, index: 100 * Math.exp(level[i] - level[0]),
      matched: i === 0 && n === 1 ? null : best[i].matched,
      from: best[i].with === null ? null : months[best[i].with],
      gap: i === 0 ? 0 : monthsBetween(months[i - 1], mo) - 1,
      reliable: !carried && best[i].matched >= MIN_MATCHED,
    });
  });
  return out;
}

/** Point de l'indice le plus proche de `target` dans une fenêtre de ±tol mois. */
function nearest(series, target, tol) {
  let best = null;
  for (const p of series) {
    const d = Math.abs(monthsBetween(p.month, target));
    if (d <= tol && (!best || d < best.d)) best = { ...p, d };
  }
  return best;
}

/**
 * Inflation à afficher : sur 12 mois si un point existe environ un an plus tôt (±2 mois),
 * sinon depuis le premier mois. Retourne {from, to, pct, months, kind}.
 */
export function headlineInflation(series) {
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  // Point de comparaison : un mois fiable (assez de produits communs) environ un an plus tôt.
  const yearAgo = nearest(series.slice(0, -1).filter((p) => p.reliable !== false), addMonths(last.month, -12), 2);
  const base = yearAgo || series[0];
  const months = monthsBetween(base.month, last.month);
  return {
    from: base.month, to: last.month, months,
    pct: (last.index / base.index - 1) * 100,
    annualized: months > 0 ? ((last.index / base.index) ** (12 / months) - 1) * 100 : null,
    kind: yearAgo ? '12mois' : 'depuisDebut',
  };
}

/** Variation de la série officielle sur la même période que l'indice personnel. */
export function officialChange(official, from, to) {
  const get = (mo) => official.find((p) => p.month === mo);
  const a = get(from);
  // La série officielle paraît avec environ un mois de retard : on s'arrête à son dernier mois publié.
  const b = get(to) || official[official.length - 1];
  if (!a || !b || b.month <= from) return null;
  return { from, to: b.month, pct: (b.value / a.value - 1) * 100 };
}

/** Série officielle ramenée à 100 au mois de base de l'indice personnel. */
export function rebase(official, baseMonth) {
  const b = official.find((p) => p.month === baseMonth);
  if (!b) return [];
  return official.filter((p) => p.month >= baseMonth).map((p) => ({ month: p.month, index: (p.value / b.value) * 100 }));
}

/**
 * Décomposition de la variation des dépenses entre deux mois observés :
 *   dépenses1/dépenses0 = effet prix × effet quantité × effet gamme/substitution
 * - prix : ratio de l'indice chaîné entre les deux mois
 * - quantité : quantités des produits communs valorisées aux prix de départ (Laspeyres)
 * - gamme : le reste (nouveaux produits, abandons, changement de gamme)
 */
export function decompose(panel, series, m0, m1) {
  const r0 = panel.get(m0);
  const r1 = panel.get(m1);
  const i0 = series.find((p) => p.month === m0);
  const i1 = series.find((p) => p.month === m1);
  if (!r0 || !r1 || !i0 || !i1) return null;
  // Fenêtres mobiles : dépenses et quantités ramenées à un mois moyen observé.
  const k0 = r0.nMonths || 1;
  const k1 = r1.nMonths || 1;
  const S0 = [...r0.values()].reduce((a, v) => a + v.spend, 0) / k0;
  const S1 = [...r1.values()].reduce((a, v) => a + v.spend, 0) / k1;
  const common = [...r0.keys()].filter((id) => r1.has(id));
  const q0 = common.reduce((a, id) => a + r0.get(id).price * r0.get(id).qty / k0, 0);
  const q1 = common.reduce((a, id) => a + r0.get(id).price * r1.get(id).qty / k1, 0);
  const price = i1.index / i0.index;
  const quantity = q0 > 0 ? q1 / q0 : 1;
  const total = S1 / S0;
  const mix = total / (price * quantity);
  const pct = (x) => (x - 1) * 100;
  return {
    m0, m1, spend0: S0, spend1: S1,
    totalPct: pct(total), pricePct: pct(price), quantityPct: pct(quantity), mixPct: pct(mix),
  };
}

/** Dépenses du périmètre par mois et par catégorie. */
export function spendByMonth(joined) {
  const m = new Map();
  for (const l of joined) {
    const row = m.get(l.month) || { month: l.month, total: 0, byCat: {} };
    row.total += l.amount;
    row.byCat[l.product.category] = (row.byCat[l.product.category] || 0) + l.amount;
    m.set(l.month, row);
  }
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** Historique de prix d'un produit (une entrée par ligne), du plus ancien au plus récent. */
export function priceHistory(joined, productId) {
  return joined
    .filter((l) => l.productId === productId)
    .map((l) => ({ date: l.date, storeId: l.storeId, price: unitPrice(l), sizeQty: l.sizeQty ?? null, sizeUnit: l.sizeUnit ?? null }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

/**
 * Alertes d'un produit à partir de son historique :
 * - 'cher'  : dernier prix > 15 % au-dessus de la médiane historique (≥ 3 observations)
 * - 'plancher' : dernier prix = prix le plus bas observé (≥ 3 observations)
 * - 'shrink' : même prix (±2 %) qu'avant mais format plus petit (taille connue)
 */
export function alertsFor(history) {
  const out = [];
  if (history.length >= 3) {
    const last = history[history.length - 1];
    const prior = history.slice(0, -1).map((h) => h.price);
    const med = median(prior);
    if (last.price > med * 1.15) out.push({ kind: 'cher', pct: (last.price / med - 1) * 100 });
    else if (last.price <= Math.min(...prior)) out.push({ kind: 'plancher' });
  }
  const sized = history.filter((h) => h.sizeQty);
  if (sized.length >= 2) {
    const a = sized[sized.length - 2];
    const b = sized[sized.length - 1];
    if (b.sizeQty < a.sizeQty && Math.abs(b.price / a.price - 1) <= 0.02) {
      out.push({ kind: 'shrink', pct: (1 - b.sizeQty / a.sizeQty) * 100 });
    }
  }
  return out;
}

/** Produits dont le prix a le plus changé entre leur première et leur dernière observation. */
export function movers(joined, { minObs = 3 } = {}) {
  const by = new Map();
  for (const l of joined) {
    if (!by.has(l.productId)) by.set(l.productId, []);
    by.get(l.productId).push(l);
  }
  const out = [];
  for (const [id, ls] of by) {
    if (ls.length < minObs) continue;
    ls.sort((a, b) => a.date.localeCompare(b.date));
    // Avec 4 achats ou plus, médiane des deux premiers et des deux derniers : un prix isolé pèse moins.
    const k = ls.length >= 4 ? 2 : 1;
    const first = median(ls.slice(0, k).map(unitPrice));
    const last = median(ls.slice(-k).map(unitPrice));
    if (first <= 0 || !plausible(last / first)) continue;
    out.push({ productId: id, name: ls[0].product.name, first, last, from: ls[0].date, to: ls[ls.length - 1].date, pct: (last / first - 1) * 100 });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

/**
 * Contrôle de qualité des achats. Retourne Map(lineId -> {kind, msg, fix}) pour les lignes suspectes :
 * - 'poids'    : quantité décimale pour un produit vendu à l'unité (un poids en kg saisi comme quantité)
 * - 'quantite' : montant ≈ k × prix habituel avec quantité 1 (quantité oubliée), ou l'inverse
 * - 'ecart'    : prix unitaire très éloigné du prix habituel du produit, sans explication évidente
 * Une ligne marquée review: 'ok' par l'utilisateur n'est plus signalée.
 */
export function auditLines(joined) {
  const flags = new Map();
  const by = new Map();
  for (const l of joined) {
    if (!by.has(l.productId)) by.set(l.productId, []);
    by.get(l.productId).push(l);
  }
  const money = (x) => x.toFixed(2).replace('.', ',') + ' $';
  for (const ls of by.values()) {
    for (const l of ls) {
      if (l.review === 'ok') continue;
      const unit = l.product.unit;
      const u = unitPrice(l);
      if (!Number.isInteger(l.qty) && unit !== 'kg') {
        flags.set(l.id, { kind: 'poids', msg: `Quantité ${String(l.qty).replace('.', ',')} pour un produit vendu « ${unit} » : c'est probablement un poids en kg.`,
          fixes: [{ label: `Vendu au kg (${String(l.qty).replace('.', ',')} kg)`, patch: { unit: 'kg' } }] });
        continue;
      }
      const others = ls.filter((x) => x !== l).map(unitPrice);
      if (others.length < 2) continue;
      const med = median(others);
      const r = u / med;
      if (r > 2.2) {
        const k = Math.round(r);
        if (l.qty === 1 && k >= 2 && k <= 8 && Math.abs(u / (k * med) - 1) <= 0.03) {
          flags.set(l.id, { kind: 'quantite', msg: `${money(l.amount)} ≈ ${k} × ${money(med)} (prix habituel) : quantité probablement ${k}.`,
            fixes: [{ label: `Quantité ${k}`, patch: { qty: k } }] });
        } else {
          flags.set(l.id, { kind: 'ecart', msg: `${money(u)} l'unité contre ${money(med)} d'habitude (${r.toFixed(1).replace('.', ',')} fois plus cher) : format différent ou erreur de saisie ?` });
        }
      } else if (r < 0.45) {
        if (l.qty > 1 && Math.abs(l.amount / med - 1) <= 0.12) {
          const total = Math.round(l.qty * l.amount * 100) / 100;
          flags.set(l.id, { kind: 'quantite', msg: `${money(l.amount)} pour ${l.qty} articles, mais c'est le prix habituel d'un seul (${money(med)}).`,
            fixes: [
              { label: `Total ${money(total)} (${l.qty} × ${money(l.amount)})`, patch: { amount: total } },
              { label: 'Quantité 1', patch: { qty: 1 } },
            ] });
        } else {
          flags.set(l.id, { kind: 'ecart', msg: `${money(u)} l'unité contre ${money(med)} d'habitude (${Math.round((1 - r) * 100)} % moins cher) : rabais, format plus petit ou erreur ?` });
        }
      }
    }
  }
  return flags;
}
