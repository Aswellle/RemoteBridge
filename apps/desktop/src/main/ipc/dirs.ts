import { ipcMain, BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import { WSMessageType } from '@remotebridge/shared';
import db from '../db/client';
import { isSystemDirectory } from '../security/path-guard';
import { getRelayClient } from '../ws-client/client';
import { invalidateAllowedDirsCache } from '../ws-client/dir-handlers';

function pushDirsUpdated(): void {
  invalidateAllowedDirsCache();
  const client = getRelayClient();
  if (!client || !client.isConnected()) return;
  client.send({ type: WSMessageType.HOST_DIRS_UPDATED, payload: { timestamp: Date.now() } });
}

// ===== 注册目录管理 IPC =====
export function registerDirsHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('dirs:select-dialog', async () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择共享目录',
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  ipcMain.handle('dirs:add', async (_, dirPath: string) => {
    if (isSystemDirectory(dirPath)) {
      return { success: false, error: '不能添加系统保护目录' };
    }

    if (!fs.existsSync(dirPath)) {
      return { success: false, error: '目录不存在' };
    }

    db.addAllowedDirectory(dirPath);
    pushDirsUpdated();
    return { success: true };
  });

  ipcMain.handle('dirs:remove', (_, id: number) => {
    db.removeAllowedDirectory(id);
    pushDirsUpdated();
    return { success: true };
  });

  ipcMain.handle('dirs:list', () => {
    return db.getAllowedDirectories();
  });

  ipcMain.handle('dirs:update-permission', (_, id: number, permission: string) => {
    db.updateDirectoryPermission(id, permission);
    pushDirsUpdated();
    return { success: true };
  });

  ipcMain.handle('dirs:save-alias', (_, id: number, alias: string) => {
    try {
      db.updateDirectoryAlias(id, alias);
      pushDirsUpdated();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('dirs:clear-all', () => {
    db.clearAllDirectories();
    pushDirsUpdated();
    return { success: true };
  });
}
