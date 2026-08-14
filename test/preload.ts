/**
 * Test preload for `bun test`. Installs the browser globals the app reads
 * (localStorage, window, document, location) into the headless test runtime,
 * so the in-browser mock adapter, its localStorage-backed store, and the
 * modules that decide transport at import time all run unchanged without a
 * DOM. Registered via bunfig.toml `[test] preload`, this executes once before
 * any test module is imported.
 *
 * Each shim is guarded so it never clobbers a real global if one is present,
 * and localStorage is backed by a single in-memory Map for the process — the
 * same isolation model the mock uses in a browser tab.
 */

const storage = new Map<string, string>()

if (!('localStorage' in globalThis)) {
  ;(globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => void storage.clear(),
    key: (i: number) => [...storage.keys()][i] ?? null,
    get length() {
      return storage.size
    },
  }
}

if (!('window' in globalThis)) {
  ;(globalThis as Record<string, unknown>).window = globalThis
}

// `window` above is `globalThis` itself, and the headless runtime carries no
// `location` on it — so `window.location` would be `undefined` and every read
// of it a TypeError. That matters at IMPORT time, not call time: the app picks
// its transport in module scope by inspecting the query string, so without
// this shim every module that reaches the api layer (the query layer, every
// page) throws while it is still being evaluated and cannot be imported by a
// test at all. The query string is EMPTY on purpose: it is what a browser tab
// opened with no `?mock=1` carries, so transport selection here lands exactly
// where it lands in the app.
if (!('location' in globalThis)) {
  ;(globalThis as Record<string, unknown>).location = {
    href: 'http://localhost/',
    origin: 'http://localhost',
    pathname: '/',
    search: '',
  }
}

if (!('document' in globalThis)) {
  ;(globalThis as Record<string, unknown>).document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
  }
}
