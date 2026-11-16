import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Duplex, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  AudioPacketEvent,
  StreamOptions,
  VideoPacketEvent,
} from '../../../../shared/types';
import { AdbBridge } from '../adb/AdbBridge';
import {
  assertBoolean,
  assertFileName,
  assertOptionalString,
  assertRemotePath,
  assertSerial,
  ValidationError,
} from '../security/validate';
import { AppService } from '../services/AppService';
import { DeviceToolsService } from '../services/DeviceToolsService';
import { FileService } from '../services/FileService';
import { SessionManager } from '../session/SessionManager';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

/** Header every legitimate API call must carry. Custom headers force a CORS preflight,
 *  which this server never approves, so cross-site pages can't send it. */
export const CSRF_HEADER = 'x-droidlink-request';

const MAX_RPC_BODY = 1 * 1024 * 1024; // 1 MB
const MAX_UPLOAD_BODY = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_WS_FRAME = 1 * 1024 * 1024; // control messages are tiny
const MAX_WS_CLIENTS = 8;

function buildContentSecurityPolicy(port: number): string {
  const wsSelf = port > 0 ? ` ws://127.0.0.1:${port} ws://localhost:${port}` : '';
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self'${wsSelf}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

class WsClient {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly socket: Duplex,
    private readonly onBinary: (payload: Buffer) => void,
    private readonly onClose: () => void,
  ) {
    socket.on('data', (chunk: Buffer) => this.handleData(chunk));
    socket.on('close', () => this.onClose());
    socket.on('error', () => this.onClose());
  }

  sendText(data: unknown): void {
    if (this.socket.destroyed) return;
    const payload = Buffer.from(JSON.stringify(data), 'utf8');
    this.socket.write(encodeWsFrame(0x1, payload));
  }

  sendBinary(payload: Buffer): void {
    if (this.socket.destroyed) return;
    this.socket.write(encodeWsFrame(0x2, payload));
  }

  close(): void {
    if (!this.socket.destroyed) {
      this.socket.end(encodeWsFrame(0x8, Buffer.alloc(0)));
    }
  }

  private abort(): void {
    this.buffer = Buffer.alloc(0);
    this.socket.destroy();
    this.onClose();
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_WS_FRAME + 14) {
      this.abort();
      return;
    }

    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      // RFC 6455 §5.1: client-to-server frames MUST be masked.
      if (!masked) {
        this.abort();
        return;
      }

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_WS_FRAME)) {
          this.abort();
          return;
        }
        payloadLen = Number(big);
        offset = 10;
      }

      if (payloadLen > MAX_WS_FRAME) {
        this.abort();
        return;
      }

      if (this.buffer.length < offset + 4 + payloadLen) return;

      const maskKey = this.buffer.subarray(offset, offset + 4);
      offset += 4;

      const raw = Buffer.from(this.buffer.subarray(offset, offset + payloadLen));
      for (let i = 0; i < raw.length; i++) {
        raw[i] ^= maskKey[i & 3];
      }

      this.buffer = this.buffer.subarray(offset + payloadLen);

      if (opcode === 0x8) {
        this.socket.destroy();
        this.onClose();
        return;
      }
      if (opcode === 0x9) {
        if (raw.length > 125) {
          this.abort();
          return;
        }
        this.socket.write(encodeWsFrame(0xa, raw));
        continue;
      }
      if (opcode === 0x2) {
        this.onBinary(raw);
      }
    }
  }
}

export interface WebBridgeDeps {
  adb: AdbBridge;
  sessionManager: SessionManager;
  fileService: FileService;
  appService: AppService;
  toolsService: DeviceToolsService;
  rendererDir: string;
  /** Optional fixed token (tests). Defaults to a fresh 256-bit random secret per launch. */
  accessToken?: string;
}

export class WebBridgeServer {
  private server: http.Server | null = null;
  private clients = new Set<WsClient>();
  private port = 0;
  private readonly token: string;

  constructor(private readonly deps: WebBridgeDeps) {
    this.token = deps.accessToken ?? crypto.randomBytes(32).toString('base64url');
  }

  getUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** One-time sign-in link. Opening it sets an HttpOnly, SameSite=Strict session cookie. */
  getLaunchUrl(): string {
    return `${this.getUrl()}/?token=${this.token}`;
  }

  private get cookieName(): string {
    return `droidlink_session_${this.port}`;
  }

