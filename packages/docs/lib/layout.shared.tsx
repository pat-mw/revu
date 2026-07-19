import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName } from "./shared";

// Options shared by the home and docs layouts (nav title, etc.).
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
    },
  };
}
