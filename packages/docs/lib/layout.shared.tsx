import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName } from "./shared";

// Options shared by the home and docs layouts (nav title, etc.). The wordmark
// mirrors the app's header exactly: "revu" in the display face (Archivo, the
// app's hero weight/color) immediately followed by the violet draft-dot — the
// 5px `#a48fff` dot that stands for pending, GitHub-invisible work — then a
// lighter-weight "docs" in the muted-ink token so the site reads as the same
// product. The dot stays violet in both schemes; the text rides the fd
// foreground/muted tokens so it flips with the theme.
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span
          className="inline-flex items-center gap-1 font-display tracking-tight"
          aria-label={appName}
        >
          <span className="font-semibold text-fd-foreground">revu</span>
          <span
            className="size-[5px] shrink-0 rounded-full"
            style={{ backgroundColor: "#a48fff" }}
            aria-hidden
          />
          <span className="font-normal text-fd-muted-foreground">docs</span>
        </span>
      ),
    },
  };
}
