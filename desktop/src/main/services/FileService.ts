import fs from 'node:fs/promises';
import path from 'node:path';
import type { RemoteFileEntry } from '../../../../shared/types';
import { AdbBridge } from '../adb/AdbBridge';
import {
  assertFileName,
  assertRemotePath,
  assertRemovableRemotePath,
} from '../security/validate';

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function parseLsOutput(dirPath: string, raw: string): RemoteFileEntry[] {
  const entries: RemoteFileEntry[] = [];
  const base = dirPath.endsWith('/') ? dirPath.slice(0, -1) : dirPath;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('total ')) continue;

    // Android toybox `ls -lA` format:
    // drwxrwx--x 4 root sdcard_rw 4096 2026-11-10 14:22 Download
    // -rw-rw---- 1 u0_a123 media_rw 123456 2026-11-10 14:22 photo.jpg
    const match = trimmed.match(
      /^([dlcbps-][rwxstST-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+)$/,
    );
    if (!match) continue;

    const permissions = match[1];
    const size = Number.parseInt(match[2], 10);
    const modifiedAt = match[3];
    let name = match[4];

    const isSymlink = permissions.startsWith('l');
    if (isSymlink) {
      const arrowIdx = name.indexOf(' -> ');
      if (arrowIdx !== -1) {
        name = name.slice(0, arrowIdx);
      }
    }

    if (name === '.' || name === '..') continue;
    const isDirectory = permissions.startsWith('d') || isSymlink;

    entries.push({
      name,
      path: `${base}/${name}` || `/${name}`,
      isDirectory,
      size: Number.isFinite(size) ? size : 0,
      permissions,
      modifiedAt,
    });
  }

  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export class FileService {
  constructor(private readonly adb: AdbBridge) {}

  async list(serial: string, dirPath: string): Promise<RemoteFileEntry[]> {
    const cleanPath = assertRemotePath(dirPath || '/sdcard');
    const out = await this.adb.shell(serial, `ls -lA ${shellQuote(cleanPath)}`, 15000);
    return parseLsOutput(cleanPath, out);
  }

  async upload(serial: string, localPaths: string[], remoteDir: string): Promise<void> {
    const dir = assertRemotePath(remoteDir);
    const targetDir = dir.endsWith('/') ? dir : `${dir}/`;
    if (!Array.isArray(localPaths) || localPaths.length > 500) {
      throw new Error('Invalid upload list');
    }
    for (const localPath of localPaths) {
      // Only regular files the user picked/dropped — never directories or devices.
      const stat = typeof localPath === 'string' ? await fs.stat(localPath).catch(() => null) : null;
      if (!stat?.isFile()) {
        throw new Error(`Not a regular file: ${String(localPath)}`);
      }
      const fileName = assertFileName(path.basename(localPath));
      await this.adb.push(serial, localPath, `${targetDir}${fileName}`, 120000);
    }
  }

  async download(serial: string, remotePath: string, localPath: string): Promise<void> {
    await this.adb.pull(serial, assertRemotePath(remotePath), localPath, 120000);
  }

  async mkdir(serial: string, remotePath: string): Promise<void> {
    await this.adb.shell(serial, `mkdir -p ${shellQuote(assertRemotePath(remotePath))}`, 8000);
  }

  async remove(serial: string, remotePath: string): Promise<void> {
    await this.adb.shell(serial, `rm -rf ${shellQuote(assertRemovableRemotePath(remotePath))}`, 15000);
  }
}
