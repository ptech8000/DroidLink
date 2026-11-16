import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StreamOptions } from '../../../shared/types';
import { AdbBridge } from './adb/AdbBridge';
import { assertRecordingExt, assertSerial } from './security/validate';
import { AppService } from './services/AppService';
import { DeviceToolsService } from './services/DeviceToolsService';
import { FileService } from './services/FileService';
import { SessionManager } from './session/SessionManager';
import { WebBridgeServer } from './web/WebBridgeServer';

let mainWindow: BrowserWindow | null = null;

// Avoid Windows DirectComposition IDCompositionDevice4 failures / blank windows on unsupported GPU drivers
app.commandLine.appendSwitch('disable-features', 'DirectComposition');
if (process.env.DROIDLINK_SW_GPU === '1') {
  app.disableHardwareAcceleration();
}

const adb = new AdbBridge();
const sessionManager = new SessionManager(adb);
const fileService = new FileService(adb);
const appService = new AppService(adb);
const toolsService = new DeviceToolsService(adb);

const prodRendererDir = path.resolve(__dirname, '../../../../dist-renderer');
const webServer = new WebBridgeServer({
  adb,
  sessionManager,
  fileService,
  appService,
  toolsService,
  rendererDir: prodRendererDir,
});

sessionManager.addSink((ch, payload) => webServer.broadcastEvent(ch, payload));
toolsService.addSink((ch, payload) => webServer.broadcastEvent(ch, payload));

const prodIndexUrl = pathToFileURL(path.join(prodRendererDir, 'index.html')).href;

function isTrustedRendererUrl(url: string): boolean {
  const devUrl = process.env.DROIDLINK_DEV_URL;
  if (devUrl) {
    try {
      if (new URL(url).origin === new URL(devUrl).origin) return true;
    } catch {
      return false;
    }
  }
  const cleanUrl = url.split('#')[0].split('?')[0];
  return process.platform === 'win32'
    ? cleanUrl.toLowerCase() === prodIndexUrl.toLowerCase()
    : cleanUrl === prodIndexUrl;
}

function isTrustedSender(e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame;
  return (
    !!mainWindow &&
    !mainWindow.isDestroyed() &&
    e.sender === mainWindow.webContents &&
    !!frame &&
    frame === mainWindow.webContents.mainFrame &&
    isTrustedRendererUrl(frame.url)
  );
}

