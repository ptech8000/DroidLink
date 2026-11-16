import {
  DEVICE_NAME_FIELD_LENGTH,
  PACKET_FLAG_CONFIG,
  PACKET_FLAG_KEY_FRAME,
  PACKET_PTS_MASK,
} from './constants';

const textDecoder = new TextDecoder('utf-8');

export type StreamEvent =
  | { kind: 'device_meta'; deviceName: string }
  | { kind: 'codec'; codecId: number }
  | { kind: 'stream_disabled'; error: boolean }
  | { kind: 'session'; width: number; height: number; clientResized: boolean }
  | {
      kind: 'packet';
      isConfig: boolean;
      isKeyFrame: boolean;
      pts: bigint;
      data: Uint8Array;
    };

export interface StreamDemuxerOptions {
  expectDummyByte: boolean;
  expectDeviceMeta: boolean;
}

type Stage = 'dummy_byte' | 'device_meta' | 'codec_id' | 'header' | 'payload' | 'ended';

/**
 * Incremental byte-stream demuxer for scrcpy v5.0.1 video and audio sockets.
 */
export class ScrcpyStreamDemuxer {
  private buffer = new Uint8Array(0);
  private stage: Stage;
  private pendingHeader: Uint8Array | null = null;
  private pendingSize = 0;

  constructor(options: StreamDemuxerOptions) {
    if (options.expectDummyByte) {
      this.stage = 'dummy_byte';
    } else if (options.expectDeviceMeta) {
      this.stage = 'device_meta';
    } else {
      this.stage = 'codec_id';
    }
    this.expectDeviceMeta = options.expectDeviceMeta;
  }

  private readonly expectDeviceMeta: boolean;

  push(chunk: Uint8Array): StreamEvent[] {
    if (chunk.length === 0 || this.stage === 'ended') return [];

    // Fast-append buffer
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.length);
    this.buffer = next;

    const events: StreamEvent[] = [];
    let offset = 0;

    while ((this.stage as Stage) !== 'ended') {
      const available = this.buffer.length - offset;

      if (this.stage === 'dummy_byte') {
        if (available < 1) break;
        offset += 1;
        this.stage = this.expectDeviceMeta ? 'device_meta' : 'codec_id';
        continue;
      }

      if (this.stage === 'device_meta') {
        if (available < DEVICE_NAME_FIELD_LENGTH) break;
        const slice = this.buffer.subarray(offset, offset + DEVICE_NAME_FIELD_LENGTH);
        const zeroIdx = slice.indexOf(0);
        const nameBytes = zeroIdx === -1 ? slice : slice.subarray(0, zeroIdx);
        const deviceName = textDecoder.decode(nameBytes);
        events.push({ kind: 'device_meta', deviceName });
        offset += DEVICE_NAME_FIELD_LENGTH;
        this.stage = 'codec_id';
        continue;
      }

      if (this.stage === 'codec_id') {
        if (available < 4) break;
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 4);
        const codecId = view.getUint32(0, false);
        offset += 4;
        if (codecId === 0 || codecId === 1) {
          events.push({ kind: 'stream_disabled', error: codecId === 1 });
          this.stage = 'ended';
          break;
        }
        events.push({ kind: 'codec', codecId });
        this.stage = 'header';
        continue;
      }

      if (this.stage === 'header') {
        if (available < 12) break;
        const header = this.buffer.subarray(offset, offset + 12);
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + offset, 12);
        offset += 12;

        if ((header[0] & 0x80) !== 0) {
          const clientResized = (header[3] & 1) !== 0;
          const width = view.getUint32(4, false);
          const height = view.getUint32(8, false);
          events.push({ kind: 'session', width, height, clientResized });
          continue;
        }

        const size = view.getUint32(8, false);
        if (size === 0) {
          throw new Error('Invalid packet size 0 in scrcpy stream');
        }
        this.pendingHeader = header.slice();
        this.pendingSize = size;
        this.stage = 'payload';
        continue;
      }

      if (this.stage === 'payload') {
        if (available < this.pendingSize || !this.pendingHeader) break;
        const view = new DataView(
          this.pendingHeader.buffer,
          this.pendingHeader.byteOffset,
          this.pendingHeader.byteLength,
        );
        const ptsAndFlags = view.getBigUint64(0, false);
        const isConfig = (ptsAndFlags & PACKET_FLAG_CONFIG) !== 0n;
        const isKeyFrame = (ptsAndFlags & PACKET_FLAG_KEY_FRAME) !== 0n;
        const pts = isConfig ? 0n : ptsAndFlags & PACKET_PTS_MASK;
        const data = this.buffer.slice(offset, offset + this.pendingSize);
        offset += this.pendingSize;

        this.pendingHeader = null;
        this.pendingSize = 0;
        this.stage = 'header';

        events.push({ kind: 'packet', isConfig, isKeyFrame, pts, data });
        continue;
      }
    }

    if (offset > 0) {
      this.buffer = this.buffer.slice(offset);
    }
    return events;
  }
}

/**
 * Merges H.264/H.265 codec config packets (SPS/PPS) into the following media packet
 * so WebCodecs Annex-B decoding handles initial config and dynamic resolution changes.
 */
export class ConfigPacketMerger {
  private pendingConfig: Uint8Array | null = null;

  merge(isConfig: boolean, data: Uint8Array): Uint8Array | null {
    if (isConfig) {
      this.pendingConfig = data;
      return null;
    }
    if (this.pendingConfig) {
      const merged = new Uint8Array(this.pendingConfig.length + data.length);
      merged.set(this.pendingConfig, 0);
      merged.set(data, this.pendingConfig.length);
      this.pendingConfig = null;
      return merged;
    }
    return data;
  }

  reset(): void {
    this.pendingConfig = null;
  }
}
