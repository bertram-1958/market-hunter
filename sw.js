// Service worker: ให้แอปเปิดเร็วและเปิดได้แม้สัญญาณอ่อน
// - ไฟล์ของแอป (หน้าเว็บ, css, js, ไอคอน): ลองโหลดใหม่จากเน็ตก่อน ถ้าช้าเกิน 3 วินาทีหรือไม่มีเน็ต ใช้ที่เก็บไว้
// - การส่งข้อมูลและ Top 10 (Google Apps Script): ไม่ผ่าน service worker เลย
const CACHE = "market-hunter-v9";
const ASSETS = [
  "./", "./index.html", "./style.css", "./app.js", "./config.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png", "./icons/favicon-64.png", "./assets/market-hunter-logo.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch { /* offline */ }
    const cached = await cache.match(req, { ignoreSearch: true });
    return cached || network;
  })());
});
