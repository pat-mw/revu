import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import "./global.css";

// Product metadata mirroring the web app: the same wordmark, the same one-line
// pitch, and the app's own favicon (the violet-draft "r" mark). The title
// template stamps every page as "<page> — revu docs"; the bare docs home uses
// the default title.
export const metadata: Metadata = {
  title: {
    template: "%s — revu docs",
    default: "revu docs",
  },
  description:
    "Documentation for revu — a self-hosted, offline-first, keyboard-first pull-request review client you run yourself.",
  icons: {
    icon: "/favicon.svg",
  },
  openGraph: {
    type: "website",
    siteName: "revu docs",
    title: "revu docs",
    description:
      "Documentation for revu — a self-hosted, offline-first, keyboard-first pull-request review client you run yourself.",
  },
};

// Fonts are self-hosted product faces loaded via @fontsource imports in
// global.css and bound to Tailwind's font utilities, so no next/font (and no
// remote Google-CDN font) is used here. The default sans face is set on <body>.
export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen font-sans">
        <RootProvider
          // Both schemes ship and match the app in each. Dark is the default
          // (the product's heritage), the toggle flips to the app's real light
          // palette, and system preference is left out so a first-time visitor
          // lands on dark on purpose — the same policy the app itself uses.
          theme={{
            defaultTheme: "dark",
            enableSystem: false,
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
