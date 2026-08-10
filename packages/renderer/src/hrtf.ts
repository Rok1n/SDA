/**
 * Binaural IR loading. Format: a compact JSON manifest + raw f32le IR files,
 * produced offline from SOFA datasets (MIT KEMAR recommended — licence:
 * "provided free with no restrictions on use"). See docs/binaural-rendering.md.
 *
 * Manifest (hrtf-set.json):
 *   { "sampleRate": 48000,
 *     "speakers": [ { "name": "FrontLeft", "azimuth": 30, "elevation": 0,
 *                     "file": "fl.f32" }, ... ] }
 * Each .f32 file: [leftIR Float32Array][rightIR Float32Array] concatenated,
 * same length, pre-trimmed/resampled offline.
 */

export interface HrtfManifestEntry {
  name: string;
  azimuth: number;
  elevation: number;
  file: string;
}

export interface HrtfManifest {
  sampleRate: number;
  speakers: HrtfManifestEntry[];
}

/** Load an IR set; returns bus-index → stereo AudioBuffer, matched by
 * speaker name against the given layout order. */
export async function loadBinauralIrs(
  ctx: AudioContext,
  baseUrl: string,
  layoutNames: string[],
): Promise<Map<number, AudioBuffer>> {
  const manifest = (await (await fetch(`${baseUrl}/hrtf-set.json`)).json()) as HrtfManifest;
  const result = new Map<number, AudioBuffer>();

  await Promise.all(
    manifest.speakers.map(async (entry) => {
      const bus = layoutNames.indexOf(entry.name);
      if (bus < 0) return;
      const raw = await (await fetch(`${baseUrl}/${entry.file}`)).arrayBuffer();
      const all = new Float32Array(raw);
      const len = all.length / 2;
      const buf = ctx.createBuffer(2, len, manifest.sampleRate);
      buf.copyToChannel(all.subarray(0, len) as Float32Array<ArrayBuffer>, 0);
      buf.copyToChannel(all.subarray(len) as Float32Array<ArrayBuffer>, 1);
      result.set(bus, buf);
    }),
  );
  return result;
}
