// sw.js - Service Worker Básico
self.addEventListener('install', (event) => {
    console.log('Service Worker instalado');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('Service Worker activado');
});

// Esto permite que la app funcione un poco mejor offline o con red inestable
self.addEventListener('fetch', (event) => {
    // Firebase long-polling and stream connections throw expected fetch errors when aborted.
    // We catch them here so they don't spam the standard console.
    event.respondWith(
        fetch(event.request).catch(err => {
            // Silenciar error en consola si es un fallo de red esperado
            return new Response("Network error occurred", { status: 408, headers: { "Content-Type": "text/plain" } });
        })
    );
});