import { describe, expect, it } from 'vitest';
import {
  extractWifiIpFromRoute,
  parseAdbDevicesOutput,
  parseMdnsServicesOutput,
} from '../desktop/src/main/adb/AdbBridge';
import { parseLsOutput } from '../desktop/src/main/services/FileService';

describe('ADB output parsers', () => {
  it('parses USB and wireless entries from adb devices -l', () => {
    const raw = `List of devices attached
* daemon started successfully
123456789ABCDEF        device product:P55T model:itel_P55T device:itel_A666L transport_id:1
192.168.1.42:5555      device product:P55T model:itel_P55T device:itel_A666L transport_id:2
ABCDEF999              unauthorized usb:1-2 transport_id:3
`;
    const list = parseAdbDevicesOutput(raw);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({
      serial: '123456789ABCDEF',
      state: 'device',
      transport: 'usb',
      model: 'itel P55T',
      transportId: '1',
    });
    expect(list[1]).toMatchObject({
      serial: '192.168.1.42:5555',
      state: 'device',
      transport: 'wireless',
      ip: '192.168.1.42',
      port: 5555,
    });
    expect(list[2].state).toBe('unauthorized');
  });

  it('parses adb mdns services output', () => {
    const raw = `adb-12345-xyz\t_adb-tls-pairing._tcp\t192.168.1.42:39123
adb-12345-abc\t_adb-tls-connect._tcp\t192.168.1.42:41235
`;
    const services = parseMdnsServicesOutput(raw);
    expect(services).toEqual([
      {
        instanceName: 'adb-12345-xyz',
        serviceType: '_adb-tls-pairing._tcp',
        address: '192.168.1.42',
        port: 39123,
      },
      {
        instanceName: 'adb-12345-abc',
        serviceType: '_adb-tls-connect._tcp',
        address: '192.168.1.42',
        port: 41235,
      },
    ]);
  });

  it('extracts Wi-Fi IP from ip route output', () => {
    const route = `192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.42`;
    expect(extractWifiIpFromRoute(route)).toBe('192.168.1.42');
  });
});

describe('FileService parseLsOutput', () => {
  it('parses Android toybox ls -lA output and sorts dirs first', () => {
    const raw = `total 16
-rw-rw---- 1 u0_a10 media_rw 2048 2026-11-10 14:22 notes.txt
drwxrwx--x 4 root sdcard_rw 4096 2026-11-10 14:20 Download
`;
    const files = parseLsOutput('/sdcard', raw);
    expect(files.map((f) => f.name)).toEqual(['Download', 'notes.txt']);
    expect(files[0].isDirectory).toBe(true);
    expect(files[0].path).toBe('/sdcard/Download');
    expect(files[1].size).toBe(2048);
  });
});