  private allowedHosts(): Set<string> {
    return new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`]);
  }

  private allowedOrigins(): Set<string> {
    return new Set([`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`]);
  }

  /** Blocks DNS rebinding: the Host header must be our loopback address. */
  private isHostAllowed(req: http.IncomingMessage): boolean {
    const host = req.headers.host;
    return typeof host === 'string' && this.allowedHosts().has(host.toLowerCase());
  }

  /** Blocks cross-site requests: a present Origin must be our own. */
  private isOriginAllowed(req: http.IncomingMessage, required: boolean): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return !required;
    return typeof origin === 'string' && this.allowedOrigins().has(origin.toLowerCase());
  }

  private isAuthenticated(req: http.IncomingMessage): boolean {
    const cookie = parseCookies(req.headers.cookie)[this.cookieName];
    return typeof cookie === 'string' && safeEqual(cookie, this.token);
  }

  async start(preferredPort = 47321): Promise<string> {
    this.server = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    this.server.requestTimeout = 10 * 60 * 1000;
    this.server.headersTimeout = 15_000;

    this.server.on('upgrade', (req, socket) => {
      const reject = (status: string) => {
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      };
      if (req.url !== '/ws') return reject('404 Not Found');
      // Browsers always send Origin on WebSocket handshakes; require it to stop
      // Cross-Site WebSocket Hijacking (watching the screen / injecting taps).
      if (!this.isHostAllowed(req) || !this.isOriginAllowed(req, true)) return reject('403 Forbidden');
      if (!this.isAuthenticated(req)) return reject('401 Unauthorized');
      if (this.clients.size >= MAX_WS_CLIENTS) return reject('503 Service Unavailable');

      const key = req.headers['sec-websocket-key'];
      if (!key || typeof key !== 'string') return reject('400 Bad Request');
      const accept = crypto
        .createHash('sha1')
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64');

      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          '',
        ].join('\r\n'),
      );

      const client = new WsClient(
        socket,
        (payload) => this.handleClientBinary(payload),
        () => this.clients.delete(client),
      );
      this.clients.add(client);
    });

    await new Promise<void>((resolve) => {
      const srv = this.server!;
      srv.once('error', () => {
        srv.listen(0, '127.0.0.1', () => resolve());
      });
      srv.listen(preferredPort, '127.0.0.1', () => resolve());
    });

    const addr = this.server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to bind web bridge server');
    }
    this.port = addr.port;
    return this.getUrl();
  }

  stop(): void {
    for (const c of this.clients) c.close();
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }

  broadcastEvent(channel: string, payload: unknown): void {
    if (this.clients.size === 0) return;

    if (channel === 'session:video-packet') {
      const ev = payload as VideoPacketEvent;
      const serialBytes = Buffer.from(ev.serial, 'utf8');
      const pkt = Buffer.allocUnsafe(1 + 1 + 8 + 2 + serialBytes.length + ev.data.length);
      pkt[0] = 1;
      pkt[1] = (ev.isConfig ? 1 : 0) | (ev.isKeyFrame ? 2 : 0);
      pkt.writeDoubleBE(ev.pts, 2);
      pkt.writeUInt16BE(serialBytes.length, 10);
      serialBytes.copy(pkt, 12);
      Buffer.from(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength).copy(
        pkt,
        12 + serialBytes.length,
      );
      for (const c of this.clients) c.sendBinary(pkt);
      return;
    }

    if (channel === 'session:audio-packet') {
      const ev = payload as AudioPacketEvent;
      const serialBytes = Buffer.from(ev.serial, 'utf8');
      const pkt = Buffer.allocUnsafe(1 + 1 + 8 + 2 + serialBytes.length + ev.data.length);
      pkt[0] = 2;
      pkt[1] = ev.isConfig ? 1 : 0;
      pkt.writeDoubleBE(ev.pts, 2);
      pkt.writeUInt16BE(serialBytes.length, 10);
      serialBytes.copy(pkt, 12);
      Buffer.from(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength).copy(
        pkt,
        12 + serialBytes.length,
      );
      for (const c of this.clients) c.sendBinary(pkt);
      return;
    }

    for (const c of this.clients) {
      c.sendText({ channel, payload });
    }
  }

  private handleClientBinary(buf: Buffer): void {
    if (buf.length < 3 || buf[0] !== 0x10) return;
    const serialLen = buf.readUInt16BE(1);
    if (serialLen === 0 || serialLen > 128 || buf.length <= 3 + serialLen) return;
    const serial = buf.subarray(3, 3 + serialLen).toString('utf8');
    const controlBytes = buf.subarray(3 + serialLen);
    this.deps.sessionManager.sendRawControl(serial, controlBytes);
  }

  private async readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) throw new HttpError(413, 'Request body too large');
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > limit) throw new HttpError(413, 'Request body too large');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /** Streams an upload to a private temp dir (no RAM buffering, unpredictable path). */
  private async receiveToTempFile(
    req: http.IncomingMessage,
    internalName = 'payload.bin',
  ): Promise<{ file: string; cleanup: () => Promise<void> }> {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_UPLOAD_BODY) throw new HttpError(413, 'Upload too large');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'droidlink-'));
    const file = path.join(dir, internalName);
    const cleanup = () => fsp.rm(dir, { recursive: true, force: true });
    let total = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        total += chunk.length;
        if (total > MAX_UPLOAD_BODY) cb(new HttpError(413, 'Upload too large'));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(req, limiter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
      await cleanup();
      throw err;
    }
    return { file, cleanup };
  }

  private setSecurityHeaders(res: http.ServerResponse): void {
    res.setHeader('Content-Security-Policy', buildContentSecurityPolicy(this.port));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  private sendLockedPage(res: http.ServerResponse, status: number): void {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><meta charset="utf-8"><title>DroidLink locked</title>' +
        '<body style="font-family:system-ui;background:#0b0f17;color:#e2e8f0;padding:3rem">' +
        '<h1>DroidLink is locked</h1><p>For your phone\'s safety, open the sign-in link ' +
        'printed in the DroidLink terminal window (it contains a one-time secret token).</p></body>',
    );
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.setSecurityHeaders(res);

    try {
      if (!this.isHostAllowed(req)) {
        throw new HttpError(421, 'Misdirected request (invalid Host header)');
      }
      if (!this.isOriginAllowed(req, false)) {
        throw new HttpError(403, 'Cross-origin request blocked');
      }

      const urlObj = new URL(req.url || '/', this.getUrl());
      const pathname = urlObj.pathname;

      // Sign-in: exchange the one-time URL token for an HttpOnly cookie, then strip it from the URL.
      if (pathname === '/' && urlObj.searchParams.has('token')) {
        const supplied = urlObj.searchParams.get('token') || '';
        if (!safeEqual(supplied, this.token)) {
          this.sendLockedPage(res, 403);
          return;
        }
        res.writeHead(302, {
          'Set-Cookie': `${this.cookieName}=${this.token}; HttpOnly; SameSite=Strict; Path=/`,
          Location: '/',
        });
        res.end();
        return;
      }

      if (pathname.startsWith('/api/')) {
        if (!this.isAuthenticated(req)) throw new HttpError(401, 'Not signed in');
        if (req.headers[CSRF_HEADER] !== '1') throw new HttpError(403, 'Missing request header');
        await this.handleApi(req, res, pathname, urlObj.searchParams);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        throw new HttpError(405, 'Method not allowed');
      }

      // Static renderer assets
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      if (rel.toLowerCase() === 'index.html' && !this.isAuthenticated(req)) {
        this.sendLockedPage(res, 401);
        return;
      }
      const root = path.resolve(this.deps.rendererDir);
      const fullPath = path.resolve(root, rel);
      if (
        !fullPath.startsWith(root + path.sep) ||
        !fs.existsSync(fullPath) ||
        !fs.statSync(fullPath).isFile()
      ) {
        throw new HttpError(404, 'Not found');
      }
      const ext = path.extname(fullPath);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      fs.createReadStream(fullPath).pipe(res);
    } catch (err) {
      const status =
        err instanceof HttpError ? err.status : err instanceof ValidationError ? 400 : 500;
      const mustCloseSocket = status === 413 || !req.complete;
      if (!res.headersSent) {
        if (mustCloseSocket) {
          res.setHeader('Connection', 'close');
          res.once('finish', () => req.socket?.destroy());
        }
        this.sendJson(res, status, { ok: false, error: (err as Error).message });
      } else {
        res.destroy();
        if (mustCloseSocket) req.socket?.destroy();
      }
    }
  }

  private async handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    params: URLSearchParams,
  ): Promise<void> {
    if (pathname === '/api/rpc' && req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        throw new HttpError(415, 'Content-Type must be application/json');
      }
      let body: { method?: unknown; args?: unknown };
      try {
        body = JSON.parse((await this.readBody(req, MAX_RPC_BODY)).toString('utf8'));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, 'Invalid JSON');
      }
      if (typeof body?.method !== 'string' || (body.args !== undefined && !Array.isArray(body.args))) {
        throw new HttpError(400, 'Invalid RPC request');
      }
      const result = await this.dispatchRpc(body.method, (body.args as unknown[]) || []);
      this.sendJson(res, 200, { ok: true, result: result ?? null });
      return;
    }

    if (pathname === '/api/screenshot' && req.method === 'GET') {
      const serial = assertSerial(params.get('serial'));
      const png = await this.deps.toolsService.captureScreenshot(serial);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Disposition': contentDisposition(`droidlink-${Date.now()}.png`),
      });
      res.end(Buffer.from(png));
      return;
    }

    if (pathname === '/api/download' && req.method === 'GET') {
      const serial = assertSerial(params.get('serial'));
      const remotePath = assertRemotePath(params.get('path'));
      const fileName = assertFileName(path.posix.basename(remotePath));
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'droidlink-'));
      // Fixed local filename avoids Windows reserved device names / invalid chars (e.g. ':').
      const tmpFile = path.join(dir, 'download.bin');
      try {
        await this.deps.fileService.download(serial, remotePath, tmpFile);
        const stat = await fsp.stat(tmpFile);
        if (!stat.isFile()) throw new HttpError(400, 'Only files can be downloaded');
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(stat.size),
          'Content-Disposition': contentDisposition(fileName),
        });
        await pipeline(fs.createReadStream(tmpFile), res);
      } finally {
        await fsp.rm(dir, { recursive: true, force: true });
      }
      return;
    }

    if (pathname === '/api/upload' && req.method === 'POST') {
      const serial = assertSerial(params.get('serial'));
      const remoteDir = assertRemotePath(params.get('dir') || '/sdcard/Download');
      const fileName = assertFileName(params.get('name') || `file-${Date.now()}`);
      const { file, cleanup } = await this.receiveToTempFile(req, 'upload.bin');
      try {
        const targetDir = remoteDir.endsWith('/') ? remoteDir : `${remoteDir}/`;
        await this.deps.adb.push(serial, file, `${targetDir}${fileName}`, 120000);
        this.sendJson(res, 200, { ok: true });
      } finally {
        await cleanup();
      }
      return;
    }

    if (pathname === '/api/install-apk' && req.method === 'POST') {
      const serial = assertSerial(params.get('serial'));
      const { file, cleanup } = await this.receiveToTempFile(req, 'upload.apk');
      try {
        const result = await this.deps.appService.installApk(serial, file);
        this.sendJson(res, 200, { ok: true, result });
      } finally {
        await cleanup();
      }
      return;
    }

    throw new HttpError(404, 'Unknown API endpoint');
  }

  private async dispatchRpc(method: string, args: unknown[]): Promise<unknown> {
    const { adb, sessionManager, fileService, appService, toolsService } = this.deps;
    const str = (i: number) => {
      const v = args[i];
      if (typeof v !== 'string') throw new ValidationError(`Argument ${i} must be a string`);
      return v;
    };
    const optStr = (i: number) => assertOptionalString(args[i], 255);
    switch (method) {
      case 'listDevices':
        return adb.listDevices();
      case 'listMdnsServices':
        return adb.listMdnsServices();
      case 'pairDevice':
        return adb.pair(str(0), str(1));
      case 'connectDevice':
        return adb.connect(str(0));
      case 'disconnectDevice':
        return adb.disconnect(optStr(0));
      case 'enableTcpIp':
        return adb.enableTcpIpAndConnect(str(0), args[1] as number | undefined);
      case 'restartAdbServer':
        return adb.restartServer();
      case 'getDeviceIp':
        return adb.getDeviceIp(str(0));
      case 'startSession':
        return sessionManager.startSession(str(0), args[1] as StreamOptions);
      case 'stopSession':
        return sessionManager.stopSession(str(0));
      case 'pushClipboard':
        return sessionManager.pushPcClipboardToDevice(
          str(0),
          assertBoolean(args[1]),
          assertOptionalString(args[2], 256_000),
        );
      case 'listFiles':
        return fileService.list(str(0), str(1));
      case 'mkdir':
        return fileService.mkdir(str(0), str(1));
      case 'removeFile':
        return fileService.remove(str(0), str(1));
      case 'listApps':
        return appService.listPackages(str(0), assertBoolean(args[1]));
      case 'launchApp':
        return appService.launch(str(0), str(1));
      case 'forceStopApp':
        return appService.forceStop(str(0), str(1));
      case 'uninstallApp':
        return appService.uninstall(str(0), str(1));
      case 'runShell':
        return toolsService.runShell(str(0), str(1));
      case 'startLogcat':
        return toolsService.startLogcat(assertSerial(args[0]));
      case 'stopLogcat':
        return toolsService.stopLogcat(str(0));
      case 'getTelemetry':
        return toolsService.getTelemetry(str(0));
      default:
        throw new HttpError(404, 'Unknown RPC method');
    }
  }
}
