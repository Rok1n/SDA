/**
 * Minimal streaming EBML/Matroska demuxer, scoped to what SDA needs:
 * find the audio tracks (A_TRUEHD / A_MLP / A_EAC3 / A_AC3 / A_DTS*),
 * then emit per-block access units in arrival order.
 *
 * Push arbitrary byte chunks; packets come out of the callbacks.
 * No seeking, no cues — playback demuxing only.
 */

export interface MkvAudioTrack {
  trackNumber: number;
  codecId: string;
  /** "truehd" | "eac3" | "ac3" | "dts" */
  codec: string;
  sampleRate: number;
  channels: number;
  name?: string;
}

export interface MkvPacket {
  trackNumber: number;
  /** Milliseconds, segment-relative. */
  timestampMs: number;
  /** One block's payload, de-laced: each entry is one access unit. */
  frames: Uint8Array[];
}

export interface MkvDemuxerCallbacks {
  onTrack?: (track: MkvAudioTrack) => void;
  onPacket?: (packet: MkvPacket) => void;
  onError?: (message: string) => void;
}

// ---- EBML element ids ----
const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Name: 0x536e,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
} as const;

const TRACK_TYPE_AUDIO = 0x02;

function codecFromCodecId(codecId: string): string | null {
  if (codecId === "A_TRUEHD" || codecId === "A_MLP") return "truehd";
  if (codecId === "A_EAC3") return "eac3";
  if (codecId === "A_AC3") return "ac3";
  if (codecId.startsWith("A_DTS")) return "dts";
  return null;
}

/** Read an EBML variable-length integer; returns [value, length] or null. */
function readVint(buf: Uint8Array, offset: number, stripMarker: boolean): [number, number] | null {
  if (offset >= buf.length) return null;
  const first = buf[offset]!;
  let mask = 0x80;
  let len = 1;
  while (len <= 8 && (first & mask) === 0) {
    mask >>= 1;
    len++;
  }
  if (len > 8 || offset + len > buf.length) return null;
  let value = stripMarker ? first & (mask - 1) : first;
  for (let i = 1; i < len; i++) value = value * 256 + buf[offset + i]!;
  return [value, len];
}

interface Element {
  id: number;
  /** Data offset within the working buffer. */
  dataOffset: number;
  /** -1 = unknown size (runs to end of parent). */
  size: number;
  headerSize: number;
}

function readElementHeader(buf: Uint8Array, offset: number): Element | null {
  const idVint = readVint(buf, offset, false);
  if (!idVint) return null;
  const [id, idLen] = idVint;
  const sizeVint = readVint(buf, offset + idLen, true);
  if (!sizeVint) return null;
  let [size, sizeLen] = sizeVint;
  // All-ones = unknown size.
  const maxForLen = Math.pow(2, 7 * sizeLen) - 1;
  if (size === maxForLen) size = -1;
  return { id, dataOffset: offset + idLen + sizeLen, size, headerSize: idLen + sizeLen };
}

export class MkvDemuxer {
  private buf = new Uint8Array(0);
  private cb: MkvDemuxerCallbacks;
  private timestampScaleNs = 1_000_000; // default: ms
  private tracks = new Map<number, MkvAudioTrack>();
  private sawTracks = false;
  private clusterTimestamp = 0;

  constructor(cb: MkvDemuxerCallbacks = {}) {
    this.cb = cb;
  }

  push(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    this.consume(0, this.buf.length, "top");
  }

