export {};

type HeadPoseState = {
  available: boolean;
  live: boolean;
  source: string | null;
  mode: "off" | "fixed" | "tracked" | "unknown";
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  ageMs: number | null;
};

type GlobalAudioSource = {
  id: string;
  label: string;
  kind: "bed-channel" | "dynamic-object";
  position: [number, number, number];
  peakDbfs: number;
  rmsDbfs: number;
  active: boolean;
};

type GlobalAudioScene = {
  connected: boolean;
  renderingEnabled: boolean;
  headTrackingEnabled: boolean;
  layoutId: string | null;
  activeStereoStreams: number;
  activeMultichannelStreams: number;
  objectMetadataAvailable: boolean;
  sources: GlobalAudioSource[];
  message: string | null;
};

declare global {
  interface Window {
    sdaSystem?: {
      getHeadPose(): Promise<HeadPoseState>;
      getGlobalScene(): Promise<GlobalAudioScene>;
      setRenderingEnabled(enabled: boolean): Promise<GlobalAudioScene>;
      setHeadTrackingEnabled(enabled: boolean): Promise<GlobalAudioScene>;
      recenterHeadTracking(): Promise<GlobalAudioScene>;
      onHeadPose(callback: (pose: HeadPoseState) => void): () => void;
      onGlobalScene(callback: (scene: GlobalAudioScene) => void): () => void;
    };
  }
}
