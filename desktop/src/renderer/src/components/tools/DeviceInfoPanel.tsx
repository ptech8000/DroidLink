import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Battery,
  Cpu,
  HardDrive,
  Monitor,
  RefreshCw,
  Smartphone,
  Thermometer,
  Wifi,
} from 'lucide-react';
import type { DeviceTelemetry } from '@shared/types';
import { evaluateDeviceHealth, parseStoragePercent } from '../../utils/streamConfig';

interface DeviceInfoPanelProps {
  serial: string;
  telemetry?: DeviceTelemetry | null;
  onRefreshTelemetry?: () => Promise<void> | void;
}

function meterTone(pct: number, warnAt = 85, critAt = 95): string {
  if (pct >= critAt) return 'bg-rose-500';
  if (pct >= warnAt) return 'bg-amber-400';
  return 'bg-sky-400';
}

export const DeviceInfoPanel: React.FC<DeviceInfoPanelProps> = ({
  serial,
  telemetry: externalTelemetry,
  onRefreshTelemetry,
}) => {
  const [localInfo, setLocalInfo] = useState<DeviceTelemetry | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (onRefreshTelemetry) {
        await onRefreshTelemetry();
      } else {
        const data = await window.droidlink.getTelemetry(serial);
        setLocalInfo(data);
      }
    } finally {
      setLoading(false);
    }
  }, [serial, onRefreshTelemetry]);

  useEffect(() => {
    if (externalTelemetry === undefined) {
      void load();
    }
  }, [externalTelemetry, load]);

  const info = externalTelemetry !== undefined ? externalTelemetry : localInfo;
  const alerts = evaluateDeviceHealth(info);

  const storagePct = info ? parseStoragePercent(info.storageSummary) : null;
  const ramUsedPct =
    info && info.memTotalMb && info.memAvailableMb !== null
      ? Math.round(((info.memTotalMb - info.memAvailableMb) / info.memTotalMb) * 100)
      : null;

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="px-3.5 py-2.5 border-b border-white/[0.07] flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Device Telemetry
        </span>
        <button
          onClick={() => void load()}
          title="Refresh telemetry"
          className="p-1.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.06] text-slate-400 hover:text-white transition"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3.5 space-y-3">
        {!info ? (
          <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/[0.06] text-slate-400 text-center">
            Loading device telemetry...
          </div>
        ) : (
          <>
            {alerts.length > 0 && (
              <div className="space-y-1.5">
                {alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`p-2.5 rounded-xl border flex items-start gap-2 text-[11px] ${
                      alert.level === 'crit'
                        ? 'bg-rose-950/50 border-rose-500/40 text-rose-200'
                        : 'bg-amber-950/40 border-amber-500/40 text-amber-200'
                    }`}
                  >
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{alert.message}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Phone summary card */}
            <div className="p-3.5 rounded-2xl bg-gradient-to-br from-sky-500/[0.08] to-indigo-500/[0.04] border border-white/[0.08] space-y-1">
              <div className="flex items-center gap-2 text-sky-300 font-semibold text-xs">
                <Smartphone className="w-4 h-4" />
                {info.manufacturer} {info.model}
              </div>
              <div className="text-[11px] text-slate-400">
                Android {info.androidVersion} (API {info.sdkVersion}) &bull; {info.brand}
              </div>
            </div>

            {/* Primary metrics */}
            <div className="grid grid-cols-2 gap-2.5">
              <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.07] space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-emerald-400 text-[11px] font-medium">
                    <Battery className="w-3.5 h-3.5" /> Battery
                  </span>
                  {info.batteryTempC !== null && (
                    <span
                      className={`flex items-center gap-0.5 text-[10px] font-mono tabular-nums ${
                        info.batteryTempC >= 43
                          ? 'text-rose-300'
                          : info.batteryTempC >= 39.5
                            ? 'text-amber-300'
                            : 'text-slate-400'
                      }`}
                    >
                      <Thermometer className="w-3 h-3" />
                      {info.batteryTempC}°C
                    </span>
                  )}
                </div>
                <div className="text-base font-bold tabular-nums text-white">
                  {info.batteryLevel !== null ? `${info.batteryLevel}%` : 'N/A'}
                </div>
                {info.batteryLevel !== null && (
                  <div className="h-1.5 rounded-full bg-white/[0.07] overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
                        info.batteryLevel <= 15
                          ? 'bg-rose-500'
                          : info.batteryLevel <= 25
                            ? 'bg-amber-400'
                            : 'bg-emerald-400'
                      }`}
                      style={{ width: `${Math.min(100, info.batteryLevel)}%` }}
                    />
                  </div>
                )}
                <div className="text-[10px] text-slate-400">{info.batteryStatus}</div>
              </div>

              <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.07] space-y-1.5">
                <div className="flex items-center gap-1.5 text-sky-400 text-[11px] font-medium">
                  <Wifi className="w-3.5 h-3.5" /> Network
                </div>
                <div className="text-xs font-mono font-semibold text-white truncate">
                  {info.wifiIp || 'Not connected'}
                </div>
                <div className="text-[10px] text-slate-400">WLAN interface</div>
              </div>

              <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.07] space-y-1">
                <div className="flex items-center gap-1.5 text-violet-400 text-[11px] font-medium">
                  <Monitor className="w-3.5 h-3.5" /> Display
                </div>
                <div className="text-xs font-semibold tabular-nums text-white">{info.resolution}</div>
                <div className="text-[10px] text-slate-400">{info.density}</div>
              </div>

              <div className="p-3 rounded-2xl bg-white/[0.03] border border-white/[0.07] space-y-1.5">
                <div className="flex items-center justify-between text-amber-400 text-[11px] font-medium">
                  <span className="flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5" /> Memory
                  </span>
                  {ramUsedPct !== null && (
                    <span className="text-[10px] font-mono tabular-nums text-slate-400">
                      {ramUsedPct}%
                    </span>
                  )}
                </div>
                <div className="text-xs font-semibold tabular-nums text-white">
                  {info.memAvailableMb !== null && info.memTotalMb !== null
                    ? `${info.memAvailableMb} / ${info.memTotalMb} MB`
                    : 'N/A'}
                </div>
                {ramUsedPct !== null && (
                  <div className="h-1.5 rounded-full bg-white/[0.07] overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${meterTone(ramUsedPct, 85, 95)}`}
                      style={{ width: `${Math.min(100, ramUsedPct)}%` }}
                    />
                  </div>
                )}
                <div className="text-[10px] text-slate-400">Free / Total RAM</div>
              </div>
            </div>

            {/* Storage bar */}
            <div className="p-3.5 rounded-2xl bg-white/[0.03] border border-white/[0.07] space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-slate-200 text-[11px] font-medium">
                  <HardDrive className="w-3.5 h-3.5 text-sky-400" /> Internal Storage (/data)
                </span>
                {storagePct !== null && (
                  <span
                    className={`text-[11px] font-mono font-semibold tabular-nums ${
                      storagePct >= 95
                        ? 'text-rose-300'
                        : storagePct >= 90
                          ? 'text-amber-300'
                          : 'text-slate-300'
                    }`}
                  >
                    {storagePct}%
                  </span>
                )}
              </div>
              {storagePct !== null && (
                <div className="h-1.5 rounded-full bg-white/[0.07] overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${meterTone(storagePct, 90, 95)}`}
                    style={{ width: `${Math.min(100, storagePct)}%` }}
                  />
                </div>
              )}
              <div className="text-[11px] font-mono text-slate-400">{info.storageSummary}</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
