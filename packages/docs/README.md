# @revu/docs

The documentation site, built with [Fumadocs](https://fumadocs.dev) on
[Next.js](https://nextjs.org). It is a standalone Next deployable — it is not
served by revud and is not part of the app's Vite build.

## Isolation

This package is deliberately excluded from the repo-root workspace glob
(`"!packages/docs"` in the root `package.json` `workspaces`). It keeps its own
nested install and lockfile (`packages/docs/bun.lock`) so its React 19 / Next
dependencies never hoist into the root install and can never resolve into the
React 18 app build. It is also outside the root `tsc -b` project references,
outside the `bun test` set (it ships no test files), and listed in the root
oxlint `ignorePatterns`. None of the repo gate steps descend into it.

> The `bun test` exclusion holds only while this package ships no test files:
> the repo-root gate globs the whole tree for `*.test.*` / `*.spec.*` (skipping
> `node_modules`). Do **not** add unit tests under `packages/docs` source — they
> would silently enter the required root gate and run under bun's runner instead
> of Next. Keep any docs-app tests out of the root gate.

## Develop

From the repo root:

```sh
bun run docs:dev     # installs (nested) and starts Next dev on http://localhost:3000
bun run docs:build   # installs (nested) and produces a production build
```

Or from this directory directly:

```sh
bun install
bun run dev
bun run build
```

## Content

Pages live in `content/docs` as MDX. The two pages shipped here are placeholder
starters; real content is authored separately.

## Deploy

This is its own Next.js app. On Vercel, set the project root directory to
`packages/docs`; `vercel.json` pins the framework, install command
(`bun install`), and build command (`bun run build`). Any Next-compatible host
works — build with `bun run build` and serve with `bun run start`.
