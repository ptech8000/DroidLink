import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFileName,
  assertHostPort,
  assertPackageName,
  assertRemotePath,
  assertRemovableRemotePath,
  assertSerial,
  assertStreamOptions,
} from '../desktop/src/main/security/validate';
import { WebBridgeServer, type WebBridgeDeps } from '../desktop/src/main/web/WebBridgeServer';

const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuv';
const calls: string[] = [];

const deps = {
  adb: { listDevices: async () => (calls.push('listDevices'), []), push: async () => calls.push('push') },
  sessionManager: { sendRawControl: () => (calls.push('sendRawControl'), true) },
  fileService: { list: async () => (calls.push('listFiles'), [{ name: 'secret.jpg' }]) },
  appService: { installApk: async () => (calls.push('installApk'), 'Success') },
  toolsService: { runShell: async () => (calls.push('runShell'), 'ok') },
  rendererDir: path.resolve(__dirname, '../dist-renderer'),
  accessToken: TOKEN,
} as unknown as WebBridgeDeps;

let server: WebBridgeServer;
let port = 0;

interface Req {
  method?: string;
  urlPath: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

function request({ method = 'GET', urlPath, headers = {}, body }: Req): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      },
    );
    req.on('error', (e) => resolve({ status: 0, body: e.message, headers: {} }));
    if (body) req.write(body);
    req.end();
  });
}

const authCookie = () => `droidlink_session_${port}=${TOKEN}`;
const goodHeaders = () => ({
  Cookie: authCookie(),
  'X-DroidLink-Request': '1',
  'Content-Type': 'application/json',
  Origin: `http://127.0.0.1:${port}`,
});
const shellBody = JSON.stringify({ method: 'runShell', args: ['PHONE123', 'id'] });

function wsUpgrade(headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = '';
    s.on('connect', () => {
      const lines = [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ];
      s.write(lines.join('\r\n'));
    });
    s.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n')) {
        s.destroy();
        resolve(buf.split('\r\n')[0]);
      }
    });
    s.on('error', () => resolve(buf.split('\r\n')[0] || 'error'));
  });
}

beforeAll(async () => {
  server = new WebBridgeServer(deps);
  const url = await server.start(0);
  port = Number(new URL(url).port);
});

afterAll(() => server.stop());
beforeEach(() => {
  calls.length = 0;
});

