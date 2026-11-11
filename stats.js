/* ============================================================
 * P-TANK — Statistiques (onglet 📊 Stats)
 * Fichier : stats.js
 *
 * Les données brutes (une ligne par joueur et par match, issues de
 * l'onglet DONNEES des archives) sont téléchargées puis gardées sur
 * le téléphone. Tous les calculs sont faits ici : changer de période
 * ou de joueur est instantané, et tout fonctionne hors connexion.
 * ============================================================ */
(function () {
  'use strict';

  const CLE_CACHE = 'ptank_stats_v1';
  const L = { ONGLET: 0, DATE: 1, TOUR: 2, MATCH: 3, EQ: 4, EQADV: 5, JID: 6, JNOM: 7, POUR: 8, CONTRE: 9, RANG: 10 };

  const S = {
    brut: null,          // { lignes, joueurs, horodatage }
    periode: null,       // 'tout' | '12m' | 's:2025' (saison 2025-2026) ; null = à choisir au premier affichage
    sousVue: 'saison',   // 'saison' | 'joueurs' | 'records'
    tri: 'pct',          // 'pct' | 'victoires' | 'diff' | 'matchs' | 'titres'
    seuil: 3,
    calc: null,
    chargement: null,
    tournoiOuvert: null
  };

  const $ = (id) => document.getElementById(id);
  const P = () => window.PTank;
  const esc = (t) => P().esc(t);

  // ==========================================================
  // OUTILS
  // ==========================================================
  function lireCache() {
    try { const v = localStorage.getItem(CLE_CACHE); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function ecrireCache(v) {
    try { localStorage.setItem(CLE_CACHE, JSON.stringify(v)); } catch (e) { /* ignoré */ }
  }
  function dateFr(iso) {
    const p = String(iso || '').split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso;
  }
  function dateCourte(iso) {
    const p = String(iso || '').split('-');
    return p.length === 3 ? p[2] + '/' + p[1] : iso;
  }
  function pct(n, d) { return d ? Math.round((n / d) * 100) : 0; }
  function signe(n) { return (n > 0 ? '+' : '') + n; }
  function pluriel(n, mot) { return n + ' ' + mot + (n > 1 ? 's' : ''); }
  function arrondi1(n) { return Math.round(n * 10) / 10; }

  // ==========================================================
  // CHARGEMENT
  // ==========================================================
  function charger(silencieux) {
    if (S.chargement) return S.chargement;
    S.chargement = P().api('getStats', [], { silencieux: silencieux })
      .then((donnees) => {
        S.brut = donnees;
        ecrireCache(donnees);
        recalculer();
        dessiner();
      })
      .catch(() => { if (!S.brut) dessiner(); })
      .finally(() => { S.chargement = null; });
    return S.chargement;
  }

  function afficher() {
    if (!S.brut) {
      S.brut = lireCache();
      if (S.brut) recalculer();
    }
    dessiner();
    charger(!!S.brut);
  }

  // ==========================================================
  // CALCULS
  // ==========================================================
  function filtrerPeriode(lignes) {
    if (S.periode === 'tout') return lignes;
    if (S.periode === '12m') {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 1);
      const limite = d.toISOString().slice(0, 10);
      return lignes.filter((l) => l[L.DATE] >= limite);
    }
    const debut = Number(S.periode.slice(2));
    return lignes.filter((l) => saisonDe(l[L.DATE]) === debut);
  }

  /** Une saison va du 1er septembre au 31 août : renvoie l'année de début. */
  function saisonDe(dateIso) {
    const a = Number(String(dateIso).slice(0, 4));
    const m = Number(String(dateIso).slice(5, 7));
    return m >= 9 ? a : a - 1;
  }

  function libelleSaison(debut) {
    return 'Saison ' + debut + '-' + (debut + 1);
  }

  /** Par défaut : la saison en cours si elle contient des tournois, sinon toute la période. */
  function choisirPeriodeParDefaut() {
    if (S.periode) return;
    const enCours = saisonDe(new Date().toISOString().slice(0, 10));
    S.periode = saisons().indexOf(enCours) !== -1 ? 's:' + enCours : 'tout';
  }

  function recalculer() {
    if (!S.brut) { S.calc = null; return; }
    choisirPeriodeParDefaut();

    const refJoueurs = {};
    (S.brut.joueurs || []).forEach((j) => { refJoueurs[String(j.id)] = j; });

    function infosJoueur(id, libelle) {
      const r = refJoueurs[id];
      if (r) return { id, prenom: r.prenom, pseudo: r.pseudo, qualite: r.qualite || 'Mixte' };
      const m = String(libelle || '').match(/^(.*) \((.*)\)$/);
      return { id, prenom: m ? m[1] : libelle, pseudo: m ? m[2] : '', qualite: 'Inconnue' };
    }

    // ---- Reconstitution des matchs ----
    const lignes = filtrerPeriode(S.brut.lignes || []);
    const matchsParCle = {};
    const joueursVus = {};
    lignes.forEach((l) => {
      const cle = l[L.ONGLET] + '|' + l[L.MATCH];
      let m = matchsParCle[cle];
      if (!m) {
        m = matchsParCle[cle] = { onglet: l[L.ONGLET], date: l[L.DATE], tour: l[L.TOUR], id: l[L.MATCH], equipes: {} };
      }
      let eq = m.equipes[l[L.EQ]];
      if (!eq) eq = m.equipes[l[L.EQ]] = { num: l[L.EQ], joueurs: [], pour: l[L.POUR], contre: l[L.CONTRE], rang: l[L.RANG] };
      eq.joueurs.push(l[L.JID]);
      if (!joueursVus[l[L.JID]]) joueursVus[l[L.JID]] = infosJoueur(l[L.JID], l[L.JNOM]);
    });

    const matchs = Object.values(matchsParCle)
      .filter((m) => Object.keys(m.equipes).length === 2)
      .map((m) => {
        const [a, b] = Object.values(m.equipes);
        return { onglet: m.onglet, date: m.date, tour: m.tour, id: m.id, a, b };
      })
      .sort((x, y) => (x.date + x.onglet + String(x.tour).padStart(3, '0')).localeCompare(y.date + y.onglet + String(y.tour).padStart(3, '0')));

    // ---- Tournois ----
    const tournoisParOnglet = {};
    matchs.forEach((m) => {
      let t = tournoisParOnglet[m.onglet];
      if (!t) t = tournoisParOnglet[m.onglet] = { onglet: m.onglet, date: m.date, matchs: [], joueurs: new Set(), equipes: {} };
      t.matchs.push(m);
      [m.a, m.b].forEach((eq) => {
        eq.joueurs.forEach((j) => t.joueurs.add(j));
        t.equipes[eq.num] = { num: eq.num, joueurs: eq.joueurs, rang: eq.rang };
      });
    });
    const tournois = Object.values(tournoisParOnglet).sort((x, y) => (x.date + x.onglet).localeCompare(y.date + y.onglet));
    tournois.forEach((t) => {
      t.podium = Object.values(t.equipes).filter((e) => e.rang >= 1 && e.rang <= 3).sort((x, y) => x.rang - y.rang);
      t.fannies = t.matchs.filter((m) => Math.min(m.a.pour, m.b.pour) === 0 && Math.max(m.a.pour, m.b.pour) === 13).length;
      // Bilan par équipe pour « meilleure équipe d'un jour »
      t.bilans = {};
      t.matchs.forEach((m) => {
        [[m.a, m.b], [m.b, m.a]].forEach(([e, adv]) => {
          const bil = t.bilans[e.num] || (t.bilans[e.num] = { num: e.num, joueurs: e.joueurs, v: 0, n: 0, diff: 0, rang: e.rang });
          bil.n++;
          if (e.pour > adv.pour) bil.v++;
          bil.diff += e.pour - adv.pour;
        });
      });
    });

    // ---- Joueurs ----
    const J = {};
    function fiche(id) {
      if (!J[id]) {
        J[id] = Object.assign({}, joueursVus[id], {
          matchs: 0, v: 0, d: 0, n: 0, pour: 0, contre: 0,
          tournois: new Set(), podiums: 0, titres: 0,
          fanniesDonnees: 0, fanniesSubies: 0,
          historique: [],       // 'V' | 'D' | 'N', dans l'ordre
          parTournoi: {},       // onglet -> {v, n}
          partenaires: {}, adversaires: {}
        });
      }
      return J[id];
    }

    // Paires de partenaires (meilleur duo)
    const duos = {};
    const tailles = { triplette: 0, tripletteGagne: 0 };
    const qualites = {};

    matchs.forEach((m) => {
      const cotes = [[m.a, m.b], [m.b, m.a]];

      if (m.a.joueurs.length !== m.b.joueurs.length && m.a.pour !== m.b.pour) {
        const trip = m.a.joueurs.length > m.b.joueurs.length ? m.a : m.b;
        const autre = trip === m.a ? m.b : m.a;
        tailles.triplette++;
        if (trip.pour > autre.pour) tailles.tripletteGagne++;
      }

      cotes.forEach(([e, adv]) => {
        const res = e.pour > adv.pour ? 'V' : (e.pour < adv.pour ? 'D' : 'N');
        const fanny = e.pour === 13 && adv.pour === 0;
        const fannySubie = e.pour === 0 && adv.pour === 13;

        e.joueurs.forEach((jid) => {
          const f = fiche(jid);
          f.matchs++;
          f[res === 'V' ? 'v' : res === 'D' ? 'd' : 'n']++;
          f.pour += e.pour;
          f.contre += adv.pour;
          f.tournois.add(m.onglet);
          f.historique.push({ res, date: m.date, onglet: m.onglet });
          if (fanny) f.fanniesDonnees++;
          if (fannySubie) f.fanniesSubies++;
          const pt = f.parTournoi[m.onglet] || (f.parTournoi[m.onglet] = { v: 0, n: 0, date: m.date, rang: e.rang });
          pt.n++;
          if (res === 'V') pt.v++;

          e.joueurs.forEach((p) => {
            if (p === jid) return;
            const s = f.partenaires[p] || (f.partenaires[p] = { n: 0, v: 0 });
            s.n++; if (res === 'V') s.v++;
          });
          adv.joueurs.forEach((a) => {
            const s = f.adversaires[a] || (f.adversaires[a] = { n: 0, v: 0, d: 0 });
            s.n++; if (res === 'V') s.v++; if (res === 'D') s.d++;
          });

          const q = f.qualite;
          const sq = qualites[q] || (qualites[q] = { n: 0, v: 0 });
          sq.n++; if (res === 'V') sq.v++;
        });

        // Duos (chaque paire comptée une fois par match)
        for (let i = 0; i < e.joueurs.length; i++) {
          for (let k = i + 1; k < e.joueurs.length; k++) {
            const cle = [e.joueurs[i], e.joueurs[k]].sort().join('|');
            const s = duos[cle] || (duos[cle] = { ids: cle.split('|'), n: 0, v: 0 });
            s.n++; if (res === 'V') s.v++;
          }
        }
      });
    });

    // Podiums et titres par tournoi
    tournois.forEach((t) => {
      t.podium.forEach((e) => {
        e.joueurs.forEach((jid) => {
          if (!J[jid]) return;
          J[jid].podiums++;
          if (e.rang === 1) J[jid].titres++;
        });
      });
    });

    // Séries
    Object.values(J).forEach((f) => {
      let meilleure = 0, courante = 0;
      f.historique.forEach((h) => {
        if (h.res === 'V') { courante++; meilleure = Math.max(meilleure, courante); }
        else courante = 0;
      });
      f.meilleureSerie = meilleure;
      let enCours = 0;
      const dernier = f.historique.length ? f.historique[f.historique.length - 1].res : null;
      for (let i = f.historique.length - 1; i >= 0 && f.historique[i].res === dernier; i--) enCours++;
      f.serieEnCours = { type: dernier, n: enCours };
      f.pct = pct(f.v, f.matchs);
      f.diff = f.pour - f.contre;
      f.diffMoy = f.matchs ? arrondi1(f.diff / f.matchs) : 0;
      f.nbTournois = f.tournois.size;
    });

    S.calc = { matchs, tournois, joueurs: J, duos: Object.values(duos), tailles, qualites, nom: (id) => J[id] || joueursVus[id] || infosJoueur(id, id) };
  }

  function nomCourt(id) {
    const j = S.calc.nom(id);
    return j.prenom + (j.pseudo ? ' (' + j.pseudo + ')' : '');
  }
  function nomsEquipe(ids) { return ids.map(nomCourt).join(', '); }

  function saisons() {
    const set = new Set((S.brut && S.brut.lignes || []).filter((l) => l[L.DATE]).map((l) => saisonDe(l[L.DATE])));
    return Array.from(set).filter((a) => !isNaN(a)).sort((a, b) => b - a);
  }

  // ==========================================================
  // GRAPHIQUES (SVG dessinés à la main, sans bibliothèque)
  // ==========================================================
  function graphBarres(etiquettes, valeurs, opts) {
    opts = opts || {};
    const n = valeurs.length;
    const larg = Math.max(320, n * 34);
    const haut = 170, bas = 26, haut2 = 18;
    const max = Math.max(1, ...valeurs);
    const pas = larg / n;
    const lb = Math.min(24, pas * 0.62);
    let svg = `<svg viewBox="0 0 ${larg} ${haut}" width="${larg}" height="${haut}" role="img" aria-label="${esc(opts.titre || '')}">`;
    svg += `<line x1="0" y1="${haut - bas}" x2="${larg}" y2="${haut - bas}" class="axe"/>`;
    valeurs.forEach((v, i) => {
      const h = ((haut - bas - haut2) * v) / max;
      const x = i * pas + (pas - lb) / 2;
      const y = haut - bas - h;
      svg += `<rect x="${x}" y="${y}" width="${lb}" height="${Math.max(h, 1)}" rx="4" class="barre"/>`;
      svg += `<text x="${x + lb / 2}" y="${y - 5}" class="val">${v}</text>`;
      svg += `<text x="${x + lb / 2}" y="${haut - 8}" class="lib">${esc(etiquettes[i])}</text>`;
    });
    svg += '</svg>';
    return `<div class="graph-defile">${svg}</div>`;
  }

  /** Courbe 0–100 % (évolution du % de victoires cumulé). */
  function graphCourbe(etiquettes, valeurs) {
    const n = valeurs.length;
    const larg = Math.max(320, n * 34);
    const haut = 170, bas = 26, gauche = 30, hautMarge = 12;
    const zoneH = haut - bas - hautMarge;
    const x = (i) => gauche + (n === 1 ? (larg - gauche) / 2 : (i * (larg - gauche - 24)) / (n - 1));
    const y = (v) => hautMarge + zoneH - (zoneH * v) / 100;
    let svg = `<svg viewBox="0 0 ${larg} ${haut}" width="${larg}" height="${haut}" role="img" aria-label="Évolution du pourcentage de victoires">`;
    [0, 50, 100].forEach((g) => {
      svg += `<line x1="${gauche}" y1="${y(g)}" x2="${larg}" y2="${y(g)}" class="${g === 50 ? 'repere' : 'grille'}"/>`;
      svg += `<text x="${gauche - 5}" y="${y(g) + 4}" class="lib" text-anchor="end">${g}%</text>`;
    });
    const pts = valeurs.map((v, i) => x(i) + ',' + y(v)).join(' ');
    svg += `<polyline points="${pts}" class="courbe"/>`;
    valeurs.forEach((v, i) => {
      svg += `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" class="point"/>`;
      if (n <= 14 || i % Math.ceil(n / 12) === 0 || i === n - 1) {
        svg += `<text x="${x(i)}" y="${haut - 8}" class="lib">${esc(etiquettes[i])}</text>`;
      }
    });
    svg += '</svg>';
    return `<div class="graph-defile">${svg}</div>`;
  }

  function jaugePct(p) {
    return `<span class="jauge" aria-hidden="true"><span style="width:${p}%"></span></span>`;
  }

  function pastilles(historique) {
    return '<div class="pastilles-resultats">' + historique.map((h) =>
      `<span class="res res-${h.res}" title="${esc(dateFr(h.date))}">${h.res}</span>`).join('') + '</div>';
  }

  // ==========================================================
  // AFFICHAGE
  // ==========================================================
  function dessiner() {
    const zone = $('statsContenu');
    if (!zone) return;
    dessinerFiltres();

    if (!S.brut) {
      zone.innerHTML = '<div class="texte-vide">Chargement des statistiques…</div>';
      return;
    }
    if (!S.calc || S.calc.matchs.length === 0) {
      zone.innerHTML = '<div class="texte-vide">Aucun match archivé sur cette période.<br><br>' +
        'Les statistiques se remplissent à chaque archivage de tournoi. Pour les anciens tournois, ' +
        'l\'administrateur lance une fois « 📊 Synchroniser les statistiques » dans le menu du Google Sheets.</div>';
      return;
    }

    if (S.sousVue === 'saison') zone.innerHTML = vueSaison();
    if (S.sousVue === 'joueurs') zone.innerHTML = vueJoueurs();
    if (S.sousVue === 'records') zone.innerHTML = vueRecords();

    const maj = S.brut.horodatage ? new Date(S.brut.horodatage) : null;
    $('statsMaj').textContent = maj ? 'Données du ' + maj.toLocaleDateString('fr-FR') + ' à ' +
      String(maj.getHours()).padStart(2, '0') + 'h' + String(maj.getMinutes()).padStart(2, '0') : '';
  }

  function dessinerFiltres() {
    const sel = $('statsPeriode');
    if (!sel) return;
    const opts = saisons().map((a) => ['s:' + a, libelleSaison(a)])
      .concat([['12m', '12 derniers mois'], ['tout', 'Toute la période']]);
    const actuel = S.periode;
    sel.innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}" ${v === actuel ? 'selected' : ''}>${esc(t)}</option>`).join('');
    document.querySelectorAll('#statsSousVues button').forEach((b) => {
      b.classList.toggle('actif', b.getAttribute('data-sv') === S.sousVue);
    });
  }

  // ---------- SAISON ----------
  function vueSaison() {
    const c = S.calc;
    const nbJoueurs = Object.keys(c.joueurs).length;
    const points = c.matchs.reduce((s, m) => s + m.a.pour + m.b.pour, 0);
    const fannies = c.tournois.reduce((s, t) => s + t.fannies, 0);
    const moyenne = c.tournois.length ? Math.round(c.tournois.reduce((s, t) => s + t.joueurs.size, 0) / c.tournois.length) : 0;

    let html = `
      <div class="kpis">
        <div class="kpi"><strong>${c.tournois.length}</strong><span>tournois</span></div>
        <div class="kpi"><strong>${nbJoueurs}</strong><span>joueurs différents</span></div>
        <div class="kpi"><strong>${c.matchs.length}</strong><span>matchs joués</span></div>
        <div class="kpi"><strong>${points.toLocaleString('fr-FR')}</strong><span>points marqués</span></div>
        <div class="kpi"><strong>${moyenne}</strong><span>joueurs par tournoi</span></div>
        <div class="kpi kpi-fanny"><strong>${fannies}</strong><span>fanny${fannies > 1 ? 's' : ''} (13-0)</span></div>
      </div>`;

    if (c.tournois.length > 1) {
      html += `<div class="carte"><div class="carte-titre">Participation par tournoi</div>
        ${graphBarres(c.tournois.map((t) => dateCourte(t.date)), c.tournois.map((t) => t.joueurs.size), { titre: 'Participants par tournoi' })}
      </div>`;
    }

    html += '<div class="titre-section" style="font-size:15px; margin-top:18px;">Historique des tournois</div>';
    html += c.tournois.slice().reverse().map((t) => {
      const ouvert = S.tournoiOuvert === t.onglet;
      const medailles = ['🥇', '🥈', '🥉'];
      const podium = t.podium.length
        ? t.podium.map((e) => `<div class="ligne-podium">${medailles[e.rang - 1] || ''} ${esc(nomsEquipe(e.joueurs))}</div>`).join('')
        : '<div class="note">Podium non disponible.</div>';
      let detail = '';
      if (ouvert) {
        detail = '<div class="detail-tournoi">' + t.matchs.map((m) => `
          <div class="ligne-match">
            <span class="tour-mini">T${esc(m.tour)}</span>
            <span class="eq-mini">${esc(nomsEquipe(m.a.joueurs))}</span>
            <strong class="score-mini ${m.a.pour === 13 && m.b.pour === 0 || m.b.pour === 13 && m.a.pour === 0 ? 'fanny' : ''}">${m.a.pour} - ${m.b.pour}</strong>
            <span class="eq-mini droite">${esc(nomsEquipe(m.b.joueurs))}</span>
          </div>`).join('') + '</div>';
      }
      return `
        <div class="carte carte-tournoi" data-onglet="${esc(t.onglet)}" role="button" tabindex="0" aria-expanded="${ouvert}">
          <div class="carte-titre">
            <span>${esc(dateFr(t.date))}</span>
            <span class="compteur-equipe-badge">${t.joueurs.size} joueurs · ${t.matchs.length} matchs ${ouvert ? '▴' : '▾'}</span>
          </div>
          ${podium}
          ${detail}
        </div>`;
    }).join('');
    return html;
  }

  // ---------- JOUEURS ----------
  function joueursClasses() {
    const liste = Object.values(S.calc.joueurs).filter((j) => j.matchs >= S.seuil);
    const cles = {
      pct: (j) => [j.pct, j.v, j.diff],
      victoires: (j) => [j.v, j.pct, j.diff],
      diff: (j) => [j.diffMoy, j.pct, j.v],
      matchs: (j) => [j.matchs, j.pct, j.v],
      titres: (j) => [j.titres, j.podiums, j.pct]
    }[S.tri];
    return liste.sort((a, b) => {
      const ka = cles(a), kb = cles(b);
      for (let i = 0; i < ka.length; i++) if (kb[i] !== ka[i]) return kb[i] - ka[i];
      return String(a.prenom).localeCompare(String(b.prenom));
    });
  }

  function vueJoueurs() {
    const tris = [['pct', '% victoires'], ['victoires', 'Victoires'], ['diff', 'Différence'], ['matchs', 'Matchs'], ['titres', 'Titres']];
    const seuils = [1, 3, 6, 10];
    let html = `
      <div class="barre-options">
        <div class="choix-dates" id="statsTris">
          ${tris.map(([v, t]) => `<button type="button" class="choix-date ${S.tri === v ? 'actif' : ''}" data-tri="${v}">${t}</button>`).join('')}
        </div>
        <label class="seuil">Au moins
          <select id="statsSeuil">${seuils.map((s) => `<option value="${s}" ${S.seuil === s ? 'selected' : ''}>${pluriel(s, 'match')}</option>`).join('')}</select>
        </label>
      </div>`;

    const liste = joueursClasses();
    if (!liste.length) {
      return html + '<div class="texte-vide">Aucun joueur n\'atteint ce nombre de matchs sur la période. Baissez le seuil.</div>';
    }

    html += '<div class="carte" style="padding:6px 10px;">' + liste.map((j, i) => {
      const valeur = {
        pct: j.pct + ' %',
        victoires: pluriel(j.v, 'victoire'),
        diff: signe(j.diffMoy) + ' / match',
        matchs: pluriel(j.matchs, 'match'),
        titres: pluriel(j.titres, 'titre') + ' · ' + pluriel(j.podiums, 'podium')
      }[S.tri];
      return `
        <div class="ligne-stat-joueur" data-joueur="${esc(j.id)}" role="button" tabindex="0">
          <div class="rang-cercle ${i < 3 ? 'rang-' + (i + 1) : ''}">${i + 1}</div>
          <div class="detail-stat">
            <div class="nom-stat"><span class="pastille ${classeQualite(j.qualite)}"></span>${esc(j.prenom)} <span class="pseudo">${esc(j.pseudo)}</span></div>
            <div class="sous-stat">${j.matchs} m · ${j.v} V · ${j.d} D${j.n ? ' · ' + j.n + ' N' : ''} · ${signe(j.diff)} pts</div>
            ${jaugePct(j.pct)}
          </div>
          <div class="valeur-stat">${esc(valeur)}</div>
        </div>`;
    }).join('') + '</div>';
    html += '<p class="note" style="text-align:center;">Touchez un joueur pour voir sa fiche.</p>';
    return html;
  }

  function classeQualite(q) {
    const k = String(q || '').toLowerCase();
    return ['pointeur', 'tireur', 'mixte'].includes(k) ? 'pastille-' + k : 'pastille-inconnue';
  }

  // ---------- RECORDS ----------
  function vueRecords() {
    const c = S.calc;
    const joueurs = Object.values(c.joueurs);
    const blocs = [];

    // Plus larges victoires
    const larges = c.matchs.slice().sort((x, y) => Math.abs(y.a.pour - y.b.pour) - Math.abs(x.a.pour - x.b.pour)).slice(0, 3);
    blocs.push(blocRecord('💥 Plus larges victoires', larges.map((m) => {
      const [g, p] = m.a.pour >= m.b.pour ? [m.a, m.b] : [m.b, m.a];
      return `<strong>${g.pour} - ${p.pour}</strong> · ${esc(nomsEquipe(g.joueurs))} <span class="note-inline">contre ${esc(nomsEquipe(p.joueurs))}, le ${esc(dateFr(m.date))}</span>`;
    })));

    // Matchs serrés (13-12)
    const serres = c.matchs.filter((m) => Math.abs(m.a.pour - m.b.pour) === 1 && Math.max(m.a.pour, m.b.pour) === 13);
    if (serres.length) {
      const dernier = serres[serres.length - 1];
      blocs.push(blocRecord('😮‍💨 Matchs au finish (13-12)', [
        `<strong>${serres.length}</strong> match${serres.length > 1 ? 's' : ''} gagné${serres.length > 1 ? 's' : ''} d'un seul point`,
        `Le dernier : ${esc(nomsEquipe((dernier.a.pour > dernier.b.pour ? dernier.a : dernier.b).joueurs))} <span class="note-inline">le ${esc(dateFr(dernier.date))}</span>`
      ]));
    }

    // Plus longue série
    const series = joueurs.filter((j) => j.meilleureSerie > 0).sort((a, b) => b.meilleureSerie - a.meilleureSerie).slice(0, 3);
    if (series.length) {
      blocs.push(blocRecord('🔥 Plus longues séries de victoires', series.map((j) =>
        `<strong>${j.meilleureSerie}</strong> victoires de suite · ${esc(j.prenom)} <span class="note-inline">${esc(j.pseudo)}</span>`)));
    }

    // Assiduité
    const assidus = joueurs.slice().sort((a, b) => b.nbTournois - a.nbTournois || b.matchs - a.matchs).slice(0, 3);
    blocs.push(blocRecord('📅 Les plus assidus', assidus.map((j) =>
      `<strong>${pluriel(j.nbTournois, 'tournoi')}</strong> · ${esc(j.prenom)} <span class="note-inline">${esc(j.pseudo)}, ${pluriel(j.matchs, 'match')}</span>`)));

    // Meilleurs duos
    const minDuo = 3;
    const duos = c.duos.filter((d) => d.n >= minDuo).sort((a, b) => pct(b.v, b.n) - pct(a.v, a.n) || b.n - a.n).slice(0, 3);
    blocs.push(blocRecord('🤝 Meilleurs duos', duos.length ? duos.map((d) =>
      `<strong>${pct(d.v, d.n)} %</strong> · ${esc(nomCourt(d.ids[0]))} & ${esc(nomCourt(d.ids[1]))} <span class="note-inline">${d.v} victoires sur ${d.n} matchs ensemble</span>`)
      : [`Pas encore de duo ayant joué ${minDuo} matchs ensemble.`]));

    // Meilleure équipe d'un jour
    const bilans = [];
    c.tournois.forEach((t) => Object.values(t.bilans).forEach((b) => bilans.push(Object.assign({ date: t.date }, b))));
    const jour = bilans.sort((a, b) => b.v - a.v || b.diff - a.diff).slice(0, 1);
    if (jour.length) {
      const b = jour[0];
      blocs.push(blocRecord('🏅 Meilleure équipe d\'un jour', [
        `${esc(nomsEquipe(b.joueurs))}`,
        `<span class="note-inline">${b.v} victoire${b.v > 1 ? 's' : ''} sur ${b.n}, ${signe(b.diff)} points, le ${esc(dateFr(b.date))}</span>`
      ]));
    }

    // Fannies
    const donneurs = joueurs.filter((j) => j.fanniesDonnees > 0).sort((a, b) => b.fanniesDonnees - a.fanniesDonnees).slice(0, 3);
    const receveurs = joueurs.filter((j) => j.fanniesSubies > 0).sort((a, b) => b.fanniesSubies - a.fanniesSubies).slice(0, 3);
    if (donneurs.length || receveurs.length) {
      const l = [];
      if (donneurs.length) l.push('Distribuées : ' + donneurs.map((j) => `${esc(j.prenom)} <strong>×${j.fanniesDonnees}</strong>`).join(', '));
      if (receveurs.length) l.push('Embrassées : ' + receveurs.map((j) => `${esc(j.prenom)} <strong>×${j.fanniesSubies}</strong>`).join(', '));
      blocs.push(blocRecord('💋 Le coin de la Fanny', l));
    }

    // Le saviez-vous : triplette vs doublette, qualités
    const savoir = [];
    if (c.tailles.triplette >= 3) {
      const p = pct(c.tailles.tripletteGagne, c.tailles.triplette);
      savoir.push(`Face à une doublette, la triplette gagne <strong>${p} %</strong> du temps <span class="note-inline">(${c.tailles.triplette} matchs). ${p > 55 ? 'Le joueur en plus pèse !' : p < 45 ? 'Avoir moins de joueurs ne handicape pas, au contraire !' : 'Le joueur en plus ne change pas grand-chose.'}</span>`);
    }
    const q = ['Pointeur', 'Tireur', 'Mixte'].filter((k) => c.qualites[k] && c.qualites[k].n >= 5);
    if (q.length >= 2) {
      savoir.push('<div class="barres-qualite">' + q.map((k) => {
        const p = pct(c.qualites[k].v, c.qualites[k].n);
        return `<div class="ligne-qualite"><span class="lib-qualite"><span class="pastille ${classeQualite(k)}"></span>${k}s</span>${jaugePct(p)}<strong>${p} %</strong></div>`;
      }).join('') + '<span class="note-inline">Pourcentage de victoires selon la qualité du joueur.</span></div>');
    }
    if (savoir.length) blocs.push(blocRecord('💡 Le saviez-vous ?', savoir));

    return blocs.join('');
  }

  function blocRecord(titre, lignes) {
    return `<div class="carte"><div class="carte-titre">${titre}</div>` +
      lignes.map((l) => `<div class="ligne-record">${l}</div>`).join('') + '</div>';
  }

  // ---------- FICHE JOUEUR ----------
  function ouvrirFiche(id) {
    const j = S.calc && S.calc.joueurs[id];
    if (!j) return;

    $('titreFicheJoueur').innerHTML = `<span class="pastille ${classeQualite(j.qualite)}"></span>${esc(j.prenom)} <span class="pseudo">${esc(j.pseudo)}</span>`;

    // Évolution du % de victoires cumulé, tournoi par tournoi
    const ordre = Object.entries(j.parTournoi).sort((a, b) => (a[1].date + a[0]).localeCompare(b[1].date + b[0]));
    let v = 0, n = 0;
    const evol = ordre.map(([, t]) => { v += t.v; n += t.n; return pct(v, n); });

    const partenaires = Object.entries(j.partenaires)
      .filter(([, s]) => s.n >= 2)
      .sort((a, b) => pct(b[1].v, b[1].n) - pct(a[1].v, a[1].n) || b[1].n - a[1].n)
      .slice(0, 3);

    const adv = Object.entries(j.adversaires).filter(([, s]) => s.n >= 2);
    const beteNoire = adv.slice().sort((a, b) => (b[1].d - b[1].v) - (a[1].d - a[1].v) || b[1].d - a[1].d)[0];
    const victime = adv.slice().sort((a, b) => (b[1].v - b[1].d) - (a[1].v - a[1].d) || b[1].v - a[1].v)[0];

    const serie = j.serieEnCours;
    const texteSerie = serie.type === 'V' ? `🔥 ${pluriel(serie.n, 'victoire')} de suite en cours`
      : serie.type === 'D' ? `${pluriel(serie.n, 'défaite')} de suite : la prochaine sera la bonne !`
      : 'Dernier match nul';

    let html = `
      <div class="kpis kpis-fiche">
        <div class="kpi"><strong>${j.pct} %</strong><span>de victoires</span></div>
        <div class="kpi"><strong>${j.matchs}</strong><span>matchs</span></div>
        <div class="kpi"><strong>${signe(j.diffMoy)}</strong><span>points / match</span></div>
        <div class="kpi"><strong>${j.nbTournois}</strong><span>tournois</span></div>
        <div class="kpi"><strong>${j.podiums}</strong><span>podiums</span></div>
        <div class="kpi"><strong>${j.titres}</strong><span>titres</span></div>
      </div>
      <p class="note" style="margin-top:0;">${texteSerie} · record : ${pluriel(j.meilleureSerie, 'victoire')} d'affilée</p>
      <div class="sous-titre-fiche">Derniers matchs</div>
      ${pastilles(j.historique.slice(-15))}`;

    if (evol.length > 1) {
      html += `<div class="sous-titre-fiche">Évolution du % de victoires</div>
        ${graphCourbe(ordre.map(([, t]) => dateCourte(t.date)), evol)}`;
    }

    html += '<div class="sous-titre-fiche">Meilleurs partenaires</div>';
    html += partenaires.length ? partenaires.map(([pid, s]) => `
      <div class="ligne-record"><strong>${pct(s.v, s.n)} %</strong> avec ${esc(nomCourt(pid))} <span class="note-inline">${s.v}/${s.n} matchs</span></div>`).join('')
      : '<p class="note">Pas encore assez de matchs avec un même partenaire.</p>';

    html += '<div class="sous-titre-fiche">Face à face</div>';
    if (beteNoire && beteNoire[1].d > beteNoire[1].v) {
      html += `<div class="ligne-record">😈 Bête noire : <strong>${esc(nomCourt(beteNoire[0]))}</strong> <span class="note-inline">${beteNoire[1].d} défaites, ${beteNoire[1].v} victoires</span></div>`;
    }
    if (victime && victime[1].v > victime[1].d) {
      html += `<div class="ligne-record">😇 Adversaire préféré : <strong>${esc(nomCourt(victime[0]))}</strong> <span class="note-inline">${victime[1].v} victoires, ${victime[1].d} défaites</span></div>`;
    }
    if (!(beteNoire && beteNoire[1].d > beteNoire[1].v) && !(victime && victime[1].v > victime[1].d)) {
      html += '<p class="note">Pas encore d\'adversaire rencontré assez souvent.</p>';
    }

    if (j.fanniesDonnees || j.fanniesSubies) {
      html += `<div class="sous-titre-fiche">Fanny</div>
        <div class="ligne-record">💋 ${pluriel(j.fanniesDonnees, 'fanny')} infligée${j.fanniesDonnees > 1 ? 's' : ''}, ${j.fanniesSubies} subie${j.fanniesSubies > 1 ? 's' : ''}</div>`;
    }

    $('contenuFicheJoueur').innerHTML = html;
    P().ouvrirPanel('overlayStatsJoueur', 'panelStatsJoueur');
    $('panelStatsJoueur').scrollTop = 0;
  }

  // ==========================================================
  // ÉVÉNEMENTS
  // ==========================================================
  function init() {
    $('statsPeriode').addEventListener('change', (e) => {
      S.periode = e.target.value;
      S.tournoiOuvert = null;
      recalculer();
      dessiner();
    });

    $('statsSousVues').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-sv]');
      if (!b) return;
      S.sousVue = b.getAttribute('data-sv');
      dessiner();
    });

    $('statsActualiser').addEventListener('click', () => { charger(false); });

    const zone = $('statsContenu');
    zone.addEventListener('click', (e) => {
      const tri = e.target.closest('[data-tri]');
      if (tri) { S.tri = tri.getAttribute('data-tri'); dessiner(); return; }

      const joueur = e.target.closest('[data-joueur]');
      if (joueur) { ouvrirFiche(joueur.getAttribute('data-joueur')); return; }

      const tournoi = e.target.closest('.carte-tournoi');
      if (tournoi) {
        const o = tournoi.getAttribute('data-onglet');
        S.tournoiOuvert = S.tournoiOuvert === o ? null : o;
        dessiner();
      }
    });
    zone.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const cible = e.target.closest('[data-joueur], .carte-tournoi');
      if (cible) { e.preventDefault(); cible.click(); }
    });
    zone.addEventListener('change', (e) => {
      if (e.target.id === 'statsSeuil') { S.seuil = Number(e.target.value); dessiner(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.PTankStats = { afficher };
})();
