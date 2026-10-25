// Lecture d'un reçu (photo ou PDF) par Claude.
// Phase de test : appel direct avec la clé API personnelle gardée sur l'appareil.
// Avant la publication, cet appel passera par une fonction serveur (la clé ne sera plus dans l'app).
import { CATEGORIES } from './categories.js';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Réduit une photo trop lourde (les reçus photographiés font souvent 4 à 8 Mo). */
async function shrinkImage(file, maxSide = 2000) {
  if (!file.type.startsWith('image/') || file.size < 1.5e6) return file;
  const img = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
  return new File([blob], 'recu.jpg', { type: 'image/jpeg' });
}

function buildPrompt(products, stores) {
  const catalogue = products.map((p) => `${p.id} | ${p.name} | ${p.unit}`).join('\n');
  return `Tu lis un reçu d'épicerie québécois et tu le convertis en JSON.

Réponds UNIQUEMENT avec un objet JSON, sans texte autour, de cette forme :
{
  "store": "nom du magasin (ex. Super C, Maxi, IGA, Provigo, Metro)",
  "date": "AAAA-MM-JJ",
  "total": 0.00,
  "lines": [
    {
      "raw": "libellé tel qu'imprimé",
      "name": "nom lisible et normalisé du produit, en français",
      "qty": 1,
      "amount": 0.00,
      "regularPrice": null,
      "size": "500 g",
      "matchId": null,
      "category": "legumes",
      "confidence": 0.9
    }
  ]
}

Règles :
- amount = montant payé pour la ligne, rabais déduits. Si un rabais est imprimé sur une ligne séparée, déduis-le de l'article concerné et mets le prix avant rabais (prix unitaire) dans regularPrice.
- qty = nombre d'unités, ou poids en kg pour les produits vendus au poids.
- size = format de l'emballage s'il est imprimé (g, kg, ml, L), sinon null.
- Ignore les taxes, sous-totaux, consignes, modes de paiement et points de fidélité.
- matchId = l'identifiant du catalogue ci-dessous si c'est clairement le même produit et la même unité, sinon null.
- category, parmi : ${CATEGORIES.map((c) => `${c.id} (${c.name})`).join(', ')}.
- confidence entre 0 et 1 : ta certitude sur le nom, le montant et la correspondance.

Magasins connus : ${stores.map((s) => s.name).join(', ')}

Catalogue (id | nom | unité) :
${catalogue}`;
}

export async function scanReceipt(file, { apiKey, model, products, stores }) {
  if (!apiKey) throw new Error('Ajoute ta clé API Claude dans Réglages pour scanner un reçu.');
  const f = await shrinkImage(file);
  const data = await fileToBase64(f);
  const isPdf = f.type === 'application/pdf';
  const media = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
    : { type: 'image', source: { type: 'base64', media_type: f.type || 'image/jpeg', data } };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: [media, { type: 'text', text: buildPrompt(products, stores) }] }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401) throw new Error('Clé API refusée. Vérifie-la dans Réglages.');
    throw new Error(`Claude a répondu ${res.status} : ${body.slice(0, 200)}`);
  }
  const out = await res.json();
  const text = out.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(json);
  } catch {
    throw new Error('La réponse de Claude n’était pas lisible. Réessaie avec une photo plus nette.');
  }
}
