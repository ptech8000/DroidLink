import React, { useCallback, useEffect, useState } from 'react';
import { PackagePlus, Play, RefreshCw, Search, Square, Trash2 } from 'lucide-react';
import type { InstalledAppInfo } from '@shared/types';

interface AppManagerPanelProps {
  serial: string;
  onToast: (msg: string, isError?: boolean) => void;
}

export const AppManagerPanel: React.FC<AppManagerPanelProps> = ({ serial, onToast }) => {
  const [apps, setApps] = useState<InstalledAppInfo[]>([]);
  const [query, setQuery] = useState('');
  const [includeSystem, setIncludeSystem] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadApps = useCallback(async () => {
    setLoading(true);
    try {
      const list = await window.droidlink.listApps(serial, includeSystem);
      setApps(list);
    } catch (err) {
      onToast((err as Error).message, true);
    } finally {
      setLoading(false);
    }
  }, [serial, includeSystem, onToast]);

  useEffect(() => {
    void loadApps();
  }, [loadApps]);

  const handleInstallApk = async () => {
    try {
      onToast('Select an APK to install...');
      const res = await window.droidlink.installApkDialog(serial);
      if (res) {
        onToast(`APK install result: ${res}`);
        void loadApps();
      }
    } catch (err) {
      onToast((err as Error).message, true);
    }
  };

  const filtered = apps.filter((a) =>
    a.packageName.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="px-3.5 py-3 border-b border-white/[0.07] space-y-2.5">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Filter packages..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-2 rounded-xl bg-slate-950/80 border border-white/[0.08] text-slate-100 focus:outline-none focus:border-sky-400/70"
            />
          </div>
          <button
            onClick={() => void loadApps()}
            className="p-2 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.06] text-slate-400 hover:text-white transition"
            title="Refresh apps"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={includeSystem}
              onChange={(e) => setIncludeSystem(e.target.checked)}
              className="accent-sky-500"
            />
            Show system apps ({filtered.length})
          </label>
          <button
            onClick={() => void handleInstallApk()}
            className="px-2.5 py-1.5 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/25 text-sky-200 flex items-center gap-1 font-medium transition"
          >
            <PackagePlus className="w-3.5 h-3.5" /> Install APK
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-white/[0.04]">
        {filtered.map((app) => (
          <div
            key={app.packageName}
            className="px-3.5 py-2.5 flex items-center justify-between gap-2 hover:bg-white/[0.03] transition"
          >
            <div className="min-w-0">
              <div className="font-mono text-[11px] text-slate-200 truncate">
                {app.packageName}
              </div>
              {app.isSystem && (
                <span className="text-[10px] text-slate-500">System</span>
              )}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() =>
                  void window.droidlink
                    .launchApp(serial, app.packageName)
                    .then(() => onToast(`Launched ${app.packageName}`))
                    .catch((e: Error) => onToast(e.message, true))
                }
                title="Launch app"
                className="p-1.5 rounded-lg hover:bg-slate-800 text-emerald-400"
              >
                <Play className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() =>
                  void window.droidlink
                    .forceStopApp(serial, app.packageName)
                    .then(() => onToast(`Force-stopped ${app.packageName}`))
                    .catch((e: Error) => onToast(e.message, true))
                }
                title="Force stop"
                className="p-1.5 rounded-lg hover:bg-slate-800 text-amber-400"
              >
                <Square className="w-3.5 h-3.5" />
              </button>
              {!app.isSystem && (
                <button
                  onClick={() => {
                    if (!window.confirm(`Uninstall ${app.packageName}?`)) return;
                    void window.droidlink
                      .uninstallApp(serial, app.packageName)
                      .then(() => {
                        onToast(`Uninstalled ${app.packageName}`);
                        void loadApps();
                      })
                      .catch((e: Error) => onToast(e.message, true));
                  }}
                  title="Uninstall"
                  className="p-1.5 rounded-lg hover:bg-slate-800 text-rose-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
