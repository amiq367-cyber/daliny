// يحفظ ملفات التطبيق والمكتبات، ويخدم حزم الخرائط (الدول) المنزّلة بدون إنترنت، ويحفظ قطع المباني اللي يفتحها المستخدم
const CACHE = 'daliny-v19';
// مسار نطاق الـ worker (مثلاً /daliny/): «الصفحة الرئيسية» = هذا المسار أو هذا المسار + index.html (مو أي مسار ينتهي بـ /)
let SCOPE_PATH = '/';
try { SCOPE_PATH = new URL('./', self.location.href).pathname; } catch (err) {}
const LIBS = 'daliny-libs-v2';
const PACK_CACHE = 'daliny-packs-v1';
const BLD_CACHE = 'daliny-bld-v1'; // قطع مباني Overture اللي فتحها المستخدم (انظر قسم المباني تحت)
const FLAGS = 'daliny-flags-v1';   // مفتاح إيقاف حفظ المباني: بكاش لحاله حتى «مسح» المباني ما يرجّع الحفظ
const SHELL = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png'];
// صفحة الخصوصية وإضافة الكتابة العربية للخريطة: نحفظها حتى تنفتح بدون إنترنت، لكن لو غابت (مثلاً ما انرفعت) ما تمنع تثبيت التحديث
const EXTRA = ['privacy.html', 'mapbox-gl-rtl-text.js'];
// ملفات ثابتة ما تتغير بين نسخة ونسخة (الأيقونات + إضافة الكتابة العربية): تنخدم من الذاكرة أول، حتى شاشة البداية والخريطة ما تنتظر الشبكة.
// إذا تغيّر واحد منها لازم نرفع رقم CACHE فوق.
const STATIC_RE = /\/(icon-[\w-]+\.png|mapbox-gl-rtl-text\.js)$/;
// الصفحة الرئيسية (index.html و './'): من الذاكرة فوراً بدون انتظار الشبكة (هذا أكبر توفير بزمن التشغيل)، والتحديث ينزل بعد ما تظهر الخريطة (رسالة refresh-shell من الصفحة) ويشتغل بالفتحة الجاية.
// باقي الملفات (privacy.html، فهرس المباني...): الشبكة أول حتى يوصل التحديث فوراً، لكن لو الشبكة بطيئة أكثر من هالمدة نفتح من الذاكرة
// (والتحديث يكمل بالخلفية للمرة الجاية) بدل ما يظل المستخدم يطالع شاشة فاضية.
const NET_WAIT_MS = 3000;

