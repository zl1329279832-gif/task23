// Service Worker - 医疗随访离线采集系统
const CACHE_NAME = 'medical-followup-v3';
const STATIC_ASSETS = [
  '/index.html',
  '/app.js',
  '/styles/main.css',
  '/lib/crypto.js',
  '/lib/db.js',
  '/lib/utils.js',
  '/lib/sync.js',
  '/lib/questionnaire-engine.js',
  '/lib/attachments.js',
  '/lib/reminders.js',
  '/lib/followup-plan.js',
  '/data/questionnaire-templates.json',
  '/views/patient-list.js',
  '/views/questionnaire.js',
  '/views/record.js',
  '/views/detail.js',
  '/views/sync-review.js',
  '/views/conflict.js',
  '/views/export.js',
  '/views/questionnaire-config.js',
  '/views/followup-plan.js',
  '/views/risk-config.js'
];

// Install - cache all static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('SW install cache error:', err))
  );
});

// Activate - clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch - cache first, then network fallback, with cache recovery
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // For data files, try network first then cache
  if (url.pathname.startsWith('/data/')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for all other assets, with recovery
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Return offline fallback for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        // For lib/view files, try to serve from any available cache version
        // This handles cache corruption or partial updates
        return caches.match(event.request, { ignoreSearch: true })
          .then(result => result || new Response('// offline', {
            headers: { 'Content-Type': 'application/javascript' }
          }));
      });
    })
  );
});

// Listen for sync events from main thread
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // Cache recovery: force re-cache all static assets
  if (event.data && event.data.type === 'RECOVER_CACHE') {
    event.waitUntil(
      caches.open(CACHE_NAME).then(cache => {
        return Promise.all(
          STATIC_ASSETS.map(url =>
            fetch(url).then(response => {
              if (response && response.status === 200) {
                return cache.put(url, response);
              }
            }).catch(() => null) // Skip failed assets
          )
        );
      }).then(() => {
        // Notify all clients that cache recovery is complete
        self.clients.matchAll().then(clients => {
          clients.forEach(client => {
            client.postMessage({ type: 'CACHE_RECOVERED' });
          });
        });
      })
    );
  }
});
