const { app, BrowserWindow } = require('electron');
const fs = require('fs');
app.setPath('userData', '/tmp/zk');
process.env.ZK_SHOW_CAPTURE = '1';
require('../main.js');
app.whenReady().then(() => setTimeout(() => app.emit('second-instance'), 500));
app.whenReady().then(() => {
  setTimeout(async () => {
    require('electron').ipcMain.emit; 
    const wins = BrowserWindow.getAllWindows();
    // open main window via tray-less path
    const { Menu } = require('electron');
    for (const w of wins) {
      const img = await w.webContents.capturePage();
      fs.writeFileSync(`/tmp/zk/shot-${w.webContents.getURL().split('/').pop()}.png`, img.toPNG());
    }
    app.exit(0);
  }, 3000);
});
