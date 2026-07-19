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
};

export default withMDX(config);
