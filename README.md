# Panier

Mon inflation d'épicerie, mesurée sur mes propres reçus et comparée à l'IPC officiel du Québec (aliments achetés en magasin).

Application web installable (PWA), en français, pensée pour le téléphone.

## Ce qu'elle calcule

- **Mon indice des prix** : base 100 en décembre 2023. Pour chaque mois observé, les achats des 6 mois civils qui le précèdent sont regroupés (prix moyen payé par produit), puis chaque fenêtre est comparée directement à toutes les autres, produit par produit (Törnqvist bilatéral, pondéré par la part des dépenses). Les niveaux retenus sont ceux qui s'accordent le mieux avec toutes ces comparaisons (GEKS, moindres carrés pondérés par le nombre de produits communs).
  - Pourquoi : avec des achats irréguliers (soldes, mois sans reçus, paniers différents), multiplier des liens mois à mois accumulait l'erreur (« dérive de chaîne ») : +0,3 % sur 12 mois et des catégories à −49 % ou +99 %. Sur les mêmes données, la méthode actuelle donne +5,3 % (92 produits communs) contre +4,5 % pour l'IPC du Québec.
  - Conséquence : l'indice est une moyenne mobile (il réagit avec environ 3 mois de retard) et un nouveau mois peut réviser légèrement les points passés.
  - Un mois qui commence (moins de 5 produits déjà achetés dans les 12 mois précédents) n'entre pas dans le résumé tant qu'il n'est pas assez complet.
- **Comparaison officielle** : série de Statistique Canada (tableau 18-10-0004-01, Québec), lissée sur les mêmes fenêtres de 6 mois, ramenée à la même base et mise à jour automatiquement par une action GitHub.
- **Pourquoi ma facture change** : variation de la dépense moyenne par mois d'achats décomposée en effet prix, effet quantité et effet gamme/substitution.
- **Par catégorie** : catégories alignées sur l'IPC ; le chiffre n'est affiché que si les deux bouts de la période reposent sur au moins 5 produits communs.
- **Alertes** : sur les produits achetés dans les 4 derniers mois : prix > 15 % au-dessus de la médiane, prix plancher, format réduit à prix égal.
- **Deux catégories d'achats** :
  - *fiables* : reçu validé, achat confirmé, ou prix cohérent (à ±50 %) avec les autres achats du même produit, au gramme près quand le format est connu ;
  - *à confirmer* : poids saisi comme quantité, quantité oubliée, ou prix hors de ±50 % de l'habitude (format, poids ou unité probablement différents).
  Seuls les achats fiables entrent dans l'indice ; les dépenses comptent tout. Dans « À vérifier », regroupé par reçu : *C'est correct*, *Autre format* (série de prix à part), *Exclure*, ou *Tout est correct dans ce reçu*. Un reçu enregistré dans l'app est validé (un prix inhabituel est signalé avant l'enregistrement). L'export Excel indique la fiabilité de chaque achat.

## Phase de test

- Toutes les données restent sur le téléphone (IndexedDB). Sauvegarde et restauration par fichier JSON dans Réglages ; export Excel.
- L'historique de décembre 2023 à janvier 2026 (Google Sheet « Suivi_depenses_V2 ») est chargé au premier lancement depuis `data/seed.json`, sans les dépenses hors épicerie (assurances, garderie, téléphone…). Les reçus de mai 2026 de l'ancienne app et le nettoyage du catalogue s'appliquent ensuite une seule fois (`data/patches/`).
- Catalogue : noms au format « Générique précision (Marque) » ; un ancien nom reste reconnu aux saisies et aux PDF. Chaque reçu enregistré peut être corrigé (Reçus → Modifier ce reçu).
- Aucune clé API. Les reçus sont saisis à la main (raccourcis d'achats fréquents), lus depuis un PDF sur le téléphone (commandes Lufa, reçus en ligne ; pdf.js intégré dans `vendor/`), ou importés depuis un fichier préparé par Claude : voir [FORMAT-IMPORT.md](FORMAT-IMPORT.md). Les libellés corrigés sont retenus.

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
| `js/pdfparse.js` | Découpage d'un PDF en lignes d'achat, testé |
| `js/similar.js` | Produits en double probables, d'après le nom, testé |
| `js/catalogue.js` | Renommages, fusions et suppressions du catalogue (`data/patches/`), testé |
| `js/sync.js` | Envoi au Google Sheet (voir `apps-script/`) |
| `data/seed.json` | Historique migré |
| `data/ipc-quebec.json` | IPC officiel du Québec |
