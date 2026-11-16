import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  AppWindow,
  Battery,
  Eye,
  EyeOff,
  FolderOpen,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  ScrollText,
  Sliders,
  Smartphone,
  Terminal,
  Thermometer,
  Volume2,
  Wifi,
} from 'lucide-react';
import { CONTROL_MSG_TYPE, serializeControlMessage } from '@shared/protocol';
import type {
  AdbDeviceInfo,
  DeviceTelemetry,
  SessionStatusEvent,
  StreamOptions,
} from '@shared/types';
import { AudioPlayer } from './components/AudioPlayer';
import { ControlToolbar } from './components/ControlToolbar';
import { DeviceSidebar } from './components/DeviceSidebar';
import { MirrorCanvas } from './components/MirrorCanvas';
import { StreamSettingsModal } from './components/StreamSettingsModal';
import { WirelessModal } from './components/WirelessModal';
import { AppManagerPanel } from './components/tools/AppManagerPanel';
import { DeviceInfoPanel } from './components/tools/DeviceInfoPanel';
import { FileManagerPanel } from './components/tools/FileManagerPanel';
import { LogcatPanel } from './components/tools/LogcatPanel';
import { ShellPanel } from './components/tools/ShellPanel';
import {
  evaluateDeviceHealth,
  getReconnectDelayMs,
  loadPreferences,
  MAX_RECONNECT_ATTEMPTS,
  savePreferences,
  STREAM_PRESETS,
} from './utils/streamConfig';

type ToolTab = 'files' | 'apps' | 'shell' | 'logcat' | 'info';

