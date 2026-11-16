import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

function getResourceRoot(): string {
  if (app && app.isPackaged) {
    return process.resourcesPath;
  }
  // In dev/compiled dist-electron/desktop/src/main -> project root is 4 levels up
  const candidates = [
    path.resolve(__dirname, '../../../../resources'),
    path.resolve(process.cwd(), 'resources'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[1];
}

export function getAdbPath(): string {
  const adbExe = path.join(getResourceRoot(), 'platform-tools', 'adb.exe');
  if (fs.existsSync(adbExe)) {
    return adbExe;
  }
  return 'adb';
}

export function getScrcpyServerPath(): string {
  return path.join(getResourceRoot(), 'server', 'scrcpy-server');
}
