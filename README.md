# DroidLink

Windows desktop application to mirror and control an **itel P55T** (or any Android device) over **ADB** via **USB** or **Wi-Fi**, with no root required.

## Features
- **Wired (USB) & Wireless ADB**:
  - Android 11+ **Wireless debugging** via **QR code** (mDNS auto-discovery), **6-digit pairing code**, or **Direct Connect** (`IP:port`).
  - One-click **USB → Wi-Fi** transition (`adb tcpip 5555`).
- **Low-latency Mirroring & Audio**:
  - Hardware-accelerated H.264/H.265 decoding via WebCodecs (`VideoDecoder`).
  - Optional Android 11+ device audio forwarding (`Opus` via WebAudio).
  - Screen-off mirroring ("mirror dark") to save phone battery.
- **Full Desktop Input**:
  - Left-click & drag = touch, Right-click = Back / wake, Middle-click = Home, Mouse wheel = swipe/scroll, Keyboard typing + navigation keys, `Ctrl+V` clipboard paste.
  - Drag & drop `.apk` files onto the phone screen to install, or any other file to push to `/sdcard/Download`.
- **Device Tools**:
  - File Manager (browse, upload, download, mkdir, delete)
  - App Manager (list, install APK, launch, force-stop, uninstall)
  - Interactive ADB Shell & Live Logcat viewer
  - PNG Screenshot & WebM Screen Recording
  - Live Device Telemetry (battery, temperature, RAM, storage, Wi-Fi IP)

## Prerequisites on your itel P55T
1. **Settings → About phone** → tap **Build number** 7 times to unlock Developer options.
2. **Settings → System → Developer options** → enable **USB debugging** (and **Wireless debugging** for cable-free pairing).
3. When plugging in via USB for the first time, tap **Allow** on the *"Allow USB debugging?"* prompt.

## Running DroidLink
```bash
# 1. Install dependencies (if not already done)
npm install

# 2. Download bundled adb.exe + scrcpy-server (already done if resources/ exists)
npm run setup:runtime

# 3. Start in development mode
npm run dev

# Or build and run production bundle
npm start
```

## Scripts
- `npm run dev` — Run Vite + Electron main compiler + Electron window
- `npm run build` — Build main process and renderer bundle
- `npm run typecheck` — TypeScript check for main, preload, shared, and renderer
- `npm test` — Run protocol and ADB parser unit tests
- `npm run pack:win` — Package Windows installer via `electron-builder`
