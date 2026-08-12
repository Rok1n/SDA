/// <reference types="vite/client" />

interface LocalHeadphoneProfileAsset {
  fileName: string;
  tapCount: number;
  sha256: string;
}

interface LocalHeadphoneProfileManifest {
  id: string;
  name: string;
  source: string;
  target: string;
  leftMeasurement: string;
  rightMeasurement: string;
  balanceEvidence: string;
  sampleRate: number;
  preampDb: number;
  leftFirUrl: string;
  rightFirUrl: string;
  schemaVersion: 1;
  measurementMode: "independent-lr" | "average-dual-mono";
  channelClaim: string;
  averageMeasurement?: string;
  derivation?: string;
  createdAt: string;
  deviceRevision: string;
  playbackState: string;
  earTips: string;
  firmware: string;
  measurementRig: string;
  referenceBand: string;
  leftFir: LocalHeadphoneProfileAsset;
  rightFir: LocalHeadphoneProfileAsset;
}

declare global {
  interface Window {
    sdaDesktop?: {
      electron3D: boolean;
      rendererMode: string;
      pickFile?: () => Promise<string | null>;
      openPath?: (filePath: string) => Promise<{ id: number; size: number; name: string }>;
      readSlice?: (id: number, offset: number, length: number) => Promise<Uint8Array>;
      close?: (id: number) => Promise<void>;
      importHeadphoneProfile?: () => Promise<{ profile: LocalHeadphoneProfileManifest; leftFir: Uint8Array; rightFir: Uint8Array } | null>;
      listHeadphoneProfiles?: () => Promise<LocalHeadphoneProfileManifest[]>;
      readHeadphoneProfile?: (id: string) => Promise<{ profile: LocalHeadphoneProfileManifest; leftFir: Uint8Array; rightFir: Uint8Array }>;
      deleteHeadphoneProfile?: (id: string) => Promise<void>;
      onOpenFile?: (callback: (filePath: string) => void) => void;
    };
  }
}

export {};
