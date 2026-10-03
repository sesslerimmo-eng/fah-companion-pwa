const CACHE_NAME = "fah-companion-v2";

const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// App shell : réseau d'abord, avec repli sur le cache hors ligne.
//
// Un cache-first classique garderait indéfiniment une ancienne version de
// l'app tant que ce fichier (service-worker.js) lui-même ne change pas —
// ce qui s'est produit pendant le développement. Réseau d'abord garantit
// que toute mise à jour est visible dès la prochaine ouverture avec
// connexion, tout en gardant le fonctionnement hors ligne en repli.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  // Les appels à l'API Folding@home (autre origine) ne passent jamais par
  // ici : seules les requêtes same-origin (l'app elle-même) sont concernées.
  if (new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});
