// خدمة بسيطة: تحفظ ملفات التطبيق، وتحفظ أجزاء الخريطة اللي تشوفها فقط (بدون تنزيل مسبق)
const CACHE = 'daliny-v2';
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png'];
const TILE_CACHE = 'daliny-tiles-v1';
const MAX_TILES = 6000; // سقف عدد الأجزاء المحفوظة، والأقدم يُمسح أول

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) {
    const extra = keys.length - MAX_TILES + 200; // نمسح زيادة قليلة حتى ما نكرر التنظيف
    await Promise.all(keys.slice(0, extra).map((k) => cache.delete(k)));
  }
}

// الإنترنت أول (والمتصفح يحترم قواعد التخزين المؤقت للسيرفر)، وإذا انقطع نستخدم المحفوظ
async function tileFetch(req) {
  const cache = await caches.open(TILE_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type !== 'opaque') {
      cache.put(req, res.clone()).then(() => { if (Math.random() < 0.02) trimTiles(cache); }).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    return hit || new Response('', { status: 504 });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'tile.openstreetmap.org') { e.respondWith(tileFetch(req)); return; }
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('./')))
  );
});
