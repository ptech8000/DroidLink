import { spawn } from 'node:child_process';
import path from 'node:path';
import { AdbBridge } from './adb/AdbBridge';
import { AppService } from './services/AppService';
import { DeviceToolsService } from './services/DeviceToolsService';
import { FileService } from './services/FileService';
import { SessionManager } from './session/SessionManager';
import { WebBridgeServer } from './web/WebBridgeServer';

async function main(): Promise<void> {
  const adb = new AdbBridge();
  const sessionManager = new SessionManager(adb);
  const fileService = new FileService(adb);
  const appService = new AppService(adb);
  const toolsService = new DeviceToolsService(adb);

  const rendererDir = path.resolve(__dirname, '../../../../dist-renderer');
  const webServer = new WebBridgeServer({
    adb,
    sessionManager,
    fileService,
    appService,
    toolsService,
    rendererDir,
  });

  sessionManager.addSink((ch, payload) => webServer.broadcastEvent(ch, payload));
  toolsService.addSink((ch, payload) => webServer.broadcastEvent(ch, payload));

  await webServer.start(47321);
  const launchUrl = webServer.getLaunchUrl();
  console.log('[DroidLink] Web interface is protected by a one-time secret token.');
  console.log(`[DroidLink] Sign in (keep this link private): ${launchUrl}`);

  await adb.startServer().catch(() => {
    // Will retry on first poll
  });

  if (process.platform === 'win32' && process.env.DROIDLINK_NO_OPEN !== '1') {
    // No shell involved: the URL is passed as a single argv element.
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', launchUrl], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  }

  const shutdown = async () => {
    toolsService.stopAll();
    await sessionManager.stopAll();
    webServer.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main();