function assertTrustedSender(e: Electron.IpcMainInvokeEvent): void {
  if (!isTrustedSender(e)) {
    throw new Error('Blocked IPC call from untrusted frame');
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    show: true,
    center: true,
    skipTaskbar: false,
    title: 'DroidLink — Android Screen & Control',
    backgroundColor: '#0b0f17',
    webPreferences: {
      preload: path.resolve(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  // The app window must never navigate away or spawn new windows (phishing / RCE pivots).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  sessionManager.attachWindow(mainWindow);
  toolsService.attachWindow(mainWindow);

  const bringToFront = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.show();
    mainWindow.moveTop();
    app.focus({ steal: true });
    mainWindow.focus();
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(false);
      }
    }, 400);
  };

  mainWindow.once('ready-to-show', () => {
    bringToFront();
    console.log('[DroidLink] Window opened.');
  });

  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }, 2500);

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[DroidLink] did-fail-load (${code}): ${desc} @ ${url}`);
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[DroidLink] render-process-gone: ${details.reason} (exitCode=${details.exitCode})`);
  });

  if (process.env.DROIDLINK_DIAG === '1') {
    mainWindow.webContents.on('console-message', (_e, level, msg) => {
      console.log(`[Renderer:${level}] ${msg}`);
    });
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const info = await mainWindow?.webContents.executeJavaScript(
          '({ rootLen: document.getElementById("root")?.innerHTML.length ?? -1, hasBridge: typeof window.droidlink, text: document.body?.innerText?.slice(0, 200) })',
        );
        console.log('[DroidLink DIAG]', JSON.stringify(info));
        console.log('[DroidLink DIAG bounds]', JSON.stringify(mainWindow?.getBounds()), 'visible=', mainWindow?.isVisible());
      } catch (err) {
        console.error('[DroidLink DIAG error]', err);
      }
    });
  }

  const devUrl = process.env.DROIDLINK_DEV_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    const prodHtml = path.resolve(__dirname, '../../../../dist-renderer/index.html');
    void mainWindow.loadFile(prodHtml);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  // Every IPC call is rejected unless it comes from our own top-level renderer page.
  const handle = <A extends unknown[], R>(
    channel: string,
    fn: (e: Electron.IpcMainInvokeEvent, ...args: A) => R,
  ) => {
    ipcMain.handle(channel, (e, ...args) => {
      assertTrustedSender(e);
      return fn(e, ...(args as A));
    });
  };

  // ADB & Device discovery
  handle('adb:list-devices', () => adb.listDevices());
  handle('adb:mdns-services', () => adb.listMdnsServices());
  handle('adb:pair', (_e, hostPort: string, code: string) => adb.pair(hostPort, code));
  handle('adb:connect', (_e, hostPort: string) => adb.connect(hostPort));
  handle('adb:disconnect', (_e, hostPort?: string) => adb.disconnect(hostPort));
  handle('adb:enable-tcpip', (_e, serial: string, port?: number) =>
    adb.enableTcpIpAndConnect(serial, port),
  );
  handle('adb:restart-server', () => adb.restartServer());
  handle('adb:get-ip', (_e, serial: string) => adb.getDeviceIp(serial));

  // Mirroring sessions
  handle('session:start', (_e, serial: string, options: StreamOptions) =>
    sessionManager.startSession(serial, options),
  );
  handle('session:stop', (_e, serial: string) => sessionManager.stopSession(serial));
  handle('session:push-clipboard', (_e, serial: string, paste: boolean) =>
    sessionManager.pushPcClipboardToDevice(serial, paste === true),
  );
  ipcMain.on('session:control', (e, serial: string, bytes: Uint8Array) => {
    if (!isTrustedSender(e)) return;
    sessionManager.sendRawControl(serial, bytes);
  });

  // File manager
  handle('files:list', (_e, serial: string, dirPath: string) =>
    fileService.list(serial, dirPath),
  );
  handle('files:upload-dialog', async (_e, serial: string, remoteDir: string) => {
    if (!mainWindow) return { uploaded: 0 };
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Upload files to phone',
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled || res.filePaths.length === 0) return { uploaded: 0 };
    await fileService.upload(serial, res.filePaths, remoteDir);
    return { uploaded: res.filePaths.length };
  });
  handle('files:upload-paths', async (_e, serial: string, localPaths: string[], remoteDir: string) => {
    await fileService.upload(serial, localPaths, remoteDir);
    return { uploaded: localPaths.length };
  });
  handle('files:download-dialog', async (_e, serial: string, remotePath: string) => {
    if (!mainWindow) return false;
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save file from phone',
      defaultPath: path.posix.basename(String(remotePath)),
    });
    if (res.canceled || !res.filePath) return false;
    await fileService.download(serial, remotePath, res.filePath);
    return true;
  });
  handle('files:mkdir', (_e, serial: string, remotePath: string) =>
    fileService.mkdir(serial, remotePath),
  );
  handle('files:remove', (_e, serial: string, remotePath: string) =>
    fileService.remove(serial, remotePath),
  );

  // Apps
  handle('apps:list', (_e, serial: string, includeSystem: boolean) =>
    appService.listPackages(serial, includeSystem === true),
  );
  handle('apps:install-dialog', async (_e, serial: string) => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Install APK on phone',
      filters: [{ name: 'Android Package', extensions: ['apk'] }],
      properties: ['openFile'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return appService.installApk(serial, res.filePaths[0]);
  });
  handle('apps:install-path', (_e, serial: string, apkPath: string) =>
    appService.installApk(serial, apkPath),
  );
  handle('apps:launch', (_e, serial: string, pkg: string) =>
    appService.launch(serial, pkg),
  );
  handle('apps:force-stop', (_e, serial: string, pkg: string) =>
    appService.forceStop(serial, pkg),
  );
  handle('apps:uninstall', (_e, serial: string, pkg: string) =>
    appService.uninstall(serial, pkg),
  );

  // Tools (screenshot, recording save, shell, logcat, telemetry)
  handle('tools:screenshot-save', async (_e, serial: string) => {
    const pngBytes = await toolsService.captureScreenshot(serial);
    if (!mainWindow) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Phone Screenshot',
      defaultPath: `droidlink-${stamp}.png`,
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await fs.writeFile(res.filePath, pngBytes);
    return res.filePath;
  });
  handle('tools:save-recording', async (_e, bytes: Uint8Array, rawExt?: string) => {
    if (!mainWindow) return null;
    const ext = assertRecordingExt(rawExt);
    if (!(bytes instanceof Uint8Array)) throw new Error('Invalid recording data');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Screen Recording',
      defaultPath: `droidlink-rec-${stamp}.${ext}`,
      filters: [{ name: 'Video Recording', extensions: [ext] }],
    });
    if (res.canceled || !res.filePath) return null;
    await fs.writeFile(res.filePath, bytes);
    return res.filePath;
  });
  handle('tools:shell', (_e, serial: string, command: string) =>
    toolsService.runShell(serial, command),
  );
  handle('tools:logcat-start', (_e, serial: string) =>
    toolsService.startLogcat(assertSerial(serial)),
  );
  handle('tools:logcat-stop', (_e, serial: string) => toolsService.stopLogcat(serial));
  handle('tools:telemetry', (_e, serial: string) => toolsService.getTelemetry(serial));
}

app.whenReady().then(async () => {
  // Deny every browser permission request (camera, mic, geolocation, notifications, ...).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  registerIpcHandlers();
  if (process.env.DROIDLINK_NO_WEB !== '1') {
    const webUrl = await webServer.start(47321).catch(() => null);
    if (webUrl) {
      console.log('[DroidLink] Browser interface is protected by a one-time secret token.');
      console.log(`[DroidLink] Sign in (keep this link private): ${webServer.getLaunchUrl()}`);
    }
  }
  createWindow();
  await adb.startServer().catch(() => {
    // Will retry on first poll
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  toolsService.stopAll();
  webServer.stop();
  void sessionManager.stopAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
