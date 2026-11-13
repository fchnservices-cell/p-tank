/* ============================================================
 * P-TANK — Textes à copier dans TMS
 * Fichier : tms.js
 *
 * Fabrique, à partir des données déjà chargées dans l'appli :
 *  - les compositions et les matchs du jour ;
 *  - les résultats (classement et scores).
 * Le texte est copié en DEUX versions à la fois : mise en forme (gras,
 * couleurs) et texte simple. L'éditeur de TMS prend la meilleure qu'il sait
 * gérer. Un commentaire TMS est limité à 2 500 caractères : au-delà, le
 * texte est découpé automatiquement en plusieurs messages.
 * ============================================================ */
(function () {
  'use strict';

  const CFG = window.P_TANK_CONFIG || {};
  const LIMITE = Number(CFG.LIMITE_TMS) || 2500;
  const MARGE = 100;                 // sécurité : TMS ne compte pas forcément comme nous
  const PLAFOND = LIMITE - MARGE;
  const VERT = '#1a5d3a';

  const $ = (id) => document.getElementById(id);
  const P = () => window.PTank;
  const esc = (t) => P().esc(t);

  let messages = [];                 // [{ html, texte }]
  let typeCourant = null;

  // ==========================================================
  // OUTILS
  // ==========================================================
  function dateFr(iso) {
    const p = String(iso || '').split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : '';
  }

  function nomsEquipe(membres) {
    return (membres || []).filter((m) => m !== null).map((m) => m.prenom + ' (' + m.pseudo + ')').join(', ');
  }

  function equipeParNumero(etat) {
    const index = {};
    (etat.equipes || []).forEach((e) => { index[String(e.numEquipe)] = e; });
    return index;
  }

  function toursDe(matchs) {
    return [...new Set(matchs.map((m) => String(m.tour)))].sort((a, b) => Number(a) - Number(b));
  }

  /**
   * Une « section » = un titre + des lignes. Chaque ligne existe en deux
   * versions : html (gras) et texte simple.
   */
  function section(titre, lignes) {
    return { titre, lignes };
  }
  function ligne(html, texte) {
    return { html, texte };
  }

  function titreHtml(t) {
    return `<b><span style="color:${VERT}">${esc(t)}</span></b>`;
  }

  /** Assemble une liste de sections en un message (html + texte). */
  function composer(entete, sections) {
    let html = `<p>${titreHtml(entete)}</p>`;
    let texte = entete + '\n';
    sections.forEach((s) => {
      html += `<p>${titreHtml(s.titre)}<br>` + s.lignes.map((l) => l.html).join('<br>') + '</p>';
      texte += '\n' + s.titre + '\n' + s.lignes.map((l) => l.texte).join('\n') + '\n';
    });
    return { html, texte: texte.trim() };
  }

  /**
   * Répartit les sections dans le moins de messages possible, sous le plafond.
   * Une section trop longue à elle seule est coupée entre deux lignes
   * (son titre est répété avec « (suite) »).
   */
  function decouper(entete, sections) {
    const morceaux = [];
    sections.forEach((s) => {
      let courant = section(s.titre, []);
      s.lignes.forEach((l) => {
        const essai = section(courant.titre, courant.lignes.concat([l]));
        if (courant.lignes.length && composer(entete + ' (suite 0/0)', [essai]).texte.length > PLAFOND) {
          morceaux.push(courant);
          courant = section(s.titre + ' (suite)', [l]);
        } else {
          courant = essai;
        }
      });
      morceaux.push(courant);
    });

    const groupes = [];
    let groupe = [];
    morceaux.forEach((m) => {
      const essai = groupe.concat([m]);
      if (groupe.length && composer(entete + ' (suite 0/0)', essai).texte.length > PLAFOND) {
        groupes.push(groupe);
        groupe = [m];
      } else {
        groupe = essai;
      }
    });
    if (groupe.length) groupes.push(groupe);

    const total = groupes.length;
    return groupes.map((g, i) => composer(total > 1 ? entete + ' (' + (i + 1) + '/' + total + ')' : entete, g));
  }

  // ==========================================================
  // CONTENUS
  // ==========================================================
  function texteCompositions(etat) {
    const date = dateFr(etat.dateTournoi);
    const entete = '🎯 TOURNOI DE PÉTANQUE' + (date ? ' DU ' + date : '');
    const parNum = equipeParNumero(etat);
    const sections = [];

    sections.push(section('👥 COMPOSITION DES ÉQUIPES', (etat.equipes || []).map((e) =>
      ligne(`• <b>Équipe ${esc(e.numEquipe)}</b> : ${esc(nomsEquipe(e.membres))}`,
            `• Équipe ${e.numEquipe} : ${nomsEquipe(e.membres)}`))));

    const matchs = etat.matchs || [];
    toursDe(matchs).forEach((tour) => {
      sections.push(section('⚔️ MATCHS — TOUR ' + tour, matchs.filter((m) => String(m.tour) === tour).map((m) => {
        const a = parNum[String(m.numEquipeA)], b = parNum[String(m.numEquipeB)];
        const na = nomsEquipe(a ? a.membres : m.composA), nb = nomsEquipe(b ? b.membres : m.composB);
        return ligne(
          `• <b>Équipe ${esc(m.numEquipeA)}</b> (${esc(na)}) 🆚 <b>Équipe ${esc(m.numEquipeB)}</b> (${esc(nb)})`,
          `• Équipe ${m.numEquipeA} (${na}) 🆚 Équipe ${m.numEquipeB} (${nb})`);
      })));
    });

    if (!matchs.length) {
      sections.push(section('⚔️ MATCHS', [ligne('<i>Le tirage des matchs n\'a pas encore été fait.</i>', 'Le tirage des matchs n\'a pas encore été fait.')]));
    }
    return decouper(entete, sections);
  }

  function texteResultats(etat) {
    const date = dateFr(etat.dateTournoi);
    const entete = '🏆 RÉSULTATS DU TOURNOI' + (date ? ' DU ' + date : '');
    const parNum = equipeParNumero(etat);
    const medailles = ['🥇', '🥈', '🥉'];
    const sections = [];

    sections.push(section('📊 CLASSEMENT', (etat.classement || []).map((c) => {
      const rang = c.rang <= 3 ? medailles[c.rang - 1] : c.rang + '.';
      const ga = (c.goalAverage > 0 ? '+' : '') + c.goalAverage;
      const noms = nomsEquipe(c.membres);
      return ligne(
        `${rang} <b>Équipe ${esc(c.numEquipe)}</b> — ${esc(c.points)} pts (${esc(ga)}) : ${esc(noms)}`,
        `${rang} Équipe ${c.numEquipe} — ${c.points} pts (${ga}) : ${noms}`);
    })));

    const matchs = etat.matchs || [];
    toursDe(matchs).forEach((tour) => {
      sections.push(section('🎯 SCORES — TOUR ' + tour, matchs.filter((m) => String(m.tour) === tour).map((m) => {
        const a = parNum[String(m.numEquipeA)], b = parNum[String(m.numEquipeB)];
        const na = nomsEquipe(a ? a.membres : m.composA), nb = nomsEquipe(b ? b.membres : m.composB);
        const joue = m.statut === 'Joué';
        const score = joue ? m.scoreA + ' – ' + m.scoreB : 'non joué';
        const fanny = joue && Math.min(m.scoreA, m.scoreB) === 0 && Math.max(m.scoreA, m.scoreB) === 13 ? ' 💋' : '';
        return ligne(
          `• <b>Équipe ${esc(m.numEquipeA)}</b> (${esc(na)}) <b>${esc(score)}</b> <b>Équipe ${esc(m.numEquipeB)}</b> (${esc(nb)})${fanny}`,
          `• Équipe ${m.numEquipeA} (${na}) ${score} Équipe ${m.numEquipeB} (${nb})${fanny}`);
      })));
    });
    return decouper(entete, sections);
  }

  // ==========================================================
  // COPIE ET PARTAGE
  // ==========================================================
  async function copier(message) {
    // 1. Version mise en forme + texte simple (navigateurs récents)
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([message.html], { type: 'text/html' }),
          'text/plain': new Blob([message.texte], { type: 'text/plain' })
        })]);
        return true;
      }
    } catch (e) { /* on essaie autrement */ }

    // 2. Ancienne méthode : sélection d'un bloc mis en forme
    try {
      const zone = document.createElement('div');
      zone.contentEditable = 'true';
      zone.innerHTML = message.html;
      zone.style.cssText = 'position:fixed; left:-9999px; top:0; white-space:normal;';
      document.body.appendChild(zone);
      const plage = document.createRange();
      plage.selectNodeContents(zone);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(plage);
      const ok = document.execCommand('copy');
      sel.removeAllRanges();
      zone.remove();
      if (ok) return true;
    } catch (e) { /* on essaie autrement */ }

    // 3. Texte simple
    try {
      await navigator.clipboard.writeText(message.texte);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ==========================================================
  // AFFICHAGE DU VOLET
  // ==========================================================
  async function ouvrir(type) {
    typeCourant = type;
    let etat;
    try {
      etat = await P().rafraichirEtat();      // données à jour avant de composer le texte
    } catch (e) {
      etat = P().etatCourant();               // hors connexion : dernières données connues
      P().afficherToast('Hors connexion : texte construit avec les dernières données reçues.', false, 3500);
    }
    if (!etat || !(etat.equipes || []).length) {
      P().afficherToast('Aucune équipe constituée pour le moment.', true);
      return;
    }

    messages = type === 'compositions' ? texteCompositions(etat) : texteResultats(etat);
    $('titrePanelTms').textContent = type === 'compositions' ? 'Compositions pour TMS' : 'Résultats pour TMS';

    const n = messages.length;
    let html = n > 1
      ? `<p class="note alerte">Le texte dépasse ${LIMITE.toLocaleString('fr-FR')} caractères, limite d'un commentaire TMS : il est découpé en <strong>${n} messages</strong> à publier l'un après l'autre.</p>`
      : '';
    html += messages.map((m, i) => `
      <div class="bloc-tms">
        <div class="entete-bloc-tms">
          <strong>${n > 1 ? 'Message ' + (i + 1) + '/' + n : 'Message'}</strong>
          <span class="compteur-tms">${m.texte.length.toLocaleString('fr-FR')} / ${LIMITE.toLocaleString('fr-FR')}</span>
        </div>
        <div class="apercu-tms">${m.html}</div>
        <div class="ligne-2col">
          <button type="button" class="btn btn-primaire" data-copier="${i}">📋 Copier</button>
          <button type="button" class="btn btn-secondaire" data-partager="${i}">📤 Partager</button>
        </div>
      </div>`).join('');
    html += '<p class="note">Dans TMS, cliquez dans la zone du commentaire, puis collez (appui long > Coller sur téléphone, ou Ctrl+V sur ordinateur).</p>';
    $('contenuTms').innerHTML = html;

    if (!navigator.share) {
      document.querySelectorAll('#contenuTms [data-partager]').forEach((b) => { b.style.display = 'none'; });
    }
    P().ouvrirPanel('overlayTms', 'panelTms');
    $('panelTms').scrollTop = 0;
  }

  function init() {
    $('btnTmsCompositions').addEventListener('click', () => ouvrir('compositions'));
    $('btnTmsResultats').addEventListener('click', () => ouvrir('resultats'));

    $('contenuTms').addEventListener('click', async (e) => {
      const bc = e.target.closest('[data-copier]');
      if (bc) {
        const i = Number(bc.getAttribute('data-copier'));
        const ok = await copier(messages[i]);
        if (ok) {
          bc.textContent = '✓ Copié';
          setTimeout(() => { bc.textContent = '📋 Copier'; }, 2500);
          P().afficherToast(messages.length > 1 ? 'Message ' + (i + 1) + ' copié : collez-le dans TMS.' : 'Texte copié : collez-le dans TMS.');
        } else {
          P().afficherToast('Copie impossible sur cet appareil. Utilisez « Partager ».', true, 4000);
        }
        return;
      }
      const bp = e.target.closest('[data-partager]');
      if (bp) {
        const i = Number(bp.getAttribute('data-partager'));
        try { await navigator.share({ text: messages[i].texte }); }
        catch (err) { /* partage annulé */ }
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
