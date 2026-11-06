# Decky Toolkit VS Code extension — rules for agents

## ALWAYS use VS Code's native types and UI
This is a hard rule from the project owner. Keep everything native to VS Code / VSCodium:

- Build UI from the extension API first: tree views, `viewsWelcome`, context keys and `when` clauses,
  `TreeView.message` / `description`, `ThemeIcon` codicons, QuickPicks, input boxes, notifications,
  `window.withProgress`, status bar items, output channels, editor title (`editor/title`) and view title
  actions, `WebviewPanel.title`.
- Icons are codicons (`$(name)` / `ThemeIcon`). No emoji, no custom icon sets, no hand-drawn toolbars.
- Controls for a panel go in its editor title bar or a QuickPick, not inside the page. Toggles are command
  pairs switched by context keys (e.g. `decky-toolkit.screen.*`).
- A webview is the last resort, for things the API cannot draw (the live screen picture, the sidebar
  preview). Inside one, use only `--vscode-*` theme tokens and match VS Code's own widgets
  (`--vscode-button-*`, `--vscode-editorWidget-*`, `--vscode-focusBorder`, `@vscode/codicons` if icons are
  needed). Never introduce a separate visual style.
- Nothing is reachable outside the extension: the device serves no browser UI.

## Practicalities
- Use the pnpm pinned by the root `package.json`'s `packageManager`: `corepack pnpm run …` or `npx --yes pnpm@12.18.0 run …`
  (typecheck, build, smoke, package). The repo is one pnpm workspace; a globally installed older pnpm does not read its
  `pnpm-workspace.yaml`.
- Every `when` clause key must be listed in the smoke test's `allowedKeys`; new UI states get smoke checks.
