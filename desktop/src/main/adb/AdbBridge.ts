import { ChildProcess, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdbDeviceInfo, DeviceStatus, MdnsServiceInfo } from '../../../../shared/types';
import { getAdbPath } from '../paths';
import {
  assertHostPort,
  assertPairingCode,
  assertSerial,
  assertTcpPort,
} from '../security/validate';

const execFileAsync = promisify(execFile);

const VALID_STATES = new Set<string>(['device', 'unauthorized', 'offline', 'authorizing']);

export function parseAdbDevicesOutput(raw: string): AdbDeviceInfo[] {
  const devices: AdbDeviceInfo[] = [];
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('List of devices attached') || trimmed.startsWith('*')) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;

    const serial = parts[0];
    const rawState = parts[1];
    const state: DeviceStatus = VALID_STATES.has(rawState)
      ? (rawState as DeviceStatus)
      : 'offline';

    const meta: Record<string, string> = {};
    for (let i = 2; i < parts.length; i++) {
      const idx = parts[i].indexOf(':');
      if (idx > 0) {
        meta[parts[i].slice(0, idx)] = parts[i].slice(idx + 1);
      }
    }

    const isWireless =
      serial.includes(':') ||
      serial.includes('_adb-tls-connect') ||
      serial.includes('_adb-tls-pairing');

    let ip: string | undefined;
    let port: number | undefined;
    const ipPortMatch = serial.match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/);
    if (ipPortMatch) {
      ip = ipPortMatch[1];
      port = Number.parseInt(ipPortMatch[2], 10);
    }

    devices.push({
      serial,
      state,
      transport: isWireless ? 'wireless' : 'usb',
      model: meta.model?.replace(/_/g, ' '),
      product: meta.product,
      device: meta.device,
      transportId: meta.transport_id,
      ip,
      port,
    });
  }

  return devices;
}

export function parseMdnsServicesOutput(raw: string): MdnsServiceInfo[] {
  const results: MdnsServiceInfo[] = [];
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('List of')) continue;
    // Example: adb-XXXXXXXX-YYYYYY  _adb-tls-pairing._tcp  192.168.1.42:37891
    const match = trimmed.match(/^(\S+)\s+(_adb[^\s]+)\s+([^\s:]+):(\d+)$/);
    if (!match) continue;
    results.push({
      instanceName: match[1],
      serviceType: match[2],
      address: match[3],
      port: Number.parseInt(match[4], 10),
    });
  }

  return results;
}

export function extractWifiIpFromRoute(routeOutput: string): string | null {
  // e.g. "192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.42"
  const srcMatch = routeOutput.match(/\bdev\s+wlan\d*\b.*?\bsrc\s+(\d+\.\d+\.\d+\.\d+)/);
  if (srcMatch) return srcMatch[1];
  const anySrc = routeOutput.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/);
  return anySrc ? anySrc[1] : null;
}

export class AdbBridge {
  private readonly adbBin: string;

  constructor(adbBin = getAdbPath()) {
    this.adbBin = adbBin;
  }

  getExecutable(): string {
    return this.adbBin;
  }

