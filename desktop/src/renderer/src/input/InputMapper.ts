import {
  ANDROID_KEYCODE,
  CONTROL_MSG_TYPE,
  KEY_ACTION,
  MOTION_ACTION,
  MOTION_BUTTON,
  POINTER_ID_GENERIC_FINGER,
  POINTER_ID_MOUSE,
  POINTER_ID_VIRTUAL_FINGER,
  serializeControlMessage,
} from '@shared/protocol';
import {
  mapBrowserCodeToAndroidKeycode,
  mapBrowserModifiersToAndroidMeta,
} from './keycodes';

export type SendControlFn = (bytes: Uint8Array) => void;

export type ViewRotation = 0 | 90 | 180 | 270;

export type PinchDirection = 'in' | 'out';

export interface DevicePoint {
  x: number;
  y: number;
}

export type PinchOverlayPoints = [{ u: number; v: number }, { u: number; v: number }] | null;

export interface DisplayGeometry {
  width: number;
  height: number;
  viewRotation?: ViewRotation;
}

/**
 * Inverse-maps normalized canvas coordinates `(u, v)` in `[0, 1]` to normalized
 * Android device coordinates `(rx, ry)` for the active mirror view rotation.
 */
export function mapNormalizedPointForRotation(
  u: number,
  v: number,
  viewRotation: ViewRotation = 0,
): { rx: number; ry: number } {
  switch (viewRotation) {
    case 90:
      return { rx: v, ry: 1 - u };
    case 180:
      return { rx: 1 - u, ry: 1 - v };
    case 270:
      return { rx: 1 - v, ry: u };
    case 0:
    default:
      return { rx: u, ry: v };
  }
}

/**
 * Forward-maps normalized Android device coordinates `(rx, ry)` in `[0, 1]` back
 * to normalized canvas coordinates `(u, v)` for visual overlays.
 */
export function mapDeviceNormalizedToCanvas(
  rx: number,
  ry: number,
  viewRotation: ViewRotation = 0,
): { u: number; v: number } {
  switch (viewRotation) {
    case 90:
      return { u: 1 - ry, v: rx };
    case 180:
      return { u: 1 - rx, v: 1 - ry };
    case 270:
      return { u: ry, v: 1 - rx };
    case 0:
    default:
      return { u: rx, v: ry };
  }
}

export function clampDevicePoint(x: number, y: number, width: number, height: number): DevicePoint {
  return {
    x: Math.max(0, Math.min(Math.max(0, width - 1), Math.round(x))),
    y: Math.max(0, Math.min(Math.max(0, height - 1), Math.round(y))),
  };
}

/**
 * Computes two opposing pinch finger positions along an angle around `(cx, cy)`.
 */
export function computePinchPositions(
  cx: number,
  cy: number,
  width: number,
  height: number,
  radius: number,
  angleRad = Math.PI / 4,
): [DevicePoint, DevicePoint] {
  const dx = radius * Math.cos(angleRad);
  const dy = radius * Math.sin(angleRad);
  return [
    clampDevicePoint(cx - dx, cy - dy, width, height),
    clampDevicePoint(cx + dx, cy + dy, width, height),
  ];
}

/**
 * Computes primary + mirrored virtual finger positions around screen center (scrcpy Ctrl+drag pinch).
 */
export function computeMirrorPinchPositions(
  p1x: number,
  p1y: number,
  width: number,
  height: number,
): [DevicePoint, DevicePoint] {
  const cx = width / 2;
  const cy = height / 2;
  const p1 = clampDevicePoint(p1x, p1y, width, height);
  const p2 = clampDevicePoint(2 * cx - p1.x, 2 * cy - p1.y, width, height);
  return [p1, p2];
}

function browserButtonsToAndroid(buttons: number): number {
  let out = MOTION_BUTTON.NONE;
  if (buttons & 1) out |= MOTION_BUTTON.PRIMARY;
  if (buttons & 2) out |= MOTION_BUTTON.SECONDARY;
  if (buttons & 4) out |= MOTION_BUTTON.TERTIARY;
  if (buttons & 8) out |= MOTION_BUTTON.BACK;
  if (buttons & 16) out |= MOTION_BUTTON.FORWARD;
  return out;
}

