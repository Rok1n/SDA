/**
 * MP4 audio extraction via mp4box.js. Covers `ec-3` (E-AC-3 / JOC Atmos),
 * `ac-3`, and `mlpa` (TrueHD-in-MP4, rare). Samples arrive as raw access
 * units ready for @sda/core.
 */

// @ts-ignore — mp4box ships untyped CommonJS.
import MP4Box from "mp4box";

export interface Mp4AudioTrack {
  trackId: number;
  codec: string; // mp4a codec string, e.g. "ec-3"
  sampleRate: number;
  channels: number;
  /** Movie duration from the container header (seconds), when known. */
  durationSec?: number;
}

export interface Mp4Packet {
  trackId: number;
  timestampMs: number;
  data: Uint8Array;
}

export interface Mp4DemuxerCallbacks {
  onTrack?: (track: Mp4AudioTrack) => void;
  onPacket?: (packet: Mp4Packet) => void;
  onError?: (message: string) => void;
}

const AUDIO_CODECS = new Set(["ec-3", "ac-3", "ac-4", "mlpa", "dtsc", "dtsh", "dtsl", "dtse"]);

export class Mp4Demuxer {
  private file: ReturnType<typeof MP4Box.createFile>;
  private offset = 0;
  private wantedTrackId: number | null = null;
  private cb: Mp4DemuxerCallbacks;

  constructor(cb: Mp4DemuxerCallbacks = {}) {
    this.cb = cb;
    this.file = MP4Box.createFile();
    this.file.onError = (e: unknown) => this.cb.onError?.(String(e));
    this.file.onReady = (info: { audioTracks: Array<{ id: number; codec: string; duration?: number; timescale?: number; movie_duration?: number; movie_timescale?: number; audio: { sample_rate: number; channel_count: number } }> }) => {
      for (const t of info.audioTracks) {
        if (!AUDIO_CODECS.has(t.codec)) continue;
        const track: Mp4AudioTrack = {
          trackId: t.id,
          codec: t.codec,
          sampleRate: t.audio.sample_rate,
          channels: t.audio.channel_count,
        };
        const dur = t.duration && t.timescale ? t.duration / t.timescale
          : t.movie_duration && t.movie_timescale ? t.movie_duration / t.movie_timescale
          : undefined;
        if (dur && Number.isFinite(dur)) track.durationSec = dur;
        this.cb.onTrack?.(track);
        // Extract the first supported track only.
        if (this.wantedTrackId === null) {
          this.wantedTrackId = t.id;
          this.file.setExtractionOptions(t.id, null, { nbSamples: 1000 });
          this.file.start();
        }
      }
    };
    this.file.onSamples = (_id: number, _user: unknown, samples: Array<{ cts: number; timescale: number; data: Uint8Array }>) => {
      for (const s of samples) {
        this.cb.onPacket?.({
          trackId: this.wantedTrackId ?? 0,
          timestampMs: (s.cts / s.timescale) * 1000,
          data: s.data,
        });
      }
    };
  }

  static sniffs(bytes: Uint8Array): boolean {
    // .... ftyp
    return (
      bytes.length >= 8 &&
      bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
    );
  }

  push(chunk: Uint8Array): void {
    const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer & { fileStart: number };
    buf.fileStart = this.offset;
    this.offset += chunk.byteLength;
    this.file.appendBuffer(buf);
  }

  flush(): void {
    this.file.flush();
  }
}
