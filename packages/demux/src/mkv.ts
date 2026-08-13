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
  /** Segment duration from the container header (seconds), when present. */
  durationSec?: number;
  /** 标题：优先音轨 Name，其次 Segment Title。 */
  title?: string;
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
  Duration: 0x4489,
  Title: 0x7ba9,
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

type ContainerScope = "top" | "segment" | "info" | "tracks" | "track" | "audio" | "cluster" | "block-group";

interface TrackDraft {
  trackNumber: number;
  trackType: number;
  codecId: string;
  name?: string;
  sampleRate: number;
  channels: number;
}

interface ContainerFrame {
  scope: ContainerScope;
  /** Absolute byte offset immediately after this container. */
  end: number;
  unknownSize: boolean;
  track?: TrackDraft;
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
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  /** Absolute stream offset represented by buf[0]. */
  private bufferOffset = 0;
  /** Remaining bytes in an uninteresting element being skipped across pushes. */
  private skipRemaining = 0;
  private containers: ContainerFrame[] = [
    { scope: "top", end: Number.POSITIVE_INFINITY, unknownSize: true },
  ];
  private cb: MkvDemuxerCallbacks;
  private timestampScaleNs = 1_000_000; // default: ms
  /** Segment Duration element value, in TimestampScale units. */
  private durationFloat?: number;
  /** Segment Title element（歌曲/影片标题）。 */
  private segmentTitle?: string;
  private tracks = new Map<number, MkvAudioTrack>();
  private selectedTrackNumber: number | null = null;
  private clusterTimestamp = 0;

