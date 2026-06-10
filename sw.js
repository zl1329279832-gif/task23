const CACHE_NAME = 'medical-followup-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/variables.css',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './css/views.css',
  './css/conflict.css',
  './js/app.js',
  './js/router.js',
  './js/core/config.js',
  './js/core/event-bus.js',
  './js/core/crypto.js',
  './js/core/db.js',
  './js/utils/uid.js',
  './js/utils/date.js',
  './js/utils/debounce.js',
  './js/utils/validators.js',
  './js/models/patient.js',
  './js/models/followup.js',
  './js/models/questionnaire.js',
  './js/models/vital-signs.js',
  './js/models/attachment.js',
  './js/models/reminder.js',
  './js/services/sync-manager.js',
  './js/services/draft-manager.js',
  './js/services/questionnaire-engine.js',
  './js/services/image-compressor.js',
  './js/services/integrity-checker.js',
  './js/services/duplicate-detector.js',
  './js/services/reminder-scheduler.js',
  './js/services/export-manager.js',
  './js/services/cleanup-manager.js',
  './js/views/login.js',
  './js/views/patient-list.js',
  './js/views/patient-detail.js',
  './js/views/followup-form.js',
  './js/views/questionnaire-view.js',
  './js/views/vital-signs-form.js',
  './js/views/photo-capture.js',
  './js/views/conflict-resolver.js',
  './js/views/sync-status.js',
  './js/views/reminders-view.js',
  './js/views/export-view.js',
  './js/components/toast.js',
  './js/components/modal.js',
  './js/components/loading.js',
  './js/components/offline-badge.js',
  './js/components/risk-badge.js',
  './data/questionnaire-schemas/hypertension-v1.json',
  './data/questionnaire-schemas/diabetes-v1.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return cache.addAll(APP_SHELL).catch(err => {
          console.warn('Some resources failed to cache:', err);
          return cache.addAll(APP_SHELL.filter(url =>
            !url.includes('icons/')
          ));
        });
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response.ok && event.request.method === 'GET') {
            const cloned = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, cloned));
          }
          return response;
        });
      })
      .catch(() => {
        if (event.request.destination === 'document') {
          return caches.match('./index.html');
        }
      })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
