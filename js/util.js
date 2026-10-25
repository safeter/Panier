export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const money = new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' });
export const fmtMoney = (x) => money.format(x ?? 0);

export function fmtPct(x, digits = 1) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const s = Math.abs(x).toLocaleString('fr-CA', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${x > 0.05 ? '+' : x < -0.05 ? '−' : ''}${s} %`;
}

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juill.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
export function fmtMonth(mo, { short = false } = {}) {
  const [y, m] = mo.split('-').map(Number);
  return short ? `${MONTHS[m - 1]} ${String(y).slice(2)}` : `${MONTHS[m - 1]} ${y}`;
}
export function fmtDate(d) {
  const [y, m, day] = d.split('-').map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
}

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const uid = (p = 'id') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
}

/** Parse un nombre saisi à la québécoise (« 3,49 » ou « 3.49 »). */
export function num(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** « 500 g », « 1,5 L », « 12 » -> { qty: grammes|ml|unités, unit } */
export function parseSize(s) {
  const m = String(s ?? '').trim().toLowerCase().replace(',', '.').match(/^([\d.]+)\s*(kg|g|l|ml|un|u)?$/);
  if (!m) return null;
  let q = parseFloat(m[1]);
  let unit = m[2] || 'un';
  if (unit === 'kg') { q *= 1000; unit = 'g'; }
  if (unit === 'l') { q *= 1000; unit = 'ml'; }
  if (unit === 'u') unit = 'un';
  return { qty: q, unit };
}
export function fmtSize(qty, unit) {
  if (!qty) return '';
  if (unit === 'g' && qty >= 1000) return `${(qty / 1000).toLocaleString('fr-CA')} kg`;
  if (unit === 'ml' && qty >= 1000) return `${(qty / 1000).toLocaleString('fr-CA')} L`;
  return `${qty.toLocaleString('fr-CA')} ${unit === 'un' ? 'un.' : unit}`;
}
