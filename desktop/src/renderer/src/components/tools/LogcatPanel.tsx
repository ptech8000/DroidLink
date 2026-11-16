import React, { useEffect, useRef, useState } from 'react';
import { Play, Square, Trash2 } from 'lucide-react';

interface LogcatPanelProps {
  serial: string;
}

export const LogcatPanel: React.FC<LogcatPanelProps> = ({ serial }) => {
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState('');
  const [lines, setLines] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const unsub = window.droidlink.onLogcatData((ev) => {
      if (ev.serial !== serial) return;
      const incoming = ev.text.split(/\r?\n/).filter(Boolean);
      if (incoming.length === 0) return;
      setLines((prev) => [...prev, ...incoming].slice(-800));
    });
    return () => {
      unsub();
      void window.droidlink.stopLogcat(serial);
    };
  }, [serial]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [lines]);

  const toggle = async () => {
    if (running) {
      await window.droidlink.stopLogcat(serial);
      setRunning(false);
    } else {
      await window.droidlink.startLogcat(serial);
      setRunning(true);
    }
  };

  const visible = filter.trim()
    ? lines.filter((l) => l.toLowerCase().includes(filter.trim().toLowerCase()))
    : lines;

  return (
    <div className="flex flex-col h-full text-xs">
      <div className="px-3 py-2.5 border-b border-white/[0.07] flex items-center gap-2">
        <button
          onClick={() => void toggle()}
          className={`px-2.5 py-1.5 rounded-xl font-medium flex items-center gap-1.5 transition ${
            running
              ? 'bg-rose-500/20 text-rose-200 border border-rose-500/35'
              : 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/35'
          }`}
        >
          {running ? <Square className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3" />}
          {running ? 'Stop' : 'Start'}
        </button>
        <input
          type="text"
          placeholder="Filter logs..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 px-3 py-1.5 rounded-xl bg-slate-950/80 border border-white/[0.08] text-[11px] text-white focus:outline-none focus:border-sky-400/70"
        />
        <button
          onClick={() => setLines([])}
          className="p-2 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] border border-white/[0.06] text-slate-400 hover:text-white transition"
          title="Clear"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 font-mono text-[10px] leading-relaxed bg-[#060910]/80 text-slate-300 space-y-0.5">
        {visible.length === 0 && (
          <div className="text-slate-500">Click Start to stream Android logcat output.</div>
        )}
        {visible.map((line, i) => (
          <div
            key={i}
            className={`break-all ${
              line.includes(' E ') || line.includes(' F ')
                ? 'text-rose-400'
                : line.includes(' W ')
                  ? 'text-amber-300'
                  : 'text-slate-300'
            }`}
          >
            {line}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};
