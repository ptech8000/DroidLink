import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import {
  ControlMessage,
  DEVICE_MSG_TYPE,
  DEVICE_SERVER_PATH,
  DeviceMessageParser,
  SCRCPY_SERVER_VERSION,
  ScrcpyStreamDemuxer,
  serializeControlMessage,
} from '../../../../shared/protocol';
import type {
  AudioPacketEvent,
  SessionStatusEvent,
  StreamOptions,
  VideoCodecEvent,
  VideoPacketEvent,
  VideoSessionEvent,
} from '../../../../shared/types';
import { AdbBridge } from '../adb/AdbBridge';
import { getScrcpyServerPath } from '../paths';

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('Failed to allocate port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function connectWithRetry(
  port: number,
  expectDummyByte: boolean,
  timeoutMs = 7000,
): Promise<{ socket: net.Socket; initialChunk: Buffer | null }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const result = await new Promise<{ socket: net.Socket; initialChunk: Buffer | null }>((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        let settled = false;

        const cleanup = () => {
          socket.removeListener('error', onError);
          socket.removeListener('close', onClose);
          socket.removeListener('data', onData);
        };

        const onError = (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          socket.destroy();
          reject(err);
        };

        const onClose = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error('Socket closed before handshake'));
        };

        const onData = (chunk: Buffer) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ socket, initialChunk: chunk });
        };

        socket.once('error', onError);
        socket.once('close', onClose);

        socket.once('connect', () => {
          if (!expectDummyByte) {
            settled = true;
            cleanup();
            resolve({ socket, initialChunk: null });
          } else {
            socket.once('data', onData);
          }
        });
      });

      return result;
    } catch {
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  throw new Error('Timed out waiting for scrcpy-server socket');
}

export class MirrorSession extends EventEmitter {
  readonly serial: string;
  readonly options: StreamOptions;
  private readonly adb: AdbBridge;

  private serverProc: ChildProcess | null = null;
  private reverseServer: net.Server | null = null;
  private videoSocket: net.Socket | null = null;
  private audioSocket: net.Socket | null = null;
  private controlSocket: net.Socket | null = null;

  private remoteSocketName: string | null = null;
  private forwardPort: number | null = null;
  private stopped = false;

  private deviceName = '';
  private width = 0;
  private height = 0;

  constructor(serial: string, options: StreamOptions, adb: AdbBridge) {
    super();
    this.serial = serial;
    this.options = options;
    this.adb = adb;
  }

  getInfo(): { deviceName: string; width: number; height: number } {
    return { deviceName: this.deviceName, width: this.width, height: this.height };
  }

