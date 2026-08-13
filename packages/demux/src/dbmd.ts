/**
 * Dolby DBMD binaural-render-mode reader.
 *
 * This intentionally implements only the byte layout documented by Dolby's
 * public dbmd-atmos-parser (version 1.0.0.7). DBMD is program metadata, not
 * OAMD object-position metadata; unsupported versions are reported instead of
 * guessing their bit layout.
 */

export type BinauralRenderMode = "off" | "near" | "mid" | "far" | "not-indicated";

export interface BinauralRenderMetadata {
  available: boolean;
  source: "dbmd";
  /** DBMD version bytes, in the order stored in the chunk. */
  version: string | null;
  /** Modes in the supplemental segment's program-element ordinal order. */
  modeTable: BinauralRenderMode[];
  /** The public parser does not expose ordinal -> bed subchannel/object identity. */
  elementMapping: "unavailable";
  error?: string;
}

const DBMD_VERSION_1_0_0_7 = [7, 0, 0, 1] as const;
const ATMOS_SUPPLEMENTAL_SEGMENT = 0x0a;
const SUPPLEMENTAL_SYNC = 0xf8726fbd;
const TRIM_CONFIG_COUNT = 6;

function empty(version: string | null, error: string): BinauralRenderMetadata {
  return { available: false, source: "dbmd", version, modeTable: [], elementMapping: "unavailable", error };
}

function versionText(bytes: Uint8Array): string {
  return `${bytes[3]}.${bytes[2]}.${bytes[1]}.${bytes[0]}`;
}

function checksum(payload: Uint8Array): number {
  let sum = payload.length & 0xff;
  for (const byte of payload) sum = (sum + byte) & 0xff;
  return (-sum) & 0xff;
}

function modeFromValue(value: number): BinauralRenderMode {
  switch (value & 0x07) {
    case 0: return "off";
    case 1: return "near";
    case 2: return "far";
    case 3: return "mid";
    default: return "not-indicated";
  }
}

/** Parse the complete BWF `dbmd` chunk payload. */
export function decodeDbmdBinauralMetadata(bytes: Uint8Array): BinauralRenderMetadata {
  if (bytes.length < 5) return empty(null, "DBMD chunk is truncated before its version field");
  const versionBytes = bytes.subarray(0, 4);
  const version = versionText(versionBytes);
  if (!DBMD_VERSION_1_0_0_7.every((byte, index) => versionBytes[index] === byte)) {
    return empty(version, `Unsupported DBMD version ${version}; binaural modes were not decoded`);
  }

  let offset = 4;
  while (offset < bytes.length) {
    const segmentId = bytes[offset++]!;
    if (segmentId === 0) break;
    if (offset + 2 > bytes.length) return empty(version, "DBMD segment length is truncated");
    const size = bytes[offset]! | (bytes[offset + 1]! << 8);
    offset += 2;
    if (offset + size >= bytes.length) return empty(version, "DBMD segment payload is truncated");
    const payload = bytes.subarray(offset, offset + size);
    const storedChecksum = bytes[offset + size]!;
    offset += size + 1;
    if (checksum(payload) !== storedChecksum) {
      if (segmentId === ATMOS_SUPPLEMENTAL_SEGMENT) return empty(version, "DBMD supplemental segment checksum failed");
      continue;
    }
    if (segmentId !== ATMOS_SUPPLEMENTAL_SEGMENT) continue;
    if (payload.length < 7) return empty(version, "DBMD supplemental segment is truncated");
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    if (view.getUint32(0, true) !== SUPPLEMENTAL_SYNC) return empty(version, "DBMD supplemental segment sync word is invalid");
    const objectCount = view.getUint16(4, true);
    const modesOffset = 7 + TRIM_CONFIG_COUNT * 15 + objectCount;
    if (modesOffset + objectCount > payload.length) return empty(version, "DBMD supplemental object-mode table is truncated");
    const modeTable: BinauralRenderMode[] = [];
    for (let ordinal = 0; ordinal < objectCount; ordinal++) modeTable.push(modeFromValue(payload[modesOffset + ordinal]!));
    return { available: true, source: "dbmd", version, modeTable, elementMapping: "unavailable" };
  }
  return empty(version, "DBMD has no Dolby Atmos supplemental metadata segment");
}
