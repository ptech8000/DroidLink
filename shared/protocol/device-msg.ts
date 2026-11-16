import { DEVICE_MSG_TYPE } from './constants';

const decoder = new TextDecoder('utf-8');

export type DeviceMessage =
  | { type: typeof DEVICE_MSG_TYPE.CLIPBOARD; text: string }
  | { type: typeof DEVICE_MSG_TYPE.ACK_CLIPBOARD; sequence: bigint }
  | { type: typeof DEVICE_MSG_TYPE.UHID_OUTPUT; id: number; data: Uint8Array };

/**
 * Incremental byte-stream parser for scrcpy DeviceMessage frames.
 */
export class DeviceMessageParser {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): DeviceMessage[] {
    if (chunk.length === 0) return [];
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer, 0);
    combined.set(chunk, this.buffer.length);
    this.buffer = combined;

    const messages: DeviceMessage[] = [];
    let offset = 0;

    while (offset < this.buffer.length) {
      const type = this.buffer[offset];
      const remaining = this.buffer.length - offset;

      if (type === DEVICE_MSG_TYPE.CLIPBOARD) {
        if (remaining < 5) break;
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, remaining);
        const len = view.getUint32(1, false);
        if (remaining < 5 + len) break;
        const text = decoder.decode(this.buffer.subarray(offset + 5, offset + 5 + len));
        messages.push({ type: DEVICE_MSG_TYPE.CLIPBOARD, text });
        offset += 5 + len;
      } else if (type === DEVICE_MSG_TYPE.ACK_CLIPBOARD) {
        if (remaining < 9) break;
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, remaining);
        const sequence = view.getBigUint64(1, false);
        messages.push({ type: DEVICE_MSG_TYPE.ACK_CLIPBOARD, sequence });
        offset += 9;
      } else if (type === DEVICE_MSG_TYPE.UHID_OUTPUT) {
        if (remaining < 5) break;
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, remaining);
        const id = view.getUint16(1, false);
        const len = view.getUint16(3, false);
        if (remaining < 5 + len) break;
        const data = this.buffer.slice(offset + 5, offset + 5 + len);
        messages.push({ type: DEVICE_MSG_TYPE.UHID_OUTPUT, id, data });
        offset += 5 + len;
      } else {
        throw new Error(`Unknown DeviceMessage type: ${type}`);
      }
    }

    if (offset > 0) {
      this.buffer = this.buffer.slice(offset);
    }
    return messages;
  }
}
