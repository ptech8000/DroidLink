import React, { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { QrCode, Wifi, X, RefreshCw, CheckCircle2 } from 'lucide-react';
import type { MdnsServiceInfo } from '@shared/types';

interface WirelessModalProps {
  open: boolean;
  onClose: () => void;
  onConnected: (serialOrMsg: string) => void;
}

type Tab = 'qr' | 'pair' | 'connect';

export const WirelessModal: React.FC<WirelessModalProps> = ({ open, onClose, onConnected }) => {
  const [tab, setTab] = useState<Tab>('qr');
  const [pairEndpoint, setPairEndpoint] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [connectEndpoint, setConnectEndpoint] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [mdnsServices, setMdnsServices] = useState<MdnsServiceInfo[]>([]);

  const qrCreds = useMemo(() => {
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    const pass = String(Math.floor(100000 + Math.random() * 900000));
    return {
      service: `ADB_WIFI_DroidLink_${suffix}`,
      password: pass,
    };
  }, [open]);

  const [qrDataUrl, setQrDataUrl] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    const payload = `WIFI:T:ADB;S:${qrCreds.service};P:${qrCreds.password};;`;
    void QRCode.toDataURL(payload, { width: 200, margin: 1, color: { dark: '#0f172a', light: '#f8fafc' } })
      .then(setQrDataUrl);
  }, [open, qrCreds]);

  // Poll mDNS services while modal is open so QR pairing or pairing endpoints appear automatically
  useEffect(() => {
    if (!open) return;
    let active = true;
    let pairedQr = false;

    const poll = async () => {
      const services = await window.droidlink.listMdnsServices();
      if (!active) return;
      setMdnsServices(services);

      if (tab === 'qr' && !pairedQr) {
        const match = services.find(
          (s) =>
            s.serviceType.includes('_adb-tls-pairing') &&
            s.instanceName.includes(qrCreds.service),
        );
        if (match) {
          pairedQr = true;
          setBusy(true);
          setStatus({ text: `Found phone at ${match.address}:${match.port}. Pairing...` });
          try {
            await window.droidlink.pairDevice(`${match.address}:${match.port}`, qrCreds.password);
            // Look for connect service on same IP
            const updated = await window.droidlink.listMdnsServices();
            const connSvc = updated.find(
              (s) => s.serviceType.includes('_adb-tls-connect') && s.address === match.address,
            );
            if (connSvc) {
              await window.droidlink.connectDevice(`${connSvc.address}:${connSvc.port}`);
              onConnected(`Connected wirelessly to ${connSvc.address}:${connSvc.port}`);
              onClose();
            } else {
              setStatus({
                text: 'Paired! If it does not appear automatically, switch to Direct Connect with the IP:port shown under Wireless debugging.',
              });
            }
          } catch (err) {
            pairedQr = false;
            setStatus({ text: (err as Error).message, error: true });
          } finally {
            setBusy(false);
          }
        }
      }
    };

    void poll();
    const id = setInterval(() => void poll(), 1500);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [open, tab, qrCreds, onConnected, onClose]);

  if (!open) return null;

  const handlePairSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const msg = await window.droidlink.pairDevice(pairEndpoint, pairCode);
      setStatus({ text: msg || 'Paired! Now connecting...' });
      // Auto-try discovered _adb-tls-connect service on same host
      const host = pairEndpoint.split(':')[0];
      const services = await window.droidlink.listMdnsServices();
      const connSvc = services.find(
        (s) => s.serviceType.includes('_adb-tls-connect') && s.address === host,
      );
      if (connSvc) {
        await window.droidlink.connectDevice(`${connSvc.address}:${connSvc.port}`);
        onConnected(`Connected wirelessly to ${connSvc.address}:${connSvc.port}`);
        onClose();
      } else {
        setTab('connect');
        setConnectEndpoint(`${host}:`);
      }
    } catch (err) {
      setStatus({ text: (err as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const handleConnectSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const msg = await window.droidlink.connectDevice(connectEndpoint);
      onConnected(msg || `Connected to ${connectEndpoint}`);
      onClose();
    } catch (err) {
      setStatus({ text: (err as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const pairingServices = mdnsServices.filter((s) => s.serviceType.includes('_adb-tls-pairing'));
  const connectServices = mdnsServices.filter((s) => s.serviceType.includes('_adb-tls-connect'));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4">
      <div className="w-full max-w-md rounded-2xl bg-[#0c121e] border border-white/[0.1] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.07]">
          <div className="flex items-center gap-2.5">
            <Wifi className="w-5 h-5 text-sky-400" />
            <h2 className="text-base font-semibold text-white">Connect Phone Wirelessly</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/[0.08] transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex border-b border-white/[0.07] bg-white/[0.02] text-xs font-medium">
          <button
            onClick={() => setTab('qr')}
            className={`flex-1 py-2.5 flex items-center justify-center gap-1.5 border-b-2 transition ${
              tab === 'qr'
                ? 'border-sky-400 text-sky-300 bg-slate-900/60'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            <QrCode className="w-3.5 h-3.5" /> QR Code
          </button>
          <button
            onClick={() => setTab('pair')}
            className={`flex-1 py-2.5 border-b-2 transition ${
              tab === 'pair'
                ? 'border-sky-400 text-sky-300 bg-slate-900/60'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Pairing Code
          </button>
          <button
            onClick={() => setTab('connect')}
            className={`flex-1 py-2.5 border-b-2 transition ${
              tab === 'connect'
                ? 'border-sky-400 text-sky-300 bg-slate-900/60'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            Direct Connect
          </button>
        </div>

        <div className="p-5 space-y-4">
          {tab === 'qr' && (
            <div className="flex flex-col items-center text-center space-y-3">
              <div className="p-3 rounded-2xl bg-white shadow-lg">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="ADB Wireless Pairing QR" className="w-44 h-44" />
                ) : (
                  <div className="w-44 h-44 bg-slate-200 animate-pulse rounded" />
                )}
              </div>
              <div className="text-xs text-slate-300 space-y-1">
                <p className="font-medium text-white">On your itel P55T:</p>
                <p className="text-slate-400">
                  Settings → Developer options → <span className="text-slate-200">Wireless debugging</span> →{' '}
                  <span className="text-sky-300">Pair device with QR code</span>
                </p>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <RefreshCw className="w-3 h-3 animate-spin text-sky-400" />
                Listening for phone on local Wi-Fi (mDNS)...
              </div>
            </div>
          )}

          {tab === 'pair' && (
            <form onSubmit={(e) => void handlePairSubmit(e)} className="space-y-3">
              <p className="text-xs text-slate-400">
                Tap <span className="text-slate-200">Pair device with pairing code</span> under Wireless debugging on your phone.
              </p>

              {pairingServices.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] uppercase tracking-wider text-slate-400">
                    Discovered pairing endpoints
                  </div>
                  {pairingServices.map((s) => (
                    <button
                      type="button"
                      key={`${s.address}:${s.port}`}
                      onClick={() => setPairEndpoint(`${s.address}:${s.port}`)}
                      className="w-full text-left px-3 py-1.5 rounded-lg bg-slate-800/70 hover:bg-slate-800 border border-slate-700 text-xs text-sky-300 flex items-center justify-between"
                    >
                      <span>{s.address}:{s.port}</span>
                      <span className="text-[10px] text-slate-400">Use</span>
                    </button>
                  ))}
                </div>
              )}

              <div>
                <label className="block text-xs text-slate-300 mb-1">IP address &amp; Pairing port</label>
                <input
                  type="text"
                  required
                  placeholder="192.168.1.42:37891"
                  value={pairEndpoint}
                  onChange={(e) => setPairEndpoint(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-sky-400"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-300 mb-1">Wi-Fi pairing code (6 digits)</label>
                <input
                  type="text"
                  required
                  placeholder="123456"
                  value={pairCode}
                  onChange={(e) => setPairCode(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-sky-400"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold text-sm transition"
              >
                {busy ? 'Pairing...' : 'Pair & Connect'}
              </button>
            </form>
          )}

          {tab === 'connect' && (
            <form onSubmit={(e) => void handleConnectSubmit(e)} className="space-y-3">
              <p className="text-xs text-slate-400">
                Enter the IP address &amp; port shown on the Wireless debugging screen (or <span className="font-mono text-slate-300">IP:5555</span> if enabled via USB).
              </p>

              {connectServices.length > 0 && (
                <div className="space-y-1">
                  <div className="text-[11px] uppercase tracking-wider text-slate-400">
                    Discovered wireless phones
                  </div>
                  {connectServices.map((s) => (
                    <button
                      type="button"
                      key={`${s.address}:${s.port}`}
                      onClick={() => setConnectEndpoint(`${s.address}:${s.port}`)}
                      className="w-full text-left px-3 py-1.5 rounded-lg bg-slate-800/70 hover:bg-slate-800 border border-slate-700 text-xs text-emerald-300 flex items-center justify-between"
                    >
                      <span className="flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {s.address}:{s.port}
                      </span>
                      <span className="text-[10px] text-slate-400">Fill</span>
                    </button>
                  ))}
                </div>
              )}

              <div>
                <label className="block text-xs text-slate-300 mb-1">IP address &amp; Port</label>
                <input
                  type="text"
                  required
                  placeholder="192.168.1.42:5555"
                  value={connectEndpoint}
                  onChange={(e) => setConnectEndpoint(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-sky-400"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 font-semibold text-sm transition"
              >
                {busy ? 'Connecting...' : 'Connect'}
              </button>
            </form>
          )}

          {status && (
            <div
              className={`p-3 rounded-xl text-xs border ${
                status.error
                  ? 'bg-rose-950/60 border-rose-500/40 text-rose-200'
                  : 'bg-emerald-950/60 border-emerald-500/40 text-emerald-200'
              }`}
            >
              {status.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
