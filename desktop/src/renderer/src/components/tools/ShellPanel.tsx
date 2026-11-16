import React, { useState } from 'react';
import { Send, Trash2 } from 'lucide-react';

interface ShellPanelProps {
  serial: string;
}

interface ShellEntry {
  cmd: string;
  out: string;
  isError?: boolean;
}

const QUICK_COMMANDS = [
  'getprop ro.product.model',
  'dumpsys battery',
  'ip addr show wlan0',
  'wm size',
];

export const ShellPanel: React.FC<ShellPanelProps> = ({ serial }) => {
  const [command, setCommand] = useState('');
  const [entries, setEntries] = useState<ShellEntry[]>([]);
  const [running, setRunning] = useState(false);

  const runCmd = async (cmdText: string) => {
    const trimmed = cmdText.trim();
    if (!trimmed) return;
    setRunning(true);
    setCommand('');
    try {
      const out = await window.droidlink.runShell(serial, trimmed);
      setEntries((prev) => [...prev, { cmd: trimmed, out: out.trim() || '(no output)' }]);
    } catch (err) {
      setEntries((prev) => [
        ...prev,
        { cmd: trimmed, out: (err as Error).message, isError: true },
      ]);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="px-3 py-2.5 border-b border-white/[0.07] flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {QUICK_COMMANDS.map((q) => (
            <button
              key={q}
              onClick={() => void runCmd(q)}
              className="px-2 py-1 rounded-lg bg-white/[0.04] border border-white/[0.06] hover:border-sky-400/40 text-[10px] font-mono text-slate-300 hover:text-sky-200 transition"
            >
              {q}
            </button>
          ))}
        </div>
        <button
          onClick={() => setEntries([])}
          className="p-1.5 rounded-lg hover:bg-white/[0.08] text-slate-400 hover:text-white transition"
          title="Clear output"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3.5 font-mono text-[11px] space-y-3 bg-[#060910]/80">
        {entries.length === 0 && (
          <div className="text-slate-500">
            Run any <span className="text-slate-300">adb shell</span> command on {serial}.
          </div>
        )}
        {entries.map((entry, idx) => (
          <div key={idx} className="space-y-1">
            <div className="text-sky-400">$ {entry.cmd}</div>
            <pre
              className={`whitespace-pre-wrap break-all ${
                entry.isError ? 'text-rose-300' : 'text-slate-300'
              }`}
            >
              {entry.out}
            </pre>
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void runCmd(command);
        }}
        className="p-3 border-t border-white/[0.07] flex items-center gap-2"
      >
        <input
          type="text"
          value={command}
          disabled={running}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="Enter adb shell command..."
          className="flex-1 px-3 py-2 rounded-xl bg-slate-950/80 border border-white/[0.08] font-mono text-[11px] text-white focus:outline-none focus:border-sky-400/70"
        />
        <button
          type="submit"
          disabled={running}
          className="p-2 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 transition"
        >
          <Send className="w-3.5 h-3.5" />
        </button>
      </form>
    </div>
  );
};
