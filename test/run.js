const { app, BrowserWindow } = require('electron');
const fs = require('fs');
app.setPath('userData', '/tmp/db-ud');
require('../main.js');
app.whenReady().then(() => setTimeout(async () => {
  const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('app.html'));
  for (const v of (process.env.VIEWS || 'today').split(',')) {
    await w.webContents.executeJavaScript(`ui.view='${v}';render(true);`);
    await new Promise((r) => setTimeout(r, 700));
    fs.writeFileSync(`/tmp/db-shot-${v}.png`, (await w.webContents.capturePage()).toPNG());
  }
  const c = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('capture.html'));
  if (c) fs.writeFileSync('/tmp/db-shot-capture.png', (await c.webContents.capturePage()).toPNG());
  app.exit(0);
}, 3500));
