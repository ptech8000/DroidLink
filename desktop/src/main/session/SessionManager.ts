import type { BrowserWindow } from 'electron';
import { CONTROL_MSG_TYPE } from '../../../../shared/protocol';
import type { StreamOptions } from '../../../../shared/types';
import { AdbBridge } from '../adb/AdbBridge';
import { assertSerial, assertStreamOptions } from '../security/validate';
import { MirrorSession } from './MirrorSession';

type EventSink = (channel: string, payload: unknown) => void;

function getElectronClipboard(): { readText(): string; writeText(t: string): void } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electronMod = require('electron') as { clipboard?: { readText(): string; writeText(t: string): void } };
    return electronMod && typeof electronMod === 'object' && electronMod.clipboard
      ? electronMod.clipboard
      : null;
  } catch {
    return null;
  }
}

export class SessionManager {
  private readonly adb: AdbBridge;
  private readonly sessions = new Map<string, MirrorSession>();
  private window: BrowserWindow | null = null;
  private sinks = new Set<EventSink>();
  private lastSyncedClipboard = '';

  constructor(adb: AdbBridge) {
    this.adb = adb;
  }

  attachWindow(win: BrowserWindow): void {
    this.window = win;
  }

  addSink(sink: EventSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  private sendToRenderer(channel: string, payload: unknown): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload);
    }
    for (const sink of this.sinks) {
      sink(channel, payload);
    }
  }

  async startSession(serial: string, rawOptions: StreamOptions): Promise<void> {
    assertSerial(serial);
    // Options are spliced into the scrcpy-server shell command — strict validation prevents injection.
    const options = assertStreamOptions(rawOptions);
    await this.stopSession(serial);

    const session = new MirrorSession(serial, options, this.adb);
    this.sessions.set(serial, session);

    session.on('status', (ev) => {
      this.sendToRenderer('session:status', ev);
      if (ev.state === 'stopped' || ev.state === 'error') {
        if (this.sessions.get(serial) === session) {
          this.sessions.delete(serial);
        }
      }
    });

    session.on('video:codec', (ev) => this.sendToRenderer('session:video-codec', ev));
    session.on('video:session', (ev) => this.sendToRenderer('session:video-session', ev));
    session.on('video:packet', (ev) => this.sendToRenderer('session:video-packet', ev));

    session.on('audio:codec', (ev) => this.sendToRenderer('session:audio-codec', ev));
    session.on('audio:packet', (ev) => this.sendToRenderer('session:audio-packet', ev));
    session.on('audio:disabled', (ev) => this.sendToRenderer('session:audio-disabled', ev));

    session.on('device:clipboard', (ev: { serial: string; text: string }) => {
      if (options.clipboardAutosync && ev.text && ev.text !== this.lastSyncedClipboard) {
        this.lastSyncedClipboard = ev.text;
        getElectronClipboard()?.writeText(ev.text);
      }
      this.sendToRenderer('session:clipboard', ev);
    });

    try {
      await session.start();
    } catch (err) {
      if (this.sessions.get(serial) === session) {
        this.sessions.delete(serial);
      }
      this.sendToRenderer('session:status', {
        serial,
        state: 'error',
        message: (err as Error).message,
      });
      throw err;
    }
  }

  async stopSession(serial: string): Promise<void> {
    const existing = this.sessions.get(serial);
    if (existing) {
      this.sessions.delete(serial);
      await existing.stop();
    }
  }

  async stopAll(): Promise<void> {
    const all = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(all.map((s) => s.stop()));
  }

  sendRawControl(serial: string, bytes: Uint8Array): boolean {
    const session = this.sessions.get(serial);
    if (!session) return false;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 300_000) return false;
    return session.sendRawControl(bytes);
  }

  pushPcClipboardToDevice(serial: string, paste = false, textOverride?: string): boolean {
    const session = this.sessions.get(serial);
    if (!session) return false;
    if (textOverride !== undefined && (typeof textOverride !== 'string' || textOverride.length > 256_000)) {
      return false;
    }
    const text = textOverride ?? getElectronClipboard()?.readText() ?? '';
    if (!text) return false;
    this.lastSyncedClipboard = text;
    return session.sendControl({
      type: CONTROL_MSG_TYPE.SET_CLIPBOARD,
      sequence: BigInt(Date.now()),
      paste,
      text,
    });
  }

  hasSession(serial: string): boolean {
    return this.sessions.has(serial);
  }
}
