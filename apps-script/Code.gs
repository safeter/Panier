/**
 * Panier → Google Sheet « Suivi_depenses_V2 »
 *
 * Reçoit les achats enregistrés dans l'app Panier et les ajoute à la feuille « 📊 Historique ».
 * Installation : voir apps-script/INSTALLATION.md.
 *
 * Colonnes A à J : identiques à l'historique existant.
 * Colonnes K à M : ID Panier (évite les doublons), catégorie IPC, source (manuel / import).
 */

// Sécurité : au premier envoi, le script retient le jeton de ton téléphone (Panier → Réglages).
// Ensuite, seuls les envois portant ce jeton sont acceptés. Pour changer de téléphone,
// exécute la fonction oublierJeton() dans l'éditeur, puis renvoie depuis le nouvel appareil.
const FEUILLE = '📊 Historique';
const PREMIERE_LIGNE = 3; // ligne 1 : titre, ligne 2 : en-têtes

function doGet() {
  return reponse({ ok: true, app: 'panier', feuille: FEUILLE });
}

function doPost(e) {
  try {
    const corps = JSON.parse(e.postData.contents);
    const proprietes = PropertiesService.getScriptProperties();
    const jeton = proprietes.getProperty('JETON_PANIER');
    if (!corps.token || String(corps.token).length < 16) return reponse({ ok: false, erreur: 'Jeton manquant.' });
    if (!jeton) proprietes.setProperty('JETON_PANIER', corps.token);
    else if (corps.token !== jeton) {
      return reponse({ ok: false, erreur: 'Jeton refusé : ce Sheet est déjà relié à un autre appareil (voir oublierJeton dans le script).' });
    }
    const verrou = LockService.getScriptLock();
    verrou.waitLock(20000);
    try {
      const feuille = SpreadsheetApp.getActive().getSheetByName(FEUILLE);
      if (!feuille) return reponse({ ok: false, erreur: 'Feuille « ' + FEUILLE + ' » introuvable.' });
      preparerEntetes(feuille);
      if (corps.op === 'delete') return reponse(supprimer(feuille, corps.ids || []));
      return reponse(ajouter(feuille, corps.rows || []));
    } finally {
      verrou.releaseLock();
    }
  } catch (err) {
    return reponse({ ok: false, erreur: String(err) });
  }
}

/** À exécuter dans l'éditeur pour relier le Sheet à un nouvel appareil. */
function oublierJeton() {
  PropertiesService.getScriptProperties().deleteProperty('JETON_PANIER');
}

/** Exécuté une fois depuis l'éditeur pour accorder les autorisations au script. */
function verifier() {
  const feuille = SpreadsheetApp.getActive().getSheetByName(FEUILLE);
  Logger.log(feuille ? 'OK : ' + (feuille.getLastRow() - 2) + ' lignes dans ' + FEUILLE : 'Feuille introuvable');
}

function preparerEntetes(feuille) {
  const entetes = feuille.getRange(2, 11, 1, 3).getValues()[0];
  if (entetes[0] !== 'ID Panier') {
    feuille.getRange(2, 11, 1, 3).setValues([['ID Panier', 'Catégorie IPC', 'Source']]).setFontWeight('bold');
  }
}

function idsExistants(feuille) {
  const derniere = feuille.getLastRow();
  if (derniere < PREMIERE_LIGNE) return {};
  const valeurs = feuille.getRange(PREMIERE_LIGNE, 11, derniere - PREMIERE_LIGNE + 1, 1).getValues();
  const index = {};
  valeurs.forEach(function (v, i) { if (v[0]) index[v[0]] = PREMIERE_LIGNE + i; });
  return index;
}

function ajouter(feuille, lignes) {
  const deja = idsExistants(feuille);
  const nouvelles = lignes.filter(function (r) { return r.id && !deja[r.id]; });
  if (nouvelles.length) {
    const valeurs = nouvelles.map(function (r) {
      const p = r.date.split('-').map(Number);
      return [
        new Date(p[0], p[1] - 1, p[2]), p[0], p[1], r.produit, r.categorie, r.magasin,
        r.quantite, r.unite, r.montant, r.prixUnitaire, r.id, r.categorieIpc, r.source,
      ];
    });
    const debut = Math.max(feuille.getLastRow() + 1, PREMIERE_LIGNE);
    feuille.getRange(debut, 1, valeurs.length, 13).setValues(valeurs);
    feuille.getRange(debut, 1, valeurs.length, 1).setNumberFormat('yyyy-mm-dd');
  }
  return { ok: true, ajoutees: nouvelles.length, ids: lignes.map(function (r) { return r.id; }) };
}

function supprimer(feuille, ids) {
  const index = idsExistants(feuille);
  const rangs = ids.map(function (id) { return index[id]; }).filter(Boolean).sort(function (a, b) { return b - a; });
  rangs.forEach(function (rang) { feuille.deleteRow(rang); });
  return { ok: true, supprimees: rangs.length, ids: ids };
}

function reponse(objet) {
  return ContentService.createTextOutput(JSON.stringify(objet)).setMimeType(ContentService.MimeType.JSON);
}
