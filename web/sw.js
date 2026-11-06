/* Service worker app Kho Shopee — cài app + nhận thông báo đẩy.
   Không cache dữ liệu (luôn lấy mới từ mạng); chỉ giữ bản trang gần nhất để mở được khi rớt mạng. */
const VERSION = 'kho-sw-v2'; // v2 (02/11/2026): xoá bộ nhớ cũ có thể đã lưu nhầm trang /test vào chỗ trang chính
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/badge-96.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Trang (navigation): ưu tiên mạng, rớt mạng thì dùng bản đã lưu
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase, CDN… để trình duyệt tự xử lý
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        // Chỉ lưu TRANG CHÍNH. Trước đây lưu mọi trang (kể cả /test) vào chỗ '/' → mất mạng mở app chính lại ra trang test.
        if (res.ok && (url.pathname === '/' || url.pathname === '/index.html')) {
          const c = await caches.open(VERSION);
          c.put('/', res.clone());
        }
        return res;
      } catch (_) {
        return (await caches.match('/')) || Response.error();
      }
    })());
    return;
  }
  if (url.pathname.startsWith('/icons/')) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req)));
  }
});

// ===== Thông báo đẩy =====
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Kho Shopee', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Kho Shopee';
  const opts = {
    body: d.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/', loai: d.loai || '' },
    vibrate: [120, 60, 120],
  };
  e.waitUntil((async () => {
    await self.registration.showNotification(title, opts);
    // báo cho app đang mở để tự tải lại số liệu
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    list.forEach((c) => c.postMessage({ type: 'kho-push', loai: d.loai || '' }));
    // số trên icon app (Android/iOS hỗ trợ)
    try { if (self.navigator && self.navigator.setAppBadge) await self.navigator.setAppBadge(); } catch (_) {}
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        c.postMessage({ type: 'kho-open', url: target });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

// Trình duyệt tự đổi khoá đăng ký -> báo app đăng ký lại lần mở sau
self.addEventListener('pushsubscriptionchange', () => {});
