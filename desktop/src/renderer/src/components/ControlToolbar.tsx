import React from 'react';
import {
  ArrowLeft,
  Bell,
  Camera,
  ClipboardPaste,
  Home,
  Layers,
  Maximize2,
  Minimize2,
  Moon,
  Power,
  RotateCcw,
  RotateCw,
  Settings,
  Square,
  Sun,
  Video,
  Volume1,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  ANDROID_KEYCODE,
  CONTROL_MSG_TYPE,
  KEY_ACTION,
  serializeControlMessage,
} from '@shared/protocol';

interface ControlToolbarProps {
  serial: string;
  screenOff: boolean;
  onToggleScreenOff: () => void;
  audioMuted: boolean;
  onToggleAudioMuted: () => void;
  audioEnabled: boolean;
  recording: boolean;
  onToggleRecording: () => void;
  viewRotation: 0 | 90 | 180 | 270;
  onCycleViewRotation: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onOpenSettings: () => void;
  activePresetLabel?: string;
  onToast: (msg: string, isError?: boolean) => void;
}

interface DeckTileProps {
  icon: React.ReactNode;
  label: string;
  title: string;
  onClick: () => void;
  tone?: 'default' | 'accent' | 'danger' | 'warn';
  active?: boolean;
  disabled?: boolean;
}

const DeckTile: React.FC<DeckTileProps> = ({
  icon,
  label,
  title,
  onClick,
  tone = 'default',
  active = false,
  disabled = false,
}) => {
  const toneClasses = active
    ? tone === 'danger'
      ? 'bg-rose-500/20 border-rose-500/50 text-rose-200'
      : tone === 'warn'
        ? 'bg-amber-500/20 border-amber-500/50 text-amber-200'
        : 'bg-sky-500/20 border-sky-400/50 text-sky-200'
    : tone === 'danger'
      ? 'bg-white/[0.03] border-white/[0.06] text-rose-300/90 hover:bg-rose-500/15 hover:border-rose-500/30'
      : tone === 'accent'
        ? 'bg-white/[0.03] border-white/[0.06] text-sky-300 hover:bg-sky-500/15 hover:border-sky-400/30'
        : 'bg-white/[0.03] border-white/[0.06] text-slate-300 hover:bg-white/[0.08] hover:text-white hover:border-white/[0.14]';

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`px-1.5 py-2 rounded-xl border flex flex-col items-center justify-center gap-1 active:scale-95 disabled:opacity-35 disabled:pointer-events-none transition ${toneClasses}`}
    >
      {icon}
      <span className="text-[10px] font-medium leading-none truncate max-w-full">{label}</span>
    </button>
  );
};

