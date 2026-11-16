import { ChildProcess } from 'node:child_process';
import type { BrowserWindow } from 'electron';
import type { DeviceTelemetry } from '../../../../shared/types';
import { AdbBridge } from '../adb/AdbBridge';
import { assertSerial, assertShellCommand } from '../security/validate';

export class DeviceToolsService {
  private logcatProcs = new Map<string, ChildProcess>();
  private window: BrowserWindow | null = null;
  private sinks = new Set<(channel: string, payload: unknown) => void>();

  constructor(private readonly adb: AdbBridge) {}

  attachWindow(win: BrowserWindow): void {
    this.window = win;
  }

  addSink(sink: (channel: string, payload: unknown) => void): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  async captureScreenshot(serial: string): Promise<Uint8Array> {
    const pngBuffer = await this.adb.execBinary(
      ['-s', assertSerial(serial), 'exec-out', 'screencap', '-p'],
      15000,
    );
    return new Uint8Array(pngBuffer);
  }

  async runShell(serial: string, command: string): Promise<string> {
    return this.adb.shell(serial, assertShellCommand(command), 20000);
  }

  startLogcat(serial: string): void {
    this.stopLogcat(serial);
    const proc = this.adb.spawnDevice(serial, ['logcat', '-v', 'time', '-T', '100']);
    this.logcatProcs.set(serial, proc);

    const emit = (chunk: Buffer) => {
      const payload = {
        serial,
        text: chunk.toString('utf8'),
      };
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send('tools:logcat-data', payload);
      }
      for (const sink of this.sinks) {
        sink('tools:logcat-data', payload);
      }
    };

    proc.stdout?.on('data', emit);
    proc.stderr?.on('data', emit);
    proc.on('exit', () => {
      if (this.logcatProcs.get(serial) === proc) {
        this.logcatProcs.delete(serial);
      }
    });
  }

  stopLogcat(serial: string): void {
    const proc = this.logcatProcs.get(serial);
    if (proc) {
      this.logcatProcs.delete(serial);
      proc.kill();
    }
  }

  stopAll(): void {
    for (const serial of this.logcatProcs.keys()) {
      this.stopLogcat(serial);
    }
  }

  async getTelemetry(serial: string): Promise<DeviceTelemetry> {
    const [propsOut, wmSizeOut, wmDensityOut, batteryOut, memOut, dfOut, wifiIp] =
      await Promise.all([
        this.adb
          .shell(
            serial,
            'getprop ro.product.manufacturer && getprop ro.product.model && getprop ro.product.brand && getprop ro.build.version.release && getprop ro.build.version.sdk',
            6000,
          )
          .catch(() => ''),
        this.adb.shell(serial, 'wm size', 5000).catch(() => ''),
        this.adb.shell(serial, 'wm density', 5000).catch(() => ''),
        this.adb.shell(serial, 'dumpsys battery', 5000).catch(() => ''),
        this.adb.shell(serial, 'cat /proc/meminfo', 5000).catch(() => ''),
        this.adb.shell(serial, 'df -h /data', 5000).catch(() => ''),
        this.adb.getDeviceIp(serial).catch(() => null),
      ]);

    const propLines = propsOut.split(/\r?\n/).map((s) => s.trim());
    const manufacturer = propLines[0] || 'Unknown';
    const model = propLines[1] || 'Unknown';
    const brand = propLines[2] || 'Unknown';
    const androidVersion = propLines[3] || '?';
    const sdkVersion = propLines[4] || '?';

    const sizeMatch = wmSizeOut.match(/(\d+x\d+)/g);
    const resolution = sizeMatch ? sizeMatch[sizeMatch.length - 1] : 'Unknown';

    const densityMatch = wmDensityOut.match(/(\d+)/g);
    const density = densityMatch ? `${densityMatch[densityMatch.length - 1]} dpi` : 'Unknown';

    const levelMatch = batteryOut.match(/level:\s*(\d+)/);
    const statusMatch = batteryOut.match(/status:\s*(\d+)/);
    const tempMatch = batteryOut.match(/temperature:\s*(\d+)/);
    const statusMap: Record<string, string> = {
      '2': 'Charging',
      '3': 'Discharging',
      '4': 'Not charging',
      '5': 'Full',
    };

    const memTotalMatch = memOut.match(/MemTotal:\s*(\d+)\s*kB/);
    const memAvailMatch = memOut.match(/MemAvailable:\s*(\d+)\s*kB/);

    const dfLines = dfOut.trim().split(/\r?\n/);
    const dfDataLine = dfLines[dfLines.length - 1] || '';
    const dfParts = dfDataLine.trim().split(/\s+/);
    const storageSummary =
      dfParts.length >= 5
        ? `${dfParts[2]} used / ${dfParts[1]} (${dfParts[4]})`
        : 'Unknown';

    return {
      manufacturer,
      model,
      brand,
      androidVersion,
      sdkVersion,
      resolution,
      density,
      batteryLevel: levelMatch ? Number.parseInt(levelMatch[1], 10) : null,
      batteryStatus: statusMatch ? statusMap[statusMatch[1]] || 'Unknown' : 'Unknown',
      batteryTempC: tempMatch ? Number.parseInt(tempMatch[1], 10) / 10 : null,
      wifiIp,
      memTotalMb: memTotalMatch ? Math.round(Number.parseInt(memTotalMatch[1], 10) / 1024) : null,
      memAvailableMb: memAvailMatch ? Math.round(Number.parseInt(memAvailMatch[1], 10) / 1024) : null,
      storageSummary,
    };
  }
}
