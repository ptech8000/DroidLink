import React, { useEffect, useRef, useState } from 'react';
import {
  CODEC_ID,
  ConfigPacketMerger,
  CONTROL_MSG_TYPE,
  serializeControlMessage,
} from '@shared/protocol';
import type { SessionStatusEvent } from '@shared/types';
import { InputMapper, type PinchDirection, type PinchOverlayPoints } from '../input/InputMapper';
import { apiFetch } from '../web-shim';

interface MirrorCanvasProps {
  serial: string;
  sessionStatus: SessionStatusEvent | null;
  recording: boolean;
  viewRotation: 0 | 90 | 180 | 270;
  cleanMode?: boolean;
  reconnectingAttempt?: number | null;
  maxReconnectAttempts?: number;
  onCancelReconnect?: () => void;
  onStopRecording: () => void;
  onToast: (msg: string, isError?: boolean) => void;
  canvasRefOut: React.MutableRefObject<HTMLCanvasElement | null>;
  zoomFnRef?: React.MutableRefObject<((dir: PinchDirection) => void) | null>;
}

function extractH264CodecString(annexB: Uint8Array): string {
  // Scan for 3-byte or 4-byte Annex-B start codes to locate SPS (NAL type 7)
  for (let i = 0; i < annexB.length - 4; i++) {
    const is4 =
      annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 0 && annexB[i + 3] === 1;
    const is3 = !is4 && annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1;
    if (!is4 && !is3) continue;

    const nalOffset = i + (is4 ? 4 : 3);
    if (nalOffset + 3 >= annexB.length) break;
    const nalType = annexB[nalOffset] & 0x1f;
    if (nalType === 7) {
      const profile = annexB[nalOffset + 1].toString(16).padStart(2, '0');
      const compat = annexB[nalOffset + 2].toString(16).padStart(2, '0');
      const level = annexB[nalOffset + 3].toString(16).padStart(2, '0');
      return `avc1.${profile}${compat}${level}`;
    }
  }
  return 'avc1.640028';
}