  constructor(cb: MkvDemuxerCallbacks = {}) {
    this.cb = cb;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;

    let incoming = chunk;
    if (this.skipRemaining > 0) {
      const skipped = Math.min(this.skipRemaining, incoming.length);
      this.skipRemaining -= skipped;
      this.bufferOffset += skipped;
      incoming = incoming.subarray(skipped);
      if (incoming.length === 0) return;
    }

    if (this.buf.length === 0) {
      this.buf = incoming;
    } else {
      const merged = new Uint8Array(this.buf.length + incoming.length);
      merged.set(this.buf);
      merged.set(incoming, this.buf.length);
      this.buf = merged;
    }
    this.consumeBuffered();
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

  /** Parse complete leaves while retaining only the current partial leaf. */
  private consumeBuffered(): void {
    let pos = 0;
    while (pos < this.buf.length) {
      this.closeCompletedContainers(this.bufferOffset + pos);
      const el = readElementHeader(this.buf, pos);
      if (!el) break;

      // Unknown-sized clusters end when the next segment-level element begins.
      while (this.isUnknownClusterBoundary(el.id)) this.closeContainer(this.containers.pop()!);

      const parent = this.containers[this.containers.length - 1]!;
      const childScope = this.childScope(parent.scope, el.id);
      const dataStart = this.bufferOffset + el.dataOffset;
      if (childScope) {
        const frame: ContainerFrame = {
          scope: childScope,
          end: el.size < 0 ? parent.end : dataStart + el.size,
          unknownSize: el.size < 0,
        };
        if (childScope === "track") {
          frame.track = {
            trackNumber: 0,
            trackType: 0,
            codecId: "",
            sampleRate: 48000,
            channels: 2,
          };
        }
        if (childScope === "cluster") this.clusterTimestamp = 0;
        this.containers.push(frame);
        pos = el.dataOffset;
        continue;
      }

      if (el.size < 0) {
        this.cb.onError?.(`unsupported unknown-sized EBML element 0x${el.id.toString(16)}`);
        break;
      }

      const available = this.buf.length - el.dataOffset;
      if (this.isRelevantLeaf(parent.scope, el.id, el.dataOffset, available)) {
        if (available < el.size) break;
        this.parseLeaf(parent.scope, el.id, el.dataOffset, el.size);
        pos = el.dataOffset + el.size;
        continue;
      }

      // Video blocks, attachments and cues can be skipped without buffering.
      const skipped = Math.min(available, el.size);
      pos = el.dataOffset + skipped;
      if (skipped < el.size) {
        this.skipRemaining = el.size - skipped;
        break;
      }
    }

    if (pos > 0) this.bufferOffset += pos;
    // Own the incomplete tail. Callers may reuse or transfer their input buffer
    // immediately after push() returns.
    this.buf = pos === this.buf.length
      ? new Uint8Array(0)
      : new Uint8Array(this.buf.subarray(pos));
  }

  private closeCompletedContainers(position: number): void {
    while (this.containers.length > 1) {
      const current = this.containers[this.containers.length - 1]!;
      if (current.unknownSize || position < current.end) break;
      this.closeContainer(this.containers.pop()!);
    }
  }

  private isUnknownClusterBoundary(id: number): boolean {
    if (this.containers.length <= 1) return false;
    const current = this.containers[this.containers.length - 1]!;
    return current.scope === "cluster" && current.unknownSize && (
      id === ID.Cluster || id === ID.Info || id === ID.Tracks
    );
  }

  private closeContainer(frame: ContainerFrame): void {
    if (frame.scope === "track" && frame.track) this.finishTrack(frame.track);
  }

  private childScope(parent: ContainerScope, id: number): ContainerScope | null {
    if (parent === "top" && id === ID.Segment) return "segment";
    if (parent === "segment") {
      if (id === ID.Info) return "info";
      if (id === ID.Tracks) return "tracks";
      if (id === ID.Cluster) return "cluster";
    }
    if (parent === "tracks" && id === ID.TrackEntry) return "track";
    if (parent === "track" && id === ID.Audio) return "audio";
    if (parent === "cluster" && id === ID.BlockGroup) return "block-group";
    return null;
  }

  private isRelevantLeaf(scope: ContainerScope, id: number, offset: number, available: number): boolean {
    if (scope === "info") return id === ID.TimestampScale || id === ID.Duration || id === ID.Title;
    if (scope === "track") {
      return id === ID.TrackNumber || id === ID.TrackType || id === ID.CodecID || id === ID.Name;
    }
    if (scope === "audio") return id === ID.SamplingFrequency || id === ID.Channels;
    if (scope === "cluster" && id === ID.Timestamp) return true;
    if ((scope === "cluster" && id === ID.SimpleBlock) || (scope === "block-group" && id === ID.Block)) {
      if (available === 0) return true;
      const trackVint = readVint(this.buf, offset, true);
      return !trackVint || trackVint[0] === this.selectedTrackNumber;
    }
    return false;
  }

  private parseLeaf(scope: ContainerScope, id: number, offset: number, size: number): void {
    if (scope === "info") {
      if (id === ID.TimestampScale) this.timestampScaleNs = this.readUint(offset, size);
      if (id === ID.Duration) this.durationFloat = this.readFloat(offset, size);
      if (id === ID.Title) this.segmentTitle = this.readString(offset, size);
      return;
    }

    const track = this.currentTrack();
    if (scope === "track" && track) {
      if (id === ID.TrackNumber) track.trackNumber = this.readUint(offset, size);
      if (id === ID.TrackType) track.trackType = this.readUint(offset, size);
      if (id === ID.CodecID) track.codecId = this.readString(offset, size);
      if (id === ID.Name) track.name = this.readString(offset, size);
      return;
    }
    if (scope === "audio" && track) {
      if (id === ID.SamplingFrequency) track.sampleRate = this.readFloat(offset, size);
      if (id === ID.Channels) track.channels = this.readUint(offset, size);
      return;
    }
    if (scope === "cluster") {
      if (id === ID.Timestamp) this.clusterTimestamp = this.readUint(offset, size);
      if (id === ID.SimpleBlock) this.parseBlock(offset, size);
      return;
    }
    if (scope === "block-group" && id === ID.Block) this.parseBlock(offset, size);
  }

  private currentTrack(): TrackDraft | undefined {
    for (let i = this.containers.length - 1; i >= 0; i--) {
      if (this.containers[i]!.track) return this.containers[i]!.track;
    }
    return undefined;
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

  private readString(offset: number, size: number): string {
    return new TextDecoder().decode(this.buf.subarray(offset, offset + size));
  }

  private finishTrack(draft: TrackDraft): void {
    if (draft.trackType !== TRACK_TYPE_AUDIO) return;
    const codec = codecFromCodecId(draft.codecId);
    if (!codec) return;
    const track: MkvAudioTrack = {
      trackNumber: draft.trackNumber,
      codecId: draft.codecId,
      codec,
      sampleRate: draft.sampleRate,
      channels: draft.channels,
    };
    if (draft.name !== undefined) track.name = draft.name;
    if (this.durationFloat !== undefined && Number.isFinite(this.durationFloat)) {
      track.durationSec = (this.durationFloat * this.timestampScaleNs) / 1e9;
    }
    const title = draft.name ?? this.segmentTitle;
    if (title) track.title = title;
    this.tracks.set(draft.trackNumber, track);
    if (this.selectedTrackNumber !== null) return;
    this.selectedTrackNumber = draft.trackNumber;
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