  /** True if the buffer starts with an EBML header. */
  static sniffs(bytes: Uint8Array): boolean {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0x1a &&
      bytes[1] === 0x45 &&
      bytes[2] === 0xdf &&
      bytes[3] === 0xa3
    );
  }

  /**
   * Parse as many complete elements as possible from `buf[start..end)`,
   * then compact consumed bytes. `level` keeps the recursion shallow.
   */
  private consume(start: number, end: number, level: "top" | "segment" | "cluster" | "tracks"): number {
    let pos = start;
    while (pos < end) {
      const el = readElementHeader(this.buf, pos);
      if (!el) break;
      const available = end - el.dataOffset;
      const size = el.size === -1 ? available : el.size;
      if (el.size !== -1 && available < el.size) break; // wait for more bytes

      switch (level) {
        case "top":
          if (el.id === ID.Segment) {
            this.consume(el.dataOffset, el.dataOffset + size, "segment");
          }
          break;
        case "segment":
          if (el.id === ID.Info) {
            this.parseInfo(el.dataOffset, el.dataOffset + size);
          } else if (el.id === ID.Tracks) {
            this.consume(el.dataOffset, el.dataOffset + size, "tracks");
            this.sawTracks = true;
          } else if (el.id === ID.Cluster) {
            this.clusterTimestamp = 0;
            this.consume(el.dataOffset, el.dataOffset + size, "cluster");
          }
          break;
        case "tracks":
          if (el.id === ID.TrackEntry) this.parseTrackEntry(el.dataOffset, el.dataOffset + size);
          break;
        case "cluster":
          if (el.id === ID.Timestamp) {
            this.clusterTimestamp = this.readUint(el.dataOffset, size);
          } else if (el.id === ID.SimpleBlock) {
            this.parseBlock(el.dataOffset, size);
          } else if (el.id === ID.BlockGroup) {
            this.parseBlockGroup(el.dataOffset, el.dataOffset + size);
          }
          break;
      }
      pos = el.dataOffset + size;
    }

    if (level === "top" && pos > 0) {
      this.buf = this.buf.subarray(pos);
    }
    return pos;
  }

  private parseInfo(start: number, end: number): void {
    let pos = start;
    while (pos < end) {
      const el = readElementHeader(this.buf, pos);
      if (!el || el.size < 0 || el.dataOffset + el.size > end) break;
      if (el.id === ID.TimestampScale) this.timestampScaleNs = this.readUint(el.dataOffset, el.size);
      pos = el.dataOffset + el.size;
    }
  }

  private parseBlockGroup(start: number, end: number): void {
    let pos = start;
    while (pos < end) {
      const el = readElementHeader(this.buf, pos);
      if (!el || el.size < 0 || el.dataOffset + el.size > end) break;
      if (el.id === ID.Block) this.parseBlock(el.dataOffset, el.size);
      pos = el.dataOffset + el.size;
    }
  }

  private readUint(offset: number, size: number): number {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + this.buf[offset + i]!;
    return v;
  }

  private readFloat(offset: number, size: number): number {
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + offset, size);
    return size === 4 ? view.getFloat32(0) : view.getFloat64(0);
  }

  private parseTrackEntry(start: number, end: number): void {
    let trackNumber = 0;
    let trackType = 0;
    let codecId = "";
    let name: string | undefined;
    let sampleRate = 48000;
    let channels = 2;
    let pos = start;
    while (pos < end) {
      const el = readElementHeader(this.buf, pos);
      if (!el || el.size < 0 || el.dataOffset + el.size > end) break;
      switch (el.id) {
        case ID.TrackNumber:
          trackNumber = this.readUint(el.dataOffset, el.size);
          break;
        case ID.TrackType:
          trackType = this.readUint(el.dataOffset, el.size);
          break;
        case ID.CodecID:
          codecId = new TextDecoder().decode(this.buf.subarray(el.dataOffset, el.dataOffset + el.size));
          break;
        case ID.Name:
          name = new TextDecoder().decode(this.buf.subarray(el.dataOffset, el.dataOffset + el.size));
          break;
        case ID.Audio: {
          let apos = el.dataOffset;
          const aend = el.dataOffset + el.size;
          while (apos < aend) {
            const ael = readElementHeader(this.buf, apos);
            if (!ael || ael.size < 0 || ael.dataOffset + ael.size > aend) break;
            if (ael.id === ID.SamplingFrequency) sampleRate = this.readFloat(ael.dataOffset, ael.size);
            if (ael.id === ID.Channels) channels = this.readUint(ael.dataOffset, ael.size);
            apos = ael.dataOffset + ael.size;
          }
          break;
        }
      }
      pos = el.dataOffset + el.size;
    }

    if (trackType !== TRACK_TYPE_AUDIO) return;
    const codec = codecFromCodecId(codecId);
    if (!codec) return;
    const track: MkvAudioTrack = { trackNumber, codecId, codec, sampleRate, channels };
    if (name !== undefined) track.name = name;
    this.tracks.set(trackNumber, track);
    this.cb.onTrack?.(track);
  }

  /** Block / SimpleBlock payload: vint track number, i16 timecode, flags, laced frames. */
  private parseBlock(offset: number, size: number): void {
    const trackVint = readVint(this.buf, offset, true);
    if (!trackVint) return;
    const [trackNumber, tnLen] = trackVint;
    const track = this.tracks.get(trackNumber);
    if (!track) return; // not an audio track we care about

    const view = new DataView(this.buf.buffer, this.buf.byteOffset + offset);
    const timecode = view.getInt16(tnLen);
    const flags = this.buf[offset + tnLen + 2]!;
    const lacing = (flags >> 1) & 0x03;
    const dataStart = offset + tnLen + 3;
    const dataEnd = offset + size;

    const frames = this.delace(lacing, dataStart, dataEnd);
    if (!frames) {
      this.cb.onError?.("unsupported lacing in block");
      return;
    }

    const timestampMs = ((this.clusterTimestamp + timecode) * this.timestampScaleNs) / 1e6;
    this.cb.onPacket?.({ trackNumber, timestampMs, frames });
  }

  private delace(lacing: number, start: number, end: number): Uint8Array[] | null {
    const slice = (a: number, b: number) => this.buf.slice(a, b);
    if (lacing === 0) return [slice(start, end)];

    const laceCount = this.buf[start]! + 1;
    let pos = start + 1;

    if (lacing === 0x02) {
      // Xiph lacing: (count-1) runs of 255-terminated sizes, last implicit.
      const sizes: number[] = [];
      for (let i = 0; i < laceCount - 1; i++) {
        let s = 0;
        while (pos < end) {
          const b = this.buf[pos++]!;
          s += b;
          if (b !== 255) break;
        }
        sizes.push(s);
      }
      const frames: Uint8Array[] = [];
      let consumed = 0;
      for (const s of sizes) {
        frames.push(slice(pos, pos + s));
        pos += s;
        consumed += s;
      }
      frames.push(slice(pos, end));
      return frames;
    }

    if (lacing === 0x01) {
      // EBML lacing: first size vint, then signed vint diffs.
      const first = readVint(this.buf, pos, true);
      if (!first) return null;
      let [size, len] = first;
      pos += len;
      const sizes = [size];
      for (let i = 1; i < laceCount - 1; i++) {
        const sv = readVint(this.buf, pos, true);
        if (!sv) return null;
        let [raw, slen] = sv;
        pos += slen;
        const bias = Math.pow(2, 7 * slen - 1) - 1;
        size += raw - bias;
        sizes.push(size);
      }
      const frames: Uint8Array[] = [];
      for (const s of sizes) {
        frames.push(slice(pos, pos + s));
        pos += s;
      }
      frames.push(slice(pos, end));
      return frames;
    }

    if (lacing === 0x03) {
      // Fixed-size lacing.
      const total = end - pos;
      const each = Math.floor(total / laceCount);
      if (each <= 0) return null;
      const frames: Uint8Array[] = [];
      for (let i = 0; i < laceCount; i++) frames.push(slice(pos + i * each, pos + (i + 1) * each));
      return frames;
    }
    return null;
  }
}
