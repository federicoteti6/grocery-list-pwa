// Service worker — cache dell'app shell per uso offline.
const CACHE = 'spesa-v5';
// NB: niente './index.html' — il Worker lo redirige (307) su './' e cache.addAll
// rifiuta le risposte redirette, facendo fallire l'install e l'intero precache.
const SHELL = ['./', './jsbarcode.min.js', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // le chiamate API passano sempre dalla rete (mai cache)
  if (url.pathname.startsWith('/api/')) return;
  // pagina: rete prima (le novità arrivano al primo avvio), cache solo se sei offline
  if(e.request.mode==='navigate'){
    e.respondWith(fetch(e.request).then(res=>{
      if(res && res.status===200) caches.open(CACHE).then(c=>c.put('./',res.clone()));
      return res;
    }).catch(()=>caches.match('./')));
    return;
  }
  // asset statici: cache-first con aggiornamento in background
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res && res.status === 200) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
