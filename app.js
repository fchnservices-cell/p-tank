/* ============================================================
 * P-TANK — Application mobile (PWA)
 * Fichier : app.js
 *
 * Reprend toutes les fonctions de l'interface historique et ajoute :
 *  - dialogue avec Google Apps Script par API (fetch) ;
 *  - affichage immédiat des dernières données connues (même sans réseau) ;
 *  - saisie des scores hors connexion, envoyée automatiquement ensuite ;
 *  - rafraîchissement automatique des équipes, scores et classement ;
 *  - choix de la date lors de l'archivage et date du tournoi modifiable ;
 *  - partage des PDF depuis le téléphone.
 * ============================================================ */
(function () {
  'use strict';

  const CFG = window.P_TANK_CONFIG || {};
  const REFRESH_MS = Math.max(10, Number(CFG.REFRESH_SECONDES) || 30) * 1000;
  const CLE_CACHE = 'ptank_etat_v1';
  const CLE_FILE = 'ptank_scores_en_attente_v1';
  const CLE_ADMIN = 'ptank_admin';
  const CLE_INSTALL_MASQUE = 'ptank_install_masque';
  const MAX_PARTICIPANTS = 46;

  // ==========================================================
  // ÉTAT GLOBAL CLIENT
  // ==========================================================
  const ETAT = {
    adminCode: lireSession(CLE_ADMIN),
    equipes: [],
    matchs: [],
    classement: [],
    dateTournoi: null,
    joueurs: [],
    majServeur: null,      // horodatage des dernières données reçues
    donneesChargees: false
  };

  // ==========================================================
  // OUTILS GÉNÉRIQUES
  // ==========================================================
  const $ = (id) => document.getElementById(id);

  function esc(texte) {
    return String(texte === null || texte === undefined ? '' : texte)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function lireStockage(cle, defaut) {
    try {
      const v = localStorage.getItem(cle);
      return v ? JSON.parse(v) : defaut;
    } catch (e) { return defaut; }
  }
  function ecrireStockage(cle, valeur) {
    try { localStorage.setItem(cle, JSON.stringify(valeur)); } catch (e) { /* stockage plein ou bloqué */ }
  }
  function lireSession(cle) {
    try { return sessionStorage.getItem(cle) || null; } catch (e) { return null; }
  }
  function ecrireSession(cle, valeur) {
    try {
      if (valeur) sessionStorage.setItem(cle, valeur); else sessionStorage.removeItem(cle);
    } catch (e) { /* ignoré */ }
  }

  let minuterieToast = null;
  function afficherToast(message, isErreur, duree) {
    const toast = $('toast');
    toast.textContent = message;
    toast.className = isErreur ? 'erreur active' : 'active';
    clearTimeout(minuterieToast);
    minuterieToast = setTimeout(() => { toast.className = isErreur ? 'erreur' : ''; }, duree || 3200);
  }

  let compteurLoader = 0;
  function afficherLoader(show) {
    compteurLoader = Math.max(0, compteurLoader + (show ? 1 : -1));
    $('loader').className = compteurLoader > 0 ? 'active' : '';
  }

  function ouvrirPanel(idOverlay, idPanel) {
    $(idOverlay).classList.add('active');
    $(idPanel).classList.add('active');
  }

  function fermerPanel(idPanel) {
    $(idPanel).classList.remove('active');
    document.querySelectorAll('.overlay').forEach((o) => o.classList.remove('active'));
  }

  function unPanelEstOuvert() {
    return !!document.querySelector('.panel.active');
  }

  function formaterDateFr(texteIso) {
    if (!texteIso) return '';
    const p = String(texteIso).slice(0, 10).split('-');
    if (p.length !== 3) return texteIso;
    return p[2] + '/' + p[1] + '/' + p[0];
  }

  function aujourdhuiIso() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function heureCourte(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + 'h' + String(d.getMinutes()).padStart(2, '0');
  }

  // ==========================================================
  // DIALOGUE AVEC LE SERVEUR (Google Apps Script)
  // ==========================================================

  /**
   * Appelle une fonction du Code.gs via l'API.
   * opts.silencieux : pas de sablier ni de message d'erreur (rafraîchissements automatiques)
   * Les erreurs portent err.reseau = true quand le serveur est injoignable.
   */
  async function api(action, args, opts) {
    opts = opts || {};
    args = args || [];

    if (!CFG.API_URL || CFG.API_URL.indexOf('COLLER_ICI') !== -1) {
      const e = new Error('Application non configurée : renseignez l\'adresse de l\'API dans config.js.');
      e.metier = true;
      if (!opts.silencieux) afficherToast(e.message, true, 6000);
      throw e;
    }

    if (!opts.silencieux) afficherLoader(true);
    try {
      let rep;
      try {
        rep = await fetch(CFG.API_URL, {
          method: 'POST',
          // text/plain évite le blocage « CORS » de Google Apps Script
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: action, args: args }),
          redirect: 'follow'
        });
      } catch (errReseau) {
        const e = new Error('Connexion impossible. Vérifiez le réseau.');
        e.reseau = true;
        throw e;
      }

      if (!rep.ok) {
        const e = new Error('Le serveur a répondu avec une erreur (' + rep.status + ').');
        e.reseau = rep.status >= 500;
        e.metier = !e.reseau;
        throw e;
      }

      let json;
      try {
        json = await rep.json();
      } catch (errJson) {
        const e = new Error('Réponse inattendue du serveur. Vérifiez que le déploiement Apps Script est accessible à « Tout le monde ».');
        e.metier = true;
        throw e;
      }

      if (!json.ok) {
        const e = new Error(json.error || 'Une erreur est survenue.');
        e.metier = true;
        throw e;
      }
      return json.data;
    } catch (err) {
      if (!opts.silencieux) afficherToast(err.message, true, err.reseau ? 3500 : 5000);
      throw err;
    } finally {
      if (!opts.silencieux) afficherLoader(false);
    }
  }

  /** Raccourci identique à l'ancienne interface : appelServeur('fonction', arg1, arg2...) */
  function appelServeur(nomFonction, ...args) {
    return api(nomFonction, args);
  }

  // ==========================================================
  // DONNÉES PUBLIQUES : CACHE LOCAL + RAFRAÎCHISSEMENT
  // ==========================================================
  function appliquerEtat(etat) {
    ETAT.equipes = etat.equipes || [];
    ETAT.matchs = etat.matchs || [];
    ETAT.classement = etat.classement || [];
    ETAT.dateTournoi = etat.dateTournoi || null;
    ETAT.majServeur = etat.horodatage || Date.now();
    ETAT.donneesChargees = true;
  }

  function chargerCacheLocal() {
    const cache = lireStockage(CLE_CACHE, null);
    if (cache && cache.equipes) {
      appliquerEtat(cache);
      return true;
    }
    return false;
  }

  let chargementEnCours = null;

  /** Recharge équipes + matchs + classement en un seul appel. */
  function chargerEtatPublic(silencieux) {
    if (chargementEnCours) return chargementEnCours;
    chargementEnCours = api('getEtatPublic', [], { silencieux: silencieux })
      .then((etat) => {
        appliquerEtat(etat);
        ecrireStockage(CLE_CACHE, etat);
        return etat;
      })
      .finally(() => { chargementEnCours = null; });
    return chargementEnCours;
  }

  function redessinerVuesPubliques(forcerScores) {
    dessinerCompositions(ETAT.equipes);
    if (forcerScores || !saisieScoreEnCours()) dessinerMatchs(ETAT.matchs);
    dessinerClassement(ETAT.classement);
    majInfosMaj();
  }

  function majInfosMaj() {
    let texte = '';
    if (ETAT.majServeur) {
      texte = 'Mis à jour à ' + heureCourte(ETAT.majServeur);
      if (!navigator.onLine) texte += ' · données enregistrées sur le téléphone';
    }
    ['infoMajCompositions', 'infoMajScores', 'infoMajClassement'].forEach((id) => { $(id).textContent = texte; });
  }

  async function rafraichirTout(silencieux) {
    try {
      await chargerEtatPublic(silencieux);
      redessinerVuesPubliques(false);
    } catch (e) {
      majInfosMaj();
    }
  }

  // Rafraîchissement automatique (uniquement si l'appli est visible et connectée)
  setInterval(() => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    if (unPanelEstOuvert()) return;
    const vue = vueActive();
    if (vue === 'compositions' || vue === 'scores' || vue === 'classement') {
      viderFileAttente().finally(() => rafraichirTout(true));
    }
  }, REFRESH_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && navigator.onLine) {
      viderFileAttente().finally(() => rafraichirTout(true));
    }
  });

  window.addEventListener('online', () => {
    majBandeau();
    viderFileAttente().finally(() => rafraichirTout(true));
  });
  window.addEventListener('offline', () => { majBandeau(); majInfosMaj(); });

  // ==========================================================
  // FILE D'ATTENTE DES SCORES (HORS CONNEXION)
  // ==========================================================
  function lireFile() { return lireStockage(CLE_FILE, []); }
  function ecrireFile(file) { ecrireStockage(CLE_FILE, file); majBandeau(); }

  function mettreEnFile(entree) {
    const file = lireFile().filter((e) => e.matchId !== entree.matchId);
    file.push(entree);
    ecrireFile(file);
  }

  function scoreEnAttente(matchId) {
    return lireFile().find((e) => e.matchId === matchId) || null;
  }

  let envoiEnCours = false;

  /** Envoie un par un les scores mémorisés. S'arrête dès que le réseau manque. */
  async function viderFileAttente() {
    if (envoiEnCours || !navigator.onLine) return;
    if (lireFile().length === 0) return;
    envoiEnCours = true;
    majBandeau();
    let nbEnvoyes = 0;
    const problemes = [];

    try {
      for (const entree of lireFile()) {
        try {
          const res = await api('saisirScoreParId',
            [entree.matchId, entree.scoreA, entree.scoreB, entree.horodatage], { silencieux: true });
          if (res && res.conflit) {
            problemes.push(entree.libelle + ' : non appliqué. ' + res.message);
          } else {
            nbEnvoyes++;
          }
          ecrireFile(lireFile().filter((e) => e.matchId !== entree.matchId));
        } catch (err) {
          if (err.reseau) break; // on réessaiera plus tard
          problemes.push(entree.libelle + ' : ' + err.message.replace('MATCH_INTROUVABLE: ', ''));
          ecrireFile(lireFile().filter((e) => e.matchId !== entree.matchId));
        }
      }
    } finally {
      envoiEnCours = false;
      majBandeau();
    }

    if (nbEnvoyes > 0) {
      afficherToast(nbEnvoyes + (nbEnvoyes > 1 ? ' scores envoyés.' : ' score envoyé.'));
    }
    if (problemes.length) {
      setTimeout(() => alert('⚠ Scores saisis hors connexion non enregistrés :\n\n' + problemes.join('\n\n')), 400);
    }
    if (nbEnvoyes > 0 || problemes.length) {
      try { await chargerEtatPublic(true); } catch (e) { /* ignoré */ }
      redessinerVuesPubliques(true);
    }
  }

  function majBandeau() {
    const bandeau = $('bandeauReseau');
    const nb = lireFile().length;
    const horsLigne = !navigator.onLine;
    const btn = $('btnEnvoyerAttente');

    if (!horsLigne && nb === 0) {
      bandeau.className = '';
      return;
    }
    let texte = horsLigne ? '📴 Hors connexion' : '';
    if (nb > 0) {
      texte += (texte ? ' · ' : '') + '⏳ ' + nb + (nb > 1 ? ' scores en attente d\'envoi' : ' score en attente d\'envoi');
    }
    if (envoiEnCours) texte = '⏳ Envoi des scores en cours…';
    $('texteBandeau').textContent = texte;
    btn.style.display = (!horsLigne && nb > 0 && !envoiEnCours) ? 'inline-block' : 'none';
    bandeau.className = 'active' + (horsLigne ? ' hors-ligne' : '');
  }

  $('btnEnvoyerAttente').addEventListener('click', () => { viderFileAttente(); });

  // ==========================================================
  // VOLETS : FERMETURE
  // ==========================================================
  function apresFermeturePanel(idPanel) {
    if (idPanel === 'panelEquipes') {
      masquerOptionsCompositions();
      rafraichirTout(true);
    }
  }

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idPanel = btn.getAttribute('data-close');
      fermerPanel(idPanel);
      apresFermeturePanel(idPanel);
    });
  });

  document.querySelectorAll('.overlay').forEach((ov) => {
    ov.addEventListener('click', () => {
      const ouverts = Array.from(document.querySelectorAll('.panel.active')).map((p) => p.id);
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      document.querySelectorAll('.overlay').forEach((o) => o.classList.remove('active'));
      ouverts.forEach(apresFermeturePanel);
    });
  });

  // ==========================================================
  // NAVIGATION ENTRE VUES
  // ==========================================================
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => afficherVue(btn.getAttribute('data-vue')));
  });

  function vueActive() {
    const v = document.querySelector('.vue.active');
    return v ? v.id.replace('vue-', '') : null;
  }

  function afficherVue(nomVue) {
    document.querySelectorAll('.vue').forEach((v) => v.classList.remove('active'));
    $('vue-' + nomVue).classList.add('active');
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    const btn = document.querySelector('.nav-btn[data-vue="' + nomVue + '"]');
    if (btn) btn.classList.add('active');
    window.scrollTo(0, 0);

    if (nomVue === 'compositions' || nomVue === 'scores' || nomVue === 'classement') {
      // Affichage immédiat des données connues, puis mise à jour
      redessinerVuesPubliques(true);
      rafraichirTout(ETAT.donneesChargees);
    }
    if (nomVue === 'joueurs') rafraichirJoueurs();
    if (nomVue === 'admin') rafraichirAdmin();
  }

  // ==========================================================
  // CONNEXION ADMIN
  // ==========================================================
  $('btnLogin').addEventListener('click', () => {
    if (ETAT.adminCode) {
      if (confirm('Quitter le mode administrateur ?')) {
        ETAT.adminCode = null;
        ecrireSession(CLE_ADMIN, null);
        majAffichageRole();
        afficherToast('Mode administrateur désactivé.');
      }
      return;
    }
    $('inputCodeAdmin').value = '';
    ouvrirPanel('overlayLogin', 'panelLogin');
    setTimeout(() => $('inputCodeAdmin').focus(), 250);
  });

  async function validerLogin() {
    const code = $('inputCodeAdmin').value.trim();
    if (!code) { afficherToast('Veuillez saisir un code.', true); return; }
    try {
      const valide = await appelServeur('checkAdminCode', code);
      if (valide) {
        ETAT.adminCode = code;
        ecrireSession(CLE_ADMIN, code);
        majAffichageRole();
        fermerPanel('panelLogin');
        afficherToast('Mode administrateur activé.');
      } else {
        afficherToast('Code administrateur incorrect.', true);
      }
    } catch (e) { /* message déjà affiché */ }
  }

  $('btnValiderLogin').addEventListener('click', validerLogin);
  $('inputCodeAdmin').addEventListener('keydown', (e) => { if (e.key === 'Enter') validerLogin(); });

  function majAffichageRole() {
    const estAdmin = !!ETAT.adminCode;
    $('badgeAdmin').style.display = estAdmin ? 'inline-block' : 'none';
    document.querySelectorAll('.admin-only').forEach((el) => { el.style.display = estAdmin ? 'flex' : 'none'; });
    $('adminActionsCompositions').style.display = estAdmin ? 'block' : 'none';
    if (!estAdmin) {
      const v = vueActive();
      if (v === 'joueurs' || v === 'admin') afficherVue('compositions');
    } else {
      majCompteurParticipants();
    }
  }

  async function majCompteurParticipants() {
    try {
      const participants = await api('getParticipants', [], { silencieux: true });
      $('compteurParticipants').textContent = participants.length + '/' + MAX_PARTICIPANTS;
    } catch (e) { /* ignoré */ }
  }

  // ==========================================================
  // VUE : COMPOSITIONS DES ÉQUIPES
  // ==========================================================
  function nomsMembres(membres) {
    return (membres || []).filter((m) => m !== null).map((m) => m.prenom + ' (' + m.pseudo + ')').join(', ');
  }

  function dessinerCompositions(equipes) {
    const conteneur = $('listeCompositions');
    if (!ETAT.donneesChargees) {
      conteneur.innerHTML = '<div class="texte-vide">Chargement…</div>';
      return;
    }
    if (!equipes || equipes.length === 0) {
      conteneur.innerHTML = '<div class="texte-vide">Aucune équipe constituée pour le moment.</div>';
      return;
    }
    conteneur.innerHTML = equipes.map((eq) => {
      const noms = nomsMembres(eq.membres);
      return `
        <div class="carte" data-recherche="${esc((noms + ' equipe ' + eq.numEquipe).toLowerCase())}">
          <div class="carte-titre">
            <span>Équipe ${esc(eq.numEquipe)}</span>
            <span style="font-size:11px; color:var(--texte-clair);">${esc(eq.nbJoueurs)} joueurs</span>
          </div>
          <div class="liste-joueurs-equipe">${esc(noms) || '—'}</div>
        </div>`;
    }).join('');
    filtrerCartes('listeCompositions', $('rechercheCompositions').value);
  }

  $('rechercheCompositions').addEventListener('input', (e) => {
    filtrerCartes('listeCompositions', e.target.value);
  });

  function filtrerCartes(idConteneur, texte) {
    const recherche = (texte || '').trim().toLowerCase();
    document.querySelectorAll('#' + idConteneur + ' [data-recherche]').forEach((carte) => {
      carte.style.display = carte.getAttribute('data-recherche').includes(recherche) ? 'block' : 'none';
    });
  }

  // ----- Participants du jour (admin) -----
  let participantsDisponibles = [];
  let participantsActuels = [];

  $('btnParticipants').addEventListener('click', () => {
    $('inputRechercheAjoutParticipant').value = '';
    ouvrirPanel('overlayParticipants', 'panelParticipants');
    initialiserParticipants();
  });

  async function initialiserParticipants() {
    try {
      if (ETAT.joueurs.length === 0) {
        ETAT.joueurs = await appelServeur('getJoueursActifs');
      }
      await rechargerParticipants();
    } catch (e) { /* message déjà affiché */ }
  }

  async function rechargerParticipants() {
    try {
      participantsActuels = await appelServeur('getParticipants');
      const texte = participantsActuels.length + '/' + MAX_PARTICIPANTS;
      $('compteurParticipants').textContent = texte;
      $('compteurParticipantsPanel').textContent = participantsActuels.length;
      dessinerParticipants();
    } catch (e) { /* message déjà affiché */ }
  }

  function classePastille(qualite) {
    const q = String(qualite || 'mixte').toLowerCase();
    return 'pastille-' + (['pointeur', 'tireur', 'mixte'].includes(q) ? q : 'mixte');
  }

  function dessinerParticipants() {
    const conteneur = $('listeParticipantsActuels');
    if (participantsActuels.length === 0) {
      conteneur.innerHTML = '<div class="texte-vide">Aucun participant inscrit pour le moment.</div>';
    } else {
      conteneur.innerHTML = participantsActuels.map((p) => {
        const badge = p.assigne
          ? '<span class="badge-statut assigne">Équipe ' + esc(p.numEquipe) + '</span>'
          : '<span class="badge-statut disponible">Non assigné</span>';
        return `
          <div class="ligne-joueur">
            <div class="info-joueur">
              <div class="ligne-nom">
                <span class="pastille ${classePastille(p.Qualité)}"></span>
                <span class="nom">${esc(p.Prénom)}</span>
                <span class="pseudo">${esc(p.Pseudo)}</span>
              </div>
              ${badge}
            </div>
            <div class="actions-joueur">
              <button type="button" data-action="retirer-participant" data-id="${esc(p.ID)}" aria-label="Retirer">🗑️</button>
            </div>
          </div>`;
      }).join('');
    }
    afficherResultatsAjoutParticipant($('inputRechercheAjoutParticipant').value);
  }

  $('listeParticipantsActuels').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="retirer-participant"]');
    if (btn) retirerParticipantClient(btn.getAttribute('data-id'));
  });

  function afficherResultatsAjoutParticipant(texte) {
    const conteneur = $('resultatsAjoutParticipant');
    const idsParticipants = new Set(participantsActuels.map((p) => Number(p.ID)));
    const recherche = (texte || '').trim().toLowerCase();
    const candidats = ETAT.joueurs.filter((j) => !idsParticipants.has(Number(j.ID)));
    const filtres = recherche
      ? candidats.filter((j) => (j.Prénom + ' ' + j.Pseudo).toLowerCase().includes(recherche))
      : candidats;
    const limite = filtres.slice(0, 40);

    if (limite.length === 0) {
      conteneur.innerHTML = '<div class="aucun-resultat">Aucun joueur disponible.</div>';
      return;
    }
    let html = limite.map((j) => `
      <div class="resultat-joueur-inline" data-id="${esc(j.ID)}" role="button" tabindex="0">
        <span class="pastille ${classePastille(j.Qualité)}"></span>
        <span>${esc(j.Prénom)} (${esc(j.Pseudo)})</span>
      </div>`).join('');
    if (filtres.length > limite.length) {
      html += `<div class="aucun-resultat">+${filtres.length - limite.length} autres résultats, affinez la recherche...</div>`;
    }
    conteneur.innerHTML = html;
  }

  $('resultatsAjoutParticipant').addEventListener('click', async (e) => {
    const el = e.target.closest('.resultat-joueur-inline');
    if (!el) return;
    try {
      await appelServeur('ajouterParticipant', ETAT.adminCode, el.getAttribute('data-id'));
      await rechargerParticipants();
    } catch (err) { /* message déjà affiché */ }
  });

  $('inputRechercheAjoutParticipant').addEventListener('input', (e) => {
    afficherResultatsAjoutParticipant(e.target.value);
  });

  async function retirerParticipantClient(joueurId) {
    if (!confirm('Retirer ce participant ? S\'il était dans une équipe, il en sera aussi retiré.')) return;
    try {
      await appelServeur('retirerParticipant', ETAT.adminCode, joueurId);
      await rechargerParticipants();
      rafraichirTout(true);
      if ($('panelEquipes').classList.contains('active')) {
        await rechargerEquipesEnEdition();
      }
    } catch (e) { /* message déjà affiché */ }
  }

  // ----- Tirage au sort des COMPOSITIONS : sélection de la structure -----
  $('btnTirageCompositions').addEventListener('click', async () => {
    const zone = $('zoneOptionsCompositions');
    if (zone.style.display !== 'none') {
      masquerOptionsCompositions();
      return;
    }
    try {
      const res = await appelServeur('getOptionsCompositionsEquipes', ETAT.adminCode);
      afficherOptionsCompositions(res);
    } catch (e) { /* message déjà affiché */ }
  });

  function afficherOptionsCompositions(res) {
    const zone = $('zoneOptionsCompositions');
    const options = res.options;
    const indexReco = res.indexReco;

    let html = `<div class="carte" style="border:2px solid var(--vert-clair); margin-bottom:12px;">
      <div class="carte-titre" style="margin-bottom:8px;">
        Structure des équipes — ${esc(res.nbParticipants)} participants
      </div>
      <p style="font-size:12px; color:var(--texte-clair); margin:0 0 10px;">
        Choisissez la répartition, puis confirmez. Le tirage remplacera toutes les équipes existantes.
      </p>`;

    options.forEach((opt, i) => {
      const estReco = (i === indexReco);
      const dansPlageTournoi = opt.nbEquipes >= 6 && opt.nbEquipes <= 22;

      let descEquipes;
      if (opt.triplets > 0 && opt.doublets > 0) {
        descEquipes = opt.triplets + ' triplette' + (opt.triplets > 1 ? 's' : '') +
                      ' + ' + opt.doublets + ' doublette' + (opt.doublets > 1 ? 's' : '');
      } else if (opt.triplets > 0) {
        descEquipes = opt.triplets + ' triplette' + (opt.triplets > 1 ? 's' : '');
      } else {
        descEquipes = opt.doublets + ' doublette' + (opt.doublets > 1 ? 's' : '');
      }

      const avertPlage = !dansPlageTournoi
        ? ' <span style="color:var(--erreur); font-size:10px;">⚠ hors plage 6-22 équipes</span>'
        : '';

      html += `
        <button type="button" class="btn ${estReco ? 'btn-primaire' : 'btn-secondaire'} btn-bloc"
                style="margin-bottom:6px; text-align:left; padding:10px 14px; display:block;"
                data-action="choisir-structure" data-t="${Number(opt.triplets)}" data-d="${Number(opt.doublets)}">
          <strong>${opt.nbEquipes} équipes${estReco ? '  ⭐ recommandé' : ''}</strong>
          <span style="display:block; font-size:11px; margin-top:2px; opacity:0.85;">${descEquipes}${avertPlage}</span>
        </button>`;
    });

    html += `<button type="button" class="btn btn-danger btn-petit btn-bloc" style="margin-top:4px;"
               data-action="annuler-structure">Annuler</button>
    </div>`;

    zone.innerHTML = html;
    zone.style.display = 'block';
  }

  $('zoneOptionsCompositions').addEventListener('click', (e) => {
    const choix = e.target.closest('[data-action="choisir-structure"]');
    if (choix) {
      selectionnerOptionCompositions(Number(choix.getAttribute('data-t')), Number(choix.getAttribute('data-d')));
      return;
    }
    if (e.target.closest('[data-action="annuler-structure"]')) masquerOptionsCompositions();
  });

  function masquerOptionsCompositions() {
    const zone = $('zoneOptionsCompositions');
    zone.style.display = 'none';
    zone.innerHTML = '';
  }

  async function selectionnerOptionCompositions(nbTriplets, nbDoublets) {
    masquerOptionsCompositions();
    const nbEquipes = nbTriplets + nbDoublets;
    if (!confirm('Lancer le tirage avec ' + nbEquipes + ' équipes ?\n\nCela remplacera toutes les équipes existantes. Vous pourrez ajuster manuellement ensuite.')) return;
    try {
      const res = await appelServeur('tirerAuSortCompositions', ETAT.adminCode, nbTriplets, nbDoublets);
      emplacementActif = null;
      await rechargerEquipesEnEdition();
      rafraichirTout(true);
      if (res.avertissement) {
        afficherToast(res.nbEquipes + ' équipes formées.');
        setTimeout(() => afficherToast('⚠ ' + res.avertissement, true, 6000), 3300);
      } else {
        afficherToast(res.nbEquipes + ' équipes formées automatiquement.');
      }
    } catch (e) { /* message déjà affiché */ }
  }

  // ----- Composition manuelle des équipes -----
  $('btnComposerEquipes').addEventListener('click', () => {
    ouvrirPanel('overlayEquipes', 'panelEquipes');
    initialiserCompositionEquipes();
  });

  let emplacementActif = null;
  let equipesEnEdition = [];

  async function initialiserCompositionEquipes() {
    emplacementActif = null;
    masquerOptionsCompositions();
    $('zoneComposition').innerHTML = '<div class="texte-vide">Chargement…</div>';
    await rechargerEquipesEnEdition();
  }

  async function rechargerEquipesEnEdition() {
    try {
      const [equipes, participants] = await Promise.all([
        appelServeur('getEquipes'),
        appelServeur('getParticipants')
      ]);
      equipesEnEdition = equipes;
      participantsDisponibles = participants;
      dessinerZoneComposition();
    } catch (e) { /* message déjà affiché */ }
  }

  function dessinerZoneComposition() {
    const zone = $('zoneComposition');
    if (equipesEnEdition.length === 0) {
      zone.innerHTML = '<div class="texte-vide">Aucune équipe pour le moment. Utilisez le tirage au sort ou "Ajouter une équipe".</div>';
      return;
    }
    zone.innerHTML = equipesEnEdition.map((eq) => {
      const complet = eq.nbJoueurs >= 2;
      return `
        <div class="carte">
          <div class="carte-titre">
            <span>Équipe ${esc(eq.numEquipe)}</span>
            <div class="carte-titre-actions">
              <span class="compteur-equipe-badge ${complet ? 'complet' : ''}">${esc(eq.nbJoueurs)}/3 joueurs</span>
              <button type="button" class="supprimer-equipe" data-equipe="${esc(eq.numEquipe)}" aria-label="Supprimer l'équipe">🗑️</button>
            </div>
          </div>
          ${dessinerEmplacements(eq)}
        </div>`;
    }).join('');

    if (emplacementActif) {
      const parts = emplacementActif.split('-');
      const input = document.querySelector('#rechercheInline-' + parts[0] + '-' + parts[1] + ' .input-recherche-inline');
      if (input) {
        afficherResultatsRechercheInline(parts[0], parts[1], '');
        input.focus();
      }
    }
  }

  function dessinerEmplacements(equipe) {
    let html = '';
    for (let slot = 0; slot < 3; slot++) {
      const membre = equipe.membres[slot];
      const estOptionnel = slot === 2;
      const idEmplacement = equipe.numEquipe + '-' + slot;
      const estActif = emplacementActif === idEmplacement;

      if (membre) {
        html += `
          <div class="emplacement rempli" data-equipe="${esc(equipe.numEquipe)}" data-slot="${slot}">
            <span>${esc(membre.prenom)} (${esc(membre.pseudo)})</span>
            <button type="button" class="retirer-joueur" data-equipe="${esc(equipe.numEquipe)}" data-slot="${slot}" aria-label="Retirer le joueur">✕</button>
          </div>`;
      } else {
        html += `
          <div class="emplacement ${estOptionnel ? 'optionnel-vide' : 'vide'}" data-equipe="${esc(equipe.numEquipe)}" data-slot="${slot}" role="button" tabindex="0">
            <span>${estOptionnel ? '+ Joueur 3 (optionnel)' : '+ Joueur ' + (slot + 1)}</span>
          </div>`;
        if (estActif) html += zoneRechercheInlineHTML(equipe.numEquipe, slot);
      }
    }
    return html;
  }

  function zoneRechercheInlineHTML(numEquipe, slot) {
    return `
      <div class="zone-recherche-inline" id="rechercheInline-${esc(numEquipe)}-${slot}" data-equipe="${esc(numEquipe)}" data-slot="${slot}">
        <input type="text" class="input-recherche-inline" placeholder="🔍 Tapez pour filtrer, ou choisissez ci-dessous...">
        <div class="resultats-recherche-inline"></div>
      </div>`;
  }

  function joueursDejaAffectes() {
    const tousIds = new Set();
    equipesEnEdition.forEach((eq) => {
      eq.membres.forEach((m) => { if (m !== null) tousIds.add(String(m.id)); });
    });
    return tousIds;
  }

  // Un seul gestionnaire pour toute la zone de composition
  $('zoneComposition').addEventListener('click', async (e) => {
    const retirer = e.target.closest('.retirer-joueur');
    if (retirer) {
      e.stopPropagation();
      try {
        await appelServeur('retirerJoueurEquipe', ETAT.adminCode, retirer.getAttribute('data-equipe'), parseInt(retirer.getAttribute('data-slot'), 10));
        emplacementActif = null;
        await rechargerEquipesEnEdition();
      } catch (err) { /* message déjà affiché */ }
      return;
    }

    const supprimer = e.target.closest('.supprimer-equipe');
    if (supprimer) {
      e.stopPropagation();
      const numEquipe = supprimer.getAttribute('data-equipe');
      if (!confirm('Supprimer l\'équipe ' + numEquipe + ' ? Les joueurs redeviendront disponibles.')) return;
      try {
        await appelServeur('supprimerEquipe', ETAT.adminCode, numEquipe);
        emplacementActif = null;
        await rechargerEquipesEnEdition();
        rafraichirTout(true);
      } catch (err) { /* message déjà affiché */ }
      return;
    }

    const resultat = e.target.closest('.resultat-joueur-inline');
    if (resultat) {
      const zone = resultat.closest('.zone-recherche-inline');
      try {
        await appelServeur('affecterJoueurEquipe', ETAT.adminCode, zone.getAttribute('data-equipe'), zone.getAttribute('data-slot'), resultat.getAttribute('data-id'));
        emplacementActif = null;
        await rechargerEquipesEnEdition();
      } catch (err) { /* message déjà affiché */ }
      return;
    }

    const emplacement = e.target.closest('.emplacement.vide, .emplacement.optionnel-vide');
    if (emplacement) {
      const idEmplacement = emplacement.getAttribute('data-equipe') + '-' + emplacement.getAttribute('data-slot');
      emplacementActif = (emplacementActif === idEmplacement) ? null : idEmplacement;
      dessinerZoneComposition();
    }
  });

  $('zoneComposition').addEventListener('input', (e) => {
    if (!e.target.classList.contains('input-recherche-inline')) return;
    const zone = e.target.closest('.zone-recherche-inline');
    afficherResultatsRechercheInline(zone.getAttribute('data-equipe'), zone.getAttribute('data-slot'), e.target.value);
  });

  function afficherResultatsRechercheInline(numEquipe, slot, texte) {
    const conteneur = document.querySelector('#rechercheInline-' + numEquipe + '-' + slot + ' .resultats-recherche-inline');
    if (!conteneur) return;

    const recherche = (texte || '').trim().toLowerCase();
    const dejaAffectes = joueursDejaAffectes();
    const disponibles = participantsDisponibles.filter((j) => !dejaAffectes.has(String(j.ID)));
    const filtres = recherche
      ? disponibles.filter((j) => (j.Prénom + ' ' + j.Pseudo).toLowerCase().includes(recherche))
      : disponibles;
    const limite = filtres.slice(0, 40);

    if (limite.length === 0) {
      conteneur.innerHTML = '<div class="aucun-resultat">Aucun participant disponible. Inscrivez d\'abord des participants via "Participants du jour".</div>';
      return;
    }
    let html = limite.map((j) => `
      <div class="resultat-joueur-inline" data-id="${esc(j.ID)}" role="button" tabindex="0">
        <span class="pastille ${classePastille(j.Qualité)}"></span>
        <span>${esc(j.Prénom)} (${esc(j.Pseudo)})</span>
      </div>`).join('');
    if (filtres.length > limite.length) {
      html += `<div class="aucun-resultat">+${filtres.length - limite.length} autres résultats, affinez la recherche...</div>`;
    }
    conteneur.innerHTML = html;
  }

  $('btnAjouterEquipe').addEventListener('click', async () => {
    try {
      await appelServeur('ajouterEquipeVide', ETAT.adminCode);
      emplacementActif = null;
      await rechargerEquipesEnEdition();
    } catch (e) { /* message déjà affiché */ }
  });

  // ----- Tirage au sort des MATCHS -----
  $('btnTirageAuSort').addEventListener('click', async () => {
    if (lireFile().length > 0) {
      alert('Des scores saisis hors connexion n\'ont pas encore été envoyés. Envoyez-les avant de relancer le tirage.');
      return;
    }
    if (!confirm('Lancer le tirage au sort des 3 tours ? Cela remplacera tout tirage existant.')) return;
    try {
      const res = await appelServeur('lancerTirageAuSort', ETAT.adminCode);
      afficherToast(res.nbMatchs + ' matchs générés sur 3 tours.');
      await chargerEtatPublic(true).catch(() => {});
      afficherVue('scores');
    } catch (e) { /* message déjà affiché */ }
  });

  // ==========================================================
  // VUE : SCORES
  // ==========================================================
  /** Vrai si l'utilisateur est en train de taper un score (on ne redessine pas sous ses doigts). */
  function saisieScoreEnCours() {
    const actif = document.activeElement;
    if (actif && actif.classList && actif.classList.contains('score-input')) return true;
    return Array.from(document.querySelectorAll('#listeMatchs .bloc-match-scores'))
      .filter((b) => b.offsetParent !== null && !b.hasAttribute('data-preremplie'))
      .some((b) => Array.from(b.querySelectorAll('.score-input')).some((i) => i.value !== ''));
  }

  function dessinerMatchs(matchs) {
    const conteneur = $('listeMatchs');
    if (!ETAT.donneesChargees) {
      conteneur.innerHTML = '<div class="texte-vide">Chargement…</div>';
      return;
    }
    if (!matchs || matchs.length === 0) {
      conteneur.innerHTML = '<div class="texte-vide">Aucun match programmé. L\'administrateur doit lancer le tirage au sort.</div>';
      return;
    }
    const tours = [...new Set(matchs.map((m) => m.tour))].sort();
    let html = '';
    tours.forEach((tour) => {
      html += `<div class="tour-titre">Tour ${esc(tour)}</div>`;
      matchs.filter((m) => m.tour === tour).forEach((m) => { html += carteMatch(m); });
    });
    conteneur.innerHTML = html;
    filtrerCartes('listeMatchs', $('rechercheScores').value);
  }

  function carteMatch(m) {
    const cle = esc(m.id || ('L' + m.row));
    const nomsA = nomsMembres(m.composA);
    const nomsB = nomsMembres(m.composB);
    const recherche = ('equipe ' + m.numEquipeA + ' equipe ' + m.numEquipeB + ' ' + nomsA + ' ' + nomsB).toLowerCase();
    const attente = m.id ? scoreEnAttente(m.id) : null;
    const dejaJoue = m.statut === 'Joué';

    const entete = `
      <div class="bloc-match-equipes">
        <div class="equipe-label">
          <span class="equipe-numero">Équipe ${esc(m.numEquipeA)}</span>
          <span class="equipe-composition">${esc(nomsA)}</span>
        </div>
        <div class="vs-separateur">VS</div>
        <div class="equipe-label equipe-droite">
          <span class="equipe-numero">Équipe ${esc(m.numEquipeB)}</span>
          <span class="equipe-composition">${esc(nomsB)}</span>
        </div>
      </div>`;

    const champs = (valA, valB, cache, preremplie) => `
      <div class="bloc-match-scores" id="edition-${cle}" ${cache ? 'style="display:none;"' : ''} ${preremplie ? 'data-preremplie="1"' : ''}>
        <input type="number" inputmode="numeric" min="0" max="13" class="score-input" id="scoreA-${cle}" value="${esc(valA)}" placeholder="0" aria-label="Score équipe ${esc(m.numEquipeA)}">
        <span class="vs">VS</span>
        <input type="number" inputmode="numeric" min="0" max="13" class="score-input" id="scoreB-${cle}" value="${esc(valB)}" placeholder="0" aria-label="Score équipe ${esc(m.numEquipeB)}">
      </div>`;

    let corps;
    if (attente) {
      corps = `
        <div class="statut-attente" data-action="modifier-score" data-cle="${cle}" id="statut-${cle}">
          ⏳ ${esc(attente.scoreA)} - ${esc(attente.scoreB)} <span class="icone-modifier">✏️</span>
          <small>En attente d'envoi</small>
        </div>
        ${champs(attente.scoreA, attente.scoreB, true, true)}
        <button type="button" class="btn btn-primaire btn-petit btn-bloc" style="margin-top:8px; display:none;" id="btnValider-${cle}" data-action="valider-score" data-cle="${cle}">Enregistrer la correction</button>`;
    } else if (dejaJoue) {
      corps = `
        <div class="statut-joue cliquable" data-action="modifier-score" data-cle="${cle}" id="statut-${cle}">
          ${esc(m.scoreA)} - ${esc(m.scoreB)} <span class="icone-modifier">✏️</span>
        </div>
        ${champs(m.scoreA, m.scoreB, true, true)}
        <button type="button" class="btn btn-primaire btn-petit btn-bloc" style="margin-top:8px; display:none;" id="btnValider-${cle}" data-action="valider-score" data-cle="${cle}">Enregistrer la correction</button>`;
    } else {
      corps = `
        ${champs('', '', false, false)}
        <button type="button" class="btn btn-primaire btn-petit btn-bloc" style="margin-top:8px;" data-action="valider-score" data-cle="${cle}">Valider le score</button>`;
    }

    return `<div class="carte ${attente ? 'carte-attente' : ''}" data-recherche="${esc(recherche)}">${entete}${corps}</div>`;
  }

  $('rechercheScores').addEventListener('input', (e) => {
    filtrerCartes('listeMatchs', e.target.value);
  });

  $('listeMatchs').addEventListener('click', (e) => {
    const modif = e.target.closest('[data-action="modifier-score"]');
    if (modif) { activerModificationScore(modif.getAttribute('data-cle')); return; }
    const valider = e.target.closest('[data-action="valider-score"]');
    if (valider) validerScore(valider.getAttribute('data-cle'));
  });

  $('listeMatchs').addEventListener('input', (e) => {
    if (e.target.classList.contains('score-input')) e.target.classList.remove('score-invalide');
  });

  function activerModificationScore(cle) {
    $('statut-' + cle).style.display = 'none';
    const edition = $('edition-' + cle);
    edition.style.display = 'flex';
    edition.removeAttribute('data-preremplie');
    $('btnValider-' + cle).style.display = 'block';
    $('scoreA-' + cle).focus();
  }

  async function validerScore(cle) {
    const match = ETAT.matchs.find((m) => (m.id || ('L' + m.row)) === cle);
    if (!match) { afficherToast('Match introuvable, rechargez la page.', true); return; }

    const inputA = $('scoreA-' + cle);
    const inputB = $('scoreB-' + cle);
    const scoreA = inputA.value.trim();
    const scoreB = inputB.value.trim();

    if (scoreA === '' || scoreB === '') {
      afficherToast('Veuillez saisir les deux scores.', true);
      return;
    }
    const a = Number(scoreA);
    const b = Number(scoreB);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
      afficherToast('Scores invalides.', true);
      inputA.classList.add('score-invalide');
      inputB.classList.add('score-invalide');
      return;
    }
    if (a > 13 || b > 13) {
      afficherToast('Un score ne peut pas dépasser 13 points.', true);
      inputA.classList.add('score-invalide');
      inputB.classList.add('score-invalide');
      return;
    }
    if (!match.id) {
      afficherToast('Ce match n\'a pas encore d\'identifiant : rechargez l\'application.', true);
      return;
    }

    const entree = {
      matchId: match.id,
      scoreA: a,
      scoreB: b,
      horodatage: Date.now(),
      libelle: 'Tour ' + match.tour + ' — Équipe ' + match.numEquipeA + ' vs Équipe ' + match.numEquipeB
    };

    if (!navigator.onLine) {
      mettreEnFile(entree);
      document.activeElement && document.activeElement.blur();
      dessinerMatchs(ETAT.matchs);
      afficherToast('Hors connexion : score mémorisé, il sera envoyé automatiquement.', false, 4000);
      return;
    }

    try {
      // En ligne : pas d'horodatage → la saisie la plus récente l'emporte
      await api('saisirScoreParId', [entree.matchId, a, b, null]);
      // Une éventuelle saisie hors ligne plus ancienne pour ce match devient caduque
      ecrireFile(lireFile().filter((x) => x.matchId !== entree.matchId));
      afficherToast('Score enregistré.');
      document.activeElement && document.activeElement.blur();
      await chargerEtatPublic(true).catch(() => {});
      redessinerVuesPubliques(true);
    } catch (err) {
      if (err.reseau) {
        mettreEnFile(entree);
        document.activeElement && document.activeElement.blur();
        dessinerMatchs(ETAT.matchs);
        afficherToast('Réseau indisponible : score mémorisé, il sera envoyé automatiquement.', false, 4000);
      } else {
        inputA.classList.add('score-invalide');
        inputB.classList.add('score-invalide');
        if (String(err.message).indexOf('MATCH_INTROUVABLE') === 0) {
          await chargerEtatPublic(true).catch(() => {});
          redessinerVuesPubliques(true);
        }
      }
    }
  }

  // ==========================================================
  // VUE : CLASSEMENT
  // ==========================================================
  function dessinerClassement(classement) {
    const podium = $('podiumClassement');
    const liste = $('listeClassement');

    if (!ETAT.donneesChargees) {
      podium.innerHTML = '';
      liste.innerHTML = '<div class="texte-vide">Chargement…</div>';
      return;
    }
    if (!classement || classement.length === 0) {
      podium.innerHTML = '';
      liste.innerHTML = '<div class="texte-vide">Le classement apparaîtra après les premiers scores saisis.</div>';
      return;
    }

    const top3 = classement.slice(0, 3);
    const medailles = ['🥇', '🥈', '🥉'];
    const ordreAffichage = top3.length >= 3 ? [1, 0, 2] : top3.map((_, i) => i);

    let htmlPodium = '<div class="podium">';
    ordreAffichage.forEach((idx) => {
      if (!top3[idx]) return;
      const c = top3[idx];
      htmlPodium += `
        <div class="podium-marche podium-${idx + 1}">
          <div class="podium-medaille">${medailles[idx]}</div>
          <div class="podium-bloc">Éq. ${esc(c.numEquipe)}</div>
          <div class="podium-nom">${esc(c.points)} pts</div>
          <div class="podium-composition">${esc(nomsMembres(c.membres))}</div>
        </div>`;
    });
    htmlPodium += '</div>';
    podium.innerHTML = htmlPodium;

    liste.innerHTML = classement.map((c) => `
      <div class="ligne-classement">
        <div class="rang-cercle">${esc(c.rang)}</div>
        <div class="classement-detail">
          <div class="classement-equipe">Équipe ${esc(c.numEquipe)}</div>
          <div class="classement-joueurs">${esc(nomsMembres(c.membres))}</div>
        </div>
        <div class="classement-stats">
          <div class="classement-points">${esc(c.points)} pts</div>
          <div>GA : ${c.goalAverage > 0 ? '+' : ''}${esc(c.goalAverage)}</div>
        </div>
      </div>`).join('');

    if (lireFile().length > 0) {
      liste.innerHTML = '<p class="note alerte" style="margin:0 0 10px;">⏳ Des scores en attente d\'envoi ne sont pas encore comptés dans ce classement.</p>' + liste.innerHTML;
    }
  }

  // ==========================================================
  // VUE : JOUEURS (admin)
  // ==========================================================
  let joueursAvecStatut = [];
  let filtreStatutActif = 'tous';

  async function rafraichirJoueurs() {
    try {
      joueursAvecStatut = await appelServeur('getJoueursAvecStatutEquipe');
      dessinerJoueurs(joueursAvecStatut);
    } catch (e) { /* message déjà affiché */ }
  }

  function dessinerJoueurs(joueurs) {
    const conteneur = $('listeJoueurs');
    const filtres = joueurs.filter((j) => {
      if (filtreStatutActif === 'assigne') return j.assigne;
      if (filtreStatutActif === 'disponible') return !j.assigne;
      return true;
    });
    if (!filtres || filtres.length === 0) {
      conteneur.innerHTML = '<div class="texte-vide">Aucun joueur ne correspond à ce filtre.</div>';
      return;
    }
    conteneur.innerHTML = filtres.map((j) => {
      const recherche = (j.Prénom + ' ' + j.Pseudo).toLowerCase();
      const badge = j.assigne
        ? `<span class="badge-statut assigne">Équipe ${esc(j.numEquipe)}</span>`
        : `<span class="badge-statut disponible">Disponible</span>`;
      return `
        <div class="ligne-joueur" data-recherche="${esc(recherche)}">
          <div class="info-joueur">
            <div class="ligne-nom">
              <span class="pastille ${classePastille(j.Qualité)}"></span>
              <span class="nom">${esc(j.Prénom)}</span>
              <span class="pseudo">${esc(j.Pseudo)}</span>
            </div>
            ${badge}
          </div>
          <div class="actions-joueur">
            <button type="button" data-action="editer-joueur" data-id="${esc(j.ID)}" aria-label="Modifier">✏️</button>
            <button type="button" data-action="supprimer-joueur" data-id="${esc(j.ID)}" aria-label="Supprimer">🗑️</button>
          </div>
        </div>`;
    }).join('');
    appliquerRechercheJoueurs();
  }

  $('listeJoueurs').addEventListener('click', (e) => {
    const editer = e.target.closest('[data-action="editer-joueur"]');
    if (editer) { editerJoueur(editer.getAttribute('data-id')); return; }
    const supprimer = e.target.closest('[data-action="supprimer-joueur"]');
    if (supprimer) confirmerSuppressionJoueur(supprimer.getAttribute('data-id'));
  });

  document.querySelectorAll('.filtre-statut button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filtre-statut button').forEach((b) => b.classList.remove('actif'));
      btn.classList.add('actif');
      filtreStatutActif = btn.getAttribute('data-filtre');
      dessinerJoueurs(joueursAvecStatut);
    });
  });

  function appliquerRechercheJoueurs() {
    const recherche = $('rechercheJoueurs').value.trim().toLowerCase();
    document.querySelectorAll('#listeJoueurs [data-recherche]').forEach((ligne) => {
      ligne.style.display = ligne.getAttribute('data-recherche').includes(recherche) ? 'flex' : 'none';
    });
  }
  $('rechercheJoueurs').addEventListener('input', appliquerRechercheJoueurs);

  $('btnAjouterJoueur').addEventListener('click', () => {
    $('titrePanelJoueur').textContent = 'Nouveau joueur';
    $('joueurId').value = '';
    $('joueurPrenom').value = '';
    $('joueurPseudo').value = '';
    $('joueurQualite').value = 'Mixte';
    $('joueurGenre').value = 'H';
    ouvrirPanel('overlayJoueur', 'panelJoueur');
  });

  function editerJoueur(id) {
    const j = joueursAvecStatut.find((x) => Number(x.ID) === Number(id));
    if (!j) return;
    $('titrePanelJoueur').textContent = 'Modifier le joueur';
    $('joueurId').value = j.ID;
    $('joueurPrenom').value = j.Prénom;
    $('joueurPseudo').value = j.Pseudo;
    $('joueurQualite').value = ['Pointeur', 'Tireur', 'Mixte'].includes(j.Qualité) ? j.Qualité : 'Mixte';
    $('joueurGenre').value = (j.Genre && String(j.Genre).toUpperCase() === 'F') ? 'F' : 'H';
    ouvrirPanel('overlayJoueur', 'panelJoueur');
  }

  $('btnSauverJoueur').addEventListener('click', async () => {
    const id = $('joueurId').value;
    const prenom = $('joueurPrenom').value.trim();
    const pseudo = $('joueurPseudo').value.trim();
    const qualite = $('joueurQualite').value;
    const genre = $('joueurGenre').value;

    if (!prenom || !pseudo) {
      afficherToast('Le prénom et le pseudo sont obligatoires.', true);
      return;
    }
    try {
      if (id) {
        await appelServeur('modifierJoueur', ETAT.adminCode, { id, prenom, pseudo, qualite, genre, actif: true });
        afficherToast('Joueur modifié.');
      } else {
        await appelServeur('ajouterJoueur', ETAT.adminCode, { prenom, pseudo, qualite, genre });
        afficherToast('Joueur ajouté.');
      }
      ETAT.joueurs = []; // la liste des joueurs actifs sera rechargée
      fermerPanel('panelJoueur');
      rafraichirJoueurs();
    } catch (e) { /* message déjà affiché */ }
  });

  function confirmerSuppressionJoueur(id) {
    if (!confirm('Supprimer ce joueur ? Cette action est irréversible.')) return;
    appelServeur('supprimerJoueur', ETAT.adminCode, id)
      .then(() => {
        ETAT.joueurs = [];
        afficherToast('Joueur supprimé.');
        rafraichirJoueurs();
      })
      .catch(() => {});
  }

  // ==========================================================
  // VUE : ADMIN (date, export, archivage, nouveau tournoi)
  // ==========================================================
  async function rafraichirAdmin() {
    try {
      ETAT.dateTournoi = await appelServeur('getDateTournoi');
      $('inputDateTournoi').value = ETAT.dateTournoi || '';
    } catch (e) { /* message déjà affiché */ }
  }

  $('btnEnregistrerDate').addEventListener('click', async () => {
    const date = $('inputDateTournoi').value;
    if (!date) { afficherToast('Choisissez une date.', true); return; }
    try {
      const res = await appelServeur('setDateTournoi', ETAT.adminCode, date);
      ETAT.dateTournoi = res.dateTournoi;
      afficherToast('Date du tournoi enregistrée : ' + formaterDateFr(res.dateTournoi) + '.');
    } catch (e) { /* message déjà affiché */ }
  });

  // ----- PDF : génération puis partage / enregistrement -----
  let pdfCourant = null;

  async function genererPdf(nomFonction) {
    try {
      const res = await appelServeur(nomFonction, ETAT.adminCode);
      const octets = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
      pdfCourant = { nom: res.nomFichier, blob: new Blob([octets], { type: 'application/pdf' }) };
      $('nomPdf').textContent = res.nomFichier;
      const fichier = new File([pdfCourant.blob], pdfCourant.nom, { type: 'application/pdf' });
      $('btnPartagerPdf').style.display =
        (navigator.canShare && navigator.canShare({ files: [fichier] })) ? 'flex' : 'none';
      ouvrirPanel('overlayPdf', 'panelPdf');
    } catch (e) { /* message déjà affiché */ }
  }

  $('btnExportCompositions').addEventListener('click', () => genererPdf('genererPdfCompositions'));
  $('btnExportScores').addEventListener('click', () => genererPdf('genererPdfScores'));

  $('btnPartagerPdf').addEventListener('click', async () => {
    if (!pdfCourant) return;
    const fichier = new File([pdfCourant.blob], pdfCourant.nom, { type: 'application/pdf' });
    try {
      await navigator.share({ files: [fichier], title: pdfCourant.nom });
      fermerPanel('panelPdf');
    } catch (e) {
      if (e && e.name !== 'AbortError') afficherToast('Partage impossible, utilisez « Enregistrer sur l\'appareil ».', true);
    }
  });

  $('btnTelechargerPdf').addEventListener('click', () => {
    if (!pdfCourant) return;
    const url = URL.createObjectURL(pdfCourant.blob);
    const lien = document.createElement('a');
    lien.href = url;
    lien.download = pdfCourant.nom;
    document.body.appendChild(lien);
    lien.click();
    lien.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    fermerPanel('panelPdf');
    afficherToast('PDF enregistré.');
  });

  // ----- Archivage avec choix de la date -----
  let infosArchive = null;

  $('btnArchiver').addEventListener('click', async () => {
    if (lireFile().length > 0) {
      alert('Des scores saisis hors connexion n\'ont pas encore été envoyés. Envoyez-les avant d\'archiver.');
      return;
    }
    try {
      infosArchive = await appelServeur('getInfosArchivage', ETAT.adminCode);
    } catch (e) { return; }

    const i = infosArchive;
    $('resumeArchive').textContent =
      i.nbEquipes + ' équipe' + (i.nbEquipes > 1 ? 's' : '') + ', ' +
      i.nbMatchsJoues + ' match' + (i.nbMatchsJoues > 1 ? 's' : '') + ' joué' + (i.nbMatchsJoues > 1 ? 's' : '') +
      ' sur ' + i.nbMatchs + '.';

    const choix = [];
    if (i.dateScores) choix.push({ date: i.dateScores, libelle: 'Jour des scores : ' + formaterDateFr(i.dateScores) });
    if (i.dateTournoi && i.dateTournoi !== i.dateScores) choix.push({ date: i.dateTournoi, libelle: 'Date du tournoi : ' + formaterDateFr(i.dateTournoi) });
    if (i.aujourdhui !== i.dateScores && i.aujourdhui !== i.dateTournoi) choix.push({ date: i.aujourdhui, libelle: 'Aujourd\'hui' });

    $('choixDatesArchive').innerHTML = choix.map((c) =>
      `<button type="button" class="choix-date" data-date="${esc(c.date)}">${esc(c.libelle)}</button>`).join('');

    $('inputDateArchive').value = i.dateProposee;
    majChoixDateArchive();
    ouvrirPanel('overlayArchive', 'panelArchive');
  });

  $('choixDatesArchive').addEventListener('click', (e) => {
    const btn = e.target.closest('.choix-date');
    if (!btn) return;
    $('inputDateArchive').value = btn.getAttribute('data-date');
    majChoixDateArchive();
  });

  $('inputDateArchive').addEventListener('input', majChoixDateArchive);
  $('inputDateArchive').addEventListener('change', majChoixDateArchive);

  function majChoixDateArchive() {
    const date = $('inputDateArchive').value;
    document.querySelectorAll('#choixDatesArchive .choix-date').forEach((b) => {
      b.classList.toggle('actif', b.getAttribute('data-date') === date);
    });

    const alertes = [];
    if (infosArchive) {
      if (infosArchive.dernierArchivage && infosArchive.dernierArchivage === date) {
        alertes.push('Un tournoi a déjà été archivé à cette date. Un second onglet sera créé (suffixe _2).');
      }
      if (infosArchive.nbMatchs > 0 && infosArchive.nbMatchsJoues < infosArchive.nbMatchs) {
        alertes.push('Tous les matchs n\'ont pas de score.');
      }
      if (infosArchive.nbEquipes === 0) {
        alertes.push('Aucune équipe : l\'archive sera vide.');
      }
    }
    $('alerteArchive').style.display = alertes.length ? 'block' : 'none';
    $('alerteArchive').textContent = alertes.join(' ');
  }

  $('btnValiderArchive').addEventListener('click', async () => {
    const date = $('inputDateArchive').value;
    if (!date) { afficherToast('Choisissez la date du tournoi.', true); return; }
    try {
      const res = await appelServeur('archiverTournoi', ETAT.adminCode, date);
      fermerPanel('panelArchive');
      afficherToast('Tournoi archivé (onglet « ' + res.ongletCree + ' »).', false, 4500);
    } catch (e) { /* message déjà affiché */ }
  });

  // ----- Nouveau tournoi -----
  $('btnNouveauTournoi').addEventListener('click', () => {
    $('inputDateNouveau').value = aujourdhuiIso();
    ouvrirPanel('overlayNouveau', 'panelNouveau');
  });

  $('btnValiderNouveau').addEventListener('click', async () => {
    const date = $('inputDateNouveau').value;
    if (!date) { afficherToast('Choisissez la date du nouveau tournoi.', true); return; }
    if (lireFile().length > 0 &&
        !confirm('Des scores saisis hors connexion n\'ont pas été envoyés. Ils seront perdus. Continuer ?')) return;
    if (!confirm('Confirmer l\'effacement du tournoi en cours ?')) return;
    try {
      await appelServeur('initialiserNouveauTournoi', ETAT.adminCode, date);
      ecrireFile([]);
      fermerPanel('panelNouveau');
      afficherToast('Nouveau tournoi initialisé.');
      rafraichirAdmin();
      majCompteurParticipants();
      await chargerEtatPublic(true).catch(() => {});
      redessinerVuesPubliques(true);
    } catch (e) { /* message déjà affiché */ }
  });

  // ==========================================================
  // INSTALLATION SUR L'ÉCRAN D'ACCUEIL
  // ==========================================================
  const estInstallee = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const estIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
                 (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let invitationInstall = null;

  function proposerInstallation(texte, avecBouton) {
    if (estInstallee || lireStockage(CLE_INSTALL_MASQUE, false)) return;
    $('texteInstallation').innerHTML = texte;
    $('btnInstaller').style.display = avecBouton ? 'inline-flex' : 'none';
    $('carteInstallation').classList.add('active');
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    invitationInstall = e;
    proposerInstallation('<strong>Installez P-tank sur votre téléphone</strong> pour l\'ouvrir comme une application, même sans réseau.', true);
  });

  if (estIOS && !estInstallee) {
    proposerInstallation('<strong>Installez P-tank sur votre iPhone</strong> : touchez <strong>Partager</strong> (carré avec une flèche), puis <strong>Sur l\'écran d\'accueil</strong>.', false);
  }

  $('btnInstaller').addEventListener('click', async () => {
    if (!invitationInstall) return;
    invitationInstall.prompt();
    try { await invitationInstall.userChoice; } catch (e) { /* ignoré */ }
    invitationInstall = null;
    $('carteInstallation').classList.remove('active');
  });

  $('btnMasquerInstallation').addEventListener('click', () => {
    ecrireStockage(CLE_INSTALL_MASQUE, true);
    $('carteInstallation').classList.remove('active');
  });

  window.addEventListener('appinstalled', () => {
    $('carteInstallation').classList.remove('active');
    afficherToast('P-tank est installée.');
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* l'appli fonctionne aussi sans */ });
    });
  }

  // ==========================================================
  // DÉMARRAGE
  // ==========================================================
  majAffichageRole();
  majBandeau();
  chargerCacheLocal();
  redessinerVuesPubliques(true);
  viderFileAttente()
    .catch(() => {})
    .finally(() => rafraichirTout(ETAT.donneesChargees));
})();