  async exec(args: string[], timeoutMs = 15000): Promise<string> {
    try {
      const { stdout } = await execFileAsync(this.adbBin, args, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      const detail = (e.stderr || e.stdout || e.message || 'ADB command failed').trim();
      throw new Error(detail);
    }
  }

  async execBinary(args: string[], timeoutMs = 20000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.adbBin, args, { windowsHide: true });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`ADB binary command timed out: ${args.join(' ')}`));
      }, timeoutMs);

      proc.stdout.on('data', (c: Buffer) => chunks.push(c));
      proc.stderr.on('data', (c: Buffer) => errChunks.push(c));
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(Buffer.concat(errChunks).toString('utf8') || `adb exited with code ${code}`));
        } else {
          resolve(Buffer.concat(chunks));
        }
      });
    });
  }

  async execDevice(serial: string, args: string[], timeoutMs = 15000): Promise<string> {
    return this.exec(['-s', assertSerial(serial), ...args], timeoutMs);
  }

  async shell(serial: string, command: string, timeoutMs = 15000): Promise<string> {
    return this.execDevice(serial, ['shell', command], timeoutMs);
  }

  spawnDevice(serial: string, args: string[]): ChildProcess {
    return spawn(this.adbBin, ['-s', assertSerial(serial), ...args], {
      windowsHide: true,
    });
  }

  async startServer(): Promise<void> {
    await this.exec(['start-server'], 15000);
  }

  async restartServer(): Promise<void> {
    try {
      await this.exec(['kill-server'], 8000);
    } catch {
      // ignore if not running
    }
    await this.exec(['start-server'], 15000);
  }

  async listDevices(): Promise<AdbDeviceInfo[]> {
    const out = await this.exec(['devices', '-l'], 10000);
    return parseAdbDevicesOutput(out);
  }

  async getDeviceIp(serial: string): Promise<string | null> {
    try {
      const route = await this.shell(serial, 'ip route', 5000);
      const ip = extractWifiIpFromRoute(route);
      if (ip) return ip;
    } catch {
      // fallback below
    }
    try {
      const addr = await this.shell(serial, 'ip -f inet addr show wlan0', 5000);
      const match = addr.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  async pair(hostPort: string, pairingCode: string): Promise<string> {
    const out = await this.exec(['pair', assertHostPort(hostPort), assertPairingCode(pairingCode)], 20000);
    if (out.toLowerCase().includes('failed')) {
      throw new Error(out.trim());
    }
    return out.trim();
  }

  async connect(hostPort: string): Promise<string> {
    const out = await this.exec(['connect', assertHostPort(hostPort)], 15000);
    const lower = out.toLowerCase();
    if (lower.includes('failed') || lower.includes('cannot') || lower.includes('unable')) {
      throw new Error(out.trim());
    }
    return out.trim();
  }

  async disconnect(hostPort?: string): Promise<string> {
    const args =
      hostPort !== undefined ? ['disconnect', assertSerial(hostPort.trim())] : ['disconnect'];
    return (await this.exec(args, 8000)).trim();
  }

  async enableTcpIpAndConnect(serial: string, port = 5555): Promise<{ ip: string; port: number; message: string }> {
    port = assertTcpPort(port);
    const ip = await this.getDeviceIp(serial);
    if (!ip) {
      throw new Error('Could not detect phone Wi-Fi IP. Make sure Wi-Fi is connected on the itel P55T.');
    }
    await this.execDevice(serial, ['tcpip', String(port)], 10000);
    // Give adbd a moment to restart in TCP mode
    await new Promise((r) => setTimeout(r, 1500));
    const message = await this.connect(`${ip}:${port}`);
    return { ip, port, message };
  }

  async listMdnsServices(): Promise<MdnsServiceInfo[]> {
    try {
      const out = await this.exec(['mdns', 'services'], 5000);
      return parseMdnsServicesOutput(out);
    } catch {
      return [];
    }
  }

  async push(serial: string, localPath: string, remotePath: string, timeoutMs = 60000): Promise<string> {
    return this.execDevice(serial, ['push', localPath, remotePath], timeoutMs);
  }

  async pull(serial: string, remotePath: string, localPath: string, timeoutMs = 60000): Promise<string> {
    return this.execDevice(serial, ['pull', remotePath, localPath], timeoutMs);
  }

  async reverse(serial: string, remoteSocket: string, localPort: number): Promise<void> {
    await this.execDevice(serial, ['reverse', remoteSocket, `tcp:${localPort}`], 8000);
  }

  async reverseRemove(serial: string, remoteSocket: string): Promise<void> {
    try {
      await this.execDevice(serial, ['reverse', '--remove', remoteSocket], 5000);
    } catch {
      // ignore cleanup failures
    }
  }

  async forward(serial: string, localPort: number, remoteSocket: string): Promise<void> {
    await this.execDevice(serial, ['forward', `tcp:${localPort}`, remoteSocket], 8000);
  }

  async forwardRemove(serial: string, localPort: number): Promise<void> {
    try {
      await this.execDevice(serial, ['forward', '--remove', `tcp:${localPort}`], 5000);
    } catch {
      // ignore cleanup failures
    }
  }
}
