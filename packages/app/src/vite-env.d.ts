/// <reference types="vite/client" />

/**
 * App-specific environment variables layered onto Vite's `import.meta.env`.
 * `VITE_REVU_API` is the daemon base URL: when set, the app talks to `revud`
 * over HTTP; when unset, it runs the pure in-browser mock. `?mock=1` forces the
 * mock regardless.
 */
interface ImportMetaEnv {
  readonly VITE_REVU_API?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
