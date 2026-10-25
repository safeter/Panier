# Relier Panier au Google Sheet (5 minutes, une seule fois)

Après l'installation, chaque reçu enregistré dans Panier est ajouté à la feuille « 📊 Historique » de **Suivi_depenses_V2**. Sans réseau, les lignes attendent et partent au retour de la connexion.

Ces étapes se font plus facilement sur un ordinateur.

1. Ouvre **Suivi_depenses_V2** dans Google Sheets, puis **Extensions → Apps Script**.
2. Efface le contenu du fichier `Code.gs` et colle le contenu de [`Code.gs`](Code.gs) (bouton « Copy raw file » sur GitHub).
3. Enregistre (icône disquette). Aucun jeton à copier : le script retient celui de ton téléphone au premier envoi.
4. Optionnel : sélectionne la fonction `verifier` et clique **Exécuter** pour accorder les autorisations et vérifier que la feuille est trouvée.
5. **Déployer → Nouveau déploiement** → icône d'engrenage → **Application Web**.
   - Exécuter en tant que : **Moi**
   - Qui a accès : **Tout le monde**
   - **Déployer**, puis autorise l'accès à ton compte quand Google le demande.
6. Copie l'**URL de l'application Web** (elle se termine par `/exec`), colle-la dans Panier → Réglages → Adresse du script, puis **Enregistrer les réglages**.

Panier envoie aussitôt les lignes en attente et affiche le résultat.

## Bon à savoir

- « Tout le monde » signifie que l'adresse accepte les requêtes sans connexion Google ; après le premier envoi, seuls les envois portant le jeton de ton téléphone sont acceptés. Ne partage pas l'adresse.
- Nouveau téléphone : exécute `oublierJeton` dans l'éditeur, puis envoie depuis le nouvel appareil.
- Les colonnes A à J suivent l'historique existant ; K à M ajoutent l'ID Panier (évite les doublons), la catégorie IPC et la source.
- Supprimer un reçu dans Panier retire aussi ses lignes du Sheet.
- Si tu modifies `Code.gs` plus tard : **Déployer → Gérer les déploiements → modifier → Nouvelle version**, pour garder la même adresse.
