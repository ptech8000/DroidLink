import React from 'react';
import { Sliders, X, Zap } from 'lucide-react';
import type { StreamOptions } from '@shared/types';
import { STREAM_PRESETS, type StreamPreset } from '../utils/streamConfig';

interface StreamSettingsModalProps {
  open: boolean;
  options: StreamOptions;
  autoReconnect: boolean;
  onChange: (next: StreamOptions) => void;
  onChangeAutoReconnect: (next: boolean) => void;
  onClose: () => void;
  onApplyRestart?: () => void;
}

export const StreamSettingsModal: React.FC<StreamSettingsModalProps> = ({
  open,
  options,
  autoReconnect,
  onChange,
  onChangeAutoReconnect,
  onClose,
  onApplyRestart,
}) => {
  if (!open) return null;

  const update = <K extends keyof StreamOptions>(key: K, val: StreamOptions[K]) => {
    onChange({ ...options, [key]: val });
  };

  const applyPreset = (preset: StreamPreset) => {
    onChange({ ...options, ...preset.options });
  };

  const matchesPreset = (preset: StreamPreset): boolean =>
    Object.entries(preset.options).every(
      ([key, val]) => options[key as keyof StreamOptions] === val,
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4">
      <div className="w-full max-w-md rounded-2xl bg-[#0c121e] border border-white/[0.1] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.07]">
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-white">Mirror &amp; Stream Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/[0.08] transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 text-xs">
          <div>
            <div className="flex items-center gap-1.5 text-slate-300 font-medium mb-2">
              <Zap className="w-3.5 h-3.5 text-amber-400" /> Quick Presets
            </div>
            <div className="grid grid-cols-2 gap-2">
              {STREAM_PRESETS.map((preset) => {
                const active = matchesPreset(preset);
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    title={preset.description}
                    className={`px-3 py-2 rounded-xl border text-left transition ${
                      active
                        ? 'bg-sky-500/20 border-sky-400/70 text-sky-200'
                        : 'bg-white/[0.02] border-white/[0.07] hover:border-white/[0.16] text-slate-300'
                    }`}
                  >
                    <div className="font-semibold text-[11px]">{preset.label}</div>
                    <div className="text-[10px] text-slate-400 truncate mt-0.5">
                      {preset.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 mb-1">Video Bitrate</label>
              <select
                value={options.videoBitRate}
                onChange={(e) => update('videoBitRate', Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl bg-slate-950/90 border border-white/[0.1] text-white focus:outline-none focus:border-sky-400/70"
              >
                <option value={2_000_000}>2 Mbps (Weak Wi-Fi)</option>
                <option value={4_000_000}>4 Mbps (Wi-Fi Balanced)</option>
                <option value={8_000_000}>8 Mbps (High Quality)</option>
                <option value={12_000_000}>12 Mbps (USB Crisp)</option>
                <option value={16_000_000}>16 Mbps (Max)</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-300 mb-1">Max Resolution</label>
              <select
                value={options.maxSize}
                onChange={(e) => update('maxSize', Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl bg-slate-950/90 border border-white/[0.1] text-white focus:outline-none focus:border-sky-400/70"
              >
                <option value={0}>Native (720×1612)</option>
                <option value={1280}>1280px max</option>
                <option value={1024}>1024px max</option>
                <option value={800}>800px (Low Latency)</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-300 mb-1">Max FPS</label>
              <select
                value={options.maxFps}
                onChange={(e) => update('maxFps', Number(e.target.value))}
                className="w-full px-3 py-2 rounded-xl bg-slate-950/90 border border-white/[0.1] text-white focus:outline-none focus:border-sky-400/70"
              >
                <option value={0}>Unlimited (up to 90 Hz)</option>
                <option value={60}>60 FPS</option>
                <option value={30}>30 FPS (Battery Saver)</option>
              </select>
            </div>

            <div>
              <label className="block text-slate-300 mb-1">Video Codec</label>
              <select
                value={options.videoCodec}
                onChange={(e) => update('videoCodec', e.target.value as 'h264' | 'h265')}
                className="w-full px-3 py-2 rounded-xl bg-slate-950/90 border border-white/[0.1] text-white focus:outline-none focus:border-sky-400/70"
              >
                <option value="h264">H.264 (Recommended)</option>
                <option value="h265">H.265 / HEVC</option>
              </select>
            </div>
          </div>

          <div className="space-y-2.5 pt-3 border-t border-white/[0.07]">
            {[
              { key: 'audio' as const, label: 'Forward device audio to PC (Android 11+)' },
              { key: 'stayAwake' as const, label: 'Keep phone awake while mirroring' },
              { key: 'turnScreenOff' as const, label: 'Turn physical phone screen off when starting' },
              { key: 'showTouches' as const, label: 'Show touch visual dots on phone' },
              { key: 'clipboardAutosync' as const, label: 'Auto-sync phone clipboard to PC' },
            ].map((item) => (
              <label key={item.key} className="flex items-center justify-between cursor-pointer">
                <span className="text-slate-300">{item.label}</span>
                <input
                  type="checkbox"
                  checked={options[item.key]}
                  onChange={(e) => update(item.key, e.target.checked)}
                  className="w-4 h-4 accent-sky-500 rounded"
                />
              </label>
            ))}
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-slate-300">Auto-reconnect stream if Wi-Fi or USB drops</span>
              <input
                type="checkbox"
                checked={autoReconnect}
                onChange={(e) => onChangeAutoReconnect(e.target.checked)}
                className="w-4 h-4 accent-sky-500 rounded"
              />
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-white/[0.07]">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] text-slate-200 font-medium transition"
            >
              Close
            </button>
            {onApplyRestart && (
              <button
                onClick={() => {
                  onApplyRestart();
                  onClose();
                }}
                className="px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold transition"
              >
                Apply &amp; Restart Stream
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
