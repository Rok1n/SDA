import { useEffect, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { LAYOUTS, sphericalToWebAudio } from "@sda/renderer";

const ROOM = 2;

type Pose = {
  available: boolean;
  live: boolean;
  source: string | null;
  mode: "off" | "fixed" | "tracked" | "unknown";
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  ageMs: number | null;
};

type Source = {
  id: string;
  label: string;
  kind: "bed-channel" | "dynamic-object";
  position: [number, number, number];
  peakDbfs: number;
  rmsDbfs: number;
  active: boolean;
};

type Scene = {
  connected: boolean;
  renderingEnabled: boolean;
  headTrackingEnabled: boolean;
  layoutId: string | null;
  activeStereoStreams: number;
  activeMultichannelStreams: number;
  objectMetadataAvailable: boolean;
  sources: Source[];
  message: string | null;
};

const EMPTY_POSE: Pose = {
  available: false,
  live: false,
  source: null,
  mode: "unknown",
  yawDeg: 0,
  pitchDeg: 0,
  rollDeg: 0,
  ageMs: null,
};

const EMPTY_SCENE: Scene = {
  connected: false,
  renderingEnabled: false,
  headTrackingEnabled: false,
  layoutId: null,
  activeStereoStreams: 0,
  activeMultichannelStreams: 0,
  objectMetadataAvailable: false,
  sources: [],
  message: "SDA global audio engine unavailable",
};

function Listener({ pose, usePose }: { pose: Pose; usePose: boolean }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!ref.current) return;
    const yaw = usePose && pose.live ? THREE.MathUtils.degToRad(-pose.yawDeg) : 0;
    const pitch = usePose && pose.live ? THREE.MathUtils.degToRad(pose.pitchDeg) : 0;
    ref.current.rotation.set(pitch, yaw, 0);
  });
  return (
    <group ref={ref}>
      <mesh scale={[0.85, 1.08, 0.92]}>
        <sphereGeometry args={[0.16, 20, 20]} />
        <meshStandardMaterial color="#8a93a6" roughness={0.5} />
      </mesh>
      <mesh position={[0, -0.2, 0]}>
        <cylinderGeometry args={[0.075, 0.08, 0.09, 24]} />
        <meshStandardMaterial color="#767e91" roughness={0.55} />
      </mesh>
      <mesh position={[0, 0, -0.17]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.025, 0.1, 10]} />
        <meshStandardMaterial color="#60a5fa" />
      </mesh>
    </group>
  );
}

function SpeakerRing() {
  const layout = LAYOUTS["7.1.4"];
  return (
    <group>
      {layout.map((speaker) => {
        const [x, y, z] = sphericalToWebAudio(speaker);
        return (
          <group key={speaker.name} position={[x * ROOM, y * ROOM, z * ROOM]}>
            <RoundedBox args={[0.11, 0.15, 0.09]} radius={0.02} smoothness={2}>
              <meshStandardMaterial color={speaker.isLfe ? "#94a3b8" : "#e2e8f0"} roughness={0.45} />
            </RoundedBox>
          </group>
        );
      })}
    </group>
  );
}

