import type { StreamOptions } from '../../../../shared/types';

/**
 * Central input validation for every value that crosses a trust boundary
 * (renderer IPC, browser RPC) before it reaches adb or a device shell.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function fail(message: string): never {
  throw new ValidationError(message);
}

/** ADB serial: USB serial, ip:port, or mDNS service name. Never an option flag. */
export function assertSerial(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    fail('Invalid device serial');
  }
  if (value.startsWith('-') || !/^[A-Za-z0-9._:\-[\]%@]+$/.test(value)) {
    fail('Invalid device serial');
  }
  return value;
}

/** host:port used by adb connect / pair. */
export function assertHostPort(value: unknown): string {
  if (typeof value !== 'string') fail('Invalid host:port');
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 255 ||
    trimmed.startsWith('-') ||
    !/^[A-Za-z0-9._\-[\]:%]+:\d{1,5}$/.test(trimmed)
  ) {
    fail('Invalid host:port (expected e.g. 192.168.0.10:5555)');
  }
  const port = Number(trimmed.slice(trimmed.lastIndexOf(':') + 1));
  if (port < 1 || port > 65535) fail('Invalid port');
  return trimmed;
}

export function assertPairingCode(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value.trim())) {
    fail('Pairing code must be 6 digits');
  }
  return value.trim();
}

export function assertTcpPort(value: unknown, fallback = 5555): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1024 || value > 65535) {
    fail('Invalid TCP port');
  }
  return value;
}

/**
 * Absolute path on the phone. Rejects option injection (`-x`), NUL bytes and newlines.
 * Shell metacharacters are fine because callers single-quote or pass as an argv element.
 */
export function assertRemotePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    fail('Invalid phone path');
  }
  if (!value.startsWith('/') || /[\0\r\n]/.test(value)) {
    fail('Phone path must be absolute');
  }
  return value;
}

/** Paths that must never be wiped with `rm -rf`. */
const PROTECTED_REMOTE_PATHS = new Set([
  '/',
  '/sdcard',
  '/storage',
  '/storage/emulated',
  '/storage/emulated/0',
  '/data',
  '/system',
  '/vendor',
]);

export function assertRemovableRemotePath(value: unknown): string {
  const p = assertRemotePath(value);
  const normalized = p.replace(/\/+$/, '') || '/';
  if (PROTECTED_REMOTE_PATHS.has(normalized) || /(^|\/)\.\.?(\/|$)/.test(normalized)) {
    fail(`Refusing to delete protected path: ${p}`);
  }
  return p;
}

/** A single file name (no directories, no `.`/`..`). */
export function assertFileName(value: unknown): string {
  if (typeof value !== 'string') fail('Invalid file name');
  const name = value.split(/[\\/]/).pop() ?? '';
  if (!name || name === '.' || name === '..' || name.length > 255 || /[\0\r\n"]/.test(name)) {
    fail('Invalid file name');
  }
  return name;
}

export function assertPackageName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 255 ||
    !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(value)
  ) {
    fail('Invalid Android package name');
  }
  return value;
}

export function assertShellCommand(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 8192 || value.includes('\0')) {
    fail('Invalid shell command');
  }
  return value;
}

export function assertBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') fail('Expected a boolean');
  return value;
}

export function assertOptionalString(value: unknown, maxLen: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > maxLen) fail('Invalid text');
  return value;
}

function intInRange(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(`Invalid stream option: ${field}`);
  }
  return value;
}

/**
 * StreamOptions are interpolated into the `adb shell app_process ...` command line that
 * starts scrcpy-server, and `adb shell` re-parses that line with the device's /bin/sh.
 * Every field therefore has to be a strict enum/number/boolean.
 */
export function assertStreamOptions(value: unknown): StreamOptions {
  if (!value || typeof value !== 'object') fail('Invalid stream options');
  const o = value as Record<string, unknown>;
  if (o.videoCodec !== 'h264' && o.videoCodec !== 'h265') fail('Invalid stream option: videoCodec');
  if (o.audioCodec !== 'opus' && o.audioCodec !== 'aac') fail('Invalid stream option: audioCodec');
  const bools = ['audio', 'stayAwake', 'showTouches', 'turnScreenOff', 'powerOffOnClose', 'clipboardAutosync'] as const;
  for (const key of bools) {
    if (typeof o[key] !== 'boolean') fail(`Invalid stream option: ${key}`);
  }
  return {
    videoCodec: o.videoCodec,
    audioCodec: o.audioCodec,
    maxSize: intInRange(o.maxSize, 0, 8192, 'maxSize'),
    maxFps: intInRange(o.maxFps, 0, 240, 'maxFps'),
    videoBitRate: intInRange(o.videoBitRate, 100_000, 200_000_000, 'videoBitRate'),
    audio: o.audio as boolean,
    stayAwake: o.stayAwake as boolean,
    showTouches: o.showTouches as boolean,
    turnScreenOff: o.turnScreenOff as boolean,
    powerOffOnClose: o.powerOffOnClose as boolean,
    clipboardAutosync: o.clipboardAutosync as boolean,
  };
}

/** Raw scrcpy control messages are small; cap them to stop memory abuse. */
export function assertControlBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > 300_000) {
    fail('Invalid control message');
  }
  return value;
}

export function assertRecordingExt(value: unknown): string {
  if (value === undefined) return 'webm';
  if (typeof value !== 'string' || !/^(webm|mp4|mkv)$/.test(value)) fail('Invalid recording format');
  return value;
}
