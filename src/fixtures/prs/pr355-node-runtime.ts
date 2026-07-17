import type { CheckRun, CommitInfo, PullDetail, PullFile } from '@/api/types'
import type { RemotePull } from '../contract'
import { ORG_JFERRIS, REPO } from '../cast'
import { blob, fakeSha, hoursAgo, minutesAgo, nodeId, pullFile } from '../helpers'

/**
 * PR #355 — opened by a real org member (jferris-ml) from github.com, so the
 * PR user is his genuine account and the body carries no identity prefix.
 * Because the broker App did not author it, this is the one open PR that revu
 * users CAN approve (GitHub refuses self-review for App-authored PRs).
 * Not pre-synced: it exercises the first-sync path for an approvable PR.
 */

const MERGE_BASE_SHA = fakeSha('pr355/merge-base')
const HEAD_SHA = fakeSha('pr355/c1')
const MAIN_TIP_SHA = fakeSha('atlas/main/tip')

// ————— Dockerfile —————

const dockerfileBaseContent = `FROM node:20.11-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:20.11-alpine AS runtime
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
EXPOSE 8080
CMD ["node", "dist/server.js"]`

const dockerfileHeadContent = `FROM node:22.12-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22.12-alpine AS runtime
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
EXPOSE 8080
CMD ["node", "dist/server.js"]`

const dockerfilePatch = `@@ -1,5 +1,5 @@
-FROM node:20.11-alpine AS base
-RUN corepack enable
+FROM node:22.12-alpine AS base
+RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
 WORKDIR /app

 FROM base AS deps
@@ -11,7 +11,7 @@ COPY tsconfig.json ./
 COPY src ./src
 RUN pnpm build

-FROM node:20.11-alpine AS runtime
+FROM node:22.12-alpine AS runtime
 WORKDIR /app
 COPY --from=build /app/dist ./dist
 COPY --from=deps /app/node_modules ./node_modules`

// ————— package.json —————

const packageJsonBaseContent = `{
  "name": "@meridian/atlas",
  "version": "0.41.2",
  "private": true,
  "engines": {
    "node": ">=20.11"
  },
  "scripts": {
    "build": "tsc -b && node scripts/bundle.mjs",
    "typecheck": "tsc -b --noEmit",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "dependencies": {
    "fastify": "^4.28.1",
    "pg": "^8.12.0",
    "pino": "^9.4.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "eslint": "^9.14.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}`

const packageJsonHeadContent = `{
  "name": "@meridian/atlas",
  "version": "0.41.2",
  "private": true,
  "packageManager": "pnpm@9.15.4",
  "engines": {
    "node": ">=22.12"
  },
  "scripts": {
    "build": "tsc -b && node scripts/bundle.mjs",
    "typecheck": "tsc -b --noEmit",
    "test": "vitest run",
    "lint": "eslint ."
  },
  "dependencies": {
    "fastify": "^4.28.1",
    "pg": "^8.12.0",
    "pino": "^9.4.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "eslint": "^9.14.0",
    "typescript": "^5.6.3",
    "vitest": "^2.1.8"
  }
}`

const packageJsonPatch = `@@ -2,6 +2,7 @@
   "name": "@meridian/atlas",
   "version": "0.41.2",
   "private": true,
+  "packageManager": "pnpm@9.15.4",
   "engines": {
-    "node": ">=20.11"
+    "node": ">=22.12"
   },`

// ————— .github/workflows/ci.yml —————

const ciYmlBaseContent = `name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  checks:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: corepack enable
      - uses: actions/setup-node@v4
        with:
          node-version: "20.11"
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm lint`

const ciYmlHeadContent = `name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  checks:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - run: corepack enable && corepack prepare pnpm@9.15.4 --activate
      - uses: actions/setup-node@v4
        with:
          node-version: "22.12"
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm lint`

const ciYmlPatch = `@@ -10,10 +10,10 @@ jobs:
     runs-on: ubuntu-24.04
     steps:
       - uses: actions/checkout@v4
-      - run: corepack enable
+      - run: corepack enable && corepack prepare pnpm@9.15.4 --activate
       - uses: actions/setup-node@v4
         with:
-          node-version: "20.11"
+          node-version: "22.12"
           cache: pnpm
       - run: pnpm install --frozen-lockfile
       - run: pnpm typecheck`

// ————— blobs, files, commits, checks —————

const dockerfileBase = blob('Dockerfile', dockerfileBaseContent, 'pr355:base:Dockerfile')
const dockerfileHead = blob('Dockerfile', dockerfileHeadContent, 'pr355:head:Dockerfile')
const packageJsonBase = blob('package.json', packageJsonBaseContent, 'pr355:base:package.json')
const packageJsonHead = blob('package.json', packageJsonHeadContent, 'pr355:head:package.json')
const ciYmlBase = blob('.github/workflows/ci.yml', ciYmlBaseContent, 'pr355:base:ci.yml')
const ciYmlHead = blob('.github/workflows/ci.yml', ciYmlHeadContent, 'pr355:head:ci.yml')

