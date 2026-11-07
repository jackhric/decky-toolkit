// The only place that reads Steam's globals. Each accessor checks the shape it relies on and returns undefined
// otherwise, so a Steam update that renames something turns a tweak off instead of breaking the page.
// Verified on Steam client 1792618285 (2026-11-07).

type MainWindow = {
  m_BrowserWindow?: { document?: Document };
  m_HeaderStore?: { m_nNumTabbedPagesActingAsHeaderBackground: number };
};

function mainWindow(): MainWindow | undefined {
  return (window as any).SteamUIStore?.WindowStore?.GamepadUIMainWindowInstance;
}

export function headerStore() {
  const store = mainWindow()?.m_HeaderStore;
  return typeof store?.m_nNumTabbedPagesActingAsHeaderBackground === "number" ? store : undefined;
}

export function mainDocument(): Document | undefined {
  return mainWindow()?.m_BrowserWindow?.document;
}

const classCache = new Map<string, boolean>();

/** Whether Steam's stylesheets in the main window define `.name`. */
export function hasGlobalClass(name: string): boolean {
  const cached = classCache.get(name);
  if (cached !== undefined) return cached;
  const doc = mainDocument();
  if (!doc) return false;
  const needle = `.${name}`;
  let found = false;
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      const sel = (rule as CSSStyleRule).selectorText;
      if (sel && sel.split(/[\s,>+~:]+/).some((part) => part === needle || part.startsWith(`${needle}.`))) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  classCache.set(name, found);
  return found;
}