export const App: React.FC = () => {
  const initialPrefs = useMemo(() => loadPreferences(), []);
  const [devices, setDevices] = useState<AdbDeviceInfo[]>([]);
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null);
  const [streamingSerials, setStreamingSerials] = useState<Set<string>>(new Set());
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, SessionStatusEvent>>({});
  const [streamOptions, setStreamOptions] = useState<StreamOptions>(initialPrefs.streamOptions);
  const [autoReconnect, setAutoReconnect] = useState<boolean>(initialPrefs.autoReconnect);
  const [audioVolume, setAudioVolume] = useState<number>(initialPrefs.audioVolume);

  const [wirelessOpen, setWirelessOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState<boolean>(initialPrefs.toolsOpen);
  const [cleanStage, setCleanStage] = useState(false);
  const [deckHidden, setDeckHidden] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [activeTool, setActiveTool] = useState<ToolTab>('info');

  const [screenOff, setScreenOff] = useState(false);
  const [audioMuted, setAudioMuted] = useState(false);
  const [recording, setRecording] = useState(false);
  const [viewRotation, setViewRotation] = useState<0 | 90 | 180 | 270>(0);
  const [telemetry, setTelemetry] = useState<DeviceTelemetry | null>(null);
  const [reconnectingMap, setReconnectingMap] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<{ msg: string; isError?: boolean } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const zoomFnRef = useRef<((dir: 'in' | 'out') => void) | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  const intendedOptionsRef = useRef<Map<string, StreamOptions>>(new Map());
  const restartingSerialsRef = useRef<Set<string>>(new Set());
  const reconnectAttemptsRef = useRef<Map<string, number>>(new Map());
  const reconnectTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const autoReconnectRef = useRef(autoReconnect);
  autoReconnectRef.current = autoReconnect;
  const criticalWarnedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    savePreferences({ streamOptions, autoReconnect, audioVolume, toolsOpen });
  }, [streamOptions, autoReconnect, audioVolume, toolsOpen]);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const showToast = useCallback((msg: string, isError = false) => {
    setToast({ msg, isError });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const refreshDevices = useCallback(async () => {
    try {
      const list = await window.droidlink.listDevices();
      setDevices(list);
      setSelectedSerial((prev) => {
        if (prev && list.some((d) => d.serial === prev)) return prev;
        return list[0]?.serial ?? null;
      });
    } catch {
      // ignore transient poll errors
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    const id = setInterval(() => void refreshDevices(), 2500);
    return () => clearInterval(id);
  }, [refreshDevices]);

  const clearReconnectTimer = useCallback((serial: string) => {
    const existing = reconnectTimersRef.current.get(serial);
    if (existing !== undefined) {
      clearTimeout(existing);
      reconnectTimersRef.current.delete(serial);
    }
  }, []);

  const cancelAutoReconnect = useCallback(
    (serial: string) => {
      intendedOptionsRef.current.delete(serial);
      restartingSerialsRef.current.delete(serial);
      reconnectAttemptsRef.current.delete(serial);
      clearReconnectTimer(serial);
      setReconnectingMap((prev) => {
        if (!(serial in prev)) return prev;
        const next = { ...prev };
        delete next[serial];
        return next;
      });
    },
    [clearReconnectTimer],
  );

  useEffect(() => {
    return () => {
      for (const timer of reconnectTimersRef.current.values()) {
        clearTimeout(timer);
      }
      reconnectTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const unsub = window.droidlink.onSessionStatus((ev) => {
      setSessionStatuses((prev) => ({ ...prev, [ev.serial]: ev }));
      setStreamingSerials((prev) => {
        const next = new Set(prev);
        if (ev.state === 'starting' || ev.state === 'streaming') {
          next.add(ev.serial);
        } else {
          next.delete(ev.serial);
        }
        return next;
      });

      if (ev.state === 'starting') {
        restartingSerialsRef.current.delete(ev.serial);
        return;
      }

      if (ev.state === 'streaming') {
        restartingSerialsRef.current.delete(ev.serial);
        reconnectAttemptsRef.current.delete(ev.serial);
        clearReconnectTimer(ev.serial);
        setReconnectingMap((prev) => {
          if (!(ev.serial in prev)) return prev;
          const next = { ...prev };
          delete next[ev.serial];
          return next;
        });
        return;
      }

      if (ev.state === 'error' && ev.message) {
        showToast(ev.message, true);
      }

      // Unexpected drop: schedule auto-reconnect if enabled and not an intentional stop/restart
      if (restartingSerialsRef.current.has(ev.serial)) {
        restartingSerialsRef.current.delete(ev.serial);
        return;
      }

      const savedOptions = intendedOptionsRef.current.get(ev.serial);
      if (autoReconnectRef.current && savedOptions && !reconnectTimersRef.current.has(ev.serial)) {
        const attempt = (reconnectAttemptsRef.current.get(ev.serial) ?? 0) + 1;
        if (attempt > MAX_RECONNECT_ATTEMPTS) {
          cancelAutoReconnect(ev.serial);
          showToast(`Auto-reconnect stopped after ${MAX_RECONNECT_ATTEMPTS} attempts`, true);
          return;
        }
        reconnectAttemptsRef.current.set(ev.serial, attempt);
        setReconnectingMap((prev) => ({ ...prev, [ev.serial]: attempt }));
        const delayMs = getReconnectDelayMs(attempt - 1);
        const timer = setTimeout(() => {
          reconnectTimersRef.current.delete(ev.serial);
          const opts = intendedOptionsRef.current.get(ev.serial);
          if (!opts || !autoReconnectRef.current) return;
          void (async () => {
            try {
              // If wireless IP:port temporarily vanished, ask ADB to re-attach before starting scrcpy
              if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ev.serial)) {
                await window.droidlink.connectDevice(ev.serial).catch(() => {});
              }
              await window.droidlink.startSession(ev.serial, opts);
            } catch {
              // Next 'error'/'stopped' event (or explicit failure below) will advance retry count
            }
          })();
        }, delayMs);
        reconnectTimersRef.current.set(ev.serial, timer);
      }
    });
    return unsub;
  }, [showToast, clearReconnectTimer, cancelAutoReconnect]);

  const startMirror = useCallback(
    async (serial: string, customOptions?: StreamOptions) => {
      const effectiveOptions = customOptions ?? streamOptions;
      clearReconnectTimer(serial);
      reconnectAttemptsRef.current.delete(serial);
      intendedOptionsRef.current.set(serial, effectiveOptions);
      restartingSerialsRef.current.add(serial);
      setReconnectingMap((prev) => {
        if (!(serial in prev)) return prev;
        const next = { ...prev };
        delete next[serial];
        return next;
      });

      setSelectedSerial(serial);
      setScreenOff(effectiveOptions.turnScreenOff);
      try {
        await window.droidlink.startSession(serial, effectiveOptions);
      } catch (err) {
        restartingSerialsRef.current.delete(serial);
        showToast((err as Error).message, true);
      }
    },
    [streamOptions, showToast, clearReconnectTimer],
  );

  const stopMirror = useCallback(
    async (serial: string) => {
      cancelAutoReconnect(serial);
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }
      await window.droidlink.stopSession(serial);
      setScreenOff(false);
      setViewRotation(0);
    },
    [cancelAutoReconnect],
  );

  const cycleViewRotation = useCallback(() => {
    setViewRotation((prev) => {
      const order: readonly (0 | 90 | 180 | 270)[] = [0, 270, 180, 90];
      const next = order[(order.indexOf(prev) + 1) % order.length];
      showToast(next === 0 ? 'Mirror view: portrait (0°)' : `Mirror view rotated ${next}°`);
      return next;
    });
  }, [showToast]);

  const handleEnableWifiFromUsb = async (serial: string) => {
    try {
      showToast('Switching USB phone to Wi-Fi ADB (port 5555)...');
      const res = await window.droidlink.enableTcpIp(serial, 5555);
      showToast(`Connected wirelessly to ${res.ip}:${res.port}. You can unplug USB.`);
      await refreshDevices();
      setSelectedSerial(`${res.ip}:${res.port}`);
    } catch (err) {
      showToast((err as Error).message, true);
    }
  };

  const handleDisconnectWireless = async (serial: string) => {
    try {
      cancelAutoReconnect(serial);
      if (streamingSerials.has(serial)) {
        await stopMirror(serial);
      }
      await window.droidlink.disconnectDevice(serial);
      showToast(`Disconnected ${serial}`);
      await refreshDevices();
    } catch (err) {
      showToast((err as Error).message, true);
    }
  };

  const handleToggleScreenOff = () => {
    if (!selectedSerial) return;
    const nextOff = !screenOff;
    setScreenOff(nextOff);
    window.droidlink.sendControl(
      selectedSerial,
      serializeControlMessage({
        type: CONTROL_MSG_TYPE.SET_DISPLAY_POWER,
        on: !nextOff,
      }),
    );
  };

  const handleToggleRecording = () => {
    if (recording && recorderRef.current) {
      recorderRef.current.stop();
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) {
      showToast('Start mirroring before recording', true);
      return;
    }

    try {
      const videoStream = canvas.captureStream(60);
      const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()];
      const audioTracks = audioStreamRef.current?.getAudioTracks() ?? [];
      const hasAudio = streamOptions.audio && audioTracks.length > 0;
      if (hasAudio) {
        tracks.push(...audioTracks);
      }
      const combined = new MediaStream(tracks);

      const candidates = hasAudio
        ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        : ['video/webm;codecs=vp9', 'video/webm'];
      const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';

      const rec = new MediaRecorder(combined, {
        mimeType,
        videoBitsPerSecond: 6_000_000,
        ...(hasAudio ? { audioBitsPerSecond: 128_000 } : {}),
      });
      recordedChunksRef.current = [];

      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) recordedChunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        setRecording(false);
        const blob = new Blob(recordedChunksRef.current, { type: mimeType });
        void blob.arrayBuffer().then(async (ab) => {
          const saved = await window.droidlink.saveRecording(new Uint8Array(ab), 'webm');
          if (saved) showToast(`Saved recording: ${saved.split(/[\\/]/).pop()}`);
        });
      };

      rec.start(500);
      recorderRef.current = rec;
      setRecording(true);
      showToast(hasAudio ? 'Recording started (video + phone audio)' : 'Recording started (video only)');
    } catch (err) {
      showToast(`Recording error: ${(err as Error).message}`, true);
    }
  };

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (stageRef.current) {
        await stageRef.current.requestFullscreen();
      }
    } catch (err) {
      showToast(`Fullscreen unavailable: ${(err as Error).message}`, true);
    }
  }, [showToast]);

  const selectedDevice = devices.find((d) => d.serial === selectedSerial) ?? null;
  const isSelectedStreaming = selectedSerial ? streamingSerials.has(selectedSerial) : false;
  const isSelectedReconnecting = selectedSerial ? selectedSerial in reconnectingMap : false;
  const isSelectedReady = selectedDevice?.state === 'device';

  const fetchTelemetry = useCallback(async () => {
    if (!selectedSerial || !isSelectedReady) {
      setTelemetry(null);
      return;
    }
    try {
      const data = await window.droidlink.getTelemetry(selectedSerial);
      setTelemetry(data);
      for (const alert of evaluateDeviceHealth(data)) {
        const key = `${selectedSerial}:${alert.id}:${alert.level}`;
        if (alert.level === 'crit' && !criticalWarnedRef.current.has(key)) {
          criticalWarnedRef.current.add(key);
          showToast(alert.message, true);
        }
      }
    } catch {
      // Ignore transient telemetry polling failures
    }
  }, [selectedSerial, isSelectedReady, showToast]);

  useEffect(() => {
    setTelemetry(null);
    if (!selectedSerial || !isSelectedReady) return;
    void fetchTelemetry();
    const id = setInterval(() => void fetchTelemetry(), 20_000);
    return () => clearInterval(id);
  }, [selectedSerial, isSelectedReady, fetchTelemetry]);

  const healthAlerts = useMemo(() => evaluateDeviceHealth(telemetry), [telemetry]);

  const activePresetLabel = useMemo(() => {
    const match = STREAM_PRESETS.find((preset) =>
      Object.entries(preset.options).every(
        ([k, v]) => streamOptions[k as keyof StreamOptions] === v,
      ),
    );
    return match ? match.label : `${Math.round(streamOptions.videoBitRate / 1_000_000)} Mbps`;
  }, [streamOptions]);

  const toolTabs: { id: ToolTab; label: string; icon: React.ReactNode }[] = [
    { id: 'info', label: 'Info', icon: <Activity className="w-3.5 h-3.5" /> },
    { id: 'files', label: 'Files', icon: <FolderOpen className="w-3.5 h-3.5" /> },
    { id: 'apps', label: 'Apps', icon: <AppWindow className="w-3.5 h-3.5" /> },
    { id: 'shell', label: 'Shell', icon: <Terminal className="w-3.5 h-3.5" /> },
    { id: 'logcat', label: 'Logs', icon: <ScrollText className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="h-screen w-screen flex bg-[#070b12] text-slate-100 select-none overflow-hidden">
      {!cleanStage && (
        <DeviceSidebar
          devices={devices}
          selectedSerial={selectedSerial}
          streamingSerials={streamingSerials}
          onSelect={setSelectedSerial}
          onStartMirror={(s) => void startMirror(s)}
          onStopMirror={(s) => void stopMirror(s)}
          onEnableWifiFromUsb={(s) => void handleEnableWifiFromUsb(s)}
          onDisconnectWireless={(s) => void handleDisconnectWireless(s)}
          onOpenWirelessModal={() => setWirelessOpen(true)}
          onRefresh={() => void refreshDevices()}
          onRestartAdb={() =>
            void window.droidlink
              .restartAdbServer()
              .then(() => {
                showToast('ADB server restarted');
                return refreshDevices();
              })
              .catch((e: Error) => showToast(e.message, true))
          }
        />
      )}

      {/* Center Stage */}
      <main className="flex-1 flex flex-col min-w-0 relative">
        {/* Unified Studio Top Bar */}
        {!cleanStage && (
          <header className="h-13 px-4 border-b border-white/[0.07] flex items-center justify-between gap-3 bg-[#0a101b]/95 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              {selectedDevice ? (
                <>
                  <span className="text-sm font-semibold text-white truncate">
                    {selectedDevice.model || selectedDevice.device || selectedDevice.serial}
                  </span>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/[0.06] border border-white/[0.07] text-slate-300 uppercase shrink-0">
                    {selectedDevice.transport}
                  </span>
                  <button
                    onClick={() => setSettingsOpen(true)}
                    title="Click to switch Stream Preset or Bitrate"
                    className="hidden sm:flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-sky-500/10 hover:bg-sky-500/20 border border-sky-400/25 text-sky-300 shrink-0 transition"
                  >
                    <Sliders className="w-3 h-3" />
                    {activePresetLabel}
                  </button>

                  {telemetry && healthAlerts.length === 0 && (
                    <span className="hidden lg:flex items-center gap-2 px-2.5 py-0.5 rounded-full text-[10px] font-mono tabular-nums bg-white/[0.04] border border-white/[0.06] text-slate-300 shrink-0">
                      {telemetry.batteryLevel !== null && (
                        <span className="flex items-center gap-1 text-emerald-400">
                          <Battery className="w-3 h-3" />
                          {telemetry.batteryLevel}%
                        </span>
                      )}
                      {telemetry.batteryTempC !== null && (
                        <span className="flex items-center gap-1 text-slate-400">
                          <Thermometer className="w-3 h-3" />
                          {telemetry.batteryTempC}°C
                        </span>
                      )}
                    </span>
                  )}

                  {healthAlerts.map((alert) => (
                    <span
                      key={alert.id}
                      title={alert.message}
                      className={`px-2 py-0.5 rounded-full text-[10px] font-semibold flex items-center gap-1 shrink-0 border ${
                        alert.level === 'crit'
                          ? 'bg-rose-950/80 border-rose-500/50 text-rose-200'
                          : 'bg-amber-950/70 border-amber-500/40 text-amber-200'
                      }`}
                    >
                      <AlertTriangle className="w-3 h-3" />
                      {alert.shortLabel}
                    </span>
                  ))}
                </>
              ) : (
                <span className="text-xs text-slate-400">Select or connect an Android device</span>
              )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {isSelectedStreaming && streamOptions.audio && (
                <div
                  className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-white/[0.04] border border-white/[0.07] text-xs text-slate-300"
                  title={`Speaker monitor volume: ${Math.round(audioVolume * 100)}%`}
                >
                  <Volume2 className="w-3.5 h-3.5 text-sky-400" />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={Math.round(audioVolume * 100)}
                    onChange={(e) => setAudioVolume(Number(e.target.value) / 100)}
                    className="w-16 accent-sky-400 cursor-pointer"
                  />
                </div>
              )}

              {isSelectedReady && !isSelectedStreaming && !isSelectedReconnecting && selectedSerial && (
                <button
                  onClick={() => void startMirror(selectedSerial)}
                  className="px-3.5 py-1.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold shadow-sm shadow-sky-500/25 transition"
                >
                  Start Mirror
                </button>
              )}

              {(isSelectedStreaming || isSelectedReconnecting) && (
                <div className="flex items-center rounded-xl bg-white/[0.04] border border-white/[0.07] p-0.5">
                  <button
                    onClick={() => setCleanStage(true)}
                    title="Hide sidebars for clean OBS / streaming view"
                    className="px-2.5 py-1 rounded-lg hover:bg-white/[0.08] text-xs text-slate-300 hover:text-white flex items-center gap-1.5 transition"
                  >
                    <EyeOff className="w-3.5 h-3.5" />
                    Clean
                  </button>
                  <button
                    onClick={() => void toggleFullscreen()}
                    title="Fullscreen stage"
                    className="px-2.5 py-1 rounded-lg hover:bg-white/[0.08] text-xs text-slate-300 hover:text-white flex items-center gap-1.5 transition"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    Full
                  </button>
                </div>
              )}

              <button
                onClick={() => setToolsOpen((v) => !v)}
                className={`px-2.5 py-1.5 rounded-xl border text-xs flex items-center gap-1.5 transition ${
                  toolsOpen
                    ? 'bg-sky-500/15 border-sky-400/30 text-sky-200'
                    : 'bg-white/[0.04] hover:bg-white/[0.08] border-white/[0.07] text-slate-300'
                }`}
              >
                {toolsOpen ? (
                  <PanelRightClose className="w-3.5 h-3.5" />
                ) : (
                  <PanelRightOpen className="w-3.5 h-3.5" />
                )}
                Inspector
              </button>
            </div>
          </header>
        )}

        {/* Main Mirror + Studio Control Deck */}
        <div
          ref={stageRef}
          className={`relative flex-1 flex min-h-0 bg-[#070b12] ${
            cleanStage || isFullscreen ? 'p-1.5 gap-2' : 'p-3 gap-3'
          }`}
        >
          {(cleanStage || isFullscreen) && (
            <div className="absolute top-3 right-4 z-30 flex items-center gap-1.5">
              <button
                onClick={() => setDeckHidden((v) => !v)}
                title={deckHidden ? 'Show Studio Control Deck' : 'Hide Control Deck for clean OBS capture'}
                className="px-2.5 py-1 rounded-full bg-slate-950/85 hover:bg-slate-900 border border-white/[0.12] text-[11px] text-slate-200 flex items-center gap-1.5 shadow-lg backdrop-blur"
              >
                {deckHidden ? 'Show Controls' : 'Hide Controls'}
              </button>
              {cleanStage && !isFullscreen && (
                <button
                  onClick={() => {
                    setCleanStage(false);
                    setDeckHidden(false);
                  }}
                  className="px-2.5 py-1 rounded-full bg-slate-950/85 hover:bg-slate-900 border border-white/[0.12] text-[11px] text-slate-200 flex items-center gap-1.5 shadow-lg backdrop-blur"
                >
                  <Eye className="w-3.5 h-3.5 text-sky-400" />
                  Show Panels
                </button>
              )}
              {isFullscreen && (
                <button
                  onClick={() => void toggleFullscreen()}
                  className="px-2.5 py-1 rounded-full bg-slate-950/85 hover:bg-slate-900 border border-white/[0.12] text-[11px] text-slate-200 flex items-center gap-1.5 shadow-lg backdrop-blur"
                >
                  <Minimize2 className="w-3.5 h-3.5 text-sky-400" />
                  Exit Fullscreen
                </button>
              )}
            </div>
          )}

          {selectedSerial && (isSelectedStreaming || isSelectedReconnecting) ? (
            <>
              <MirrorCanvas
                serial={selectedSerial}
                sessionStatus={sessionStatuses[selectedSerial] ?? null}
                recording={recording}
                viewRotation={viewRotation}
                cleanMode={cleanStage || isFullscreen}
                reconnectingAttempt={reconnectingMap[selectedSerial] ?? null}
                maxReconnectAttempts={MAX_RECONNECT_ATTEMPTS}
                onCancelReconnect={() => cancelAutoReconnect(selectedSerial)}
                onStopRecording={handleToggleRecording}
                onToast={showToast}
                canvasRefOut={canvasRef}
                zoomFnRef={zoomFnRef}
              />
              <AudioPlayer
                serial={selectedSerial}
                enabled={streamOptions.audio}
                muted={audioMuted}
                volume={audioVolume}
                audioStreamRef={audioStreamRef}
                onAudioUnavailable={(msg) => showToast(msg)}
              />
              {!(cleanStage && deckHidden) && !(isFullscreen && deckHidden) && (
                <ControlToolbar
                  serial={selectedSerial}
                  screenOff={screenOff}
                  onToggleScreenOff={handleToggleScreenOff}
                  audioMuted={audioMuted}
                  onToggleAudioMuted={() => setAudioMuted((m) => !m)}
                  audioEnabled={streamOptions.audio}
                  recording={recording}
                  onToggleRecording={handleToggleRecording}
                  viewRotation={viewRotation}
                  onCycleViewRotation={cycleViewRotation}
                  onZoomIn={() => zoomFnRef.current?.('in')}
                  onZoomOut={() => zoomFnRef.current?.('out')}
                  isFullscreen={isFullscreen}
                  onToggleFullscreen={() => void toggleFullscreen()}
                  activePresetLabel={activePresetLabel}
                  onOpenSettings={() => {
                    if (document.fullscreenElement) void document.exitFullscreen();
                    setSettingsOpen(true);
                  }}
                  onToast={showToast}
                />
              )}
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center studio-stage-bg rounded-2xl border border-white/[0.07] p-8 text-center">
              <div className="w-16 h-16 rounded-3xl bg-gradient-to-br from-sky-500/20 to-indigo-500/10 border border-sky-400/25 flex items-center justify-center mb-4 shadow-xl shadow-sky-950/30">
                <Smartphone className="w-8 h-8 text-sky-400" />
              </div>
              <h2 className="text-lg font-semibold text-white">
                {selectedDevice
                  ? `${selectedDevice.model || selectedDevice.serial} is ${
                      selectedDevice.state === 'device' ? 'ready to mirror' : selectedDevice.state
                    }`
                  : 'Connect your phone via USB or Wi-Fi'}
              </h2>
              <p className="text-xs text-slate-400 max-w-md mt-2 leading-relaxed">
                {selectedDevice?.state === 'device'
                  ? `Preset active: ${activePresetLabel}. Start mirroring to control your screen, zoom your camera, record video with phone audio, or manage files.`
                  : 'Enable USB debugging or Wireless debugging in Settings → Developer options on your phone, then connect via USB cable or Wi-Fi.'}
              </p>

              <div className="flex items-center flex-wrap justify-center gap-2.5 mt-6">
                {isSelectedReady && selectedSerial && (
                  <button
                    onClick={() => void startMirror(selectedSerial)}
                    className="px-5 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold text-sm shadow-lg shadow-sky-500/20 transition"
                  >
                    Start Mirroring
                  </button>
                )}
                <button
                  onClick={() => setSettingsOpen(true)}
                  className="px-4 py-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.08] text-slate-200 font-medium text-sm flex items-center gap-2 transition"
                >
                  <Sliders className="w-4 h-4 text-sky-400" />
                  Stream Preset
                </button>
                <button
                  onClick={() => setWirelessOpen(true)}
                  className="px-4 py-2.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.08] text-slate-200 font-medium text-sm flex items-center gap-2 transition"
                >
                  <Wifi className="w-4 h-4 text-sky-400" />
                  Wireless Setup
                </button>
              </div>
            </div>
          )}

          {/* Toast placed inside stageRef so notifications stay visible in Fullscreen as well */}
          {toast && (
            <div
              className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl text-xs font-medium shadow-2xl border backdrop-blur ${
                toast.isError
                  ? 'bg-rose-950/90 border-rose-500/50 text-rose-200'
                  : 'bg-slate-900/95 border-sky-500/40 text-slate-100'
              }`}
            >
              {toast.msg}
            </div>
          )}
        </div>
      </main>

      {/* Right Feature Inspector Drawer */}
      {toolsOpen && !cleanStage && (
        <aside className="w-[376px] shrink-0 flex flex-col bg-[#0a101b]/95 border-l border-white/[0.07]">
          <div className="p-2 border-b border-white/[0.07] bg-white/[0.02]">
            <div className="grid grid-cols-5 gap-1 p-1 rounded-xl bg-slate-950/80 border border-white/[0.06]">
              {toolTabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTool(tab.id)}
                  className={`py-1.5 px-1 rounded-lg flex items-center justify-center gap-1 text-[11px] font-medium transition ${
                    activeTool === tab.id
                      ? 'bg-sky-500/20 text-sky-200 border border-sky-400/30 shadow-sm'
                      : 'border border-transparent text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 min-h-0">
            {!selectedSerial || !isSelectedReady ? (
              <div className="h-full flex items-center justify-center p-6 text-center text-xs text-slate-500">
                Connect and authorize a phone to use File Manager, App Manager, Shell, Logcat, and Telemetry.
              </div>
            ) : activeTool === 'info' ? (
              <DeviceInfoPanel
                serial={selectedSerial}
                telemetry={telemetry}
                onRefreshTelemetry={fetchTelemetry}
              />
            ) : activeTool === 'files' ? (
              <FileManagerPanel serial={selectedSerial} onToast={showToast} />
            ) : activeTool === 'apps' ? (
              <AppManagerPanel serial={selectedSerial} onToast={showToast} />
            ) : activeTool === 'shell' ? (
              <ShellPanel serial={selectedSerial} />
            ) : (
              <LogcatPanel serial={selectedSerial} />
            )}
          </div>
        </aside>
      )}

      <WirelessModal
        open={wirelessOpen}
        onClose={() => setWirelessOpen(false)}
        onConnected={(msg) => {
          showToast(msg);
          void refreshDevices();
        }}
      />

      <StreamSettingsModal
        open={settingsOpen}
        options={streamOptions}
        autoReconnect={autoReconnect}
        onChange={setStreamOptions}
        onChangeAutoReconnect={setAutoReconnect}
        onClose={() => setSettingsOpen(false)}
        onApplyRestart={
          selectedSerial && (isSelectedStreaming || isSelectedReconnecting)
            ? () => void startMirror(selectedSerial, streamOptions)
            : undefined
        }
      />
    </div>
  );
};