const files: PullFile[] = [
  pullFile({
    sha: ciYmlHead.sha,
    filename: '.github/workflows/ci.yml',
    status: 'modified',
    patch: ciYmlPatch,
  }),
  pullFile({
    sha: dockerfileHead.sha,
    filename: 'Dockerfile',
    status: 'modified',
    patch: dockerfilePatch,
  }),
  pullFile({
    sha: packageJsonHead.sha,
    filename: 'package.json',
    status: 'modified',
    patch: packageJsonPatch,
  }),
]

const additions = files.reduce((n, f) => n + f.additions, 0)
const deletions = files.reduce((n, f) => n + f.deletions, 0)

const commits: CommitInfo[] = [
  {
    sha: HEAD_SHA,
    commit: {
      message:
        'chore: bump Node to 22.12, pin pnpm 9.15.4 via corepack\n\nNode 20 leaves our support window at the end of the quarter; 22.12 is\nthe active LTS. Pinning pnpm through corepack stops local/CI/prod drift.',
      author: {
        name: 'Jordan Ferris',
        email: 'jferris@meridianlabs.io',
        date: hoursAgo(28),
      },
    },
    author: ORG_JFERRIS,
    parents: [{ sha: MERGE_BASE_SHA }],
  },
]

const checks: CheckRun[] = [
  {
    id: 88355001,
    name: 'ci/typecheck',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(1_665),
    completed_at: minutesAgo(1_662),
    details_url: 'https://ci.meridianlabs.io/atlas/runs/88355001',
    output: { title: 'tsc --noEmit', summary: '0 errors across 412 files', text: null },
  },
  {
    id: 88355002,
    name: 'ci/tests',
    status: 'completed',
    conclusion: 'success',
    started_at: minutesAgo(1_665),
    completed_at: minutesAgo(1_658),
    details_url: 'https://ci.meridianlabs.io/atlas/runs/88355002',
    output: { title: 'vitest', summary: '321 passed, 0 failed, 0 skipped', text: null },
  },
]

const detail: PullDetail = {
  id: 2841355,
  node_id: nodeId('PR', 355),
  number: 355,
  state: 'open',
  draft: false,
  merged_at: null,
  title: 'chore: bump Node to 22.12, pin pnpm via corepack',
  body: [
    'Node 20 leaves our support window at the end of the quarter and 22.12 is the active LTS. Corepack now pins pnpm to 9.15.4 in the image and in CI, so local/CI/prod stop drifting.',
    '',
    '- **Dockerfile** — both stages on `node:22.12-alpine`, pnpm pinned via corepack',
    '- **package.json** — engines bump + `packageManager` field',
    '- **CI** — setup-node on 22.12, same corepack pin',
    '',
    'No runtime code changes. Canaried on staging for a day; smoke suite clean.',
  ].join('\n'),
  user: ORG_JFERRIS,
  labels: [
    { id: 9005, name: 'infra', color: 'fbca04', description: 'Build, CI, and runtime plumbing' },
  ],
  requested_reviewers: [],
  head: {
    ref: 'chore/node-22',
    sha: HEAD_SHA,
    label: 'meridian-labs:chore/node-22',
    repo: { full_name: REPO.full_name, default_branch: REPO.default_branch },
  },
  base: {
    ref: 'main',
    sha: MAIN_TIP_SHA,
    label: 'meridian-labs:main',
    repo: { full_name: REPO.full_name, default_branch: REPO.default_branch },
  },
  created_at: hoursAgo(28),
  updated_at: hoursAgo(27),
  merged: false,
  mergeable: true,
  mergeable_state: 'clean',
  merge_base_sha: MERGE_BASE_SHA,
  comments: 0,
  review_comments: 0,
  commits: commits.length,
  additions,
  deletions,
  changed_files: files.length,
}

export const pr355: RemotePull = {
  detail,
  files,
  blobs: [dockerfileBase, dockerfileHead, packageJsonBase, packageJsonHead, ciYmlBase, ciYmlHead],
  blobIndex: {
    Dockerfile: { base: dockerfileBase.sha, head: dockerfileHead.sha },
    'package.json': { base: packageJsonBase.sha, head: packageJsonHead.sha },
    '.github/workflows/ci.yml': { base: ciYmlBase.sha, head: ciYmlHead.sha },
  },
  threads: [],
  issueComments: [],
  reviews: [],
  checks,
  commits,
  broker: {
    authorHumanId: null,
    canApprove: true,
    unresolvedThreads: 0,
    assignedReviewerHumanIds: ['h-priya', 'h-marcus'],
    compareKey: `${MERGE_BASE_SHA}...${HEAD_SHA}`,
    commitCount: commits.length,
  },
}
