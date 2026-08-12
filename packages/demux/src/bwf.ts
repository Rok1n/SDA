import { decodeDbmdBinauralMetadata, type BinauralRenderMetadata } from "./dbmd.js";

export interface BwfDemuxerCallbacks {
  onBinauralMetadata?: (metadata: BinauralRenderMetadata) => void;
  onError?: (message: string) => void;
}

/** Streaming BWF/RF64 chunk scanner. Audio remains untouched: SDA's existing
 * E-AC-3/TrueHD decoder cannot decode a PCM Atmos master from BWF data. */
export class BwfDemuxer {
  private bytes = new Uint8Array();
  private scanned = false;
  private reportedMissing = false;

  constructor(private cb: BwfDemuxerCallbacks = {}) {}

  static sniffs(bytes: Uint8Array): boolean {
    if (bytes.length < 12) return false;
    const tag = String.fromCharCode(...bytes.subarray(0, 4));
    return (tag === "RIFF" || tag === "RF64") && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE";
  }

  push(chunk: Uint8Array): void {
    if (this.scanned) return;
    const next = new Uint8Array(this.bytes.length + chunk.length);
    next.set(this.bytes);
    next.set(chunk, this.bytes.length);
    this.bytes = next;
    this.scan();
  }

  flush(): void {
    if (this.scanned || this.reportedMissing) return;
    this.reportedMissing = true;
    this.cb.onBinauralMetadata?.({
      available: false,
      source: "dbmd",
      version: null,
      objectModes: [],
      bedModes: {},
      error: "BWF input has no readable dbmd chunk",
    });
  }

  private scan(): void {
    if (!BwfDemuxer.sniffs(this.bytes)) return;
    let offset = 12;
    while (offset + 8 <= this.bytes.length) {
      const id = String.fromCharCode(...this.bytes.subarray(offset, offset + 4));
      const size = new DataView(this.bytes.buffer, this.bytes.byteOffset + offset + 4, 4).getUint32(0, true);
      const end = offset + 8 + size;
      if (end > this.bytes.length) return;
      if (id === "dbmd") {
        this.scanned = true;
        this.cb.onBinauralMetadata?.(decodeDbmdBinauralMetadata(this.bytes.slice(offset + 8, end)));
        return;
      }
      offset = end + (size & 1);
    }
  }
}