  async start(): Promise<void> {
    this.emitStatus('starting', 'Pushing DroidLink device agent...');

    const serverJar = getScrcpyServerPath();
    await this.adb.push(this.serial, serverJar, DEVICE_SERVER_PATH, 30000);

    if (this.stopped) return;

    const scid = Math.floor(Math.random() * 0x7fffffff);
    const scidHex = scid.toString(16).padStart(8, '0');
    const socketName = `scrcpy_${scidHex}`;
    this.remoteSocketName = `localabstract:${socketName}`;

    let tunnelForward = false;
    let reversePort = 0;

    // Prefer adb reverse so the phone connects directly to our listening socket
    try {
      const srv = net.createServer();
      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => resolve());
      });
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        throw new Error('Invalid reverse server address');
      }
      reversePort = addr.port;
      this.reverseServer = srv;
      await this.adb.reverse(this.serial, this.remoteSocketName, reversePort);
    } catch {
      if (this.reverseServer) {
        this.reverseServer.close();
        this.reverseServer = null;
      }
      tunnelForward = true;
      this.forwardPort = await findFreePort();
      await this.adb.forward(this.serial, this.forwardPort, this.remoteSocketName);
    }

    if (this.stopped) {
      await this.cleanupTunnels();
      return;
    }

    const expectedSockets = this.options.audio ? 3 : 2;
    const acceptedPromise = !tunnelForward && this.reverseServer
      ? this.waitForReverseConnections(this.reverseServer, expectedSockets, 10000)
      : null;

    const args = [
      'shell',
      `CLASSPATH=${DEVICE_SERVER_PATH}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      SCRCPY_SERVER_VERSION,
      `scid=${scidHex}`,
      'log_level=info',
      `video_codec=${this.options.videoCodec}`,
      `video_bit_rate=${this.options.videoBitRate}`,
      ...(this.options.maxSize > 0 ? [`max_size=${this.options.maxSize}`] : []),
      ...(this.options.maxFps > 0 ? [`max_fps=${this.options.maxFps}`] : []),
      `audio=${this.options.audio}`,
      ...(this.options.audio ? [`audio_codec=${this.options.audioCodec}`] : []),
      ...(tunnelForward ? ['tunnel_forward=true'] : []),
      ...(this.options.stayAwake ? ['stay_awake=true'] : []),
      ...(this.options.showTouches ? ['show_touches=true'] : []),
      ...(this.options.powerOffOnClose ? ['power_off_on_close=true'] : []),
      `clipboard_autosync=${this.options.clipboardAutosync}`,
      'cleanup=true',
      'power_on=true',
    ];

    this.emitStatus('starting', 'Starting screen capture on phone...');

    let serverLogTail = '';
    const proc = this.adb.spawnDevice(this.serial, args);
    this.serverProc = proc;

    proc.stdout?.on('data', (chunk: Buffer) => {
      serverLogTail = (serverLogTail + chunk.toString('utf8')).slice(-2000);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      serverLogTail = (serverLogTail + chunk.toString('utf8')).slice(-2000);
    });
    proc.on('exit', (code) => {
      if (!this.stopped) {
        const msg = serverLogTail.trim() || `Device agent exited (code ${code ?? 'unknown'})`;
        this.emitStatus('stopped', msg);
        void this.stop();
      }
    });

    let initialVideoChunk: Buffer | null = null;
    try {
      if (acceptedPromise) {
        const sockets = await acceptedPromise;
        this.reverseServer?.close();
        this.reverseServer = null;
        await this.adb.reverseRemove(this.serial, this.remoteSocketName);
        this.remoteSocketName = null;

        this.videoSocket = sockets[0];
        if (this.options.audio) {
          this.audioSocket = sockets[1];
          this.controlSocket = sockets[2];
        } else {
          this.controlSocket = sockets[1];
        }
      } else if (this.forwardPort !== null) {
        const vConn = await connectWithRetry(this.forwardPort, true, 10000);
        this.videoSocket = vConn.socket;
        initialVideoChunk = vConn.initialChunk;

        if (this.options.audio) {
          const aConn = await connectWithRetry(this.forwardPort, false, 5000);
          this.audioSocket = aConn.socket;
        }
        const cConn = await connectWithRetry(this.forwardPort, false, 5000);
        this.controlSocket = cConn.socket;

        await this.adb.forwardRemove(this.serial, this.forwardPort);
        this.forwardPort = null;
      }
    } catch (err) {
      const detail = serverLogTail.trim()
        ? `${(err as Error).message} (${serverLogTail.trim()})`
        : (err as Error).message;
      await this.stop();
      throw new Error(detail);
    }

    if (this.stopped) {
      await this.stop();
      return;
    }

    this.setupVideoStream(tunnelForward, initialVideoChunk);
    if (this.audioSocket) {
      this.setupAudioStream();
    }
    this.setupControlStream();

    if (this.options.turnScreenOff) {
      this.sendControl({ type: 10 /* SET_DISPLAY_POWER */, on: false });
    }
  }

  private waitForReverseConnections(
    server: net.Server,
    count: number,
    timeoutMs: number,
  ): Promise<net.Socket[]> {
    return new Promise((resolve, reject) => {
      const sockets: net.Socket[] = [];
      const timer = setTimeout(() => {
        server.removeListener('connection', onConn);
        for (const s of sockets) s.destroy();
        reject(new Error('Timed out waiting for phone to connect back over ADB reverse'));
      }, timeoutMs);

      const onConn = (socket: net.Socket) => {
        socket.setNoDelay(true);
        sockets.push(socket);
        if (sockets.length === count) {
          clearTimeout(timer);
          server.removeListener('connection', onConn);
          resolve(sockets);
        }
      };

      server.on('connection', onConn);
    });
  }

  private setupVideoStream(expectDummyByte: boolean, initialChunk: Buffer | null): void {
    if (!this.videoSocket) return;
    this.videoSocket.setNoDelay(true);

    const demuxer = new ScrcpyStreamDemuxer({
      expectDummyByte,
      expectDeviceMeta: true,
    });

    const handleChunk = (chunk: Buffer) => {
      try {
        const events = demuxer.push(chunk);
        for (const ev of events) {
          if (ev.kind === 'device_meta') {
            this.deviceName = ev.deviceName;
          } else if (ev.kind === 'codec') {
            const payload: VideoCodecEvent = { serial: this.serial, codecId: ev.codecId };
            this.emit('video:codec', payload);
          } else if (ev.kind === 'session') {
            this.width = ev.width;
            this.height = ev.height;
            const payload: VideoSessionEvent = {
              serial: this.serial,
              width: ev.width,
              height: ev.height,
              clientResized: ev.clientResized,
            };
            this.emit('video:session', payload);
            this.emitStatus('streaming', 'Mirroring active');
          } else if (ev.kind === 'packet') {
            const payload: VideoPacketEvent = {
              serial: this.serial,
              isConfig: ev.isConfig,
              isKeyFrame: ev.isKeyFrame,
              pts: Number(ev.pts),
              data: ev.data,
            };
            this.emit('video:packet', payload);
          } else if (ev.kind === 'stream_disabled' && ev.error) {
            this.emitStatus('error', 'Device video encoder configuration failed');
          }
        }
      } catch (err) {
        this.emitStatus('error', (err as Error).message);
        void this.stop();
      }
    };

    if (initialChunk && initialChunk.length > 0) {
      handleChunk(initialChunk);
    }

    this.videoSocket.on('data', handleChunk);
    this.videoSocket.on('close', () => {
      if (!this.stopped) {
        this.emitStatus('stopped', 'Video stream closed');
        void this.stop();
      }
    });
    this.videoSocket.on('error', (err) => {
      if (!this.stopped) {
        this.emitStatus('error', err.message);
        void this.stop();
      }
    });
  }

  private setupAudioStream(): void {
    if (!this.audioSocket) return;
    this.audioSocket.setNoDelay(true);

    const demuxer = new ScrcpyStreamDemuxer({
      expectDummyByte: false,
      expectDeviceMeta: false,
    });

    this.audioSocket.on('data', (chunk: Buffer) => {
      try {
        const events = demuxer.push(chunk);
        for (const ev of events) {
          if (ev.kind === 'stream_disabled') {
            this.emit('audio:disabled', { serial: this.serial, error: ev.error });
            this.audioSocket?.destroy();
            this.audioSocket = null;
            return;
          } else if (ev.kind === 'codec') {
            this.emit('audio:codec', { serial: this.serial, codecId: ev.codecId });
          } else if (ev.kind === 'packet') {
            const payload: AudioPacketEvent = {
              serial: this.serial,
              isConfig: ev.isConfig,
              pts: Number(ev.pts),
              data: ev.data,
            };
            this.emit('audio:packet', payload);
          }
        }
      } catch {
        // Non-fatal: disable audio without tearing down video
        this.audioSocket?.destroy();
        this.audioSocket = null;
      }
    });
  }

  private setupControlStream(): void {
    if (!this.controlSocket) return;
    this.controlSocket.setNoDelay(true);

    const parser = new DeviceMessageParser();

    this.controlSocket.on('data', (chunk: Buffer) => {
      try {
        const messages = parser.push(chunk);
        for (const msg of messages) {
          if (msg.type === DEVICE_MSG_TYPE.CLIPBOARD) {
            this.emit('device:clipboard', { serial: this.serial, text: msg.text });
          } else if (msg.type === DEVICE_MSG_TYPE.ACK_CLIPBOARD) {
            this.emit('device:ack_clipboard', { serial: this.serial, sequence: Number(msg.sequence) });
          }
        }
      } catch {
        // ignore malformed control response
      }
    });
  }

  sendControl(message: ControlMessage): boolean {
    if (this.stopped || !this.controlSocket || this.controlSocket.destroyed) {
      return false;
    }
    const bytes = serializeControlMessage(message);
    this.controlSocket.write(bytes);
    return true;
  }

  sendRawControl(bytes: Uint8Array): boolean {
    if (this.stopped || !this.controlSocket || this.controlSocket.destroyed) {
      return false;
    }
    this.controlSocket.write(bytes);
    return true;
  }

  private emitStatus(state: SessionStatusEvent['state'], message?: string): void {
    const ev: SessionStatusEvent = {
      serial: this.serial,
      state,
      deviceName: this.deviceName || undefined,
      width: this.width || undefined,
      height: this.height || undefined,
      message,
    };
    this.emit('status', ev);
  }

  private async cleanupTunnels(): Promise<void> {
    if (this.reverseServer) {
      this.reverseServer.close();
      this.reverseServer = null;
    }
    if (this.remoteSocketName) {
      await this.adb.reverseRemove(this.serial, this.remoteSocketName);
      this.remoteSocketName = null;
    }
    if (this.forwardPort !== null) {
      await this.adb.forwardRemove(this.serial, this.forwardPort);
      this.forwardPort = null;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    this.videoSocket?.destroy();
    this.videoSocket = null;

    this.audioSocket?.destroy();
    this.audioSocket = null;

    this.controlSocket?.destroy();
    this.controlSocket = null;

    await this.cleanupTunnels();

    const proc = this.serverProc;
    this.serverProc = null;
    if (proc && !proc.killed) {
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill();
        }
      }, 600);
    }

    this.emitStatus('stopped', 'Session stopped');
  }
}
