import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';

export const PLUGIN_REPO = 'https://github.com/jackhric/decky-toolkit';
export const PAIRING_WALKTHROUGH = 'jackhric.decky-toolkit#pairing';

// The codicon `add` glyph; the view needs one icon, so it is inlined rather than shipping the font.
const ADD_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>';

/**
 * Takes the Devices slot while nothing is listed (`!decky-toolkit.hasDevices`): the flat Decky Toolkit mark,
 * Add a device, what the device needs and a link to the pairing walkthrough. viewsWelcome cannot show an
 * image or center content, hence a webview drawn only with VS Code's theme tokens.
 */
export class WelcomeViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'decky-toolkit.welcome';

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.html();
    const sub = view.webview.onDidReceiveMessage(m => {
      if (m?.type === 'add') void vscode.commands.executeCommand('decky-toolkit.addDevice');
      if (m?.type === 'plugin') void vscode.env.openExternal(vscode.Uri.parse(PLUGIN_REPO));
      if (m?.type === 'pairing') void vscode.commands.executeCommand('workbench.action.openWalkthrough', PAIRING_WALKTHROUGH, false);
    });
    view.onDidDispose(() => sub.dispose());
  }

  private html(): string {
    const nonce = randomBytes(16).toString('base64');
    const mark = readFileSync(vscode.Uri.joinPath(this.extensionUri, 'media', 'mark-flat.svg').fsPath, 'utf8')
      .replace(/<svg /, '<svg class="mark" aria-hidden="true" ').replace(/ width="\d+" height="\d+"/, '');
    const csp = ["default-src 'none'", `style-src 'nonce-${nonce}'`, `script-src 'nonce-${nonce}'`].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
html, body { height: 100%; margin: 0; }
body {
  display: flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 0 20px 24px;
  color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
}
main { width: 100%; max-width: 220px; display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; }
.mark { width: 92px; height: auto; color: var(--vscode-foreground); opacity: .8; }
button {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px; box-sizing: border-box;
  padding: 4px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer;
  font: inherit; line-height: 18px;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
}
button:hover { background: var(--vscode-button-hoverBackground); }
button:focus-visible, a:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
p { margin: -4px 0 0; color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; text-wrap: balance; }
a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
.secondary { font-size: 12px; }
</style>
<title>Add a device</title>
</head>
<body>
<main>
  ${mark}
  <button id="add" type="button">${ADD_ICON}Add a device</button>
  <p>The device needs Decky Loader and the <a id="plugin" href="${PLUGIN_REPO}" title="${PLUGIN_REPO}">Decky Toolkit plugin</a> installed.</p>
  <a id="pairing" class="secondary" href="#" role="button">How pairing works</a>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const send = type => e => { e.preventDefault(); vscode.postMessage({ type }); };
  document.getElementById('add').addEventListener('click', send('add'));
  document.getElementById('plugin').addEventListener('click', send('plugin'));
  document.getElementById('pairing').addEventListener('click', send('pairing'));
</script>
</body>
</html>`;
  }
}
