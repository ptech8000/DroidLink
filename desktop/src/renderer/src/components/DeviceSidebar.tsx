import React from 'react';
import {
  AlertTriangle,
  Cable,
  Cast,
  Plus,
  RefreshCw,
  Smartphone,
  StopCircle,
  Unplug,
  Wifi,
} from 'lucide-react';
import type { AdbDeviceInfo } from '@shared/types';

interface DeviceSidebarProps {
  devices: AdbDeviceInfo[];
  selectedSerial: string | null;
  streamingSerials: Set<string>;
  onSelect: (serial: string) => void;
  onStartMirror: (serial: string) => void;
  onStopMirror: (serial: string) => void;
  onEnableWifiFromUsb: (serial: string) => void;
  onDisconnectWireless: (serial: string) => void;
  onOpenWirelessModal: () => void;
  onRefresh: () => void;
  onRestartAdb: () => void;
}

export const DeviceSidebar: React.FC<DeviceSidebarProps> = ({
  devices,
  selectedSerial,
  streamingSerials,
  onSelect,
  onStartMirror,
  onStopMirror,
  onEnableWifiFromUsb,
  onDisconnectWireless,
  onOpenWirelessModal,
  onRefresh,
  onRestartAdb,
}) => {
  return (
    <aside className="w-72 shrink-0 flex flex-col bg-[#0a101b]/95 border-r border-white/[0.07]">
      {/* Brand Header */}
      <div className="px-4 py-3.5 border-b border-white/[0.07] flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-sky-400 via-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-sky-500/20 ring-1 ring-white/15">
            <Smartphone className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="text-sm font-bold tracking-tight text-white">DroidLink</h1>
              <span className="px-1.5 py-0.5 rounded-md bg-sky-500/15 border border-sky-400/20 text-[9px] font-semibold uppercase tracking-wider text-sky-300">
                Studio
              </span>
            </div>
            <p className="text-[11px] text-slate-400">ADB Screen &amp; Control</p>
          </div>
        </div>
        <button
          onClick={onRefresh}
          title="Refresh ADB devices"
          className="p-2 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.06] text-slate-400 hover:text-white transition"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Primary Action */}
      <div className="p-3">
        <button
          onClick={onOpenWirelessModal}
          className="w-full py-2.5 px-3 rounded-xl bg-gradient-to-r from-sky-500/20 to-indigo-500/15 hover:from-sky-500/30 hover:to-indigo-500/25 border border-sky-400/30 text-sky-200 text-xs font-semibold flex items-center justify-center gap-2 shadow-sm transition"
        >
          <Plus className="w-4 h-4 text-sky-300" />
          Pair Wireless Device
        </button>
      </div>

      {/* Device List */}
      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2.5">
        <div className="flex items-center justify-between px-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Connected Devices
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/[0.04] text-slate-400">
            {devices.length}
          </span>
        </div>

        {devices.length === 0 ? (
          <div className="p-4 rounded-2xl bg-white/[0.02] border border-white/[0.06] text-xs text-slate-400 space-y-2.5">
            <p className="font-semibold text-slate-200">No phone connected</p>
            <ol className="list-decimal list-inside space-y-1.5 text-[11px] leading-relaxed text-slate-400">
              <li>Enable Developer options on your phone.</li>
              <li>Turn on USB debugging or Wireless debugging.</li>
              <li>
                Plug in USB or click <span className="text-sky-300 font-medium">Pair Wireless Device</span>.
              </li>
            </ol>
          </div>
        ) : (
          devices.map((dev) => {
            const isSelected = dev.serial === selectedSerial;
            const isStreaming = streamingSerials.has(dev.serial);
            const isReady = dev.state === 'device';
            const isTls = dev.serial.includes('_adb-tls');

            return (
              <div
                key={dev.serial}
                onClick={() => onSelect(dev.serial)}
                className={`p-3 rounded-2xl border cursor-pointer transition space-y-2.5 ${
                  isSelected
                    ? 'bg-gradient-to-b from-slate-900/95 to-[#0d1524] border-sky-400/45 shadow-lg shadow-sky-950/30'
                    : 'bg-white/[0.02] border-white/[0.06] hover:border-white/[0.14] hover:bg-white/[0.04]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`p-1 rounded-lg ${
                          dev.transport === 'wireless'
                            ? 'bg-sky-500/15 text-sky-400'
                            : 'bg-emerald-500/15 text-emerald-400'
                        }`}
                      >
                        {dev.transport === 'wireless' ? (
                          <Wifi className="w-3 h-3" />
                        ) : (
                          <Cable className="w-3 h-3" />
                        )}
                      </span>
                      <span className="text-xs font-semibold text-white truncate">
                        {dev.model || dev.device || dev.serial}
                      </span>
                    </div>
                    <p
                      title={dev.serial}
                      className="text-[10px] font-mono text-slate-400 truncate mt-1"
                    >
                      {isTls ? 'Wireless TLS • ' : ''}
                      {dev.serial}
                    </p>
                  </div>

                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-semibold shrink-0 flex items-center gap-1 ${
                      isStreaming
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        : isReady
                          ? 'bg-white/[0.06] text-slate-300 border border-white/[0.06]'
                          : 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                    }`}
                  >
                    {isStreaming && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    )}
                    {isStreaming ? 'Live' : dev.state}
                  </span>
                </div>

                {dev.state === 'unauthorized' && (
                  <div className="flex items-start gap-1.5 text-[11px] text-amber-200 bg-amber-950/40 border border-amber-500/30 rounded-xl p-2">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
                    <span>Tap &ldquo;Allow USB debugging&rdquo; on your phone screen.</span>
                  </div>
                )}

                {isReady && (
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    {isStreaming ? (
                      <button
                        onClick={() => onStopMirror(dev.serial)}
                        className="flex-1 py-1.5 px-2.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-200 text-xs font-medium flex items-center justify-center gap-1.5 transition"
                      >
                        <StopCircle className="w-3.5 h-3.5 text-rose-400" />
                        Stop Mirror
                      </button>
                    ) : (
                      <button
                        onClick={() => onStartMirror(dev.serial)}
                        className="flex-1 py-1.5 px-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold flex items-center justify-center gap-1.5 shadow-sm shadow-sky-500/20 transition"
                      >
                        <Cast className="w-3.5 h-3.5" />
                        Start Mirror
                      </button>
                    )}

                    {dev.transport === 'usb' ? (
                      <button
                        onClick={() => onEnableWifiFromUsb(dev.serial)}
                        title="Switch USB phone to Wi-Fi ADB (port 5555)"
                        className="p-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.1] border border-white/[0.06] text-sky-300 transition"
                      >
                        <Wifi className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => onDisconnectWireless(dev.serial)}
                        title="Disconnect wireless ADB"
                        className="p-2 rounded-xl bg-white/[0.04] hover:bg-rose-500/20 border border-white/[0.06] text-slate-300 hover:text-rose-200 transition"
                      >
                        <Unplug className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-white/[0.07] flex items-center justify-between text-[11px] text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/80" />
          ADB Runtime Ready
        </span>
        <button
          onClick={onRestartAdb}
          className="text-slate-400 hover:text-sky-300 font-medium transition"
        >
          Restart ADB
        </button>
      </div>
    </aside>
  );
};
