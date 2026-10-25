# Format d'import des reçus

Fichier `.json` importé par l'écran **Ajouter → Importer des reçus**. Il est produit par Claude dans le projet Panier à partir de photos ou de PDF de reçus.

```json
{
  "app": "panier-recus",
  "receipts": [
    {
      "date": "2026-10-24",
      "store": "Super C",
      "total": 87.42,
      "lines": [
        { "name": "Banane bio", "unit": "kg", "qty": 1.2, "amount": 2.87 },
        { "name": "Yogourt Oikos grec", "unit": "pot", "qty": 1, "amount": 4.99, "regularPrice": 5.99, "size": "750 g" },
        { "name": "Kombucha gingembre", "unit": "bouteille", "qty": 1, "amount": 4.29, "size": "414 ml", "category": "autres" }
      ]
    }
  ]
}
```

| Champ | Obligatoire | Règle |
| --- | --- | --- |
| `date` | oui | `AAAA-MM-JJ` |
| `store` | oui | Nom du magasin ; créé s'il est nouveau |
| `total` | non | Total imprimé, taxes comprises (contrôle seulement) |
| `lines[].name` | oui | Nom du catalogue Panier quand le produit existe déjà, à l'identique ; sinon un nom lisible en français |
| `lines[].unit` | non | Unité du catalogue (`unité`, `kg`, `sac`, `paquet`, `boîte`, `contenant`, `bouteille`, `pot`, `litre`, `carton`, `botte`, `pain`, `douzaine`, `tablette`) |
| `lines[].qty` | non | Unités, ou kg pour le vrac ; 1 par défaut |
| `lines[].amount` | oui | Montant payé, rabais déduits |
| `lines[].regularPrice` | non | Prix unitaire avant rabais |
| `lines[].size` | non | Format de l'emballage : `500 g`, `1,5 L` |
| `lines[].category` | non | Pour un nouveau produit : `viande`, `poisson`, `laitiers`, `boulangerie`, `fruits`, `legumes`, `autres`, `hors` |

Taxes, consignes, sous-totaux et paiements sont exclus. Un reçu déjà présent (même date, même magasin, même somme des lignes) est ignoré à l'import.
