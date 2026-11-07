import { DialogControlsSection, DialogControlsSectionHeader, SidebarNavigation } from "@decky/ui";
import { ComponentProps, ReactNode } from "react";
import { headerStore, hasGlobalClass } from "./internals";
import { useTweak } from "./react";

/**
 * Makes the top bar transparent like Steam's own settings: Steam counts pages "acting as the header background" and
 * drops the bar's dark backdrop while any is shown. Without the store the bar stays dark.
 */
export function useTransparentHeader() {
  useTweak("transparent-header", () => {
    const store = headerStore();
    if (!store) return;
    store.m_nNumTabbedPagesActingAsHeaderBackground++;
    return () => {
      store.m_nNumTabbedPagesActingAsHeaderBackground = Math.max(0, store.m_nNumTabbedPagesActingAsHeaderBackground - 1);
    };
  });
}

/** A group of rows with a heading styled like Steam's settings ("Updates"); DFL's own header if Steam lacks the classes. */
export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  if (!hasGlobalClass("SettingsDialogSubHeader")) {
    return (
      <DialogControlsSection>
        <DialogControlsSectionHeader>{title}</DialogControlsSectionHeader>
        {children}
      </DialogControlsSection>
    );
  }
  return (
    <DialogControlsSection className="DialogLabelledControlsSection DialogSettingsSection">
      <div role="heading" aria-level={3} className="SettingsDialogSubHeader">
        {title}
      </div>
      {children}
    </DialogControlsSection>
  );
}

type Pages = ComponentProps<typeof SidebarNavigation>["pages"];
type Page = Exclude<Pages[number], "separator">;

/** Sidebar pages in groups with a line between them. Steam drops a separator unless a later page is `visible`. */
export function settingsPages(...groups: Page[][]): Pages {
  return groups.flatMap((group, i) => [...(i ? (["separator"] as const) : []), ...group.map((p) => ({ visible: true, ...p }))]);
}
