import { ipcMain } from 'electron';

export function registerIdentityHandlers(store: any) {
  ipcMain.handle('get-identities', () => {
    const ids = store.get('identities');
    if (!ids) {
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
    store.set('active_identity_id', id);
    return true;
  });
}