export const ControlToolbar: React.FC<ControlToolbarProps> = ({
  serial,
  screenOff,
  onToggleScreenOff,
  audioMuted,
  onToggleAudioMuted,
  audioEnabled,
  recording,
  onToggleRecording,
  viewRotation,
  onCycleViewRotation,
  onZoomIn,
  onZoomOut,
  isFullscreen,
  onToggleFullscreen,
  onOpenSettings,
  activePresetLabel,
  onToast,
}) => {
  const sendKey = (keycode: number) => {
    window.droidlink.sendControl(
      serial,
      serializeControlMessage({
        type: CONTROL_MSG_TYPE.INJECT_KEYCODE,
        action: KEY_ACTION.DOWN,
        keycode,
        repeat: 0,
        metaState: 0,
      }),
    );
    window.droidlink.sendControl(
      serial,
      serializeControlMessage({
        type: CONTROL_MSG_TYPE.INJECT_KEYCODE,
        action: KEY_ACTION.UP,
        keycode,
        repeat: 0,
        metaState: 0,
      }),
    );
  };

  const sendBack = () => {
    window.droidlink.sendControl(
      serial,
      serializeControlMessage({
        type: CONTROL_MSG_TYPE.BACK_OR_SCREEN_ON,
        action: KEY_ACTION.DOWN,
      }),
    );
    window.droidlink.sendControl(
      serial,
      serializeControlMessage({
        type: CONTROL_MSG_TYPE.BACK_OR_SCREEN_ON,
        action: KEY_ACTION.UP,
      }),
    );
  };

  const handleScreenshot = async () => {
    try {
      const saved = await window.droidlink.captureAndSaveScreenshot(serial);
      if (saved) onToast(`Saved screenshot: ${saved.split(/[\\/]/).pop()}`);
    } catch (err) {
      onToast((err as Error).message, true);
    }
  };

  const handlePasteClipboard = async () => {
    const ok = await window.droidlink.pushClipboard(serial, true);
    onToast(ok ? 'Pasted PC clipboard to phone' : 'Clipboard empty or session inactive', !ok);
  };

  return (
    <aside className="w-[144px] shrink-0 flex flex-col gap-2.5 p-2.5 rounded-2xl bg-[#0c121e]/95 border border-white/[0.08] shadow-2xl shadow-black/50 overflow-y-auto">
      {/* Camera & View */}
      <section className="space-y-1.5">
        <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500 px-0.5">
          Camera &amp; View
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <DeckTile
            icon={<ZoomIn className="w-4 h-4" />}
            label="Zoom +"
            title="Zoom Camera In (Ctrl+Scroll / Ctrl+Drag / Ctrl+=)"
            tone="accent"
            onClick={onZoomIn}
          />
          <DeckTile
            icon={<ZoomOut className="w-4 h-4" />}
            label="Zoom −"
            title="Zoom Camera Out (Ctrl+Scroll / Ctrl+Drag / Ctrl+-)"
            tone="accent"
            onClick={onZoomOut}
          />
          <DeckTile
            icon={<RotateCcw className="w-3.5 h-3.5" />}
            label={viewRotation === 0 ? 'Rotate' : `View ${viewRotation}°`}
            title={`Rotate Mirror View (${viewRotation}°) — flip portrait-locked apps like Camera`}
            active={viewRotation !== 0}
            onClick={onCycleViewRotation}
          />
          <DeckTile
            icon={<RotateCw className="w-3.5 h-3.5" />}
            label="Phone ↻"
            title="Rotate Phone Orientation (Android OS)"
            onClick={() =>
              window.droidlink.sendControl(
                serial,
                serializeControlMessage({ type: CONTROL_MSG_TYPE.ROTATE_DEVICE }),
              )
            }
          />
        </div>
      </section>

      {/* Capture & Stage */}
      <section className="space-y-1.5 pt-2 border-t border-white/[0.06]">
        <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500 px-0.5">
          Capture &amp; Audio
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <DeckTile
            icon={<Camera className="w-3.5 h-3.5" />}
            label="Snap"
            title="Take Phone Screenshot (PNG)"
            onClick={() => void handleScreenshot()}
          />
          <DeckTile
            icon={
              recording ? (
                <Square className="w-3.5 h-3.5 fill-current animate-pulse" />
              ) : (
                <Video className="w-3.5 h-3.5" />
              )
            }
            label={recording ? 'Stop Rec' : 'Record'}
            title={recording ? 'Stop Recording' : 'Record Mirrored Screen (Video + Audio)'}
            tone="danger"
            active={recording}
            onClick={onToggleRecording}
          />
          <DeckTile
            icon={
              audioMuted || !audioEnabled ? (
                <VolumeX className="w-3.5 h-3.5" />
              ) : (
                <Volume2 className="w-3.5 h-3.5" />
              )
            }
            label={!audioEnabled ? 'Audio Off' : audioMuted ? 'Muted' : 'Sound'}
            title={
              !audioEnabled
                ? 'Audio forwarding disabled in Stream Settings'
                : audioMuted
                  ? 'Unmute Phone Audio'
                  : 'Mute Phone Audio'
            }
            active={audioEnabled && !audioMuted}
            disabled={!audioEnabled}
            onClick={onToggleAudioMuted}
          />
          <DeckTile
            icon={
              isFullscreen ? (
                <Minimize2 className="w-3.5 h-3.5" />
              ) : (
                <Maximize2 className="w-3.5 h-3.5" />
              )
            }
            label={isFullscreen ? 'Exit Full' : 'Fullscreen'}
            title={isFullscreen ? 'Exit Fullscreen (Esc)' : 'Fullscreen Stage'}
            active={isFullscreen}
            onClick={onToggleFullscreen}
          />
        </div>
      </section>

      {/* Android Navigation */}
      <section className="space-y-1.5 pt-2 border-t border-white/[0.06]">
        <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500 px-0.5">
          Navigation
        </div>
        <div className="grid grid-cols-3 gap-1">
          <DeckTile
            icon={<ArrowLeft className="w-3.5 h-3.5" />}
            label="Back"
            title="Back (Right-click)"
            onClick={sendBack}
          />
          <DeckTile
            icon={<Home className="w-3.5 h-3.5" />}
            label="Home"
            title="Home (Middle-click)"
            onClick={() => sendKey(ANDROID_KEYCODE.HOME)}
          />
          <DeckTile
            icon={<Layers className="w-3.5 h-3.5" />}
            label="Apps"
            title="App Switcher / Recents"
            onClick={() => sendKey(ANDROID_KEYCODE.APP_SWITCH)}
          />
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <DeckTile
            icon={<Bell className="w-3.5 h-3.5" />}
            label="Notifs"
            title="Expand Notification Shade"
            onClick={() =>
              window.droidlink.sendControl(
                serial,
                serializeControlMessage({ type: CONTROL_MSG_TYPE.EXPAND_NOTIFICATION_PANEL }),
              )
            }
          />
          <DeckTile
            icon={<ClipboardPaste className="w-3.5 h-3.5" />}
            label="Paste"
            title="Paste PC Clipboard to Phone (Ctrl+V)"
            onClick={() => void handlePasteClipboard()}
          />
        </div>
      </section>

      {/* Device Power & Stream Settings */}
      <section className="space-y-1.5 pt-2 border-t border-white/[0.06] mt-auto">
        <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500 px-0.5">
          Hardware
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <DeckTile
            icon={<Volume1 className="w-3.5 h-3.5" />}
            label="Vol −"
            title="Phone Volume Down"
            onClick={() => sendKey(ANDROID_KEYCODE.VOLUME_DOWN)}
          />
          <DeckTile
            icon={<Volume2 className="w-3.5 h-3.5" />}
            label="Vol +"
            title="Phone Volume Up"
            onClick={() => sendKey(ANDROID_KEYCODE.VOLUME_UP)}
          />
          <DeckTile
            icon={screenOff ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            label={screenOff ? 'Wake Disp' : 'Dim Phone'}
            title={screenOff ? 'Turn Phone Display Back On' : 'Turn Phone Display Off (Save Battery & Heat)'}
            tone="warn"
            active={screenOff}
            onClick={onToggleScreenOff}
          />
          <DeckTile
            icon={<Power className="w-3.5 h-3.5" />}
            label="Power"
            title="Phone Power / Lock Button"
            tone="danger"
            onClick={() => sendKey(ANDROID_KEYCODE.POWER)}
          />
        </div>

        <button
          type="button"
          onClick={onOpenSettings}
          title="Open Stream Quality & Presets"
          className="w-full mt-1 px-2.5 py-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.09] border border-white/[0.08] text-slate-200 flex items-center justify-between gap-2 transition"
        >
          <span className="flex items-center gap-1.5 text-[11px] font-medium truncate">
            <Settings className="w-3.5 h-3.5 text-sky-400 shrink-0" />
            <span className="truncate">{activePresetLabel || 'Stream Settings'}</span>
          </span>
        </button>
      </section>
    </aside>
  );
};
