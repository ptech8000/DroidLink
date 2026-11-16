import fs from 'node:fs/promises';
import type { InstalledAppInfo } from '../../../../shared/types';
import { AdbBridge } from '../adb/AdbBridge';
import { assertPackageName } from '../security/validate';

export class AppService {
  constructor(private readonly adb: AdbBridge) {}

  async listPackages(serial: string, includeSystem = false): Promise<InstalledAppInfo[]> {
    const userOut = await this.adb.shell(serial, 'pm list packages -3', 15000);
    const apps = new Map<string, InstalledAppInfo>();

    for (const line of userOut.split(/\r?\n/)) {
      const m = line.trim().match(/^package:(.+)$/);
      if (m) {
        apps.set(m[1], { packageName: m[1], isSystem: false });
      }
    }

    if (includeSystem) {
      const sysOut = await this.adb.shell(serial, 'pm list packages -s', 15000);
      for (const line of sysOut.split(/\r?\n/)) {
        const m = line.trim().match(/^package:(.+)$/);
        if (m && !apps.has(m[1])) {
          apps.set(m[1], { packageName: m[1], isSystem: true });
        }
      }
    }

    return Array.from(apps.values()).sort((a, b) => a.packageName.localeCompare(b.packageName));
  }

  async installApk(serial: string, apkPath: string): Promise<string> {
    const stat = await fs.stat(apkPath).catch(() => null);
    if (!stat?.isFile() || !apkPath.toLowerCase().endsWith('.apk')) {
      throw new Error('Only existing .apk files can be installed');
    }
    return (await this.adb.execDevice(serial, ['install', '-r', '-d', apkPath], 120000)).trim();
  }

  async launch(serial: string, packageName: string): Promise<string> {
    const pkg = assertPackageName(packageName);
    return (
      await this.adb.shell(
        serial,
        `monkey -p '${pkg}' -c android.intent.category.LAUNCHER 1`,
        10000,
      )
    ).trim();
  }

  async forceStop(serial: string, packageName: string): Promise<void> {
    const pkg = assertPackageName(packageName);
    await this.adb.shell(serial, `am force-stop '${pkg}'`, 8000);
  }

  async uninstall(serial: string, packageName: string): Promise<string> {
    const pkg = assertPackageName(packageName);
    return (await this.adb.execDevice(serial, ['uninstall', pkg], 30000)).trim();
  }
}