export const MirrorCanvas: React.FC<MirrorCanvasProps> = ({
  serial,
  sessionStatus,
  recording,
  viewRotation,
  cleanMode = false,
  reconnectingAttempt = null,
  maxReconnectAttempts = 5,
  onCancelReconnect,
  onToast,
  canvasRefOut,
  zoomFnRef,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const geometryRef = useRef<{ width: number; height: number; viewRotation: 0 | 90 | 180 | 270 }>({
    width: 0,
    height: 0,
    viewRotation,
  });
  const viewRotationRef = useRef<0 | 90 | 180 | 270>(viewRotation);
  viewRotationRef.current = viewRotation;
  geometryRef.current.viewRotation = viewRotation;

  const [resolution, setResolution] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [fps, setFps] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [pinchOverlay, setPinchOverlay] = useState<PinchOverlayPoints>(null);

  const inputMapperRef = useRef<InputMapper | null>(null);
  if (!inputMapperRef.current) {
    inputMapperRef.current = new InputMapper(
      () => geometryRef.current,
      (bytes) => window.droidlink.sendControl(serial, bytes),
      setPinchOverlay,
    );
  }

  // Keep InputMapper bound to latest serial and register toolbar zoom action
  useEffect(() => {
    const mapper = new InputMapper(
      () => geometryRef.current,
      (bytes) => window.droidlink.sendControl(serial, bytes),
      setPinchOverlay,
    );
    inputMapperRef.current = mapper;
    if (zoomFnRef) {
      zoomFnRef.current = (dir) => mapper.performPinchZoom(dir);
    }
    return () => {
      mapper.dispose();
      if (zoomFnRef) {
        zoomFnRef.current = null;
      }
    };
  }, [serial, zoomFnRef]);

  // Attach non-passive wheel listener so Ctrl+Scroll / trackpad pinch can prevent browser page zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      inputMapperRef.current?.handleWheel(e);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    canvasRefOut.current = canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) return;

    let codecId: number = CODEC_ID.H264;
    let decoder: VideoDecoder | null = null;
    let configured = false;
    let waitingForKeyframe = true;
    const merger = new ConfigPacketMerger();

    let latestFrame: VideoFrame | null = null;
    let lastDrawnFrame: VideoFrame | null = null;
    let lastDrawnRot: 0 | 90 | 180 | 270 = viewRotationRef.current;
    let rafId = 0;
    let frameCounter = 0;
    let lastFpsTick = performance.now();

    const drawFrame = (frame: VideoFrame, rot: 0 | 90 | 180 | 270) => {
      const fw = frame.displayWidth;
      const fh = frame.displayHeight;
      const targetW = rot === 90 || rot === 270 ? fh : fw;
      const targetH = rot === 90 || rot === 270 ? fw : fh;

      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      ctx.save();
      if (rot === 90) {
        ctx.translate(targetW, 0);
        ctx.rotate(Math.PI / 2);
      } else if (rot === 180) {
        ctx.translate(targetW, targetH);
        ctx.rotate(Math.PI);
      } else if (rot === 270) {
        ctx.translate(0, targetH);
        ctx.rotate(-Math.PI / 2);
      }
      ctx.drawImage(frame, 0, 0, fw, fh);
      ctx.restore();
    };

    const renderLoop = () => {
      const rot = viewRotationRef.current;
      if (latestFrame) {
        const frame = latestFrame;
        latestFrame = null;
        drawFrame(frame, rot);
        if (lastDrawnFrame) {
          lastDrawnFrame.close();
        }
        lastDrawnFrame = frame;
        lastDrawnRot = rot;

        frameCounter++;
        const now = performance.now();
        if (now - lastFpsTick >= 1000) {
          setFps(Math.round((frameCounter * 1000) / (now - lastFpsTick)));
          frameCounter = 0;
          lastFpsTick = now;
        }
      } else if (lastDrawnFrame && lastDrawnRot !== rot) {
        // Re-render idle frame immediately when user toggles view rotation
        drawFrame(lastDrawnFrame, rot);
        lastDrawnRot = rot;
      }
      rafId = requestAnimationFrame(renderLoop);
    };
    rafId = requestAnimationFrame(renderLoop);

    const ensureDecoder = (codecString: string) => {
      if (decoder && decoder.state !== 'closed') {
        decoder.close();
      }
      configured = false;
      waitingForKeyframe = true;

      decoder = new VideoDecoder({
        output: (frame) => {
          if (latestFrame) {
            latestFrame.close();
          }
          latestFrame = frame;
        },
        error: (err) => {
          console.error('VideoDecoder error:', err);
          configured = false;
          waitingForKeyframe = true;
          window.droidlink.sendControl(
            serial,
            serializeControlMessage({ type: CONTROL_MSG_TYPE.RESET_VIDEO }),
          );
        },
      });

      decoder.configure({
        codec: codecString,
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: true,
      });
      configured = true;
    };

    const unsubCodec = window.droidlink.onVideoCodec((ev) => {
      if (ev.serial !== serial) return;
      codecId = ev.codecId;
      merger.reset();
      if (codecId === CODEC_ID.H265) {
        ensureDecoder('hvc1.1.6.L120.B0');
      } else {
        ensureDecoder('avc1.640028');
      }
    });

    const unsubSession = window.droidlink.onVideoSession((ev) => {
      if (ev.serial !== serial) return;
      geometryRef.current = {
        width: ev.width,
        height: ev.height,
        viewRotation: viewRotationRef.current,
      };
      setResolution({ width: ev.width, height: ev.height });
      // Reset decoder & config merger so orientation/size changes reconfigure cleanly
      configured = false;
      waitingForKeyframe = true;
      merger.reset();
    });

    const unsubPacket = window.droidlink.onVideoPacket((ev) => {
      if (ev.serial !== serial) return;

      if (ev.isConfig && codecId === CODEC_ID.H264) {
        const detected = extractH264CodecString(ev.data);
        if (!configured || !decoder || decoder.state === 'closed') {
          ensureDecoder(detected);
        }
      }

      const merged = merger.merge(ev.isConfig, ev.data);
      if (!merged) return;

      if (!decoder || decoder.state === 'closed' || !configured) {
        ensureDecoder(codecId === CODEC_ID.H265 ? 'hvc1.1.6.L120.B0' : 'avc1.640028');
      }

      if (waitingForKeyframe) {
        if (!ev.isKeyFrame) return;
        waitingForKeyframe = false;
      }

      // Drop excess queued chunks to preserve ultra-low latency
      if (decoder && decoder.decodeQueueSize > 4 && !ev.isKeyFrame) {
        return;
      }

      try {
        decoder?.decode(
          new EncodedVideoChunk({
            type: ev.isKeyFrame ? 'key' : 'delta',
            timestamp: ev.pts,
            data: merged,
          }),
        );
      } catch {
        waitingForKeyframe = true;
      }
    });

    return () => {
      cancelAnimationFrame(rafId);
      unsubCodec();
      unsubSession();
      unsubPacket();
      if (latestFrame) {
        latestFrame.close();
        latestFrame = null;
      }
      if (lastDrawnFrame) {
        lastDrawnFrame.close();
        lastDrawnFrame = null;
      }
      if (decoder && decoder.state !== 'closed') {
        decoder.close();
      }
      geometryRef.current = { width: 0, height: 0, viewRotation: viewRotationRef.current };
      setResolution({ width: 0, height: 0 });
      setFps(0);
    };
  }, [serial, canvasRefOut]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
      e.preventDefault();
      void window.droidlink.pushClipboard(serial, true);
      return;
    }
    if (
      (e.ctrlKey || e.metaKey) &&
      (e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd')
    ) {
      e.preventDefault();
      inputMapperRef.current?.performPinchZoom('in');
      return;
    }
    if (
      (e.ctrlKey || e.metaKey) &&
      (e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract')
    ) {
      e.preventDefault();
      inputMapperRef.current?.performPinchZoom('out');
      return;
    }
    inputMapperRef.current?.handleKeyDown(e);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const paths = files.map((f) => window.droidlink.getPathForFile(f)).filter(Boolean);
    try {
      const hasPaths = paths.length === files.length;
      if (hasPaths) {
        const apks = paths.filter((p) => p.toLowerCase().endsWith('.apk'));
        const others = paths.filter((p) => !p.toLowerCase().endsWith('.apk'));
        for (const apk of apks) {
          onToast(`Installing ${apk.split(/[\\/]/).pop()}...`);
          await window.droidlink.installApkPath(serial, apk);
          onToast(`Installed ${apk.split(/[\\/]/).pop()}`);
        }
        if (others.length > 0) {
          onToast(`Pushing ${others.length} file(s) to /sdcard/Download...`);
          await window.droidlink.uploadFilePaths(serial, others, '/sdcard/Download');
          onToast(`Uploaded ${others.length} file(s) to /sdcard/Download`);
        }
      } else {
        for (const file of files) {
          if (file.name.toLowerCase().endsWith('.apk')) {
            onToast(`Installing ${file.name}...`);
            const res = await apiFetch(
              `/api/install-apk?serial=${encodeURIComponent(serial)}&name=${encodeURIComponent(file.name)}`,
              { method: 'POST', body: await file.arrayBuffer() },
            );
            if (!res.ok) throw new Error(await res.text());
            onToast(`Installed ${file.name}`);
          } else {
            onToast(`Uploading ${file.name} to /sdcard/Download...`);
            const res = await apiFetch(
              `/api/upload?serial=${encodeURIComponent(serial)}&dir=${encodeURIComponent('/sdcard/Download')}&name=${encodeURIComponent(file.name)}`,
              { method: 'POST', body: await file.arrayBuffer() },
            );
            if (!res.ok) throw new Error(await res.text());
            onToast(`Uploaded ${file.name} to /sdcard/Download`);
          }
        }
      }
    } catch (err) {
      onToast((err as Error).message, true);
    }
  };

  const isStreaming = sessionStatus?.state === 'streaming' && resolution.width > 0;
  const displayWidth =
    viewRotation === 90 || viewRotation === 270 ? resolution.height : resolution.width;
  const displayHeight =
    viewRotation === 90 || viewRotation === 270 ? resolution.width : resolution.height;

  return (
    <div
      className={`group relative flex-1 flex items-center justify-center transition-colors overflow-hidden ${
        cleanMode
          ? 'bg-[#05080f] rounded-xl p-1 border border-transparent'
          : 'studio-stage-bg rounded-2xl border p-4 shadow-inner shadow-black/60'
      } ${dragOver ? '!border-sky-400 bg-sky-950/20' : cleanMode ? '' : 'border-white/[0.07]'}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => void handleDrop(e)}
    >
      {/* Live stage HUD */}
      {isStreaming && !cleanMode && (
        <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5 pointer-events-none">
          <span className="px-2.5 py-1 rounded-full bg-slate-950/80 backdrop-blur-md border border-white/[0.08] text-[11px] font-mono tabular-nums text-slate-300 shadow-lg">
            {displayWidth}×{displayHeight}
            {viewRotation !== 0 ? ` • ${viewRotation}°` : ''}
          </span>
          <span className="px-2.5 py-1 rounded-full bg-slate-950/80 backdrop-blur-md border border-white/[0.08] text-[11px] font-mono tabular-nums text-emerald-400 flex items-center gap-1.5 shadow-lg">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {fps} FPS
          </span>
          {recording && (
            <span className="px-2.5 py-1 rounded-full bg-rose-950/90 backdrop-blur-md border border-rose-500/50 text-[11px] font-semibold tracking-wide text-rose-200 flex items-center gap-1.5 shadow-lg animate-pulse">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
              REC
            </span>
          )}
        </div>
      )}

      {isStreaming && !cleanMode && (
        <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 z-10 px-3 py-1 rounded-full bg-slate-950/75 backdrop-blur-md border border-white/[0.07] text-[10px] text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
          Click &amp; drag = Touch &bull; Right-click = Back &bull; Ctrl+Scroll / Ctrl+Drag = Pinch Zoom
        </div>
      )}

      {dragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-sky-950/60 backdrop-blur-sm pointer-events-none">
          <div className="px-6 py-4 rounded-xl bg-slate-900/90 border border-sky-400/50 text-sky-200 text-sm font-medium shadow-xl">
            Drop .apk to install or files to send to /sdcard/Download
          </div>
        </div>
      )}

      {!isStreaming && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6 pointer-events-none">
          <div className="w-12 h-12 rounded-2xl bg-slate-800/70 border border-slate-700/60 flex items-center justify-center mb-3">
            <div className="w-3 h-3 rounded-full bg-sky-400 animate-ping" />
          </div>
          <p className="text-sm font-medium text-slate-200">
            {reconnectingAttempt
              ? `Connection interrupted — reconnecting (${reconnectingAttempt}/${maxReconnectAttempts})...`
              : sessionStatus?.message || 'Connecting to device screen...'}
          </p>
          <p className="text-xs text-slate-400 mt-1 max-w-xs">
            Left-click &amp; drag = touch, Right-click = Back, Middle-click = Home, Ctrl+Scroll/Drag = Pinch Zoom
          </p>
          {reconnectingAttempt && onCancelReconnect && (
            <button
              onClick={onCancelReconnect}
              className="pointer-events-auto mt-4 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 border border-slate-700"
            >
              Cancel Auto-Reconnect
            </button>
          )}
        </div>
      )}

      {pinchOverlay && canvasRef.current && (
        <div
          className="absolute pointer-events-none z-20"
          style={{
            left: canvasRef.current.offsetLeft,
            top: canvasRef.current.offsetTop,
            width: canvasRef.current.offsetWidth,
            height: canvasRef.current.offsetHeight,
          }}
        >
          {pinchOverlay.map((pt, idx) => (
            <div
              key={idx}
              style={{ left: `${pt.u * 100}%`, top: `${pt.v * 100}%` }}
              className="absolute -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full border-2 border-sky-400 bg-sky-400/20 shadow-[0_0_12px_rgba(56,189,248,0.65)]"
            />
          ))}
        </div>
      )}

      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={
          displayWidth > 0 && displayHeight > 0
            ? { aspectRatio: `${displayWidth} / ${displayHeight}` }
            : undefined
        }
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => inputMapperRef.current?.handlePointerDown(e)}
        onPointerMove={(e) => inputMapperRef.current?.handlePointerMove(e)}
        onPointerUp={(e) => inputMapperRef.current?.handlePointerUp(e)}
        onPointerCancel={(e) => inputMapperRef.current?.handlePointerUp(e)}
        onKeyDown={handleKeyDown}
        onKeyUp={(e) => inputMapperRef.current?.handleKeyUp(e)}
        className={`w-auto h-auto max-w-full max-h-full object-contain rounded-xl shadow-2xl shadow-black/80 outline-none focus:ring-2 focus:ring-sky-500/40 cursor-pointer transition-opacity ${
          isStreaming ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </div>
  );
};
