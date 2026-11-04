// Service worker mínimo: permite instalar o AgroSat e recebê-lo no menu "Compartilhar" do Android.
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
self.addEventListener('fetch', () => {});
