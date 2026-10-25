// Met à jour data/ipc-quebec.json depuis l'API WDS de Statistique Canada.
// Tableau 18-10-0004-01 (IPC mensuel, non désaisonnalisé, 2002=100),
// géographie « Québec », produit « Aliments achetés en magasin ».
// Exécuté chaque mois par .github/workflows/ipc.yml (et à la demande).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const WDS = 'https://www150.statcan.gc.ca/t1/wds/rest';
const PID = 18100004;
const OUT = new URL('../data/ipc-quebec.json', import.meta.url);

async function post(endpoint, body) {
  const res = await fetch(`${WDS}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${endpoint} : HTTP ${res.status}`);
  const [first] = await res.json();
  if (first.status !== 'SUCCESS') throw new Error(`${endpoint} : ${JSON.stringify(first).slice(0, 300)}`);
  return first.object;
}

const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function findMember(dimension, ...names) {
  const wanted = names.map(norm);
  const m = dimension.member.find((x) => wanted.includes(norm(x.memberNameEn)) || wanted.includes(norm(x.memberNameFr || '')));
  if (!m) throw new Error(`membre introuvable : ${names.join(' / ')} dans ${dimension.dimensionNameEn}`);
  return m.memberId;
}

const meta = await post('getCubeMetadata', [{ productId: PID }]);
const dims = meta.dimension;
const geo = dims.find((d) => /geograph/i.test(d.dimensionNameEn));
const prod = dims.find((d) => /product/i.test(d.dimensionNameEn));
const coord = new Array(10).fill(0);
coord[geo.dimensionPositionId - 1] = findMember(geo, 'Quebec', 'Québec');
coord[prod.dimensionPositionId - 1] = findMember(prod, 'Food purchased from stores', 'Aliments achetés en magasin');

const data = await post('getDataFromCubePidCoordAndLatestN', [{ productId: PID, coordinate: coord.join('.'), latestN: 120 }]);
const points = data.vectorDataPoint
  .filter((p) => p.value !== null)
  .map((p) => ({ month: p.refPer.slice(0, 7), value: Number(p.value) }))
  .sort((a, b) => a.month.localeCompare(b.month));
if (points.length < 12) throw new Error(`série trop courte : ${points.length} points`);

const out = {
  source: 'Statistique Canada, tableau 18-10-0004-01 — Québec, aliments achetés en magasin (2002=100)',
  vector: `v${data.vectorId}`,
  updated: new Date().toISOString().slice(0, 10),
  points,
};
const before = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
const prevPoints = before ? JSON.stringify(JSON.parse(before).points) : '';
if (prevPoints === JSON.stringify(points)) {
  console.log('Aucune nouvelle donnée.');
} else {
  writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  console.log(`${points.length} points, dernier : ${points.at(-1).month} = ${points.at(-1).value}`);
}
