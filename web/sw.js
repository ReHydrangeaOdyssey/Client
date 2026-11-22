const PREFIX = "reorsg-static-";
let activeName = null;
async function activeCache() {
  if (activeName) return activeName;
  const control = await caches.open("reorsg-active");
  const response = await control.match(new URL("./active", self.location).href);
  if (response) activeName = await response.text();
  return activeName;
}
self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("message", event => {
  if (event.data?.type !== "activate" || !/^[a-f0-9]{64}$/.test(event.data.version)) return;
  event.waitUntil((async () => {
    const name = PREFIX + event.data.version;
    const cache = await caches.open(name);
    const marker = await cache.match(new URL("./distribution.json", self.location).href);
    if (!marker) { event.ports[0]?.postMessage({ok: false}); return; }
    const control = await caches.open("reorsg-active");
    await control.put(new URL("./active", self.location).href, new Response(name));
    activeName = name;
    event.ports[0]?.postMessage({ok: true});
  })());
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    if (event.request.headers.get("X-ReORSG-Redownload") === "1") return fetch(event.request);
    const name = await activeCache();
    if (name) {
      const cache = await caches.open(name);
      const url = new URL(event.request.url);
      if (url.pathname.endsWith("/")) url.pathname += "index.html";
      const saved = await cache.match(url.href);
      if (saved) return saved;
    }
    return fetch(event.request);
  })());
});
