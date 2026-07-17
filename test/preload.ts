/**
 * Test preload for `bun test`. Installs the browser globals the mock API
 * layer reads (localStorage, window, document) into the headless test
 * runtime, so the in-browser mock adapter and its localStorage-backed store
 * run unchanged without a DOM. Registered via bunfig.toml `[test] preload`,
 * this executes once before any test module is imported.
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

if (!('document' in globalThis)) {
  ;(globalThis as Record<string, unknown>).document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
  }
}
