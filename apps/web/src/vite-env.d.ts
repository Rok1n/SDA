/// <reference types="vite/client" />

declare global {
  interface Window {
    sdaDesktop?: {
      electron3D: boolean;
      rendererMode: string;
      pickFile?: () => Promise<string | null>;
      openPath?: (filePath: string) => Promise<{ id: number; size: number; name: string }>;
      readSlice?: (id: number, offset: number, length: number) => Promise<Uint8Array>;
      close?: (id: number) => Promise<void>;
      onOpenFile?: (callback: (filePath: string) => void) => void;
    };
  }
}

export {};