const LIB_URLS = [
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/pmtiles@3.2.1/dist/pmtiles.js',
  'https://unpkg.com/@protomaps/basemaps@5.7.2/dist/basemaps.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    Promise.all([
      caches.open(CACHE).then(async (c) => {
        // cache: 'reload' = نجيب من السيرفر مباشرة (مو من كاش المتصفح اللي ممكن يمسك نسخة قديمة 10 دقائق بعد الرفع)
        await c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
        await Promise.all(EXTRA.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
      }),
      // نحفظ مكتبات التطبيق من البداية حتى يشتغل بدون إنترنت حتى لو انفتح أول مرة بعد التحديث
      caches.open(LIBS).then((c) => Promise.all(LIB_URLS.map(async (u) => {
        try {
          if (await c.match(u)) return;
          const r = await fetch(u, { mode: 'cors', credentials: 'omit' });
          if (r && r.ok) await c.put(u, r);
        } catch (err) { /* نحاول لاحقاً عند أول فتح */ }
      })))
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k !== CACHE && k !== LIBS && k !== PACK_CACHE && k !== BLD_CACHE && k !== FLAGS)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const packBlobs = {};
const chunkMeta = {};
let recent = [];

self.addEventListener('message', (e) => {
  const d = e.data;
  if (d === 'pack-reset') {
    for (const k in packBlobs) delete packBlobs[k];
    for (const k in chunkMeta) delete chunkMeta[k];
    recent = [];
  } else if (d && d.t === 'bld-keep') {
    e.waitUntil(bldSetKeep(d.on !== false));          // المستخدم شغّل/طفّى حفظ المباني من الإعدادات
  } else if (d && d.t === 'bld-reset') {
    bldSizesP = null; bldTotal = 0;                    // الصفحة مسحت كاش المباني: نعيد حساب الحجم من الصفر
  } else if (d && d.t === 'refresh-shell') {
    e.waitUntil(refreshShell());                       // الصفحة ظهرت: نتأكد إذا فيه نسخة أحدث ونحفظها للفتحة الجاية
  }
});

// تحديث الصفحة الرئيسية بالخلفية: نجيبها من السيرفر (طلب شرطي ETag بدون كاش المتصفح)، وإذا تغيّرت عن المحفوظة نحفظها ونخبر الصفحة المفتوحة.
async function refreshShell() {
  let changed = false;
  try {
    const c = await caches.open(CACHE);
    const res = await fetch(new Request('index.html', { cache: 'no-cache' }));
    if (!res || !res.ok) return;
    const old = await c.match('index.html');
    if (old) {
      const [a, b] = await Promise.all([old.clone().text(), res.clone().text()]);
      if (a === b) return;                 // نفس النسخة: ما نكتب شي
      changed = true;
    }
    // نسخة جديدة (أو الاثنتين كانت ناقصة): نحفظها بالمفتاحين (الصفحة تنفتح بـ ./ أو index.html)
    await Promise.all([c.put('index.html', res.clone()), c.put('./', res.clone())]);
  } catch (err) { return; }                // بدون إنترنت: نبقى على المحفوظة
  if (!changed) return;
  const all = await self.clients.matchAll();
  all.forEach((cl) => { try { cl.postMessage({ t: 'shell-updated' }); } catch (err) {} });
}

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

/* ---- حفظ قطع المباني (bld/*.pmtiles) ----
   الخريطة تقرأ ملف المحافظة بطلبات Range (رأس الملف + الفهارس + قطع المباني). نحفظ كل جزء تطلبه (لين 1 ميغا) ونخدمه من الجوال
   المرة الجاية بدون شبكة، فتظهر مباني أماكنك المعتادة تقريباً فوراً وحتى بدون إنترنت.
   - حد أقصى 100 ميغا و3000 جزء، وإذا انتهى المجال ينحذف الأقدم أول.
   - مفتاح الجزء يتضمن ?v= (نسخة الملف حسب فهرس المباني) فنسخة جديدة من الملف ما تنخلط بالقديمة،
     وإذا ظهر إن الملف تغيّر (ETag ما يطابق If-Match) نمسح أجزاء هالنسخة ولا نخلط.
   - المستخدم يوقف الحفظ أو يمسحه من الإعدادات: الصفحة ترسل bld-keep، وتمسح الكاش بنفسها ثم ترسل bld-reset.
   - Cache API ما يقبل رد 206، فنخزّن الجزء كرد 200 مع Content-Range بترويسة X-CR، ونرجّعه 206 عند الطلب. */
const BLD_RE = /\/bld\/[\w-]+\.pmtiles$/;
const BLD_RANGE_RE = /^bytes=(\d+)-(\d+)$/;
const BLD_MAX_BYTES = 100 * 1048576;
const BLD_MAX_ENTRIES = 3000;
const BLD_MAX_PART = 1048576;
const BLD_OFF_KEY = 'bld-keep-off';
let bldOn = null;                    // هل الحفظ شغّال؟ (null = ما قرأناه بعد من الكاش)
let bldSizesP = null, bldTotal = 0;  // (مفتاح الجزء → حجمه) بترتيب الأقدم أول + المجموع

async function bldKeepEnabled() {
  if (bldOn === null) {
    let v = true;
    try { v = !(await (await caches.open(FLAGS)).match(BLD_OFF_KEY)); } catch (err) { /* نفترض شغّال */ }
    if (bldOn === null) bldOn = v;     // لو وصلت رسالة من الصفحة أثناء القراءة، رأي الصفحة أحدث
  }
  return bldOn;
}
async function bldSetKeep(on) {
  bldOn = on;
  try {
    const c = await caches.open(FLAGS);
    if (on) await c.delete(BLD_OFF_KEY); else await c.put(BLD_OFF_KEY, new Response('off'));
  } catch (err) { /* ما نكدر نحفظ المفتاح: يبقى مطبّق لين ينغلق الـ worker */ }
}

const bldBase = (url) => new URL(url.origin + url.pathname + '?v=' + encodeURIComponent(url.searchParams.get('v')) + '&r=').href; // بداية مفتاح كل أجزاء نسخة ملف
const bldKey = (url, a, b) => bldBase(url) + a + '-' + b;
const bldSizeOf = (key) => { const m = /&r=(\d+)-(\d+)$/.exec(key); return m ? +m[2] - +m[1] + 1 : 0; };

// نقرأ المفاتيح مرة وحدة (من غير ما نفتح الأجزاء) ونحسب الحجم من المدى اللي بالمفتاح
function bldSizes() {
  if (!bldSizesP) {
    bldSizesP = (async () => {
      const sizes = new Map();
      bldTotal = 0;
      try {
        const c = await caches.open(BLD_CACHE);
        for (const rq of await c.keys()) { const n = bldSizeOf(rq.url); sizes.set(rq.url, n); bldTotal += n; }
      } catch (err) { /* كاش فاضي أو غير متاح */ }
      return sizes;
    })();
  }
  return bldSizesP;
}
async function bldEvict(c, maxBytes, maxEntries) {   // نحذف الأقدم أول لين نرجع تحت الحد
  const sizes = await bldSizes();
  for (const [k, n] of sizes) {
    if (bldTotal <= maxBytes && sizes.size <= maxEntries) break;
    sizes.delete(k); bldTotal -= n;
    try { await c.delete(k); } catch (err) { /* نكمل */ }
  }
}
async function bldPurge(prefix) {                    // نمسح كل أجزاء نسخة ملف معيّنة
  try {
    const sizes = await bldSizes();
    const c = await caches.open(BLD_CACHE);
    for (const [k, n] of Array.from(sizes)) {
      if (!k.startsWith(prefix)) continue;
      sizes.delete(k); bldTotal -= n;
      await c.delete(k);
    }
  } catch (err) { /* نكمل */ }
}

// null = ما عندنا الجزء، false = عندنا بس من نسخة ثانية للملف، غير هيج = الرد 206 جاهز
async function bldHit(key, req) {
  try {
    const hit = await (await caches.open(BLD_CACHE)).match(key);
    const cr = hit && hit.headers.get('x-cr');
    const m = cr && /^bytes (\d+)-(\d+)\/\d+$/.exec(cr);
    if (!m) return null;
    const et = hit.headers.get('etag'), want = req.headers.get('if-match');
    if (et && want && want !== '*' && want !== et) return false;
    const h = { 'Content-Type': hit.headers.get('content-type') || 'application/octet-stream', 'Content-Range': cr, 'Content-Length': String(+m[2] - +m[1] + 1), 'Accept-Ranges': 'bytes' };
    if (et) h.ETag = et;
    return new Response(hit.body, { status: 206, headers: h });
  } catch (err) { return null; }
}
async function bldSave(key, prefix, req, copy) {
  try {
    const cr = copy.headers.get('content-range') || '';
    const m = /^bytes (\d+)-(\d+)\/\d+$/.exec(cr);
    if (!m) return;
    const len = +m[2] - +m[1] + 1;
    const et = copy.headers.get('etag') || '', want = req.headers.get('if-match');
    if (et && want && want !== '*' && want !== et) { await bldPurge(prefix); return; } // الملف تغيّر عند السيرفر: ما نخلط
    const buf = await copy.arrayBuffer();              // لو انقطع الطلب (الخريطة تلغي اللي ما تحتاجه) يرمي خطأ ولا نحفظ جزء ناقص
    if (buf.byteLength !== len || len > BLD_MAX_PART) return;
    const h = { 'Content-Type': copy.headers.get('content-type') || 'application/octet-stream', 'Content-Length': String(len), 'X-CR': cr };
    if (et) h.ETag = et;
    const c = await caches.open(BLD_CACHE);
    const sizes = await bldSizes();
    try { await c.put(key, new Response(buf, { status: 200, headers: h })); }
    catch (err) {
      if (err && err.name === 'QuotaExceededError') await bldEvict(c, bldTotal / 2, sizes.size / 2); // مساحة الجهاز ممتلئة: نفرّغ نصف اللي عندنا
      return;
    }
    const n = bldSizeOf(key);
    bldTotal += n - (sizes.get(key) || 0);
    sizes.delete(key); sizes.set(key, n);              // آخر مكان = الأحدث
    if (bldTotal > BLD_MAX_BYTES || sizes.size > BLD_MAX_ENTRIES) await bldEvict(c, BLD_MAX_BYTES * 0.9, BLD_MAX_ENTRIES * 0.9);
  } catch (err) { /* ما نكدر نحفظ: الخريطة تشتغل عادي من الشبكة */ }
}
// يرجّع { res, done }: الرد للصفحة، وdone = شغل الحفظ بالخلفية (يمسكه waitUntil)
async function bldResponse(req, url) {
  const m = BLD_RANGE_RE.exec(req.headers.get('range') || ''), v = url.searchParams.get('v');
  const a = m ? +m[1] : 0, b = m ? +m[2] : 0;
  // بدون Range أو بدون ?v= أو الطلب يريد نسخة جديدة من الشبكة (cache: reload) أو الحفظ مطفّى: يمر للشبكة مثل قبل
  if (!m || !v || b < a || b - a + 1 > BLD_MAX_PART || req.cache === 'reload' || req.cache === 'no-store' || !(await bldKeepEnabled())) return { res: await fetch(req) };
  const key = bldKey(url, a, b), prefix = bldBase(url);
  const hit = await bldHit(key, req);
  if (hit) return { res: hit };
  const jobs = [];
  if (hit === false) jobs.push(bldPurge(prefix));
  const res = await fetch(req);
  if (res.status === 206) jobs.push(bldSave(key, prefix, req, res.clone()));
  else if (res.status === 412 || res.status === 416) jobs.push(bldPurge(prefix));
  return { res, done: Promise.all(jobs) };
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // قطع المباني: من الجوال إذا انحفظت، وإلا من الشبكة وتنحفظ (انظر قسم المباني فوق)
  if (BLD_RE.test(url.pathname) && !url.searchParams.has('dl')) {
    const task = bldResponse(req, url);
    e.waitUntil(task.then((t) => t.done).catch(() => {}));
    e.respondWith(task.then((t) => t.res));
    return;
  }

  // ملفات الخرائط المنزّلة (التنزيل نفسه يستخدم ?dl=1 فيمر بدون تدخل)
  if (url.pathname.endsWith('.pmtiles')) {
    if (url.searchParams.has('dl')) return;
    e.respondWith(packResponse(req, url.origin + url.pathname));
    return;
  }

  // مكتبات التطبيق والخطوط: من الذاكرة أول حتى يفتح التطبيق بدون إنترنت.
  // نجيبها بوضع CORS (مو opaque) لأن importScripts داخل الـ worker يرفض الرد المغلق.
  if (url.hostname === 'unpkg.com' || url.hostname === 'protomaps.github.io') {
    e.respondWith(
      caches.open(LIBS).then(async (c) => {
        const key = req.url;
        const hit = await c.match(key);
        if (hit && hit.type !== 'opaque') return hit;
        try {
          const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
          if (res && res.ok) c.put(key, res.clone());
          return res;
        } catch (err) {
          if (hit) return hit; // بدون إنترنت: نرجع النسخة المحفوظة القديمة
          throw err;
        }
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (STATIC_RE.test(url.pathname)) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // الصفحة الرئيسية: من الذاكرة فوراً (التحديث بالخلفية عبر refresh-shell). أول مرة بالجهاز (ما فيه نسخة) تنزل من الشبكة وتنحفظ.
  if (url.pathname === SCOPE_PATH || url.pathname === SCOPE_PATH + 'index.html') {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = (await c.match(req, { ignoreSearch: true, ignoreVary: true })) || (await c.match('./'));
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) { const copy = res.clone(); c.put('./', copy); }
      return res;
    })());
    return;
  }

  const net = fetch(req).then((res) => {
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  });
  e.waitUntil(net.catch(() => {})); // التحديث يكمل ويتحفظ بالخلفية حتى لو فتحنا من الذاكرة
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (!cached) {
      try { return await net; } catch (err) { return (await caches.match('./')) || Promise.reject(err); }
    }
    // عندنا نسخة محفوظة: الشبكة تسبق إذا وصلت سليمة خلال NET_WAIT_MS (آخر إصدار)، وإذا فشلت أو رجّعت خطأ (404/5xx) أو تأخرت نفتح المحفوظة
    const fresh = net.then((res) => (res && res.status >= 400 ? cached : res), () => cached);
    return Promise.race([fresh, new Promise((r) => setTimeout(() => r(cached), NET_WAIT_MS))]);
  })());
});
