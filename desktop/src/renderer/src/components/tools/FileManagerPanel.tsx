import React, { useCallback, useEffect, useState } from 'react';
import {
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  RefreshCw,
  Trash2,
  Upload,
  ChevronRight,
} from 'lucide-react';
import type { RemoteFileEntry } from '@shared/types';

interface FileManagerPanelProps {
  serial: string;
  onToast: (msg: string, isError?: boolean) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const FileManagerPanel: React.FC<FileManagerPanelProps> = ({ serial, onToast }) => {
  const [cwd, setCwd] = useState('/sdcard');
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const loadDir = useCallback(
    async (dir: string) => {
      setLoading(true);
      try {
        const list = await window.droidlink.listFiles(serial, dir);
        setEntries(list);
        setCwd(dir);
      } catch (err) {
        onToast((err as Error).message, true);
      } finally {
        setLoading(false);
      }
    },
    [serial, onToast],
  );

  useEffect(() => {
    void loadDir('/sdcard');
  }, [loadDir]);

  const handleUpload = async () => {
    try {
      const res = await window.droidlink.uploadFilesDialog(serial, cwd);
      if (res.uploaded > 0) {
        onToast(`Uploaded ${res.uploaded} file(s)`);
        void loadDir(cwd);
      }
    } catch (err) {
      onToast((err as Error).message, true);
    }
  };

  const handleNewFolder = async () => {
    const name = window.prompt('New folder name:');
    if (!name?.trim()) return;
    try {
      await window.droidlink.mkdir(serial, `${cwd}/${name.trim()}`);
      void loadDir(cwd);
    } catch (err) {
      onToast((err as Error).message, true);
    }
  };

  const handleDownload = async (entry: RemoteFileEntry) => {
    try {
      const ok = await window.droidlink.downloadFileDialog(serial, entry.path);
      if (ok) onToast(`Saved ${entry.name}`);
    } catch (err) {
      onToast((err as Error).message, true);
    }
  };

  const handleDelete = async (entry: RemoteFileEntry) => {
    if (!window.confirm(`Delete ${entry.name} from phone?`)) return;
    try {
      await window.droidlink.removeFile(serial, entry.path);
      onToast(`Deleted ${entry.name}`);
      void loadDir(cwd);
    } catch (err) {
      onToast((err as Error).message, true);
    }
  };

  const goUp = () => {
    if (cwd === '/' || cwd === '/sdcard') return;
    const parent = cwd.split('/').slice(0, -1).join('/') || '/';
    void loadDir(parent);
  };

  const crumbs = cwd.split('/').filter(Boolean);

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="px-3.5 py-3 border-b border-white/[0.07] space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 flex-wrap text-slate-300 font-mono text-[11px] bg-white/[0.03] border border-white/[0.06] rounded-xl px-2.5 py-1.5 flex-1 min-w-0">
            <button onClick={() => void loadDir('/sdcard')} className="hover:text-sky-300 font-semibold">
              /sdcard
            </button>
            {crumbs.slice(1).map((part, idx) => {
              const target = '/' + crumbs.slice(0, idx + 2).join('/');
              return (
                <React.Fragment key={target}>
                  <ChevronRight className="w-3 h-3 text-slate-600 shrink-0" />
                  <button onClick={() => void loadDir(target)} className="hover:text-sky-300 truncate">
                    {part}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
          <button
            onClick={() => void loadDir(cwd)}
            className="p-2 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.06] text-slate-400 hover:text-white transition"
            title="Refresh folder"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={goUp}
            disabled={cwd === '/sdcard' || cwd === '/'}
            className="px-2.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] disabled:opacity-35 text-slate-200 font-medium transition"
          >
            Up
          </button>
          <button
            onClick={() => void handleUpload()}
            className="px-2.5 py-1.5 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/25 text-sky-200 flex items-center gap-1 font-medium transition"
          >
            <Upload className="w-3 h-3" /> Upload
          </button>
          <button
            onClick={() => void handleNewFolder()}
            className="px-2.5 py-1.5 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] text-slate-200 flex items-center gap-1 transition"
          >
            <FolderPlus className="w-3 h-3" /> New Folder
          </button>
          {['/sdcard/Download', '/sdcard/DCIM'].map((quick) => (
            <button
              key={quick}
              onClick={() => void loadDir(quick)}
              className="px-2 py-1.5 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:border-sky-400/30 text-slate-400 hover:text-sky-200 transition"
            >
              {quick.split('/').pop()}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-white/[0.04]">
        {entries.length === 0 && !loading && (
          <div className="p-8 text-center text-slate-500">Folder is empty</div>
        )}
        {entries.map((entry) => (
          <div
            key={entry.path}
            className="px-3.5 py-2.5 flex items-center justify-between gap-2 hover:bg-white/[0.03] transition"
          >
            <button
              onClick={() => {
                if (entry.isDirectory) void loadDir(entry.path);
              }}
              className="flex items-center gap-2 min-w-0 flex-1 text-left"
            >
              {entry.isDirectory ? (
                <Folder className="w-4 h-4 text-amber-400 shrink-0" />
              ) : (
                <FileIcon className="w-4 h-4 text-slate-400 shrink-0" />
              )}
              <div className="min-w-0">
                <div className="text-slate-200 truncate">{entry.name}</div>
                <div className="text-[10px] text-slate-500">
                  {entry.isDirectory ? 'Folder' : formatBytes(entry.size)} • {entry.modifiedAt}
                </div>
              </div>
            </button>

            <div className="flex items-center gap-1 shrink-0">
              {!entry.isDirectory && (
                <button
                  onClick={() => void handleDownload(entry)}
                  title="Download to PC"
                  className="p-1.5 rounded-lg hover:bg-slate-800 text-sky-400"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => void handleDelete(entry)}
                title="Delete"
                className="p-1.5 rounded-lg hover:bg-slate-800 text-rose-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
