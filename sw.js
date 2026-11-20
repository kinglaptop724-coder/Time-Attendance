/* Service Worker แบบเรียบง่าย: ใช้ให้เบราว์เซอร์ติดตั้งเป็นแอปได้ (ไม่แคชข้อมูลลงเวลา) */
var CACHE = 'teacher-shell-v1';
var SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).catch(function () {}));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// เฉพาะการเปิดหน้า: ใช้เครือข่ายก่อน ถ้าออฟไลน์ใช้ไฟล์เปลือกที่เก็บไว้ (คำขอไป Apps Script ไม่ถูกแตะ)
self.addEventListener('fetch', function (e) {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(function () { return caches.match('index.html'); }));
});
