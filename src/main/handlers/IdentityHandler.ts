import { app, ipcMain } from 'electron';
import fs from 'fs';
import { join } from 'path';

export function registerIdentityHandlers(store: any) {
  ipcMain.handle('get-identities', () => {
    let ids = store.get('identities') || [];
    if (ids?.length === 0) {
      const dir = join(app.getPath('userData'), 'wallets');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      ids = fs.readdirSync(dir).filter(f => f.endsWith('.keys')).map(f => ({ id: f.replace('.keys', ''), name: f.replace('.keys', ''), created: fs.statSync(join(dir, f)).birthtimeMs }));
    }
    if (ids?.length === 0) {
      const defaultId = [{ id: 'primary', name: 'DEFAULT_VAULT', created: Date.now() }];
      store.set('identities', defaultId);
      return defaultId;
    }
    return ids;
  });

  ipcMain.handle('save-identities', (_, ids) => {
    store.set('identities', ids);
    return true;
  });

  ipcMain.handle('get-active-identity', () => {
    return store.get('active_identity_id') || 'primary';
  });

  ipcMain.handle('set-active-identity', (_, id) => {
    if (!id) {
      store.delete('active_identity_id');
      return true;
    }
    store.set('active_identity_id', id);
    return true;
  });

  ipcMain.handle('rename-identity', (_, { id, name }) => {
    const ids = store.get('identities') || [];
    const updated = ids.map((i: any) => i.id === id ? { ...i, name } : i);
    store.set('identities', updated);
    return true;
  });
}
