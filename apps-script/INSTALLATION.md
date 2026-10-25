# Relier Panier au Google Sheet (5 minutes, une seule fois)

Après l'installation, chaque reçu enregistré dans Panier est ajouté à la feuille « 📊 Historique » de **Suivi_depenses_V2**. Sans réseau, les lignes attendent et partent au retour de la connexion.

Ces étapes se font plus facilement sur un ordinateur.

1. Ouvre **Suivi_depenses_V2** dans Google Sheets, puis **Extensions → Apps Script**.
2. Efface le contenu du fichier `Code.gs` et colle le contenu de [`Code.gs`](Code.gs) (bouton « Copy raw file » sur GitHub).
3. Dans Panier sur ton téléphone : **Réglages → Google Sheet → Copier** le jeton. Colle-le dans la ligne `const JETON = '…';` à la place de `COLLE_ICI_LE_JETON_DE_PANIER`.
4. Enregistre (icône disquette).
5. **Déployer → Nouveau déploiement** → icône d'engrenage → **Application Web**.
   - Exécuter en tant que : **Moi**
   - Qui a accès : **Tout le monde**
   - **Déployer**, puis autorise l'accès à ton compte quand Google le demande.
6. Copie l'**URL de l'application Web** (elle se termine par `/exec`), colle-la dans Panier → Réglages → Adresse du script, puis **Enregistrer les réglages**.

Panier envoie aussitôt les lignes en attente et affiche le résultat.

## Bon à savoir

- « Tout le monde » signifie que l'adresse accepte les requêtes sans connexion Google ; seul l'envoi portant ton jeton est accepté. Ne partage ni l'adresse ni le jeton.
- Les colonnes A à J suivent l'historique existant ; K à M ajoutent l'ID Panier (évite les doublons), la catégorie IPC et la source.
- Supprimer un reçu dans Panier retire aussi ses lignes du Sheet.
- Si tu modifies `Code.gs` plus tard : **Déployer → Gérer les déploiements → modifier → Nouvelle version**, pour garder la même adresse.
