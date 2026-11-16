import type { DroidLinkApi } from '../../preload';

type Listener = (payload: unknown) => void;

/**
 * fetch() wrapper for the DroidLink web bridge. The custom header is required by the
 * server: cross-site pages cannot add it without a CORS preflight, which is never granted.
 */
export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('X-DroidLink-Request', '1');
  return fetch(url, { ...init, headers, credentials: 'same-origin' });
}

async function rpc<T>(method: string, ...args: unknown[]): Promise<T> {
  const res = await apiFetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args }),
  });
  if (res.status === 401) {
    throw new Error('DroidLink web session expired — open the sign-in link from the DroidLink terminal again.');
  }
  const json = (await res.json()) as { ok: boolean; result?: T; error?: string };
  if (!json.ok) {
    throw new Error(json.error || `RPC ${method} failed`);
  }
  return json.result as T;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function pickFiles(accept?: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (accept) input.accept = accept;
    input.onchange = () => resolve(Array.from(input.files || []));
    input.click();
  });
}

export function installWebDroidLinkShim(): void {
  if (typeof window === 'undefined' || window.droidlink) return;

  const listeners = new Map<string, Set<Listener>>();
  const textDecoder = new TextDecoder('utf-8');
  const textEncoder = new TextEncoder();

  const emit = (channel: string, payload: unknown) => {
    const set = listeners.get(channel);
    if (!set) return;
    for (const cb of set) cb(payload);
  };

  let ws: WebSocket | null = null;
  const connectWs = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data) as { channel: string; payload: unknown };
        if (msg.channel === 'session:clipboard') {
          const clip = msg.payload as { text?: string };
          if (clip.text) {
            void navigator.clipboard?.writeText(clip.text).catch(() => {});
          }
        }
        emit(msg.channel, msg.payload);
        return;
      }

      const buf = new Uint8Array(ev.data as ArrayBuffer);
      if (buf.length < 12) return;
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const kind = buf[0];
      const flags = buf[1];
      const pts = view.getFloat64(2, false);
      const serialLen = view.getUint16(10, false);
      if (buf.length < 12 + serialLen) return;
      const serial = textDecoder.decode(buf.subarray(12, 12 + serialLen));
      const data = buf.subarray(12 + serialLen);

      if (kind === 1) {
        emit('session:video-packet', {
          serial,
          isConfig: (flags & 1) !== 0,
          isKeyFrame: (flags & 2) !== 0,
          pts,
          data,
        });
      } else if (kind === 2) {
        emit('session:audio-packet', {
          serial,
          isConfig: (flags & 1) !== 0,
          pts,
          data,
        });
      }
    };

    ws.onclose = () => {
      setTimeout(connectWs, 1200);
    };
  };
  connectWs();

  const subscribe = <T>(channel: string, cb: (payload: T) => void): (() => void) => {
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    const wrapped = cb as Listener;
    set.add(wrapped);
    return () => set?.delete(wrapped);
  };

  const api: DroidLinkApi = {
    getPathForFile: () => '',

    listDevices: () => rpc('listDevices'),
    listMdnsServices: () => rpc('listMdnsServices'),
    pairDevice: (hostPort, code) => rpc('pairDevice', hostPort, code),
    connectDevice: (hostPort) => rpc('connectDevice', hostPort),
    disconnectDevice: (hostPort) => rpc('disconnectDevice', hostPort),
    enableTcpIp: (serial, port) => rpc('enableTcpIp', serial, port),
    restartAdbServer: () => rpc('restartAdbServer'),
    getDeviceIp: (serial) => rpc('getDeviceIp', serial),

    startSession: (serial, options) => rpc('startSession', serial, options),
    stopSession: (serial) => rpc('stopSession', serial),
    pushClipboard: async (serial, paste = false) => {
      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch {
        text = window.prompt('Enter text to paste onto phone:') || '';
      }
      return rpc('pushClipboard', serial, paste, text);
    },
    sendControl: (serial, bytes) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const serialBytes = textEncoder.encode(serial);
      const out = new Uint8Array(3 + serialBytes.length + bytes.length);
      out[0] = 0x10;
      new DataView(out.buffer).setUint16(1, serialBytes.length, false);
      out.set(serialBytes, 3);
      out.set(bytes, 3 + serialBytes.length);
      ws.send(out);
    },

    onSessionStatus: (cb) => subscribe('session:status', cb),
    onVideoCodec: (cb) => subscribe('session:video-codec', cb),
    onVideoSession: (cb) => subscribe('session:video-session', cb),
    onVideoPacket: (cb) => subscribe('session:video-packet', cb),
    onAudioCodec: (cb) => subscribe('session:audio-codec', cb),
    onAudioPacket: (cb) => subscribe('session:audio-packet', cb),
    onAudioDisabled: (cb) => subscribe('session:audio-disabled', cb),
    onDeviceClipboard: (cb) => subscribe('session:clipboard', cb),

    listFiles: (serial, dirPath) => rpc('listFiles', serial, dirPath),
    uploadFilesDialog: async (serial, remoteDir) => {
      const files = await pickFiles(undefined, true);
      if (files.length === 0) return { uploaded: 0 };
      for (const file of files) {
        const res = await apiFetch(
          `/api/upload?serial=${encodeURIComponent(serial)}&dir=${encodeURIComponent(remoteDir)}&name=${encodeURIComponent(file.name)}`,
          { method: 'POST', body: await file.arrayBuffer() },
        );
        if (!res.ok) throw new Error(await res.text());
      }
      return { uploaded: files.length };
    },
    uploadFilePaths: async () => ({ uploaded: 0 }),
    downloadFileDialog: async (serial, remotePath) => {
      const res = await apiFetch(
        `/api/download?serial=${encodeURIComponent(serial)}&path=${encodeURIComponent(remotePath)}`,
      );
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      triggerDownload(blob, remotePath.split('/').pop() || 'download');
      return true;
    },
    mkdir: (serial, remotePath) => rpc('mkdir', serial, remotePath),
    removeFile: (serial, remotePath) => rpc('removeFile', serial, remotePath),

    listApps: (serial, includeSystem) => rpc('listApps', serial, includeSystem),
    installApkDialog: async (serial) => {
      const files = await pickFiles('.apk', false);
      if (files.length === 0) return null;
      const file = files[0];
      const res = await apiFetch(
        `/api/install-apk?serial=${encodeURIComponent(serial)}&name=${encodeURIComponent(file.name)}`,
        { method: 'POST', body: await file.arrayBuffer() },
      );
      const json = (await res.json()) as { ok: boolean; result?: string; error?: string };
      if (!json.ok) throw new Error(json.error || 'APK install failed');
      return json.result || 'Success';
    },
    installApkPath: async () => '',
    launchApp: (serial, pkg) => rpc('launchApp', serial, pkg),
    forceStopApp: (serial, pkg) => rpc('forceStopApp', serial, pkg),
    uninstallApp: (serial, pkg) => rpc('uninstallApp', serial, pkg),

    captureAndSaveScreenshot: async (serial) => {
      const res = await apiFetch(`/api/screenshot?serial=${encodeURIComponent(serial)}`);
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const name = `droidlink-${Date.now()}.png`;
      triggerDownload(blob, name);
      return name;
    },
    saveRecording: async (bytes, ext = 'webm') => {
      const name = `droidlink-rec-${Date.now()}.${ext}`;
      triggerDownload(new Blob([new Uint8Array(bytes)], { type: `video/${ext}` }), name);
      return name;
    },
    runShell: (serial, command) => rpc('runShell', serial, command),
    startLogcat: (serial) => rpc('startLogcat', serial),
    stopLogcat: (serial) => rpc('stopLogcat', serial),
    onLogcatData: (cb) => subscribe('tools:logcat-data', cb),
    getTelemetry: (serial) => rpc('getTelemetry', serial),
  };

  window.droidlink = api;
}
