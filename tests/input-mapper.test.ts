import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROL_MSG_TYPE,
  MOTION_ACTION,
  POINTER_ID_GENERIC_FINGER,
  POINTER_ID_VIRTUAL_FINGER,
} from '../shared/protocol';
import {
  computeMirrorPinchPositions,
  computePinchPositions,
  InputMapper,
  mapDeviceNormalizedToCanvas,
  mapNormalizedPointForRotation,
  type PinchOverlayPoints,
  type ViewRotation,
} from '../desktop/src/renderer/src/input/InputMapper';

function decodeTouchPacket(packet: Uint8Array): {
  type: number;
  action: number;
  pointerId: bigint;
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
} {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  return {
    type: view.getUint8(0),
    action: view.getUint8(1),
    pointerId: view.getBigInt64(2, false),
    x: view.getInt32(10, false),
    y: view.getInt32(14, false),
    screenWidth: view.getUint16(18, false),
    screenHeight: view.getUint16(20, false),
  };
}

function decodeTouchCoordinates(packet: Uint8Array): {
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
} {
  const { x, y, screenWidth, screenHeight } = decodeTouchPacket(packet);
  return { x, y, screenWidth, screenHeight };
}

function makePointerEvent(
  clientX: number,
  clientY: number,
  rectWidth: number,
  rectHeight: number,
  opts: { ctrlKey?: boolean; altKey?: boolean } = {},
): React.PointerEvent<HTMLCanvasElement> {
  const rect = {
    left: 0,
    top: 0,
    width: rectWidth,
    height: rectHeight,
    right: rectWidth,
    bottom: rectHeight,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;

  return {
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    pointerId: 1,
    clientX,
    clientY,
    pressure: 1,
    ctrlKey: opts.ctrlKey ?? false,
    altKey: opts.altKey ?? false,
    currentTarget: {
      focus: () => {},
      setPointerCapture: () => {},
      hasPointerCapture: () => true,
      releasePointerCapture: () => {},
      getBoundingClientRect: () => rect,
    },
  } as unknown as React.PointerEvent<HTMLCanvasElement>;
}

const makePointerDownEvent = makePointerEvent;

describe('mapNormalizedPointForRotation', () => {
  it('maps 0° view directly without rotation', () => {
    expect(mapNormalizedPointForRotation(0.25, 0.75, 0)).toEqual({ rx: 0.25, ry: 0.75 });
  });

  it('inverse-maps 90° CW view so top-right canvas hits phone top-left', () => {
    expect(mapNormalizedPointForRotation(1, 0, 90)).toEqual({ rx: 0, ry: 0 });
    expect(mapNormalizedPointForRotation(1, 1, 90)).toEqual({ rx: 1, ry: 0 });
    expect(mapNormalizedPointForRotation(0, 0, 90)).toEqual({ rx: 0, ry: 1 });
  });

  it('inverse-maps 180° inverted view so bottom-right canvas hits phone top-left', () => {
    expect(mapNormalizedPointForRotation(1, 1, 180)).toEqual({ rx: 0, ry: 0 });
    expect(mapNormalizedPointForRotation(0, 1, 180)).toEqual({ rx: 1, ry: 0 });
  });

  it('inverse-maps 270° CCW landscape view so bottom-left canvas hits phone top-left', () => {
    expect(mapNormalizedPointForRotation(0, 1, 270)).toEqual({ rx: 0, ry: 0 });
    expect(mapNormalizedPointForRotation(0, 0, 270)).toEqual({ rx: 1, ry: 0 });
    expect(mapNormalizedPointForRotation(1, 1, 270)).toEqual({ rx: 0, ry: 1 });
  });
});

describe('InputMapper pointer coordinate transform', () => {
  const portraitW = 720;
  const portraitH = 1612;

  it.each<{
    viewRotation: ViewRotation;
    rectW: number;
    rectH: number;
    clientX: number;
    clientY: number;
    expectedX: number;
    expectedY: number;
  }>([
    // Portrait 0°: (180, 403) in 360x806 canvas -> (360, 806) on 720x1612 phone
    {
      viewRotation: 0,
      rectW: 360,
      rectH: 806,
      clientX: 180,
      clientY: 403,
      expectedX: 360,
      expectedY: 806,
    },
    // Rotated 270° (landscape canvas 806x360): bottom-left edge near origin maps to top-left of phone
    {
      viewRotation: 270,
      rectW: 806,
      rectH: 360,
      clientX: 0,
      clientY: 360,
      expectedX: 0,
      expectedY: 0,
    },
    // Rotated 270° (landscape canvas 806x360): top-left (0, 0) maps to phone top-right (720, 0)
    {
      viewRotation: 270,
      rectW: 806,
      rectH: 360,
      clientX: 0,
      clientY: 0,
      expectedX: 720,
      expectedY: 0,
    },
    // Rotated 90° (landscape canvas 806x360): top-right (806, 0) maps to phone top-left (0, 0)
    {
      viewRotation: 90,
      rectW: 806,
      rectH: 360,
      clientX: 806,
      clientY: 0,
      expectedX: 0,
      expectedY: 0,
    },
    // Rotated 180° (portrait canvas 360x806): (90, 201.5) -> u=0.25, v=0.25 -> rx=0.75, ry=0.75
    {
      viewRotation: 180,
      rectW: 360,
      rectH: 806,
      clientX: 90,
      clientY: 201.5,
      expectedX: 540,
      expectedY: 1209,
    },
  ])(
    'encodes INJECT_TOUCH_EVENT accurately for $viewRotation° view',
    ({ viewRotation, rectW, rectH, clientX, clientY, expectedX, expectedY }) => {
      const sent: Uint8Array[] = [];
      const mapper = new InputMapper(
        () => ({ width: portraitW, height: portraitH, viewRotation }),
        (bytes) => sent.push(bytes),
      );

      mapper.handlePointerDown(makePointerDownEvent(clientX, clientY, rectW, rectH));

      expect(sent).toHaveLength(1);
      expect(decodeTouchCoordinates(sent[0])).toEqual({
        x: expectedX,
        y: expectedY,
        screenWidth: portraitW,
        screenHeight: portraitH,
      });
    },
  );
});

describe('camera pinch-to-zoom controls', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('roundtrips forward device-to-canvas mapping across all rotations', () => {
    for (const rot of [0, 90, 180, 270] as ViewRotation[]) {
      const { u, v } = mapDeviceNormalizedToCanvas(0.2, 0.7, rot);
      const { rx, ry } = mapNormalizedPointForRotation(u, v, rot);
      expect(rx).toBeCloseTo(0.2, 6);
      expect(ry).toBeCloseTo(0.7, 6);
    }
  });

  it('clamps opposing pinch points inside screen bounds', () => {
    const [p1, p2] = computePinchPositions(806, 360, 1612, 720, 200);
    expect(p1).toEqual({ x: 665, y: 219 });
    expect(p2).toEqual({ x: 947, y: 501 });

    // Edge clamping keeps fingers within [0..width-1, 0..height-1]
    const [e1, e2] = computePinchPositions(10, 10, 1612, 720, 200);
    expect(e1).toEqual({ x: 0, y: 0 });
    expect(e2).toEqual({ x: 151, y: 151 });

    const [m1, m2] = computeMirrorPinchPositions(1000, 500, 1612, 720);
    expect(m1).toEqual({ x: 1000, y: 500 });
    expect(m2).toEqual({ x: 612, y: 220 });
  });

  it('animates dual-finger pinch out (zoom in) and pinch in (zoom out) with clean DOWN -> MOVE -> UP', () => {
    vi.useFakeTimers();
    const sent: Uint8Array[] = [];
    const overlays: PinchOverlayPoints[] = [];
    const mapper = new InputMapper(
      () => ({ width: 1612, height: 720, viewRotation: 0 }),
      (bytes) => sent.push(bytes),
      (pts) => overlays.push(pts),
    );

    mapper.performPinchZoom('in');
    vi.runAllTimers();

    const events = sent.map(decodeTouchPacket);
    expect(events.every((e) => e.type === CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT)).toBe(true);

    const downPairs = events.filter((e) => e.action === MOTION_ACTION.DOWN);
    const movePairs = events.filter((e) => e.action === MOTION_ACTION.MOVE);
    const upPairs = events.filter((e) => e.action === MOTION_ACTION.UP);

    expect(downPairs).toHaveLength(2);
    expect(downPairs[0].pointerId).toBe(POINTER_ID_GENERIC_FINGER);
    expect(downPairs[1].pointerId).toBe(POINTER_ID_VIRTUAL_FINGER);
    expect(upPairs).toHaveLength(2);
    // Secondary virtual finger lifts before primary finger
    expect(upPairs[0].pointerId).toBe(POINTER_ID_VIRTUAL_FINGER);
    expect(upPairs[1].pointerId).toBe(POINTER_ID_GENERIC_FINGER);
    expect(movePairs.length).toBeGreaterThanOrEqual(16);

    const initialSpan = Math.hypot(
      downPairs[1].x - downPairs[0].x,
      downPairs[1].y - downPairs[0].y,
    );
    const finalSpan = Math.hypot(
      upPairs[0].x - upPairs[1].x,
      upPairs[0].y - upPairs[1].y,
    );
    // Initial span exceeds Android 288dpi config_minScalingSpan (~306px) and expands for zoom-in
    expect(initialSpan).toBeGreaterThanOrEqual(310);
    expect(finalSpan).toBeGreaterThan(initialSpan * 1.4);
    expect(overlays.at(-1)).toBeNull();

    // Now test Zoom Out shrinks finger span
    sent.length = 0;
    mapper.performPinchZoom('out');
    vi.runAllTimers();
    const outEvents = sent.map(decodeTouchPacket);
    const outDown = outEvents.filter((e) => e.action === MOTION_ACTION.DOWN);
    const outUp = outEvents.filter((e) => e.action === MOTION_ACTION.UP);
    const outStartSpan = Math.hypot(outDown[1].x - outDown[0].x, outDown[1].y - outDown[0].y);
    const outEndSpan = Math.hypot(outUp[0].x - outUp[1].x, outUp[0].y - outUp[1].y);
    expect(outEndSpan).toBeLessThan(outStartSpan * 0.7);
  });

  it('supports Ctrl+Left-Drag mirrored two-finger pinch and cleans up on pointerup', () => {
    const sent: Uint8Array[] = [];
    const overlays: PinchOverlayPoints[] = [];
    const mapper = new InputMapper(
      () => ({ width: 1612, height: 720, viewRotation: 0 }),
      (bytes) => sent.push(bytes),
      (pts) => overlays.push(pts),
    );

    mapper.handlePointerDown(makePointerEvent(900, 400, 1612, 720, { ctrlKey: true }));
    mapper.handlePointerMove(makePointerEvent(1100, 480, 1612, 720, { ctrlKey: true }));
    mapper.handlePointerUp(makePointerEvent(1100, 480, 1612, 720, { ctrlKey: true }));

    const events = sent.map(decodeTouchPacket);
    expect(events).toHaveLength(6);
    expect(events.map((e) => e.action)).toEqual([
      MOTION_ACTION.DOWN,
      MOTION_ACTION.DOWN,
      MOTION_ACTION.MOVE,
      MOTION_ACTION.MOVE,
      MOTION_ACTION.UP,
      MOTION_ACTION.UP,
    ]);
    // Finger 1 moves to (1100, 480), virtual finger mirrors around center (806, 360) -> (512, 240)
    expect(events[2]).toMatchObject({ pointerId: POINTER_ID_GENERIC_FINGER, x: 1100, y: 480 });
    expect(events[3]).toMatchObject({ pointerId: POINTER_ID_VIRTUAL_FINGER, x: 512, y: 240 });
    expect(overlays.at(-1)).toBeNull();
  });

  it('converts Ctrl+Wheel into continuous pinch zoom and calls preventDefault()', () => {
    vi.useFakeTimers();
    const sent: Uint8Array[] = [];
    const mapper = new InputMapper(
      () => ({ width: 1612, height: 720, viewRotation: 0 }),
      (bytes) => sent.push(bytes),
    );

    const preventDefault = vi.fn();
    const rect = { left: 0, top: 0, width: 1612, height: 720 } as DOMRect;
    const target = { getBoundingClientRect: () => rect } as unknown as HTMLCanvasElement;

    // Scroll up (-deltaY) -> zoom in (expand fingers)
    mapper.handleWheel({
      currentTarget: target,
      clientX: 806,
      clientY: 360,
      deltaX: 0,
      deltaY: -60,
      deltaMode: 0,
      buttons: 0,
      ctrlKey: true,
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledTimes(1);

    const afterFirst = sent.map(decodeTouchPacket);
    expect(afterFirst.every((e) => e.type === CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT)).toBe(true);
    const downSpan = Math.hypot(afterFirst[1].x - afterFirst[0].x, afterFirst[1].y - afterFirst[0].y);
    const moveUpSpan = Math.hypot(afterFirst[3].x - afterFirst[2].x, afterFirst[3].y - afterFirst[2].y);
    expect(moveUpSpan).toBeGreaterThan(downSpan);

    // Idle timeout lifts both fingers cleanly
    vi.advanceTimersByTime(300);
    const finalEvents = sent.map(decodeTouchPacket);
    expect(finalEvents.slice(-2).map((e) => e.action)).toEqual([MOTION_ACTION.UP, MOTION_ACTION.UP]);
  });
});
