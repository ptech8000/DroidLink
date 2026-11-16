import type { DeviceTelemetry, StreamOptions } from '@shared/types';

export type StreamPresetId = 'stream-saver' | 'balanced' | 'high-quality' | 'usb-crisp';

export interface StreamPreset {
  id: StreamPresetId;
  label: string;
  description: string;
  options: Partial<StreamOptions>;
}

export const DEFAULT_STREAM_OPTIONS: StreamOptions = {
  videoCodec: 'h264',
  maxSize: 0,
  maxFps: 0,
  videoBitRate: 4_000_000,
  audio: true,
  audioCodec: 'opus',
  stayAwake: true,
  showTouches: false,
  turnScreenOff: false,
  powerOffOnClose: false,
  clipboardAutosync: true,
};

export const STREAM_PRESETS: readonly StreamPreset[] = [
  {
    id: 'stream-saver',
    label: 'Stream Saver',
    description: '2 Mbps • 30 FPS • Screen off (low heat & clear Wi-Fi for live broadcasts)',
    options: {
      videoBitRate: 2_000_000,
      maxSize: 1024,
      maxFps: 30,
      turnScreenOff: true,
      stayAwake: true,
    },
  },
  {
    id: 'balanced',
    label: 'Wi-Fi Balanced',
    description: '4 Mbps • Native • 60 FPS',
    options: {
      videoBitRate: 4_000_000,
      maxSize: 0,
      maxFps: 60,
      turnScreenOff: false,
    },
  },
  {
    id: 'high-quality',
    label: 'High Quality',
    description: '8 Mbps • Native • Unlimited FPS',
    options: {
      videoBitRate: 8_000_000,
      maxSize: 0,
      maxFps: 0,
      turnScreenOff: false,
    },
  },
  {
    id: 'usb-crisp',
    label: 'USB Crisp',
    description: '12 Mbps • Native • Unlimited FPS',
    options: {
      videoBitRate: 12_000_000,
      maxSize: 0,
      maxFps: 0,
      turnScreenOff: false,
    },
  },
];

export interface PersistedPreferences {
  streamOptions: StreamOptions;
  autoReconnect: boolean;
  audioVolume: number;
  toolsOpen: boolean;
}

const STORAGE_KEY = 'droidlink.preferences.v1';

export const DEFAULT_PREFERENCES: PersistedPreferences = {
  streamOptions: DEFAULT_STREAM_OPTIONS,
  autoReconnect: true,
  audioVolume: 1,
  toolsOpen: true,
};

function sanitizeStreamOptions(raw: unknown): StreamOptions {
  if (!raw || typeof raw !== 'object') return DEFAULT_STREAM_OPTIONS;
  const o = raw as Record<string, unknown>;
  return {
    videoCodec: o.videoCodec === 'h265' ? 'h265' : 'h264',
    audioCodec: o.audioCodec === 'aac' ? 'aac' : 'opus',
    maxSize: typeof o.maxSize === 'number' && Number.isFinite(o.maxSize) && o.maxSize >= 0 ? o.maxSize : 0,
    maxFps: typeof o.maxFps === 'number' && Number.isFinite(o.maxFps) && o.maxFps >= 0 ? o.maxFps : 0,
    videoBitRate:
      typeof o.videoBitRate === 'number' && o.videoBitRate >= 500_000 && o.videoBitRate <= 32_000_000
        ? o.videoBitRate
        : DEFAULT_STREAM_OPTIONS.videoBitRate,
    audio: typeof o.audio === 'boolean' ? o.audio : DEFAULT_STREAM_OPTIONS.audio,
    stayAwake: typeof o.stayAwake === 'boolean' ? o.stayAwake : DEFAULT_STREAM_OPTIONS.stayAwake,
    showTouches: typeof o.showTouches === 'boolean' ? o.showTouches : DEFAULT_STREAM_OPTIONS.showTouches,
    turnScreenOff:
      typeof o.turnScreenOff === 'boolean' ? o.turnScreenOff : DEFAULT_STREAM_OPTIONS.turnScreenOff,
    powerOffOnClose:
      typeof o.powerOffOnClose === 'boolean' ? o.powerOffOnClose : DEFAULT_STREAM_OPTIONS.powerOffOnClose,
    clipboardAutosync:
      typeof o.clipboardAutosync === 'boolean' ? o.clipboardAutosync : DEFAULT_STREAM_OPTIONS.clipboardAutosync,
  };
}

