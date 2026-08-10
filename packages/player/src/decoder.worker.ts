/**
 * Decoder worker script — runs demux + wasm decode off the UI thread.
 * Loaded as a module worker; messages:
 *   in:  { type: "init", wasmUrl }         → init wasm
 *        { type: "open", codec, kind }     → create decoder + demuxer
 *        { type: "push", chunk }           → container bytes (transferable)
 *   out: { type: "track", ... }            → discovered audio track
 *        { type: "frame", frame }          → decoded frame (channels transferred)
 *        { type: "error", message }
 */

import { initCore, SdaDecoder, type CodecName, type DecodedFrameData } from "@sda/core";
import { createDemuxer, sniffContainer, type ContainerKind, type Demuxer } from "@sda/demux";

/** Minimal worker global typing (avoids DOM/WebWorker lib conflicts). */
declare const self: {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

let decoder: SdaDecoder | null = null;
let demuxer: Demuxer | null = null;

function postFrame(frame: DecodedFrameData): void {
  self.postMessage(
    { type: "frame", frame },
    frame.channels.map((c) => c.buffer),
  );
}

function drainFrames(): void {
  if (!decoder) return;
  while (true) {
    const frame = decoder.nextFrame();
    if (!frame) break;
    postFrame(frame);
  }
  for (const message of decoder.drainErrors()) {
    self.postMessage({ type: "error", message });
  }
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  switch (msg.type) {
    case "init": {
      await initCore();
      self.postMessage({ type: "ready" });
      break;
    }
    case "open": {
      decoder?.free();
      decoder = new SdaDecoder(msg.codec as CodecName);
      demuxer = null; // created on first push, after sniffing
      break;
    }
    case "push": {
      if (!decoder) break;
      const chunk = new Uint8Array(msg.chunk as ArrayBuffer);
      if (!demuxer) {
        const kind: ContainerKind = msg.kind ?? sniffContainer(chunk);
        demuxer = createDemuxer(kind, {
          onTrack: (t) => self.postMessage({ type: "track", track: t }),
          onPacket: (p) => {
            for (const au of p.frames) decoder!.push(au);
            drainFrames();
          },
          onError: (m) => self.postMessage({ type: "error", message: m }),
        });
      }
      demuxer.push(chunk);
      drainFrames();
      break;
    }
  }
};

export {};
