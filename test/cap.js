const { app, BrowserWindow } = require('electron');
const fs = require('fs');
app.setPath('userData', '/tmp/db-ud');
require('../main.js');
app.whenReady().then(() => setTimeout(async () => {
  const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('app.html'));
  await w.webContents.executeJavaScript(`ui.view='today';render(true);`);
  await new Promise((r) => setTimeout(r, 600));
  fs.writeFileSync('/tmp/db-shot-today.png', (await w.webContents.capturePage()).toPNG());
  const c = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('capture.html'));
  c.setSize(640, 360);
  await c.webContents.executeJavaScript(`input.value='дим';input.dispatchEvent(new Event('input'));sel=0;search();`);
  await new Promise((r) => setTimeout(r, 500));
  fs.writeFileSync('/tmp/db-shot-capture.png', (await c.webContents.capturePage()).toPNG());
  app.exit(0);
}, 4000));