export function loadPreferences(): PersistedPreferences {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      streamOptions: sanitizeStreamOptions(parsed.streamOptions),
      autoReconnect:
        typeof parsed.autoReconnect === 'boolean' ? parsed.autoReconnect : DEFAULT_PREFERENCES.autoReconnect,
      audioVolume:
        typeof parsed.audioVolume === 'number' && parsed.audioVolume >= 0 && parsed.audioVolume <= 1
          ? parsed.audioVolume
          : DEFAULT_PREFERENCES.audioVolume,
      toolsOpen: typeof parsed.toolsOpen === 'boolean' ? parsed.toolsOpen : DEFAULT_PREFERENCES.toolsOpen,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(prefs: PersistedPreferences): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota or private-mode failures
  }
}

export function parseStoragePercent(storageSummary: string): number | null {
  const m = storageSummary.match(/\((\d{1,3})%\)/);
  if (!m) return null;
  const pct = Number.parseInt(m[1], 10);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
}

export interface DeviceHealthAlert {
  id: 'temp' | 'battery' | 'storage';
  level: 'warn' | 'crit';
  shortLabel: string;
  message: string;
}

export function evaluateDeviceHealth(telemetry: DeviceTelemetry | null): DeviceHealthAlert[] {
  if (!telemetry) return [];
  const alerts: DeviceHealthAlert[] = [];

  if (telemetry.batteryTempC !== null) {
    if (telemetry.batteryTempC >= 43) {
      alerts.push({
        id: 'temp',
        level: 'crit',
        shortLabel: `${telemetry.batteryTempC.toFixed(1)}°C Hot`,
        message: `Phone temperature is high (${telemetry.batteryTempC.toFixed(1)}°C). Enable Stream Saver or turn phone screen off to cool down.`,
      });
    } else if (telemetry.batteryTempC >= 39.5) {
      alerts.push({
        id: 'temp',
        level: 'warn',
        shortLabel: `${telemetry.batteryTempC.toFixed(1)}°C Warm`,
        message: `Phone is warming up (${telemetry.batteryTempC.toFixed(1)}°C).`,
      });
    }
  }

  const isCharging = telemetry.batteryStatus === 'Charging' || telemetry.batteryStatus === 'Full';
  if (telemetry.batteryLevel !== null && !isCharging) {
    if (telemetry.batteryLevel <= 15) {
      alerts.push({
        id: 'battery',
        level: 'crit',
        shortLabel: `${telemetry.batteryLevel}% Low`,
        message: `Phone battery critical (${telemetry.batteryLevel}%). Plug in charger soon.`,
      });
    } else if (telemetry.batteryLevel <= 25) {
      alerts.push({
        id: 'battery',
        level: 'warn',
        shortLabel: `${telemetry.batteryLevel}%`,
        message: `Phone battery is below 25% (${telemetry.batteryLevel}%).`,
      });
    }
  }

  const storagePct = parseStoragePercent(telemetry.storageSummary);
  if (storagePct !== null) {
    if (storagePct >= 95) {
      alerts.push({
        id: 'storage',
        level: 'crit',
        shortLabel: `${storagePct}% Full`,
        message: `Phone storage is almost full (${telemetry.storageSummary}). Recording on-device may stop unexpectedly.`,
      });
    } else if (storagePct >= 90) {
      alerts.push({
        id: 'storage',
        level: 'warn',
        shortLabel: `${storagePct}% Disk`,
        message: `Phone storage is running low (${telemetry.storageSummary}).`,
      });
    }
  }

  return alerts;
}

export const MAX_RECONNECT_ATTEMPTS = 5;

export function getReconnectDelayMs(attempt: number): number {
  const capped = Math.max(0, Math.min(attempt, 4));
  return [1500, 3000, 5000, 8000, 12000][capped];
}
