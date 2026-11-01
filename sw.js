// يحفظ ملفات التطبيق والمكتبات، ويخدم حزم الخرائط (الدول) المنزّلة بدون إنترنت
const CACHE = 'daliny-v8';
const LIBS = 'daliny-libs-v1';
const PACK_CACHE = 'daliny-packs-v1';
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k !== CACHE && k !== LIBS && k !== PACK_CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const packBlobs = {};
const chunkMeta = {};
let recent = [];

self.addEventListener('message', (e) => {
  if (e.data === 'pack-reset') {
    for (const k in packBlobs) delete packBlobs[k];
    for (const k in chunkMeta) delete chunkMeta[k];
    recent = [];
  }
});

async function getMeta(cache, key) {
  if (chunkMeta[key]) return chunkMeta[key];
  const r = await cache.match(key + '?meta');
  if (!r) return null;
  const m = await r.json();
  chunkMeta[key] = m;
  return m;
}
async function getChunk(cache, key, i) {
  const k = key + '?c=' + i;
  const hit = recent.find((x) => x.k === k);
  if (hit) return hit.b;
  const r = await cache.match(k);
  if (!r) return null;
  const b = await r.blob();
  recent.push({ k, b });
  if (recent.length > 4) recent.shift();
  return b;
}

// يرجّع الجزء المطلوب (Range) من ملف الخريطة المحفوظ
async function packResponse(req, key) {
  const cache0 = await caches.open(PACK_CACHE);
  const meta = await getMeta(cache0, key);
  if (meta) {
    const size = meta.size, CH = meta.chunk;
    const range = req.headers.get('range');
    const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    let start = 0, end = size - 1, status = 200;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m && m[1]) start = parseInt(m[1], 10);
      if (m && m[2]) end = parseInt(m[2], 10);
      if (m && !m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
      end = Math.min(end, size - 1);
      status = 206;
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    }
    const first = Math.floor(start / CH), last = Math.floor(end / CH);
    const parts = [];
    for (let i = first; i <= last; i++) {
      const b = await getChunk(cache0, key, i);
      if (!b) return fetch(req);
      parts.push(b.slice(i === first ? start - i * CH : 0, i === last ? end - i * CH + 1 : b.size));
    }
    headers['Content-Length'] = String(end - start + 1);
    return new Response(new Blob(parts), { status, headers });
  }
  let blob = packBlobs[key];
  if (!blob) {
    const cache = cache0;
    const hit = await cache.match(key);
    if (!hit) return fetch(req);
    blob = await hit.blob();
    packBlobs[key] = blob; // نبقيه بالذاكرة حتى ما نقرأه من جديد مع كل جزء خريطة
  }
  const range = req.headers.get('range');
  const headers = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  if (!range) {
    headers['Content-Length'] = String(blob.size);
    return new Response(blob, { status: 200, headers });
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : blob.size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, blob.size - parseInt(m[2], 10)); end = blob.size - 1; }
  end = Math.min(end, blob.size - 1);
  headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + blob.size;
  headers['Content-Length'] = String(end - start + 1);
  return new Response(blob.slice(start, end + 1), { status: 206, headers });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // ملفات الخرائط المنزّلة (التنزيل نفسه يستخدم ?dl=1 فيمر بدون تدخل)
  if (url.pathname.endsWith('.pmtiles')) {
    if (url.searchParams.has('dl')) return;
    e.respondWith(packResponse(req, url.origin + url.pathname));
    return;
  }

  // مكتبات التطبيق (Leaflet وغيرها): من الذاكرة أول حتى يفتح التطبيق بدون إنترنت
  if (url.hostname === 'unpkg.com' || url.hostname === 'protomaps.github.io') {
    e.respondWith(
      caches.open(LIBS).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

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
