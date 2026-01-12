/* =========================================================
   Service Worker – Offline + Background Sync + Periodic Sync
   ========================================================= */

const CACHE_VERSION = 'v1';
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `runtime-${CACHE_VERSION}`;
const NOTES_CACHE = `notes-${CACHE_VERSION}`;

/* -------- FILES FOR OFFLINE -------- */
const OFFLINE_FILES = [
  '/',
  '/index.html',
  '/about.html',
  '/book.html',
  '/editor.html',
  '/offline.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

/* =========================================================
   IndexedDB (Outbox for Background Sync)
   ========================================================= */
const DB_NAME = 'bg-sync-db';
const STORE_NAME = 'outbox';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = e => {
      e.target.result.createObjectStore(STORE_NAME, {
        keyPath: 'id',
        autoIncrement: true
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveRequest(data) {
  const db = await openDB();
  return new Promise(resolve => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(data);
    tx.oncomplete = () => resolve();
  });
}

async function getRequests() {
  const db = await openDB();
  return new Promise(resolve => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
  });
}

async function deleteRequest(id) {
  const db = await openDB();
  return new Promise(resolve => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
  });
}

/* =========================================================
   INSTALL
   ========================================================= */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(OFFLINE_FILES))
  );
  self.skipWaiting();
});

/* =========================================================
   ACTIVATE
   ========================================================= */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => {
          if (![STATIC_CACHE, RUNTIME_CACHE, NOTES_CACHE].includes(key)) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});

/* =========================================================
   FETCH – OFFLINE FIRST + QUEUE POST REQUESTS
   ========================================================= */
self.addEventListener('fetch', event => {
  const req = event.request;

  /* ---- NAVIGATION (HTML) ---- */
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          caches.open(RUNTIME_CACHE).then(c => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match('/offline.html'))
    );
    return;
  }

  /* ---- GET REQUESTS ---- */
  if (req.method === 'GET') {
    event.respondWith(
      caches.match(req).then(cached =>
        cached ||
        fetch(req)
          .then(res => {
            caches.open(RUNTIME_CACHE).then(c => c.put(req, res.clone()));
            return res;
          })
          .catch(() => caches.match('/offline.html'))
      )
    );
    return;
  }

  /* ---- POST / PUT / DELETE (QUEUE IF OFFLINE) ---- */
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    event.respondWith(
      fetch(req.clone()).catch(async () => {
        const clone = req.clone();
        let body = null;

        try {
          body = await clone.json();
        } catch {
          body = await clone.text();
        }

        await saveRequest({
          url: req.url,
          method: req.method,
          headers: [...req.headers],
          body
        });

        if ('sync' in self.registration) {
          await self.registration.sync.register('bg-sync');
        }

        return new Response(
          JSON.stringify({ queued: true, offline: true }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
  }
});

/* =========================================================
   BACKGROUND SYNC – SEND QUEUED REQUESTS
   ========================================================= */
self.addEventListener('sync', event => {
  if (event.tag === 'bg-sync') {
    event.waitUntil(sendQueuedRequests());
  }
});

async function sendQueuedRequests() {
  const queue = await getRequests();
  for (const item of queue) {
    try {
      const headers = new Headers(item.headers);
      const options = {
        method: item.method,
        headers,
        body: typeof item.body === 'object'
          ? JSON.stringify(item.body)
          : item.body
      };

      const res = await fetch(item.url, options);
      if (res.ok) {
        await deleteRequest(item.id);
      }
    } catch {
      // keep request for next retry
    }
  }
}

/* =========================================================
   PERIODIC BACKGROUND SYNC – AUTO UPDATE DATA
   ========================================================= */
self.addEventListener('periodicsync', event => {
  if (event.tag === 'notes-sync') {
    event.waitUntil(updateNotes());
  }
});

async function updateNotes() {
  try {
    const res = await fetch('/api/notes'); // CHANGE to your API
    if (res.ok) {
      const cache = await caches.open(NOTES_CACHE);
      await cache.put('/api/notes', res.clone());
    }
  } catch {
    // silent fail – next periodic sync will retry
  }
}

/* =========================================================
   PUSH (OPTIONAL)
   ========================================================= */
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Update', {
      body: data.body || 'New data available',
      icon: '/icons/icon-192.png'
    })
  );
});