import React, { useEffect, useRef } from 'react';
import { CODEC_ID } from '@shared/protocol';

interface AudioPlayerProps {
  serial: string;
  enabled: boolean;
  muted: boolean;
  volume?: number;
  audioStreamRef?: React.MutableRefObject<MediaStream | null>;
  onAudioUnavailable: (reason: string) => void;
}

export const AudioPlayer: React.FC<AudioPlayerProps> = ({
  serial,
  enabled,
  muted,
  volume = 1,
  audioStreamRef,
  onAudioUnavailable,
}) => {
  const mutedRef = useRef(muted);
  const volumeRef = useRef(volume);
  const speakerGainRef = useRef<GainNode | null>(null);
  mutedRef.current = muted;
  volumeRef.current = volume;

  useEffect(() => {
    if (speakerGainRef.current) {
      speakerGainRef.current.gain.value = muted ? 0 : Math.max(0, Math.min(1, volume));
    }
  }, [muted, volume]);

  useEffect(() => {
    if (!enabled) {
      if (audioStreamRef) audioStreamRef.current = null;
      return;
    }

    let audioCtx: AudioContext | null = null;
    let tapGainNode: GainNode | null = null;
    let speakerGainNode: GainNode | null = null;
    let mediaDest: MediaStreamAudioDestinationNode | null = null;
    let decoder: AudioDecoder | null = null;
    let codecId: number = CODEC_ID.OPUS;
    let nextPlayTime = 0;

    const initAudioContext = () => {
      if (!audioCtx) {
        audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        tapGainNode = audioCtx.createGain();
        tapGainNode.gain.value = 1;

        // Recording tap receives full-level phone audio even when local PC speakers are muted
        mediaDest = audioCtx.createMediaStreamDestination();
        tapGainNode.connect(mediaDest);
        if (audioStreamRef) {
          audioStreamRef.current = mediaDest.stream;
        }

        speakerGainNode = audioCtx.createGain();
        speakerGainNode.gain.value = mutedRef.current
          ? 0
          : Math.max(0, Math.min(1, volumeRef.current));
        tapGainNode.connect(speakerGainNode);
        speakerGainNode.connect(audioCtx.destination);
        speakerGainRef.current = speakerGainNode;
      }
      if (audioCtx.state === 'suspended') {
        void audioCtx.resume();
      }
      if (speakerGainNode) {
        speakerGainNode.gain.value = mutedRef.current
          ? 0
          : Math.max(0, Math.min(1, volumeRef.current));
      }
    };

    const ensureDecoder = (description?: Uint8Array) => {
      if (decoder && decoder.state !== 'closed') {
        decoder.close();
      }
      decoder = new AudioDecoder({
        output: (audioData) => {
          initAudioContext();
          if (!audioCtx || !tapGainNode) {
            audioData.close();
            return;
          }
          const numChannels = audioData.numberOfChannels;
          const numFrames = audioData.numberOfFrames;
          const buffer = audioCtx.createBuffer(numChannels, numFrames, audioData.sampleRate);

          for (let ch = 0; ch < numChannels; ch++) {
            const channelData = new Float32Array(numFrames);
            audioData.copyTo(channelData, { planeIndex: ch, format: 'f32-planar' });
            buffer.copyToChannel(channelData, ch);
          }
          audioData.close();

          const now = audioCtx.currentTime;
          if (nextPlayTime < now || nextPlayTime - now > 0.18) {
            nextPlayTime = now + 0.03;
          }

          const src = audioCtx.createBufferSource();
          src.buffer = buffer;
          src.connect(tapGainNode);
          src.start(nextPlayTime);
          nextPlayTime += buffer.duration;
        },
        error: (err) => {
          console.warn('AudioDecoder error:', err);
        },
      });

      const codec = codecId === CODEC_ID.AAC ? 'mp4a.40.2' : 'opus';
      decoder.configure({
        codec,
        sampleRate: 48000,
        numberOfChannels: 2,
        ...(description ? { description } : {}),
      });
    };

    const unsubCodec = window.droidlink.onAudioCodec((ev) => {
      if (ev.serial !== serial) return;
      codecId = ev.codecId;
      ensureDecoder();
    });

    const unsubDisabled = window.droidlink.onAudioDisabled((ev) => {
      if (ev.serial !== serial) return;
      onAudioUnavailable('Audio capture unavailable on this device/app');
    });

    const unsubPacket = window.droidlink.onAudioPacket((ev) => {
      if (ev.serial !== serial) return;
      if (ev.isConfig) {
        ensureDecoder(ev.data);
        return;
      }
      if (!decoder || decoder.state !== 'configured') {
        ensureDecoder();
      }
      try {
        decoder?.decode(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: ev.pts,
            data: ev.data,
          }),
        );
      } catch {
        // Ignore transient malformed chunk
      }
    });

    return () => {
      unsubCodec();
      unsubDisabled();
      unsubPacket();
      speakerGainRef.current = null;
      if (audioStreamRef) audioStreamRef.current = null;
      if (decoder && decoder.state !== 'closed') {
        decoder.close();
      }
      if (audioCtx) {
        void audioCtx.close();
      }
    };
  }, [serial, enabled, audioStreamRef, onAudioUnavailable]);

  return null;
};
