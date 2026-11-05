export type Editor = 'vscode' | 'vscodium';

export const editors: Record<Editor, { name: string; site: string; store: string; storeName: string }> = {
  vscode: {
    name: 'VS Code',
    site: 'https://code.visualstudio.com/',
    store: 'https://marketplace.visualstudio.com/items?itemName=jackhric.decky-toolkit',
    storeName: 'VS Code Marketplace',
  },
  vscodium: {
    name: 'VSCodium',
    site: 'https://vscodium.com/',
    store: 'https://open-vsx.org/extension/jackhric/decky-toolkit',
    storeName: 'Open VSX',
  },
};
