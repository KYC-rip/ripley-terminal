import { app, ipcMain } from 'electron';
import { join } from 'path';
import fs from 'fs';

export function registerFileHandlers() {
  ipcMain.handle('read-wallet-file', async (_, filename) => {
    try {
      const dir = join(app.getPath('userData'), 'wallets');
      if (!fs.existsSync(dir)) return null;

      const keysPath = join(dir, filename + ".keys");
      const cachePath = join(dir, filename + ".cache");
      
      const [keys, cache] = await Promise.all([
        fs.promises.readFile(keysPath).catch(() => null),
        fs.promises.readFile(cachePath).catch(() => null)
      ]);

      return [keys, cache];
    } catch (e) {
      return null;
    }
  });

  ipcMain.handle('write-wallet-file', async (_, { filename, data }) => {
    try {
      const dir = join(app.getPath('userData'), 'wallets');
      if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });

      if (!data) return false;

      const keysPath = join(dir, filename + ".keys");
      const cachePath = join(dir, filename + ".cache");

      if (data.length === 0) {
        await Promise.all([
          fs.promises.unlink(keysPath).catch(() => {}),
          fs.promises.unlink(cachePath).catch(() => {})
        ]);
      } else {
        // 'data' is an array of Buffers/Uint8Arrays from IPC
        if (data[0]) await fs.promises.writeFile(keysPath, Buffer.from(data[0]));
        if (data[1]) await fs.promises.writeFile(cachePath, Buffer.from(data[1]));
      }

      return true;
    } catch (e) {
      console.error(`[FileHandler] Write failed for ${filename}:`, e);
      return false;
    }
  });

  ipcMain.handle('get-wallet-path', () => join(app.getPath('userData'), 'wallets'));
}
