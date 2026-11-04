import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { Connection, externalProxyBase } from './connection';

export class PreviewViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'decky-mcp.preview';

  private view?: vscode.WebviewView;
  private description?: string;

  constructor(private readonly extensionUri: vscode.Uri, private readonly conn: Connection) {}

  setDescription(description: string | undefined): void {
    this.description = description;
    if (this.view) this.view.description = description;
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.description = this.description;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const { external } = await externalProxyBase(this.conn);
    view.webview.html = this.html(view.webview, media, external);
    const subs = [
      view.onDidChangeVisibility(() => void view.webview.postMessage({ type: 'visible', visible: view.visible })),
      this.conn.onDidChangeTarget(() => void view.webview.postMessage({ type: 'state', paired: this.conn.paired })),
      view.webview.onDidReceiveMessage(m => {
        if (m?.type === 'open') void vscode.commands.executeCommand('decky-mcp.openScreen');
      }),
    ];
    view.onDidDispose(() => {
      subs.forEach(s => s.dispose());
      if (this.view === view) this.view = undefined;
    });
  }

  private html(webview: vscode.Webview, media: vscode.Uri, external: string): string {
    const origin = new URL(external).origin;
    const nonce = randomBytes(16).toString('base64');
    const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    const csp = [
      "default-src 'none'",
      `img-src ${origin} blob:`,
      `connect-src ${origin}`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('preview.css')}">
<title>Deck preview</title>
</head>
<body data-base="${attr(external)}" data-paired="${this.conn.paired}">
<div class="frame"><img id="img" alt="Deck display"><div id="msg">Loading…</div></div>
<button id="open">Open full screen view</button>
<script nonce="${nonce}" src="${uri('preview.js')}"></script>
</body>
</html>`;
  }
}
