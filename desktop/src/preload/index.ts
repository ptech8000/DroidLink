import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  AdbDeviceInfo,
  AudioPacketEvent,
  DeviceTelemetry,
  InstalledAppInfo,
  MdnsServiceInfo,
  RemoteFileEntry,
  SessionStatusEvent,
  StreamOptions,
  VideoCodecEvent,
  VideoPacketEvent,
  VideoSessionEvent,
} from '../../../shared/types';

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  // Drag-and-drop file path helper for sandbox/contextIsolation
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // ADB & devices
  listDevices: (): Promise<AdbDeviceInfo[]> => ipcRenderer.invoke('adb:list-devices'),
  listMdnsServices: (): Promise<MdnsServiceInfo[]> => ipcRenderer.invoke('adb:mdns-services'),
  pairDevice: (hostPort: string, code: string): Promise<string> =>
    ipcRenderer.invoke('adb:pair', hostPort, code),
  connectDevice: (hostPort: string): Promise<string> => ipcRenderer.invoke('adb:connect', hostPort),
  disconnectDevice: (hostPort?: string): Promise<string> =>
    ipcRenderer.invoke('adb:disconnect', hostPort),
  enableTcpIp: (
    serial: string,
    port?: number,
  ): Promise<{ ip: string; port: number; message: string }> =>
    ipcRenderer.invoke('adb:enable-tcpip', serial, port),
  restartAdbServer: (): Promise<void> => ipcRenderer.invoke('adb:restart-server'),
  getDeviceIp: (serial: string): Promise<string | null> => ipcRenderer.invoke('adb:get-ip', serial),

  // Sessions
  startSession: (serial: string, options: StreamOptions): Promise<void> =>
    ipcRenderer.invoke('session:start', serial, options),
  stopSession: (serial: string): Promise<void> => ipcRenderer.invoke('session:stop', serial),
  pushClipboard: (serial: string, paste = false): Promise<boolean> =>
    ipcRenderer.invoke('session:push-clipboard', serial, paste),
  sendControl: (serial: string, bytes: Uint8Array): void =>
    ipcRenderer.send('session:control', serial, bytes),

  onSessionStatus: (cb: (ev: SessionStatusEvent) => void) => subscribe('session:status', cb),
  onVideoCodec: (cb: (ev: VideoCodecEvent) => void) => subscribe('session:video-codec', cb),
  onVideoSession: (cb: (ev: VideoSessionEvent) => void) => subscribe('session:video-session', cb),
  onVideoPacket: (cb: (ev: VideoPacketEvent) => void) => subscribe('session:video-packet', cb),
  onAudioCodec: (cb: (ev: { serial: string; codecId: number }) => void) =>
    subscribe('session:audio-codec', cb),
  onAudioPacket: (cb: (ev: AudioPacketEvent) => void) => subscribe('session:audio-packet', cb),
  onAudioDisabled: (cb: (ev: { serial: string; error: boolean }) => void) =>
    subscribe('session:audio-disabled', cb),
  onDeviceClipboard: (cb: (ev: { serial: string; text: string }) => void) =>
    subscribe('session:clipboard', cb),

  // Files
  listFiles: (serial: string, dirPath: string): Promise<RemoteFileEntry[]> =>
    ipcRenderer.invoke('files:list', serial, dirPath),
  uploadFilesDialog: (serial: string, remoteDir: string): Promise<{ uploaded: number }> =>
    ipcRenderer.invoke('files:upload-dialog', serial, remoteDir),
  uploadFilePaths: (
    serial: string,
    localPaths: string[],
    remoteDir: string,
  ): Promise<{ uploaded: number }> =>
    ipcRenderer.invoke('files:upload-paths', serial, localPaths, remoteDir),
  downloadFileDialog: (serial: string, remotePath: string): Promise<boolean> =>
    ipcRenderer.invoke('files:download-dialog', serial, remotePath),
  mkdir: (serial: string, remotePath: string): Promise<void> =>
    ipcRenderer.invoke('files:mkdir', serial, remotePath),
  removeFile: (serial: string, remotePath: string): Promise<void> =>
    ipcRenderer.invoke('files:remove', serial, remotePath),

  // Apps
  listApps: (serial: string, includeSystem: boolean): Promise<InstalledAppInfo[]> =>
    ipcRenderer.invoke('apps:list', serial, includeSystem),
  installApkDialog: (serial: string): Promise<string | null> =>
    ipcRenderer.invoke('apps:install-dialog', serial),
  installApkPath: (serial: string, apkPath: string): Promise<string> =>
    ipcRenderer.invoke('apps:install-path', serial, apkPath),
  launchApp: (serial: string, pkg: string): Promise<string> =>
    ipcRenderer.invoke('apps:launch', serial, pkg),
  forceStopApp: (serial: string, pkg: string): Promise<void> =>
    ipcRenderer.invoke('apps:force-stop', serial, pkg),
  uninstallApp: (serial: string, pkg: string): Promise<string> =>
    ipcRenderer.invoke('apps:uninstall', serial, pkg),

  // Tools
  captureAndSaveScreenshot: (serial: string): Promise<string | null> =>
    ipcRenderer.invoke('tools:screenshot-save', serial),
  saveRecording: (bytes: Uint8Array, ext?: string): Promise<string | null> =>
    ipcRenderer.invoke('tools:save-recording', bytes, ext),
  runShell: (serial: string, command: string): Promise<string> =>
    ipcRenderer.invoke('tools:shell', serial, command),
  startLogcat: (serial: string): Promise<void> => ipcRenderer.invoke('tools:logcat-start', serial),
  stopLogcat: (serial: string): Promise<void> => ipcRenderer.invoke('tools:logcat-stop', serial),
  onLogcatData: (cb: (ev: { serial: string; text: string }) => void) =>
    subscribe('tools:logcat-data', cb),
  getTelemetry: (serial: string): Promise<DeviceTelemetry> =>
    ipcRenderer.invoke('tools:telemetry', serial),
};

export type DroidLinkApi = typeof api;

contextBridge.exposeInMainWorld('droidlink', api);
