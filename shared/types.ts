export type ConnectionTransport = 'usb' | 'wireless';

export type DeviceStatus =
  | 'device'
  | 'unauthorized'
  | 'offline'
  | 'authorizing'
  | 'connecting';

export interface AdbDeviceInfo {
  serial: string;
  state: DeviceStatus;
  transport: ConnectionTransport;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
  ip?: string;
  port?: number;
  androidVersion?: string;
  sdkVersion?: number;
  batteryLevel?: number;
}

export interface MdnsServiceInfo {
  instanceName: string;
  serviceType: string;
  address: string;
  port: number;
}

export interface StreamOptions {
  videoCodec: 'h264' | 'h265';
  maxSize: number; // 0 = native
  maxFps: number;
  videoBitRate: number; // bps
  audio: boolean;
  audioCodec: 'opus' | 'aac';
  stayAwake: boolean;
  showTouches: boolean;
  turnScreenOff: boolean;
  powerOffOnClose: boolean;
  clipboardAutosync: boolean;
}

export interface SessionStatusEvent {
  serial: string;
  state: 'starting' | 'streaming' | 'stopped' | 'error';
  deviceName?: string;
  width?: number;
  height?: number;
  message?: string;
}

export interface VideoCodecEvent {
  serial: string;
  codecId: number;
}

export interface VideoSessionEvent {
  serial: string;
  width: number;
  height: number;
  clientResized: boolean;
}

export interface VideoPacketEvent {
  serial: string;
  isConfig: boolean;
  isKeyFrame: boolean;
  pts: number;
  data: Uint8Array;
}

export interface AudioPacketEvent {
  serial: string;
  isConfig: boolean;
  pts: number;
  data: Uint8Array;
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  permissions: string;
  modifiedAt: string;
}

export interface InstalledAppInfo {
  packageName: string;
  isSystem: boolean;
  apkPath?: string;
}

export interface DeviceTelemetry {
  manufacturer: string;
  model: string;
  brand: string;
  androidVersion: string;
  sdkVersion: string;
  resolution: string;
  density: string;
  batteryLevel: number | null;
  batteryStatus: string;
  batteryTempC: number | null;
  wifiIp: string | null;
  memTotalMb: number | null;
  memAvailableMb: number | null;
  storageSummary: string;
}
