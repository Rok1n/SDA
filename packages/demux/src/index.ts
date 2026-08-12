/**
 * @sda/demux — container demuxing for SDA.
 *
 * `createDemuxer` sniffs the container from the first bytes:
 *   - EBML magic          → Matroska (streaming, all A_* codecs we support)
 *   - `....ftyp`          → MP4 (mp4box.js)
 *   - otherwise           → treated as a raw elementary stream (passthrough)
 */

import { MkvDemuxer, type MkvAudioTrack, type MkvPacket } from "./mkv.js";
import { Mp4Demuxer, type Mp4AudioTrack } from "./mp4.js";

export { MkvDemuxer, Mp4Demuxer };
export type { MkvAudioTrack, MkvPacket, Mp4AudioTrack };

export type ContainerKind = "mkv" | "mp4" | "raw";

export function sniffContainer(firstBytes: Uint8Array): ContainerKind {
  if (MkvDemuxer.sniffs(firstBytes)) return "mkv";
  if (Mp4Demuxer.sniffs(firstBytes)) return "mp4";
  return "raw";
}

export interface DemuxedAudioPacket {
  timestampMs: number;
  /** Raw access units, ready for SdaDecoder.push(). */
  frames: Uint8Array[];
}

export interface DemuxerCallbacks {
  /** First supported audio track discovered. durationSec 来自容器头部元数据（如有）。 */
  onTrack?: (info: { codec: string; sampleRate: number; channels: number; container: ContainerKind; durationSec?: number; title?: string; coverArt?: { bytes: Uint8Array; mimeType: "image/jpeg" | "image/png" } }) => void;
  onPacket?: (packet: DemuxedAudioPacket) => void;
  onError?: (message: string) => void;
}

export interface Demuxer {
  readonly kind: ContainerKind;
  push(chunk: Uint8Array): void;
  flush(): void;
}

export function createDemuxer(kind: ContainerKind, cb: DemuxerCallbacks): Demuxer {
  if (kind === "mkv") {
    const mkv = new MkvDemuxer({
      onTrack: (t: MkvAudioTrack) =>
        cb.onTrack?.({ codec: t.codec, sampleRate: t.sampleRate, channels: t.channels, container: "mkv", durationSec: t.durationSec, title: t.title }),
      onPacket: (p: MkvPacket) => cb.onPacket?.({ timestampMs: p.timestampMs, frames: p.frames }),
      onError: cb.onError,
    });
    return { kind, push: (c) => mkv.push(c), flush: () => {} };
  }
  if (kind === "mp4") {
    const mp4 = new Mp4Demuxer({
      onTrack: (t: Mp4AudioTrack) =>
        cb.onTrack?.({ codec: t.codec, sampleRate: t.sampleRate, channels: t.channels, container: "mp4", durationSec: t.durationSec, coverArt: t.coverArt }),
      onPacket: (p) => cb.onPacket?.({ timestampMs: p.timestampMs, frames: [p.data] }),
      onError: cb.onError,
    });
    return { kind, push: (c) => mp4.push(c), flush: () => mp4.flush() };
  }
  // Raw elementary stream: pass bytes straight through; the decoder's own
  // extractor does the framing.
  return {
    kind: "raw",
    push: (c) => cb.onPacket?.({ timestampMs: 0, frames: [c] }),
    flush: () => {},
  };
}
