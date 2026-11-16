import { CONTROL_MSG_TYPE } from './constants';

const encoder = new TextEncoder();

export interface Position {
  x: number;
  y: number;
  screenWidth: number;
  screenHeight: number;
}

export type ControlMessage =
  | {
      type: typeof CONTROL_MSG_TYPE.INJECT_KEYCODE;
      action: number;
      keycode: number;
      repeat: number;
      metaState: number;
    }
  | {
      type: typeof CONTROL_MSG_TYPE.INJECT_TEXT;
      text: string;
    }
  | {
      type: typeof CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT;
      action: number;
      pointerId: bigint;
      position: Position;
      pressure: number;
      actionButton: number;
      buttons: number;
    }
  | {
      type: typeof CONTROL_MSG_TYPE.INJECT_SCROLL_EVENT;
      position: Position;
      hScroll: number;
      vScroll: number;
      buttons: number;
    }
  | {
      type: typeof CONTROL_MSG_TYPE.BACK_OR_SCREEN_ON;
      action: number;
    }
  | {
      type:
        | typeof CONTROL_MSG_TYPE.EXPAND_NOTIFICATION_PANEL
        | typeof CONTROL_MSG_TYPE.EXPAND_SETTINGS_PANEL
        | typeof CONTROL_MSG_TYPE.COLLAPSE_PANELS
        | typeof CONTROL_MSG_TYPE.ROTATE_DEVICE
        | typeof CONTROL_MSG_TYPE.OPEN_HARD_KEYBOARD_SETTINGS
        | typeof CONTROL_MSG_TYPE.RESET_VIDEO;
    }
  | {
      type: typeof CONTROL_MSG_TYPE.GET_CLIPBOARD;
      copyKey: number;
    }
  | {
      type: typeof CONTROL_MSG_TYPE.SET_CLIPBOARD;
      sequence: bigint;
      paste: boolean;
      text: string;
    }
  | {
      type: typeof CONTROL_MSG_TYPE.SET_DISPLAY_POWER;
      on: boolean;
    }
  | {
      type: typeof CONTROL_MSG_TYPE.START_APP;
      name: string;
    };

function floatToU16FixedPoint(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  if (clamped >= 1) return 0xffff;
  return Math.floor(clamped * 0x10000) & 0xffff;
}

function floatToI16FixedPoint(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  if (clamped >= 1) return 0x7fff;
  if (clamped <= -1) return -0x8000;
  return Math.round(clamped * 0x8000);
}

export function serializeControlMessage(msg: ControlMessage): Uint8Array {
  switch (msg.type) {
    case CONTROL_MSG_TYPE.INJECT_KEYCODE: {
      const buf = new Uint8Array(14);
      const view = new DataView(buf.buffer);
      view.setUint8(0, msg.type);
      view.setUint8(1, msg.action);
      view.setInt32(2, msg.keycode, false);
      view.setInt32(6, msg.repeat, false);
      view.setInt32(10, msg.metaState, false);
      return buf;
    }

    case CONTROL_MSG_TYPE.INJECT_TEXT: {
      const textBytes = encoder.encode(msg.text.slice(0, 300));
      const buf = new Uint8Array(5 + textBytes.length);
      const view = new DataView(buf.buffer);
      view.setUint8(0, msg.type);
      view.setUint32(1, textBytes.length, false);
      buf.set(textBytes, 5);
      return buf;
    }

    case CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT: {
      const buf = new Uint8Array(32);
      const view = new DataView(buf.buffer);
      view.setUint8(0, msg.type);
      view.setUint8(1, msg.action);
      view.setBigInt64(2, msg.pointerId, false);
      view.setInt32(10, Math.round(msg.position.x), false);
      view.setInt32(14, Math.round(msg.position.y), false);
      view.setUint16(18, msg.position.screenWidth, false);
      view.setUint16(20, msg.position.screenHeight, false);
      view.setUint16(22, floatToU16FixedPoint(msg.pressure), false);
      view.setInt32(24, msg.actionButton, false);
      view.setInt32(28, msg.buttons, false);
      return buf;
    }

    case CONTROL_MSG_TYPE.INJECT_SCROLL_EVENT: {
      const buf = new Uint8Array(21);
      const view = new DataView(buf.buffer);
      view.setUint8(0, msg.type);
      view.setInt32(1, Math.round(msg.position.x), false);
      view.setInt32(5, Math.round(msg.position.y), false);
      view.setUint16(9, msg.position.screenWidth, false);
      view.setUint16(11, msg.position.screenHeight, false);
      view.setInt16(13, floatToI16FixedPoint(msg.hScroll / 16), false);
      view.setInt16(15, floatToI16FixedPoint(msg.vScroll / 16), false);
      view.setInt32(17, msg.buttons, false);
      return buf;
    }

    case CONTROL_MSG_TYPE.BACK_OR_SCREEN_ON: {
      return new Uint8Array([msg.type, msg.action & 0xff]);
    }

    case CONTROL_MSG_TYPE.EXPAND_NOTIFICATION_PANEL:
    case CONTROL_MSG_TYPE.EXPAND_SETTINGS_PANEL:
    case CONTROL_MSG_TYPE.COLLAPSE_PANELS:
    case CONTROL_MSG_TYPE.ROTATE_DEVICE:
    case CONTROL_MSG_TYPE.OPEN_HARD_KEYBOARD_SETTINGS:
    case CONTROL_MSG_TYPE.RESET_VIDEO: {
      return new Uint8Array([msg.type]);
    }

    case CONTROL_MSG_TYPE.GET_CLIPBOARD: {
      return new Uint8Array([msg.type, msg.copyKey & 0xff]);
    }

    case CONTROL_MSG_TYPE.SET_CLIPBOARD: {
      const raw = encoder.encode(msg.text);
      const maxLen = (1 << 18) - 14;
      const sliced = raw.length > maxLen ? raw.subarray(0, maxLen) : raw;
      const buf = new Uint8Array(14 + sliced.length);
      const view = new DataView(buf.buffer);
      view.setUint8(0, msg.type);
      view.setBigUint64(1, msg.sequence, false);
      view.setUint8(9, msg.paste ? 1 : 0);
      view.setUint32(10, sliced.length, false);
      buf.set(sliced, 14);
      return buf;
    }

    case CONTROL_MSG_TYPE.SET_DISPLAY_POWER: {
      return new Uint8Array([msg.type, msg.on ? 1 : 0]);
    }

    case CONTROL_MSG_TYPE.START_APP: {
      const raw = encoder.encode(msg.name).subarray(0, 255);
      const buf = new Uint8Array(2 + raw.length);
      buf[0] = msg.type;
      buf[1] = raw.length;
      buf.set(raw, 2);
      return buf;
    }
  }
}
