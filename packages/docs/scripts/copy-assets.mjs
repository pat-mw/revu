// Copies the repository's canonical image assets into the Next site's public
// directory so MDX can reference them under site-absolute `/assets/...` paths.
//
// The canonical images live at the repo's `docs/assets/` (the same files the
// root README embeds). They are the single source of truth; this step mirrors
// them into `public/assets/` at dev/build time rather than committing a second
// copy. `public/assets` is gitignored for exactly that reason.
//
// Paths are resolved relative to this file's own location, so the copy works
// identically from a local checkout and from a full-repo CI/Vercel build where
// the working directory may differ.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// scripts/ -> packages/docs -> packages -> repo root, then into docs/assets.
const source = resolve(here, "..", "..", "..", "docs", "assets");
const dest = resolve(here, "..", "public", "assets");

if (!existsSync(source)) {
  console.error(`[copy-assets] source not found: ${source}`);
  process.exit(1);
}

// Start clean so removed source files never linger in the mirror.
rmSync(dest, { recursive: true, force: true });
cpSync(source, dest, { recursive: true });
console.log(`[copy-assets] ${source} -> ${dest}`);
