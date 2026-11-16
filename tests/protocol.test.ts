import { describe, expect, it } from 'vitest';
import {
  ANDROID_KEYCODE,
  CODEC_ID,
  CONTROL_MSG_TYPE,
  ConfigPacketMerger,
  DEVICE_MSG_TYPE,
  DEVICE_NAME_FIELD_LENGTH,
  DeviceMessageParser,
  KEY_ACTION,
  MOTION_ACTION,
  MOTION_BUTTON,
  PACKET_FLAG_CONFIG,
  PACKET_FLAG_KEY_FRAME,
  PACKET_FLAG_SESSION,
  POINTER_ID_MOUSE,
  ScrcpyStreamDemuxer,
  serializeControlMessage,
} from '../shared/protocol';

describe('serializeControlMessage', () => {
  it('encodes INJECT_KEYCODE as 14 big-endian bytes', () => {
    const bytes = serializeControlMessage({
      type: CONTROL_MSG_TYPE.INJECT_KEYCODE,
      action: KEY_ACTION.DOWN,
      keycode: ANDROID_KEYCODE.HOME,
      repeat: 1,
      metaState: 0x41,
    });
    expect(bytes.length).toBe(14);
    const view = new DataView(bytes.buffer);
    expect(view.getUint8(0)).toBe(0);
    expect(view.getUint8(1)).toBe(0);
    expect(view.getInt32(2, false)).toBe(3);
    expect(view.getInt32(6, false)).toBe(1);
    expect(view.getInt32(10, false)).toBe(0x41);
  });

  it('encodes INJECT_TOUCH_EVENT as 32 bytes with u16 pressure', () => {
    const bytes = serializeControlMessage({
      type: CONTROL_MSG_TYPE.INJECT_TOUCH_EVENT,
      action: MOTION_ACTION.DOWN,
      pointerId: POINTER_ID_MOUSE,
      position: { x: 360, y: 806, screenWidth: 720, screenHeight: 1612 },
      pressure: 1,
      actionButton: MOTION_BUTTON.PRIMARY,
      buttons: MOTION_BUTTON.PRIMARY,
    });
    expect(bytes.length).toBe(32);
    const view = new DataView(bytes.buffer);
    expect(view.getUint8(0)).toBe(2);
    expect(view.getUint8(1)).toBe(0);
    expect(view.getBigInt64(2, false)).toBe(-1n);
    expect(view.getInt32(10, false)).toBe(360);
    expect(view.getInt32(14, false)).toBe(806);
    expect(view.getUint16(18, false)).toBe(720);
    expect(view.getUint16(20, false)).toBe(1612);
    expect(view.getUint16(22, false)).toBe(0xffff);
    expect(view.getInt32(24, false)).toBe(1);
    expect(view.getInt32(28, false)).toBe(1);
  });

  it('encodes SET_CLIPBOARD with sequence, paste flag, and UTF-8 text', () => {
    const bytes = serializeControlMessage({
      type: CONTROL_MSG_TYPE.SET_CLIPBOARD,
      sequence: 42n,
      paste: true,
      text: 'itel P55T',
    });
    const view = new DataView(bytes.buffer);
    expect(view.getUint8(0)).toBe(9);
    expect(view.getBigUint64(1, false)).toBe(42n);
    expect(view.getUint8(9)).toBe(1);
    expect(view.getUint32(10, false)).toBe(9);
    expect(new TextDecoder().decode(bytes.subarray(14))).toBe('itel P55T');
  });
});

describe('DeviceMessageParser', () => {
  it('parses fragmented clipboard and ack messages across chunks', () => {
    const parser = new DeviceMessageParser();
    const textBytes = new TextEncoder().encode('hello');
    const frame = new Uint8Array(1 + 4 + textBytes.length + 1 + 8);
    const view = new DataView(frame.buffer);
    view.setUint8(0, DEVICE_MSG_TYPE.CLIPBOARD);
    view.setUint32(1, textBytes.length, false);
    frame.set(textBytes, 5);
    const ackStart = 5 + textBytes.length;
    view.setUint8(ackStart, DEVICE_MSG_TYPE.ACK_CLIPBOARD);
    view.setBigUint64(ackStart + 1, 99n, false);

    // Feed 3 bytes at a time
    const all = [];
    for (let i = 0; i < frame.length; i += 3) {
      all.push(...parser.push(frame.subarray(i, i + 3)));
    }

    expect(all).toEqual([
      { type: DEVICE_MSG_TYPE.CLIPBOARD, text: 'hello' },
      { type: DEVICE_MSG_TYPE.ACK_CLIPBOARD, sequence: 99n },
    ]);
  });
});

