import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";

// Declares the `docs` content collection sourced from `content/docs`.
// `fumadocs-mdx` reads this to generate the typed `.source` index that
// `lib/source.ts` consumes. Customize the frontmatter and `meta.json` Zod
// schemas here.
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema,
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig();
