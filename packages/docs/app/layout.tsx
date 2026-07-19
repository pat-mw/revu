import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";

// Fonts are self-hosted product faces loaded via @fontsource imports in
// global.css and bound to Tailwind's font utilities, so no next/font (and no
// remote Google-CDN font) is used here. The default sans face is set on <body>.
export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen font-sans">
        <RootProvider
          // The app is dark-only; lock the docs to dark and drop the toggle so
          // the palette always matches the product.
          theme={{
            defaultTheme: "dark",
            forcedTheme: "dark",
            enableSystem: false,
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