describe('ScrcpyStreamDemuxer & ConfigPacketMerger', () => {
  it('demuxes dummy byte, device meta, codec id, session meta, config & keyframe packets', () => {
    const demuxer = new ScrcpyStreamDemuxer({
      expectDummyByte: true,
      expectDeviceMeta: true,
    });

    const deviceMeta = new Uint8Array(DEVICE_NAME_FIELD_LENGTH);
    deviceMeta.set(new TextEncoder().encode('itel P55T'));

    const codecBuf = new Uint8Array(4);
    new DataView(codecBuf.buffer).setUint32(0, CODEC_ID.H264, false);

    const sessionBuf = new Uint8Array(12);
    const sv = new DataView(sessionBuf.buffer);
    sv.setBigUint64(0, PACKET_FLAG_SESSION | 1n, false); // MSB set + clientResized? wait: flags in first 4 bytes
    // Actually in scrcpy v5.0.1: header[0..3] = (PACKET_FLAG_SESSION >> 32) | clientResized
    sv.setUint32(0, Number(PACKET_FLAG_SESSION >> 32n) | 1, false);
    sv.setUint32(4, 720, false);
    sv.setUint32(8, 1612, false);

    const configPayload = new Uint8Array([0, 0, 0, 1, 0x67, 0x64]);
    const configHdr = new Uint8Array(12);
    const chv = new DataView(configHdr.buffer);
    chv.setBigUint64(0, PACKET_FLAG_CONFIG, false);
    chv.setUint32(8, configPayload.length, false);

    const keyPayload = new Uint8Array([0, 0, 0, 1, 0x65, 0x88]);
    const keyHdr = new Uint8Array(12);
    const khv = new DataView(keyHdr.buffer);
    khv.setBigUint64(0, PACKET_FLAG_KEY_FRAME | 12345n, false);
    khv.setUint32(8, keyPayload.length, false);

    const stream = new Uint8Array(
      1 +
        deviceMeta.length +
        codecBuf.length +
        sessionBuf.length +
        configHdr.length +
        configPayload.length +
        keyHdr.length +
        keyPayload.length,
    );
    let o = 0;
    stream[o++] = 0;
    stream.set(deviceMeta, o);
    o += deviceMeta.length;
    stream.set(codecBuf, o);
    o += codecBuf.length;
    stream.set(sessionBuf, o);
    o += sessionBuf.length;
    stream.set(configHdr, o);
    o += configHdr.length;
    stream.set(configPayload, o);
    o += configPayload.length;
    stream.set(keyHdr, o);
    o += keyHdr.length;
    stream.set(keyPayload, o);

    const events = [];
    for (let i = 0; i < stream.length; i += 7) {
      events.push(...demuxer.push(stream.subarray(i, i + 7)));
    }

    expect(events[0]).toEqual({ kind: 'device_meta', deviceName: 'itel P55T' });
    expect(events[1]).toEqual({ kind: 'codec', codecId: CODEC_ID.H264 });
    expect(events[2]).toEqual({
      kind: 'session',
      width: 720,
      height: 1612,
      clientResized: true,
    });
    expect(events[3]).toEqual({
      kind: 'packet',
      isConfig: true,
      isKeyFrame: false,
      pts: 0n,
      data: configPayload,
    });
    expect(events[4]).toEqual({
      kind: 'packet',
      isConfig: false,
      isKeyFrame: true,
      pts: 12345n,
      data: keyPayload,
    });

    const merger = new ConfigPacketMerger();
    expect(merger.merge(true, configPayload)).toBeNull();
    expect(merger.merge(false, keyPayload)).toEqual(
      new Uint8Array([...configPayload, ...keyPayload]),
    );
  });
});