function ActivityDot({ source }: { source: Source }) {
  const p: [number, number, number] = [
    source.position[0] * ROOM,
    source.position[2] * ROOM,
    -source.position[1] * ROOM,
  ];
  const strength = Math.max(0, Math.min(1, (source.peakDbfs + 60) / 60));
  const scale = 0.05 + strength * 0.12;
  return (
    <group position={p}>
      <mesh>
        <sphereGeometry args={[scale, 16, 16]} />
        <meshBasicMaterial color={source.kind === "dynamic-object" ? "#22d3ee" : "#f59e0b"} transparent opacity={source.active ? 0.95 : 0.25} />
      </mesh>
      {source.active && (
        <mesh>
          <sphereGeometry args={[scale * 2.2, 16, 16]} />
          <meshBasicMaterial color="#f8fafc" transparent opacity={0.08 + strength * 0.12} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

function RoomScene({ pose, usePose, sources }: { pose: Pose; usePose: boolean; sources: Source[] }) {
  return (
    <Canvas camera={{ position: [0, 1.4, 4.5], fov: 52 }}>
      <color attach="background" args={["#080d18"]} />
      <ambientLight intensity={0.8} />
      <directionalLight position={[3, 4, 2]} intensity={1.2} />
      <gridHelper args={[ROOM * 2, 10, "#334155", "#172033"]} position={[0, -0.6, 0]} />
      <SpeakerRing />
      <Listener pose={pose} usePose={usePose} />
      {sources.map((source) => <ActivityDot key={source.id} source={source} />)}
      <OrbitControls enableDamping dampingFactor={0.08} minDistance={1.1} maxDistance={10} />
    </Canvas>
  );
}

export function SystemMonitor() {
  const [pose, setPose] = useState<Pose>(EMPTY_POSE);
  const [scene, setScene] = useState<Scene>(EMPTY_SCENE);
  const [previewPose, setPreviewPose] = useState(true);
  const bridge = window.sdaSystem;

  useEffect(() => {
    if (!bridge) return;
    void bridge.getHeadPose().then(setPose).catch(() => {});
    void bridge.getGlobalScene().then(setScene).catch(() => {});
    const offPose = bridge.onHeadPose(setPose);
    const offScene = bridge.onGlobalScene(setScene);
    return () => { offPose(); offScene(); };
  }, [bridge]);

  const toggleRendering = async () => {
    if (!bridge || !scene.connected) return;
    setScene(await bridge.setRenderingEnabled(!scene.renderingEnabled));
  };

  const toggleTracking = async () => {
    if (!bridge || !scene.connected) {
      setPreviewPose((value) => !value);
      return;
    }
    setScene(await bridge.setHeadTrackingEnabled(!scene.headTrackingEnabled));
  };

  const recenter = async () => {
    if (!bridge || !pose.available) return;
    setScene(await bridge.recenterHeadTracking());
  };

  const headPoseApplied = scene.connected ? scene.headTrackingEnabled : previewPose;
  const visualMode = scene.objectMetadataAvailable ? "Spatial Objects" : "Channel Activity";

  return (
    <main className="system-shell">
      <header className="system-header">
        <div>
          <h1>SDA System Audio</h1>
          <p>全局多声道监视 · AirPods Head Pose · Omniphony-style 3D</p>
        </div>
        <span className={scene.connected ? "pill ok" : "pill warn"}>
          {scene.connected ? "GLOBAL ENGINE CONNECTED" : "MONITOR MODE"}
        </span>
      </header>

      <section className="controls-card">
        <div className="control-row">
          <div>
            <strong>Multichannel Spatial Rendering</strong>
            <small>{scene.connected ? "只控制受支持的多声道流；Stereo 继续 bypass" : "等待 SDA GlobalAudio native bridge"}</small>
          </div>
          <button disabled={!scene.connected} className={scene.renderingEnabled ? "toggle on" : "toggle"} onClick={toggleRendering}>
            {scene.renderingEnabled ? "ON" : "OFF"}
          </button>
        </div>

        <div className="control-row">
          <div>
            <strong>AirPods Head Tracking</strong>
            <small>{pose.live ? `${pose.source ?? "AirPods Motion"} · LIVE` : pose.available ? `state: ${pose.mode}` : "No live AirPods motion state"}</small>
          </div>
          <div className="control-actions">
            <button disabled={!pose.available} className="secondary" onClick={recenter}>Recenter</button>
            <button disabled={!pose.available} className={headPoseApplied ? "toggle on" : "toggle"} onClick={toggleTracking}>
              {headPoseApplied ? "ON" : "OFF"}
            </button>
          </div>
        </div>

        <div className="metrics">
          <div><span>Yaw</span><strong>{pose.yawDeg.toFixed(1)}°</strong></div>
          <div><span>Pitch</span><strong>{pose.pitchDeg.toFixed(1)}°</strong></div>
          <div><span>Pose age</span><strong>{pose.ageMs == null ? "—" : `${Math.round(pose.ageMs)} ms`}</strong></div>
          <div><span>Layout</span><strong>{scene.layoutId ?? "—"}</strong></div>
          <div><span>Stereo bypass</span><strong>{scene.activeStereoStreams}</strong></div>
          <div><span>Multichannel</span><strong>{scene.activeMultichannelStreams}</strong></div>
        </div>
      </section>

      <section className="scene-card">
        <div className="scene-title">
          <div>
            <strong>{visualMode}</strong>
            <small>{scene.message ?? (scene.connected ? "Global telemetry live" : "3D listener follows verified AirPods motion when available")}</small>
          </div>
          <span>{scene.sources.length} active visual sources</span>
        </div>
        <div className="scene-canvas">
          <RoomScene pose={pose} usePose={headPoseApplied} sources={scene.sources} />
        </div>
      </section>

      <footer>
        Channel Activity 只显示真实声道/能量；只有 native bridge 提供真实 object XYZ 时才标记 Spatial Objects。
      </footer>
    </main>
  );
}
