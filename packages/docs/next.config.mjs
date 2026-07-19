import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // This package keeps its own nested install (its React 19 / Next deps are
  // deliberately not hoisted into the repo-root workspace). Pin the workspace
  // root here so Next does not walk up to the repo-root lockfile and warn about
  // multiple lockfiles.
  turbopack: {
    root: import.meta.dirname,
  },
  // The site is documentation-only; the root is a doorway, not a landing page,
  // so it forwards straight to the docs tree. Temporary (307/308) rather than
  // permanent so the mapping is not cached by browsers if the site later grows
  // a real home.
  async redirects() {
    return [
      {
        source: "/",
        destination: "/docs",
        permanent: false,
      },
    ];
  },
};

export default withMDX(config);