function browserButtonToAndroid(button: number): number {
  switch (button) {
    case 0:
      return MOTION_BUTTON.PRIMARY;
    case 1:
      return MOTION_BUTTON.TERTIARY;
    case 2:
      return MOTION_BUTTON.SECONDARY;
    case 3:
      return MOTION_BUTTON.BACK;
    case 4:
      return MOTION_BUTTON.FORWARD;
    default:
      return MOTION_BUTTON.NONE;
  }
}

export class InputMapper {
  private isPrimaryPressed = false;
  private isPinchDragActive = false;
  private activeTouchIds = new Set<number>();
  private pinchTimers: ReturnType<typeof setTimeout>[] = [];
  private animPinchActive: { width: number; height: number; p1: DevicePoint; p2: DevicePoint } | null =
    null;
  private wheelPinch: {
    cx: number;
    cy: number;
    width: number;
    height: number;
    radius: number;
    minR: number;
    maxR: number;
    p1: DevicePoint;
    p2: DevicePoint;
    idleTimer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    private readonly getGeometry: () => DisplayGeometry,
    private readonly send: SendControlFn,
    private readonly onPinchOverlay?: (points: PinchOverlayPoints) => void,
  ) {}

  dispose(): void {
    this.cancelAnimatedPinch();
    this.endWheelPinch();
    this.isPrimaryPressed = false;
    this.isPinchDragActive = false;
    this.activeTouchIds.clear();
  }

  private emitPinchOverlay(
    p1: DevicePoint,
    p2: DevicePoint,
    width: number,
    height: number,
  ): void {
    if (!this.onPinchOverlay || width <= 0 || height <= 0) return;
    const rot = this.getGeometry().viewRotation ?? 0;
    this.onPinchOverlay([
      mapDeviceNormalizedToCanvas(p1.x / width, p1.y / height, rot),
      mapDeviceNormalizedToCanvas(p2.x / width, p2.y / height, rot),
    ]);
  }

  private sendFingerTouch(
    action: number,
    pointerId: bigint,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    this.send(
      serializeControlMessage({
        type: CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT,
        action,
        pointerId,
        position: { x, y, screenWidth: width, screenHeight: height },
        pressure: action === MOTION_ACTION.UP ? 0 : 1,
        actionButton: 0,
        buttons: 0,
      }),
    );
  }

  private sendPinchPair(
    action: number,
    p1: DevicePoint,
    p2: DevicePoint,
    width: number,
    height: number,
  ): void {
    if (action === MOTION_ACTION.UP) {
      // Lift virtual secondary finger before primary finger so scrcpy sees POINTER_UP then UP
      this.sendFingerTouch(MOTION_ACTION.UP, POINTER_ID_VIRTUAL_FINGER, p2.x, p2.y, width, height);
      this.sendFingerTouch(MOTION_ACTION.UP, POINTER_ID_GENERIC_FINGER, p1.x, p1.y, width, height);
      this.onPinchOverlay?.(null);
      return;
    }
    this.sendFingerTouch(action, POINTER_ID_GENERIC_FINGER, p1.x, p1.y, width, height);
    this.sendFingerTouch(action, POINTER_ID_VIRTUAL_FINGER, p2.x, p2.y, width, height);
    this.emitPinchOverlay(p1, p2, width, height);
  }

  private cancelAnimatedPinch(): void {
    for (const id of this.pinchTimers) {
      clearTimeout(id);
    }
    this.pinchTimers = [];
    if (this.animPinchActive) {
      const { p1, p2, width, height } = this.animPinchActive;
      this.animPinchActive = null;
      this.sendPinchPair(MOTION_ACTION.UP, p1, p2, width, height);
    }
  }

  private endWheelPinch(): void {
    if (!this.wheelPinch) return;
    clearTimeout(this.wheelPinch.idleTimer);
    const { p1, p2, width, height } = this.wheelPinch;
    this.wheelPinch = null;
    this.sendPinchPair(MOTION_ACTION.UP, p1, p2, width, height);
  }

