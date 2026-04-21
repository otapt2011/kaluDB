/**
 * JaferSQL Cache Helper v1.0.0
 * Provides HTTP, Service Worker, and IndexedDB caching for sql.js assets.
 * MIT License – Copyright (c) 2026 Jafer
 */
(function(global) {
  'use strict';
  
  const DEFAULT_JS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js';
  const DEFAULT_WASM_URL = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.wasm';
  
  const CACHE_NAME = 'jafersql-cache-v1';
  const IDB_NAME = 'JaferSQLCache';
  const STORE_NAME = 'assets';
  
  // ---------- Utilities ----------
  function log(...args) {
    console.log('[JaferSQL Cache]', ...args);
  }
  
  // ---------- HTTP Cache (browser built-in) ----------
  async function preloadHTTP(jsUrl = DEFAULT_JS_URL, wasmUrl = DEFAULT_WASM_URL) {
    log('Preloading via HTTP (browser cache)');
    await fetch(jsUrl, { cache: 'force-cache' });
    await fetch(wasmUrl, { cache: 'force-cache' });
    return { jsUrl, wasmUrl };
  }
  
  // ---------- Service Worker Cache API ----------
  async function registerServiceWorker(jsUrl = DEFAULT_JS_URL, wasmUrl = DEFAULT_WASM_URL) {
    if (!navigator.serviceWorker) {
      throw new Error('Service Worker not supported');
    }
    
    // Unregister existing
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing) await existing.unregister();
    
    const swCode = `
      const CACHE_NAME = '${CACHE_NAME}';
      const URLS = ['${jsUrl}', '${wasmUrl}'];

      self.addEventListener('install', (e) => {
        e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(URLS)));
      });

      self.addEventListener('fetch', (e) => {
        if (e.request.url.includes('sql-wasm')) {
          e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
        }
      });
    `;
    
    const blob = new Blob([swCode], { type: 'application/javascript' });
    const swUrl = URL.createObjectURL(blob);
    const reg = await navigator.serviceWorker.register(swUrl);
    await navigator.serviceWorker.ready;
    
    // Trigger caching
    await fetch(jsUrl, { cache: 'reload' });
    await fetch(wasmUrl, { cache: 'reload' });
    
    log('Service Worker registered and assets cached');
    return reg;
  }
  
  async function unregisterServiceWorker() {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.unregister();
    log('Service Worker unregistered');
  }
  
  // ---------- IndexedDB ----------
  function openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
    });
  }
  
  async function storeInIDB(key, url) {
    const res = await fetch(url);
    const blob = await res.blob();
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(blob, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }
  
  async function loadFromIDB(key) {
    const db = await openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    });
  }
  
  async function cacheWithIDB(jsUrl = DEFAULT_JS_URL, wasmUrl = DEFAULT_WASM_URL) {
    log('Storing assets in IndexedDB');
    await storeInIDB('sql-wasm.js', jsUrl);
    await storeInIDB('sql-wasm.wasm', wasmUrl);
    log('Assets stored in IndexedDB');
  }
  
  async function getIDBBlobUrls() {
    log('Loading assets from IndexedDB');
    const jsBlob = await loadFromIDB('sql-wasm.js');
    const wasmBlob = await loadFromIDB('sql-wasm.wasm');
    if (!jsBlob || !wasmBlob) {
      throw new Error('Assets not found in IndexedDB. Cache them first.');
    }
    return {
      jsUrl: URL.createObjectURL(jsBlob),
      wasmUrl: URL.createObjectURL(wasmBlob)
    };
  }
  
  // ---------- Public API ----------
  const JaferSQLCache = {
    // HTTP (browser) cache – just prefetch
    preloadHTTP,
    
    // Service Worker
    registerSW: registerServiceWorker,
    unregisterSW: unregisterServiceWorker,
    
    // IndexedDB
    storeInIDB: cacheWithIDB,
    getIDBBlobUrls,
    
    // Helper to get cached config (tries all strategies in order)
    async getCachedConfig(preferred = 'auto') {
      // 1. Try IDB first if available
      try {
        const { jsUrl, wasmUrl } = await getIDBBlobUrls();
        log('Using IndexedDB cached assets');
        return { jsUrl, wasmUrl };
      } catch (e) {
        log('IDB cache not available:', e.message);
      }
      
      // 2. Fallback: assume HTTP cache will work (use original URLs)
      log('Falling back to CDN (HTTP cache may apply)');
      return { jsUrl: DEFAULT_JS_URL, wasmUrl: DEFAULT_WASM_URL };
    },
    
    // Clear all caches
    async clearAll() {
      // IDB
      try {
        const db = await openIDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        await tx.done;
        db.close();
        log('IndexedDB cleared');
      } catch (e) {}
      
      // SW cache
      if (navigator.serviceWorker) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.unregister();
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
        log('Service Worker cache cleared');
      }
    }
  };
  
  // Expose
  global.JaferSQLCache = JaferSQLCache;
  
})(typeof window !== 'undefined' ? window : global);