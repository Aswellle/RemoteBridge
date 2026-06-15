import { ipcMain, BrowserWindow, dialog } from 'electron';
import fs from 'fs';
import db from '../db/client';
import { isSystemDirectory } from '../security/path-guard';

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
    return { success: true };
  });

  ipcMain.handle('dirs:remove', (_, id: number) => {
    db.removeAllowedDirectory(id);
    return { success: true };
  });

  ipcMain.handle('dirs:list', () => {
    return db.getAllowedDirectories();
  });

  ipcMain.handle('dirs:update-permission', (_, id: number, permission: string) => {
    db.updateDirectoryPermission(id, permission);
    return { success: true };
  });

  ipcMain.handle('dirs:save-alias', (_, id: number, alias: string) => {
    try {
      db.updateDirectoryAlias(id, alias);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
}