  /**
   * Performs a smooth two-finger pinch-out ('in') or pinch-in ('out') gesture on the phone
   * screen so camera & livestream apps zoom reliably.
   */
  performPinchZoom(direction: PinchDirection, center?: DevicePoint): void {
    const geom = this.getGeometry();
    const { width, height } = geom;
    if (width <= 0 || height <= 0) return;

    this.cancelAnimatedPinch();
    this.endWheelPinch();

    const minDim = Math.min(width, height);
    // Start/end radii stay above Android ScaleGestureDetector's minScalingSpan (~27mm / ~306px at 288dpi)
    const minR = Math.max(40, Math.round(0.22 * minDim));
    const maxR = Math.max(minR + 40, Math.round(0.35 * minDim));
    const startR = direction === 'in' ? minR : maxR;
    const endR = direction === 'in' ? maxR : minR;

    const margin = Math.round(0.24 * minDim);
    const cx = center
      ? Math.max(margin, Math.min(width - margin, center.x))
      : Math.round(width / 2);
    const cy = center
      ? Math.max(margin, Math.min(height - margin, center.y))
      : Math.round(height / 2);

    const [p1Start, p2Start] = computePinchPositions(cx, cy, width, height, startR);
    this.animPinchActive = { width, height, p1: p1Start, p2: p2Start };
    this.sendPinchPair(MOTION_ACTION.DOWN, p1Start, p2Start, width, height);

    const steps = 8;
    const stepDelayMs = 18;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const r = startR + (endR - startR) * t;
      const timerId = setTimeout(() => {
        if (!this.animPinchActive) return;
        const [p1, p2] = computePinchPositions(cx, cy, width, height, r);
        this.animPinchActive = { width, height, p1, p2 };
        this.sendPinchPair(MOTION_ACTION.MOVE, p1, p2, width, height);
      }, i * stepDelayMs);
      this.pinchTimers.push(timerId);
    }

