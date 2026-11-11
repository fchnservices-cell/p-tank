/* ============================================================
 * P-TANK — Service worker
 * Garde une copie de l'application sur le téléphone pour qu'elle
 * s'ouvre même sans réseau. Les données (scores…) ne sont pas
 * gérées ici : elles passent par l'API Google Apps Script.
 *
 * Stratégie « réseau d'abord » : avec du réseau, on charge toujours
 * la dernière version publiée ; sans réseau (ou s'il est trop lent),
 * on utilise la copie locale. Aucun numéro de version à gérer.
 *
 * GitHub Pages demande aux navigateurs de garder les fichiers 10 minutes
 * en mémoire : on force donc la vérification auprès du serveur
 * (cache: 'no-cache'), pour qu'une mise à jour soit visible tout de suite.
 * ============================================================ */
const CACHE = 'ptank-app';
const DELAI_RESEAU_MS = 3500;
const FICHIERS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './stats.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(FICHIERS.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((c) => c !== CACHE).map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // l'API Google n'est jamais mise en cache

  const traitement = reseauDabord(req);
  event.respondWith(traitement.reponse);
  // Laisse le temps à la mise à jour en arrière-plan de se terminer
  event.waitUntil(traitement.miseAJour.catch(() => {}));
});

/** Empreinte d'une version de fichier, fournie par GitHub Pages. */
function empreinte(rep) {
  return (rep && (rep.headers.get('etag') || rep.headers.get('last-modified'))) || '';
}

let notificationEnvoyee = false;
async function signalerNouvelleVersion() {
  if (notificationEnvoyee) return;
  notificationEnvoyee = true;
  const fenetres = await self.clients.matchAll({ type: 'window' });
  fenetres.forEach((f) => f.postMessage({ type: 'nouvelle-version' }));
  setTimeout(() => { notificationEnvoyee = false; }, 10000);
}

/**
 * Réseau d'abord, copie locale si le réseau est absent ou trop lent.
 * Si la copie locale a été servie et que le réseau apporte ensuite une
 * version différente, l'application est prévenue (bouton « Recharger »).
 */
function reseauDabord(req) {
  let copieServie = false;
  let resoudreMaj;
  const miseAJour = new Promise((r) => { resoudreMaj = r; });

  const reponse = (async () => {
    const cache = await caches.open(CACHE);
    const copie = await cache.match(req, { ignoreSearch: true });

    // Une requête de navigation ne peut pas être recopiée avec des options : on repart de son adresse
    const cible = req.mode === 'navigate' ? req.url : req;
    const reseau = fetch(cible, { cache: 'no-cache' }).then(async (rep) => {
      if (rep && rep.ok) {
        await cache.put(req, rep.clone());
        const ancienne = empreinte(copie);
        const nouvelle = empreinte(rep);
        if (copieServie && ancienne && nouvelle && ancienne !== nouvelle) signalerNouvelleVersion();
      }
      return rep;
    });
    resoudreMaj(reseau);

    if (!copie) {
      try { return await reseau; }
      catch (e) {
        const accueil = await cache.match('./index.html');
        return accueil || Response.error();
      }
    }

    // Réseau trop lent ou absent → copie locale ; la mise à jour continue en arrière-plan
    const delai = new Promise((resolve) => setTimeout(() => { copieServie = true; resolve(copie); }, DELAI_RESEAU_MS));
    try {
      return await Promise.race([reseau.catch(() => { copieServie = true; return copie; }), delai]);
    } catch (e) {
      copieServie = true;
      return copie;
    }
  })();

  return { reponse, miseAJour };
}
