// Catégories alignées sur l'IPC de Statistique Canada (aliments achetés en magasin).
export const CATEGORIES = [
  { id: 'viande', name: 'Viande', short: 'Viande' },
  { id: 'poisson', name: 'Poissons et fruits de mer', short: 'Poisson' },
  { id: 'laitiers', name: 'Produits laitiers et œufs', short: 'Laitiers' },
  { id: 'boulangerie', name: 'Boulangerie et céréales', short: 'Boulangerie' },
  { id: 'fruits', name: 'Fruits, préparations et noix', short: 'Fruits' },
  { id: 'legumes', name: 'Légumes et préparations', short: 'Légumes' },
  { id: 'autres', name: 'Autres aliments et boissons non alcoolisées', short: 'Autres' },
  { id: 'hors', name: 'Hors périmètre (non alimentaire, alcool…)', short: 'Hors' },
];

export const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
export const IN_SCOPE = CATEGORIES.filter((c) => c.id !== 'hors');
