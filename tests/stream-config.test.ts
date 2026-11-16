import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceTelemetry } from '../shared/types';
import {
  DEFAULT_PREFERENCES,
  evaluateDeviceHealth,
  getReconnectDelayMs,
  loadPreferences,
  parseStoragePercent,
  savePreferences,
  STREAM_PRESETS,
} from '../desktop/src/renderer/src/utils/streamConfig';

function makeTelemetry(overrides: Partial<DeviceTelemetry> = {}): DeviceTelemetry {
  return {
    manufacturer: 'ACME',
    model: 'Example Phone',
    brand: 'Example',
    androidVersion: '14',
    sdkVersion: '34',
    resolution: '720x1612',
    density: '288 dpi',
    batteryLevel: 80,
    batteryStatus: 'Discharging',
    batteryTempC: 33,
    wifiIp: '192.0.2.10',
    memTotalMb: 3716,
    memAvailableMb: 1702,
    storageSummary: '60G used / 113G (53%)',
    ...overrides,
  };
}

describe('streamConfig & health evaluation', () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('parses storage percentage from df summary', () => {
    expect(parseStoragePercent('110G used / 113G (98%)')).toBe(98);
    expect(parseStoragePercent('Unknown')).toBeNull();
  });

  it('flags warm/critical temperature, low battery (only when not charging), and full storage', () => {
    expect(evaluateDeviceHealth(makeTelemetry())).toEqual([]);

    const warmAndFull = evaluateDeviceHealth(
      makeTelemetry({ batteryTempC: 40.1, storageSummary: '110G used / 113G (98%)', batteryLevel: 20 }),
    );
    expect(warmAndFull.map((a) => [a.id, a.level])).toEqual([
      ['temp', 'warn'],
      ['battery', 'warn'],
      ['storage', 'crit'],
    ]);

    const hotAndLow = evaluateDeviceHealth(
      makeTelemetry({ batteryTempC: 44.0, batteryLevel: 12 }),
    );
    expect(hotAndLow.map((a) => [a.id, a.level])).toEqual([
      ['temp', 'crit'],
      ['battery', 'crit'],
    ]);

    // Charging exempts low-battery warning
    const chargingLow = evaluateDeviceHealth(
      makeTelemetry({ batteryLevel: 10, batteryStatus: 'Charging' }),
    );
    expect(chargingLow).toEqual([]);
  });

  it('roundtrips persisted preferences through localStorage and ignores corrupt JSON', () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };

    const custom = {
      ...DEFAULT_PREFERENCES,
      autoReconnect: false,
      audioVolume: 0.45,
      toolsOpen: false,
      streamOptions: {
        ...DEFAULT_PREFERENCES.streamOptions,
        ...STREAM_PRESETS[0].options,
      },
    };
    savePreferences(custom);
    expect(loadPreferences()).toEqual(custom);

    store.set('droidlink.preferences.v1', '{broken-json');
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('computes bounded exponential reconnect delays', () => {
    expect([0, 1, 2, 3, 4, 5].map(getReconnectDelayMs)).toEqual([
      1500, 3000, 5000, 8000, 12000, 12000,
    ]);
  });
});
