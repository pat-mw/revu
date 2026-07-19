import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName } from "./shared";

// Options shared by the home and docs layouts (nav title, etc.). The wordmark
// takes the product's display face (Archivo) to match the app's header.
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <span className="font-display font-semibold">{appName}</span>,
    },
  };
}
