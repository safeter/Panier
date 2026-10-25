// Petits graphiques SVG faits main : pas de bibliothèque, rendu net sur mobile.
import { esc, fmtMonth, fmtMoney, fmtPct } from './util.js';
import { monthsBetween } from './calc.js';

const W = 340;

/** Courbe de l'indice personnel (et officiel), axe des temps à l'échelle, trous en pointillé. */
export function indexChart(personal, official = []) {
  if (personal.length < 2) return '<p class="muted">Il faut au moins deux mois de données pour tracer l’indice.</p>';
  const H = 190, L = 34, R = 10, T = 14, B = 26;
  const first = personal[0].month;
  const last = [personal.at(-1).month, official.at(-1)?.month].filter(Boolean).sort().at(-1);
  const span = Math.max(1, monthsBetween(first, last));
  const X = (mo) => L + (monthsBetween(first, mo) / span) * (W - L - R);
  const vals = [...personal.map((p) => p.index), ...official.map((p) => p.index)];
  let lo = Math.floor(Math.min(95, ...vals) / 5) * 5;
  let hi = Math.ceil(Math.max(105, ...vals) / 5) * 5;
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = [];
  for (let v = lo; v <= hi; v += (hi - lo) > 30 ? 10 : 5) ticks.push(v);

  const segs = [];
  for (let i = 1; i < personal.length; i++) {
    const a = personal[i - 1], b = personal[i];
    const dashed = b.gap > 0 || !b.reliable;
    segs.push(`<line x1="${X(a.month)}" y1="${Y(a.index)}" x2="${X(b.month)}" y2="${Y(b.index)}" class="ln-me${dashed ? ' dashed' : ''}"/>`);
  }
  const offPath = official.length > 1
    ? `<polyline class="ln-qc" points="${official.map((p) => `${X(p.month)},${Y(p.index)}`).join(' ')}"/>` : '';
  const dots = personal.map((p) => `<circle cx="${X(p.month)}" cy="${Y(p.index)}" r="3" class="${p.reliable ? 'dot-me' : 'dot-me weak'}"><title>${esc(fmtMonth(p.month))} : ${p.index.toFixed(1)}</title></circle>`).join('');
  const years = [];
  for (let y = Number(first.slice(0, 4)) + 1; y <= Number(last.slice(0, 4)); y++) years.push(`${y}-01`);
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Évolution de mon indice des prix, base 100 en ${esc(fmtMonth(first))}">
    ${ticks.map((v) => `<g><line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="${v === 100 ? 'grid base' : 'grid'}"/><text x="${L - 6}" y="${Y(v) + 3.5}" class="tick" text-anchor="end">${v}</text></g>`).join('')}
    ${years.map((mo) => `<g><line x1="${X(mo)}" x2="${X(mo)}" y1="${T}" y2="${H - B}" class="grid"/><text x="${X(mo)}" y="${H - 8}" class="tick" text-anchor="middle">${mo.slice(0, 4)}</text></g>`).join('')}
    ${offPath}${segs.join('')}${dots}
  </svg>`;
}

/** Barres des dépenses mensuelles du périmètre, mois manquants laissés vides. */
export function spendBars(rows) {
  if (!rows.length) return '';
  const H = 150, L = 8, R = 8, T = 18, B = 24;
  const first = rows[0].month, last = rows.at(-1).month;
  const n = monthsBetween(first, last) + 1;
  const bw = (W - L - R) / n;
  const max = Math.max(...rows.map((r) => r.total));
  const Y = (v) => T + (1 - v / max) * (H - T - B);
  const bars = rows.map((r) => {
    const i = monthsBetween(first, r.month);
    const x = L + i * bw + bw * 0.15;
    return `<rect x="${x}" y="${Y(r.total)}" width="${Math.max(2, bw * 0.7)}" height="${H - B - Y(r.total)}" rx="2" class="bar"><title>${esc(fmtMonth(r.month))} : ${esc(fmtMoney(r.total))}</title></rect>`;
  }).join('');
  const peak = rows.reduce((a, b) => (b.total > a.total ? b : a));
  const px = L + monthsBetween(first, peak.month) * bw + bw / 2;
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Dépenses d'épicerie par mois">
    <line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="axis"/>
    ${bars}
    <text x="${Math.min(W - 40, Math.max(40, px))}" y="${Y(peak.total) - 5}" class="tick strong" text-anchor="middle">${esc(fmtMoney(peak.total).replace(/,\d\d/, ''))}</text>
    <text x="${L}" y="${H - 7}" class="tick">${esc(fmtMonth(first, { short: true }))}</text>
    <text x="${W - R}" y="${H - 7}" class="tick" text-anchor="end">${esc(fmtMonth(last, { short: true }))}</text>
  </svg>`;
}

/** Les trois effets de la décomposition, en barres signées autour de zéro. */
export function effectBars(d) {
  const items = [
    ['Prix', d.pricePct, 'Les mêmes produits coûtent plus ou moins cher'],
    ['Quantité', d.quantityPct, 'J’achète plus ou moins de ces produits'],
    ['Gamme et substitution', d.mixPct, 'Produits nouveaux, abandonnés ou de gamme différente'],
  ];
  const max = Math.max(10, ...items.map(([, v]) => Math.abs(v)));
  return `<ul class="effects">${items.map(([label, v, hint]) => {
    const w = (Math.abs(v) / max) * 50;
    return `<li><div class="eff-head"><span>${label}</span><strong class="${v > 0 ? 'up' : 'down'}">${fmtPct(v)}</strong></div>
      <div class="eff-track" aria-hidden="true"><span class="eff-zero"></span><span class="eff-bar ${v > 0 ? 'up' : 'down'}" style="${v >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`}"></span></div>
      <p class="hint">${hint}</p></li>`;
  }).join('')}</ul>`;
}

/** Historique de prix d'un produit : points par achat, médiane en repère. */
export function priceSpark(history, med) {
  if (history.length < 2) return '';
  const H = 120, L = 40, R = 10, T = 10, B = 22;
  const t = (d) => Date.parse(d) / 864e5;
  const t0 = t(history[0].date), t1 = t(history.at(-1).date);
  const X = (d) => L + ((t(d) - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const ps = history.map((h) => h.price);
  const lo = Math.min(...ps) * 0.92, hi = Math.max(...ps) * 1.08;
  const Y = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Historique des prix">
    ${med ? `<line x1="${L}" x2="${W - R}" y1="${Y(med)}" y2="${Y(med)}" class="grid base"/><text x="${L - 6}" y="${Y(med) + 3.5}" class="tick" text-anchor="end">${med.toFixed(2).replace('.', ',')}</text>` : ''}
    <polyline class="ln-me" points="${history.map((h) => `${X(h.date)},${Y(h.price)}`).join(' ')}"/>
    ${history.map((h) => `<circle cx="${X(h.date)}" cy="${Y(h.price)}" r="3" class="dot-me"><title>${esc(h.date)} : ${esc(fmtMoney(h.price))}</title></circle>`).join('')}
    <text x="${L}" y="${H - 6}" class="tick">${esc(history[0].date.slice(0, 7))}</text>
    <text x="${W - R}" y="${H - 6}" class="tick" text-anchor="end">${esc(history.at(-1).date.slice(0, 7))}</text>
  </svg>`;
}