describe('WebBridgeServer attack resistance', () => {
  it('A1: blocks cross-site CSRF (text/plain from evil origin) from running shell', async () => {
    const res = await request({
      method: 'POST',
      urlPath: '/api/rpc',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      body: shellBody,
    });
    expect(res.status).toBe(403);
    expect(calls).not.toContain('runShell');
  });

  it('A1b: blocks CSRF even when the browser attaches the victim cookie', async () => {
    const res = await request({
      method: 'POST',
      urlPath: '/api/rpc',
      headers: { Cookie: authCookie(), 'Content-Type': 'text/plain' },
      body: shellBody,
    });
    expect(res.status).toBe(403); // missing X-DroidLink-Request header
    expect(calls).not.toContain('runShell');
  });

  it('A2: blocks drive-by APK install from another website', async () => {
    const res = await request({
      method: 'POST',
      urlPath: '/api/install-apk?serial=PHONE123',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/octet-stream' },
      body: 'PK',
    });
    expect(res.status).toBe(403);
    expect(calls).not.toContain('installApk');
  });

  it('A3: blocks DNS rebinding (foreign Host header) even with valid credentials', async () => {
    const res = await request({
      method: 'POST',
      urlPath: '/api/rpc',
      headers: { ...goodHeaders(), Host: `rebind.evil.example:${port}`, Origin: `http://rebind.evil.example:${port}` },
      body: JSON.stringify({ method: 'listFiles', args: ['PHONE123', '/sdcard'] }),
    });
    expect(res.status).toBe(421);
    expect(res.body).not.toContain('secret.jpg');
  });

  it('A4: rejects cross-site WebSocket hijacking and unauthenticated sockets', async () => {
    expect(await wsUpgrade({ Origin: 'https://evil.example', Cookie: authCookie() })).toContain('403');
    expect(await wsUpgrade({ Cookie: authCookie() })).toContain('403'); // no Origin
    expect(await wsUpgrade({ Origin: `http://127.0.0.1:${port}` })).toContain('401'); // no cookie
    expect(await wsUpgrade({ Origin: `http://127.0.0.1:${port}`, Cookie: authCookie() })).toContain('101');
  });

  it('A5: requires the secret token — local processes without it are refused', async () => {
    const { Cookie: _c, ...noCookie } = goodHeaders();
    const res = await request({ method: 'POST', urlPath: '/api/rpc', headers: noCookie, body: shellBody });
    expect(res.status).toBe(401);
    const wrong = await request({
      method: 'POST',
      urlPath: '/api/rpc',
      headers: { ...goodHeaders(), Cookie: `droidlink_session_${port}=guess` },
      body: shellBody,
    });
    expect(wrong.status).toBe(401);
    expect(calls).not.toContain('runShell');
  });

  it('A6: rejects oversized RPC bodies with 413', async () => {
    const res = await request({
      method: 'POST',
      urlPath: '/api/rpc',
      headers: goodHeaders(),
      body: Buffer.alloc(2 * 1024 * 1024, 0x41),
    });
    expect([0, 413]).toContain(res.status);
  });

  it('allows the legitimate signed-in UI', async () => {
    const res = await request({ method: 'POST', urlPath: '/api/rpc', headers: goodHeaders(), body: shellBody });
    expect(res.status).toBe(200);
    expect(calls).toContain('runShell');
  });

  it('sign-in link sets an HttpOnly SameSite=Strict cookie; wrong token is refused', async () => {
    const ok = await request({ urlPath: `/?token=${TOKEN}` });
    expect(ok.status).toBe(302);
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    const bad = await request({ urlPath: '/?token=nope' });
    expect(bad.status).toBe(403);
    expect(bad.headers['set-cookie']).toBeUndefined();
  });

  it('serves anti-clickjacking and CSP headers, and locks index.html without sign-in', async () => {
    const res = await request({ urlPath: '/' });
    expect(res.status).toBe(401);
    expect(res.headers['x-frame-options']).toBe('DENY');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain(`ws://127.0.0.1:${port}`);

    // Case-insensitive Windows FS must not bypass index.html lock screen
    const upper = await request({ urlPath: '/INDEX.HTML' });
    expect(upper.status).toBe(401);

    // Path traversal outside rendererDir is rejected
    const trav = await request({ urlPath: '/..%2Fpackage.json', headers: { Cookie: authCookie() } });
    expect(trav.status).toBe(404);
  });

  it('rejects invalid RPC arguments with 400 before touching adb', async () => {
    const res = await request({
      method: 'POST',
      urlPath: '/api/rpc',
      headers: goodHeaders(),
      body: JSON.stringify({ method: 'runShell', args: [{ evil: true }, 'id'] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('input validation', () => {
  const baseOptions = {
    videoCodec: 'h264',
    maxSize: 0,
    maxFps: 0,
    videoBitRate: 8_000_000,
    audio: true,
    audioCodec: 'opus',
    stayAwake: true,
    showTouches: false,
    turnScreenOff: false,
    powerOffOnClose: false,
    clipboardAutosync: true,
  };

  it('blocks shell injection through stream options', () => {
    expect(() => assertStreamOptions({ ...baseOptions, videoCodec: 'h264; reboot' })).toThrow();
    expect(() => assertStreamOptions({ ...baseOptions, videoBitRate: '8000000;rm -rf /sdcard' })).toThrow();
    expect(() => assertStreamOptions({ ...baseOptions, audio: 'true && reboot' })).toThrow();
    expect(assertStreamOptions(baseOptions).videoCodec).toBe('h264');
  });

  it('rejects adb option injection via serial / host / path', () => {
    expect(() => assertSerial('-a')).toThrow();
    expect(() => assertSerial('abc;reboot')).toThrow();
    expect(assertSerial('192.0.2.10:5555')).toBe('192.0.2.10:5555');
    expect(() => assertHostPort('--help:1')).toThrow();
    expect(assertHostPort(' 192.0.2.10:5555 ')).toBe('192.0.2.10:5555');
    expect(() => assertRemotePath('-a')).toThrow();
    expect(() => assertRemotePath('relative/path')).toThrow();
    expect(() => assertRemotePath('/sdcard/a\nb')).toThrow();
  });

  it('refuses to rm -rf protected storage roots', () => {
    for (const p of ['/', '/sdcard', '/sdcard/', '/storage/emulated/0', '/data', '/sdcard/../']) {
      expect(() => assertRemovableRemotePath(p)).toThrow();
    }
    expect(assertRemovableRemotePath('/sdcard/Download/old.zip')).toBe('/sdcard/Download/old.zip');
  });

  it('sanitizes file and package names', () => {
    expect(assertFileName('C:\\Users\\x\\photo.jpg')).toBe('photo.jpg');
    expect(() => assertFileName('..')).toThrow();
    expect(() => assertFileName('a"b')).toThrow();
    expect(assertPackageName('com.transsion.camera')).toBe('com.transsion.camera');
    expect(() => assertPackageName("com.x'; reboot; '")).toThrow();
  });
});
