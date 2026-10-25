# Panier

Mon inflation d'épicerie, mesurée sur mes propres reçus et comparée à l'IPC officiel du Québec (aliments achetés en magasin).

Application web installable (PWA), en français, pensée pour le téléphone.

## Ce qu'elle calcule

- **Mon indice des prix** : mensuel, chaîné (Törnqvist), base 100 en décembre 2023. Chaque produit pèse selon sa part de mes dépenses ; les trous dans l'historique sont franchis par un lien direct entre mois observés.
- **Comparaison officielle** : série de Statistique Canada (tableau 18-10-0004-01, Québec), ramenée à la même base et mise à jour automatiquement par une action GitHub.
- **Pourquoi ma facture change** : variation des dépenses décomposée en effet prix, effet quantité et effet gamme/substitution.
- **Par catégorie** : catégories alignées sur l'IPC.
- **Alertes** : prix > 15 % au-dessus de la médiane, prix plancher, format réduit à prix égal.

## Phase de test

- Toutes les données restent sur le téléphone (IndexedDB). Sauvegarde et restauration par fichier JSON dans Réglages ; export Excel.
- L'historique de décembre 2023 à janvier 2026 (814 lignes, Google Sheet « Suivi_depenses_V2 ») est chargé au premier lancement depuis `data/seed.json`.
- Aucune clé API. Les reçus sont saisis à la main (avec raccourcis d'achats fréquents) ou importés depuis un fichier préparé par Claude dans le projet Panier : voir [FORMAT-IMPORT.md](FORMAT-IMPORT.md).

## Développement

Aucune étape de build : modules JavaScript natifs servis tels quels.

```
python3 -m http.server 8000      # puis http://localhost:8000
node --test tests/*.test.mjs     # tests des calculs
node scripts/update-ipc.mjs      # met à jour data/ipc-quebec.json
```

| Fichier | Rôle |
| --- | --- |
| `js/calc.js` | Calculs purs (indice, décomposition, alertes), testés |
| `js/db.js` | Stockage local IndexedDB |
| `js/app.js` | Écrans et navigation |
| `js/importer.js` | Import de reçus (fichier JSON), testé |
| `data/seed.json` | Historique migré |
| `data/ipc-quebec.json` | IPC officiel du Québec |