    const upTimer = setTimeout(() => {
      if (!this.animPinchActive) return;
      const { p1, p2 } = this.animPinchActive;
      this.animPinchActive = null;
      this.sendPinchPair(MOTION_ACTION.UP, p1, p2, width, height);
      this.pinchTimers = [];
    }, (steps + 1) * stepDelayMs + 10);
    this.pinchTimers.push(upTimer);
  }

  private mapClientToDevice(
    clientX: number,
    clientY: number,
    rect: DOMRect,
  ): { x: number; y: number; screenWidth: number; screenHeight: number } | null {
    const geom = this.getGeometry();
    if (geom.width <= 0 || geom.height <= 0 || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const u = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const { rx, ry } = mapNormalizedPointForRotation(u, v, geom.viewRotation ?? 0);

    return {
      x: Math.round(rx * geom.width),
      y: Math.round(ry * geom.height),
      screenWidth: geom.width,
      screenHeight: geom.height,
    };
  }

  handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    const canvas = e.currentTarget;
    canvas.focus();
    const rect = canvas.getBoundingClientRect();

    // Right-click triggers Android BACK / wake screen (scrcpy convention)
    if (e.pointerType === 'mouse' && e.button === 2) {
      e.preventDefault();
      this.send(
        serializeControlMessage({
          type: CONTROL_MSG_TYPE.BACK_OR_SCREEN_ON,
          action: KEY_ACTION.DOWN,
        }),
      );
      return;
    }

    // Middle-click triggers Android HOME
    if (e.pointerType === 'mouse' && e.button === 1) {
      e.preventDefault();
      this.sendKeycode(ANDROID_KEYCODE.HOME, KEY_ACTION.DOWN, 0);
      return;
    }

    const pos = this.mapClientToDevice(e.clientX, e.clientY, rect);
    if (!pos) return;

    canvas.setPointerCapture(e.pointerId);

    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      if (e.ctrlKey || e.altKey) {
        this.cancelAnimatedPinch();
        this.endWheelPinch();
        this.isPinchDragActive = true;
        const [p1, p2] = computeMirrorPinchPositions(pos.x, pos.y, pos.screenWidth, pos.screenHeight);
        this.sendPinchPair(MOTION_ACTION.DOWN, p1, p2, pos.screenWidth, pos.screenHeight);
        return;
      }
      this.isPrimaryPressed = true;
      this.send(
        serializeControlMessage({
          type: CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT,
          action: MOTION_ACTION.DOWN,
          pointerId: POINTER_ID_MOUSE,
          position: pos,
          pressure: 1,
          actionButton: browserButtonToAndroid(e.button),
          buttons: browserButtonsToAndroid(e.buttons),
        }),
      );
    } else {
      this.activeTouchIds.add(e.pointerId);
      this.send(
        serializeControlMessage({
          type: CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT,
          action: MOTION_ACTION.DOWN,
          pointerId: BigInt(e.pointerId),
          position: pos,
          pressure: e.pressure > 0 ? e.pressure : 1,
          actionButton: 0,
          buttons: 0,
        }),
      );
    }
  }

  handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = this.mapClientToDevice(e.clientX, e.clientY, rect);
    if (!pos) return;

    if (e.pointerType === 'mouse') {
      if (this.isPinchDragActive) {
        const [p1, p2] = computeMirrorPinchPositions(pos.x, pos.y, pos.screenWidth, pos.screenHeight);
        this.sendPinchPair(MOTION_ACTION.MOVE, p1, p2, pos.screenWidth, pos.screenHeight);
        return;
      }
      if (!this.isPrimaryPressed) return;
      this.send(
        serializeControlMessage({
          type: CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT,
          action: MOTION_ACTION.MOVE,
          pointerId: POINTER_ID_MOUSE,
          position: pos,
          pressure: 1,
          actionButton: 0,
          buttons: browserButtonsToAndroid(e.buttons),
        }),
      );
    } else if (this.activeTouchIds.has(e.pointerId)) {
      this.send(
        serializeControlMessage({
          type: CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT,
          action: MOTION_ACTION.MOVE,
          pointerId: BigInt(e.pointerId),
          position: pos,
          pressure: e.pressure > 0 ? e.pressure : 1,
          actionButton: 0,
          buttons: 0,
        }),
      );
    }
  }

  handlePointerUp(e: React.PointerEvent<HTMLCanvasElement>): void {
    const canvas = e.currentTarget;
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }

    if (e.pointerType === 'mouse' && e.button === 2) {
      this.send(
        serializeControlMessage({
          type: CONTROL_MSG_TYPE.BACK_OR_SCREEN_ON,
          action: KEY_ACTION.UP,
        }),
      );
      return;
    }

    if (e.pointerType === 'mouse' && e.button === 1) {
      this.sendKeycode(ANDROID_KEYCODE.HOME, KEY_ACTION.UP, 0);
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const pos = this.mapClientToDevice(e.clientX, e.clientY, rect);
    if (!pos) return;

    if (e.pointerType === 'mouse') {
      if (this.isPinchDragActive) {
        this.isPinchDragActive = false;
        const [p1, p2] = computeMirrorPinchPositions(pos.x, pos.y, pos.screenWidth, pos.screenHeight);
        this.sendPinchPair(MOTION_ACTION.UP, p1, p2, pos.screenWidth, pos.screenHeight);
        return;
      }
      if (!this.isPrimaryPressed) return;
      this.isPrimaryPressed = false;
      this.send(
        serializeControlMessage({
          type: CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT,
          action: MOTION_ACTION.UP,
          pointerId: POINTER_ID_MOUSE,
          position: pos,
          pressure: 0,
          actionButton: browserButtonToAndroid(e.button),
          buttons: browserButtonsToAndroid(e.buttons),
        }),
      );
    } else if (this.activeTouchIds.has(e.pointerId)) {
      this.activeTouchIds.delete(e.pointerId);
      this.send(
        serializeControlMessage({
          type: CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT,
          action: MOTION_ACTION.UP,
          pointerId: BigInt(e.pointerId),
          position: pos,
          pressure: 0,
          actionButton: 0,
          buttons: 0,
        }),
      );
    }
  }

  handleWheel(
    e: Pick<
      WheelEvent,
      'clientX' | 'clientY' | 'deltaX' | 'deltaY' | 'deltaMode' | 'buttons' | 'ctrlKey' | 'preventDefault'
    > & { currentTarget: EventTarget | null },
  ): void {
    const target = e.currentTarget as HTMLCanvasElement | null;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const pos = this.mapClientToDevice(e.clientX, e.clientY, rect);
    if (!pos) return;

    // Ctrl+Wheel (and laptop trackpad two-finger pinch, which Chrome sends as ctrlKey wheel)
    if (e.ctrlKey) {
      e.preventDefault();
      this.handlePinchWheel(pos, e.deltaY, e.deltaMode);
      return;
    }

    // Normalize browser wheel delta into scrcpy [-16, 16] scroll units
    const scale = e.deltaMode === 1 ? 1 : 1 / 40;
    const hScroll = Math.max(-16, Math.min(16, -e.deltaX * scale));
    const vScroll = Math.max(-16, Math.min(16, -e.deltaY * scale));

    this.send(
      serializeControlMessage({
        type: CONTROL_MSG_TYPE.INJECT_SCROLL_EVENT,
        position: pos,
        hScroll,
        vScroll,
        buttons: browserButtonsToAndroid(e.buttons),
      }),
    );
  }

  private handlePinchWheel(
    pos: { x: number; y: number; screenWidth: number; screenHeight: number },
    deltaY: number,
    deltaMode: number,
  ): void {
    const rawStep = deltaMode === 1 ? -deltaY * 18 : -deltaY * 0.55;
    const step = Math.max(-42, Math.min(42, rawStep));
    if (step === 0) return;

    this.cancelAnimatedPinch();

    const width = pos.screenWidth;
    const height = pos.screenHeight;
    const minDim = Math.min(width, height);
    const minR = Math.max(30, Math.round(0.14 * minDim));
    const maxR = Math.max(minR + 60, Math.round(0.45 * minDim));
    const startR = Math.round(0.25 * minDim);

    if (!this.wheelPinch || this.wheelPinch.width !== width || this.wheelPinch.height !== height) {
      this.endWheelPinch();
      const margin = Math.round(0.24 * minDim);
      const cx = Math.max(margin, Math.min(width - margin, pos.x));
      const cy = Math.max(margin, Math.min(height - margin, pos.y));
      const [p1Start, p2Start] = computePinchPositions(cx, cy, width, height, startR);
      this.sendPinchPair(MOTION_ACTION.DOWN, p1Start, p2Start, width, height);
      this.wheelPinch = {
        cx,
        cy,
        width,
        height,
        radius: startR,
        minR,
        maxR,
        p1: p1Start,
        p2: p2Start,
        idleTimer: setTimeout(() => this.endWheelPinch(), 260),
      };
    } else {
      clearTimeout(this.wheelPinch.idleTimer);
    }

    const wp = this.wheelPinch;
    let nextR = wp.radius + step;
    if (nextR > wp.maxR || nextR < wp.minR) {
      // Re-anchor fingers at neutral radius so continuous scrolling can zoom indefinitely
      this.sendPinchPair(MOTION_ACTION.UP, wp.p1, wp.p2, wp.width, wp.height);
      const [p1Reset, p2Reset] = computePinchPositions(wp.cx, wp.cy, wp.width, wp.height, startR);
      this.sendPinchPair(MOTION_ACTION.DOWN, p1Reset, p2Reset, wp.width, wp.height);
      nextR = Math.max(wp.minR, Math.min(wp.maxR, startR + step));
    }

    const [p1, p2] = computePinchPositions(wp.cx, wp.cy, wp.width, wp.height, nextR);
    wp.radius = nextR;
    wp.p1 = p1;
    wp.p2 = p2;
    this.sendPinchPair(MOTION_ACTION.MOVE, p1, p2, wp.width, wp.height);
    wp.idleTimer = setTimeout(() => this.endWheelPinch(), 260);
  }

  handleKeyDown(e: React.KeyboardEvent<HTMLCanvasElement>): void {
    // Allow Ctrl+V to inject text / paste via device clipboard
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
      e.preventDefault();
      return; // handled by MirrorCanvas calling pushClipboard(..., true)
    }

    const keycode = mapBrowserCodeToAndroidKeycode(e.code);
    const meta = mapBrowserModifiersToAndroidMeta(e);

    // If printable character without Ctrl/Alt/Meta, prefer INJECT_TEXT for accurate layout/symbols
    if (
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey
    ) {
      e.preventDefault();
      this.send(
        serializeControlMessage({
          type: CONTROL_MSG_TYPE.INJECT_TEXT,
          text: e.key,
        }),
      );
      return;
    }

    if (keycode !== null) {
      e.preventDefault();
      this.sendKeycode(keycode, KEY_ACTION.DOWN, meta, e.repeat ? 1 : 0);
    }
  }

  handleKeyUp(e: React.KeyboardEvent<HTMLCanvasElement>): void {
    if (
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey
    ) {
      return;
    }
    const keycode = mapBrowserCodeToAndroidKeycode(e.code);
    if (keycode !== null) {
      e.preventDefault();
      const meta = mapBrowserModifiersToAndroidMeta(e);
      this.sendKeycode(keycode, KEY_ACTION.UP, meta, 0);
    }
  }

  sendKeycode(keycode: number, action: number, metaState = 0, repeat = 0): void {
    this.send(
      serializeControlMessage({
        type: CONTROL_MSG_TYPE.INJECT_KEYCODE,
        action,
        keycode,
        repeat,
        metaState,
      }),
    );
  }
}
