/**
 * Live 3D object visualization — the spiritual successor to Omniphony
 * Studio's OSC view: every audio object is a glowing dot moving through a
 * top/front wireframe room, coloured by height. Speaker ring shows the
 * 7.1.4 virtual layout used by the renderer.
 */

import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { sphericalToWebAudio, type VirtualSpeaker } from "@sda/renderer";
import type { VisualObject } from "@sda/player";
export type { VisualObject };

const ROOM = 2; // half-extent of the room footprint in scene units
// 物理房间：地板在听者脚下，天花板在 ADM z = +1 处（耳位高度约为房高的 2/7）
const FLOOR_Y = -0.6;
const CEIL_Y = ROOM;
const WALL_H = CEIL_Y - FLOOR_Y;
const WALL_MID_Y = (CEIL_Y + FLOOR_Y) / 2;

export type Theme = "dark" | "light";

/** 房间配色：深色 / 浅色两套 */
const PALETTE = {
  dark: {
    bg: "#0c101c",
    floor: "#101a30",
    wallSide: "#0d1628",
    wallFront: "#12203c",
    gridMain: "#223344",
    gridWall: "#141d33",
    outline: "#26304d",
    floorGrid: "#1a2338",
  },
  light: {
    bg: "#e9edf4",
    floor: "#dde4ef",
    wallSide: "#d0d9e8",
    wallFront: "#e2e9f4",
    gridMain: "#a8b5cd",
    gridWall: "#c3cddd",
    outline: "#9dabc5",
    floorGrid: "#c8d1e2",
  },
} as const;

type Palette = (typeof PALETTE)[Theme];

/** ADM cartesian → scene position (three.js: x right, y up, z toward viewer;
 *  ADM: x left, y front, z up). */
function admToScene(pos: [number, number, number]): [number, number, number] {
  return [-pos[0] * ROOM, pos[2] * ROOM, -pos[1] * ROOM];
}

/** 仿真力 The Ones 同轴音箱：圆角箱体 + 大椭圆波导 + 中央同轴单元 + Iso-Pod 支架。
 *  局部 +z 为正面（朝向听者）。 */
function GenelecSpeaker() {
  return (
    <group>
      {/* 圆角箱体（Polar White 极地白） */}
      <RoundedBox args={[0.13, 0.18, 0.11]} radius={0.03} smoothness={4}>
        <meshStandardMaterial color="#e8eaec" roughness={0.4} metalness={0.15} />
      </RoundedBox>
      {/* 正面大椭圆波导（DCW，覆盖整个前障板） */}
      <mesh position={[0, 0, 0.05]} scale={[1, 1.35, 0.35]}>
        <sphereGeometry args={[0.052, 24, 24]} />
        <meshStandardMaterial color="#c9ced4" roughness={0.45} metalness={0.1} />
      </mesh>
      {/* 中央同轴中高音单元 */}
      <mesh position={[0, 0, 0.062]} scale={[1, 1, 0.5]}>
        <sphereGeometry args={[0.016, 16, 16]} />
        <meshStandardMaterial color="#1c2026" roughness={0.3} metalness={0.5} />
      </mesh>
      {/* Iso-Pod 避震支架（微后倾） */}
      <mesh position={[0, -0.1, 0]} rotation={[0.12, 0, 0]}>
        <boxGeometry args={[0.07, 0.018, 0.08]} />
        <meshStandardMaterial color="#aab0b8" roughness={0.55} />
      </mesh>
    </group>
  );
}

/** 真力 7350A 低音炮：矮胖的圆角箱体 + 正面低音单元 + 支脚，放地板上。 */
function GenelecSub() {
  return (
    <group>
      <RoundedBox args={[0.24, 0.22, 0.2]} radius={0.04} smoothness={4}>
        <meshStandardMaterial color="#e8eaec" roughness={0.4} metalness={0.15} />
      </RoundedBox>
      {/* 正面低音单元（纸盆）—— 前移避开与箱体面板的 z-fighting */}
      <mesh position={[0, -0.02, 0.106]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.07, 0.07, 0.02, 32]} />
        <meshStandardMaterial color="#1c2026" roughness={0.35} metalness={0.4} />
      </mesh>
      {/* 防尘帽 */}
      <mesh position={[0, -0.02, 0.124]} scale={[1, 1, 0.5]}>
        <sphereGeometry args={[0.028, 16, 16]} />
        <meshStandardMaterial color="#2b2f35" roughness={0.4} />
      </mesh>
      {/* 四只支脚 */}
      {([[-0.08, -0.06], [0.08, -0.06], [-0.08, 0.06], [0.08, 0.06]] as const).map(([fx, fz], i) => (
        <mesh key={i} position={[fx, -0.115, fz]}>
          <cylinderGeometry args={[0.015, 0.018, 0.02, 12]} />
          <meshStandardMaterial color="#aab0b8" roughness={0.55} />
        </mesh>
      ))}
    </group>
  );
}

function SpeakerRing({ layout }: { layout: readonly VirtualSpeaker[] }) {
  const speakers = useMemo(
    () =>
      layout.map((s) => {
        const [x, y, z] = sphericalToWebAudio(s);
        // 低音炮：按真力指南沿前墙摆放、略偏离中轴线（音频定位仍用布局的 45°）
        const position = s.isLfe
          ? new THREE.Vector3(-0.7, FLOOR_Y + 0.13, -ROOM + 0.13)
          : new THREE.Vector3(x * ROOM, y * ROOM, z * ROOM);
        const dummy = new THREE.Object3D();
        dummy.position.copy(position);
        if (s.isLfe) dummy.lookAt(0, FLOOR_Y + 0.13, 0);
        else dummy.lookAt(0, 0, 0);
        return { name: s.name, isLfe: s.isLfe, position, quaternion: dummy.quaternion.clone() };
      }),
    [layout],
  );
  return (
    <group>
      {speakers.map((s) => (
        <group key={s.name} position={s.position} quaternion={s.quaternion}>
          {s.isLfe ? <GenelecSub /> : <GenelecSpeaker />}
        </group>
      ))}
    </group>
  );
}

function Room({ p }: { p: Palette }) {
  const geometry = useMemo(() => new THREE.BoxGeometry(ROOM * 2, WALL_H, ROOM * 2), []);
  return (
    <group>
      {/* 实体地板（听者脚下） */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y + 0.001, 0]}>
        <planeGeometry args={[ROOM * 2, ROOM * 2]} />
        <meshBasicMaterial color={p.floor} />
      </mesh>
      {/* 两面实体侧墙（-x / -z），半透明，不挡对象 */}
      <mesh rotation={[0, Math.PI / 2, 0]} position={[-ROOM + 0.001, WALL_MID_Y, 0]}>
        <planeGeometry args={[ROOM * 2, WALL_H]} />
        <meshBasicMaterial color={p.wallSide} transparent opacity={0.75} />
      </mesh>
      {/* 正面墙（听者朝向，-z）颜色稍亮以示区分 */}
      <mesh position={[0, WALL_MID_Y, -ROOM + 0.001]}>
        <planeGeometry args={[ROOM * 2, WALL_H]} />
        <meshBasicMaterial color={p.wallFront} transparent opacity={0.85} />
      </mesh>
      {/* 墙面参考网格（4 × WALL_H，压扁局部高度轴） */}
      <gridHelper
        args={[ROOM * 2, 10, p.gridMain, p.gridWall]}
        rotation={[Math.PI / 2, 0, 0]}
        position={[0, WALL_MID_Y, -ROOM + 0.002]}
        scale={[1, 1, WALL_H / (ROOM * 2)]}
      />
      <gridHelper
        args={[ROOM * 2, 10, p.gridMain, p.gridWall]}
        rotation={[0, 0, Math.PI / 2]}
        position={[-ROOM + 0.002, WALL_MID_Y, 0]}
        scale={[WALL_H / (ROOM * 2), 1, 1]}
      />
      {/* 房间轮廓线（地板到天花板的矩形房间） */}
      <lineSegments position={[0, WALL_MID_Y, 0]}>
        <edgesGeometry args={[geometry]} />
        <lineBasicMaterial color={p.outline} />
      </lineSegments>
    </group>
  );
}

/** 听者：仿纽曼 KU 100 人头麦 —— 光滑无五官的蛋形头、两侧硅胶耳廓、
 *  平直颈部切口 + 话筒立杆。耳廓中心对齐 y=0（ADM 耳位）。 */
function Listener() {
  const gray = "#8a93a6";
  const grayDark = "#767e91";
  return (
    <group position={[0, 0, 0]}>
      {/* 头：蛋形（略高、前后稍扁） */}
      <mesh scale={[0.85, 1.08, 0.92]}>
        <sphereGeometry args={[0.16, 32, 32]} />
        <meshStandardMaterial color={gray} roughness={0.5} />
      </mesh>
      {/* 面部（-z = 前方）：闭眼眼睑、鼻梁、嘴 —— KEMAR 式浮雕感 */}
      {/* 眼睑：略暗的扁椭球，半嵌入表面 */}
      <mesh position={[-0.05, 0.04, -0.128]} scale={[1.1, 0.55, 0.5]}>
        <sphereGeometry args={[0.021, 16, 16]} />
        <meshStandardMaterial color={grayDark} roughness={0.55} />
      </mesh>
      <mesh position={[0.05, 0.04, -0.128]} scale={[1.1, 0.55, 0.5]}>
        <sphereGeometry args={[0.021, 16, 16]} />
        <meshStandardMaterial color={grayDark} roughness={0.55} />
      </mesh>
      {/* 鼻梁：竖向小椭球 */}
      <mesh position={[0, -0.012, -0.148]} scale={[0.5, 1, 0.75]}>
        <sphereGeometry args={[0.032, 16, 16]} />
        <meshStandardMaterial color={gray} roughness={0.5} />
      </mesh>
      {/* 嘴：细横条微凸 */}
      <mesh position={[0, -0.075, -0.132]}>
        <boxGeometry args={[0.052, 0.009, 0.012]} />
        <meshStandardMaterial color={grayDark} roughness={0.55} />
      </mesh>
      {/* 耳廓：两侧凸起，略靠后（+z 是后方），是前后朝向的提示 */}
      {[-1, 1].map((side) => (
        <group key={side} position={[side * 0.145, 0, 0.02]}>
          <mesh scale={[0.28, 0.75, 0.55]}>
            <sphereGeometry args={[0.06, 20, 20]} />
            <meshStandardMaterial color={grayDark} roughness={0.55} />
          </mesh>
          <mesh position={[side * 0.014, 0, -0.004]} scale={[0.16, 0.42, 0.3]}>
            <sphereGeometry args={[0.045, 16, 16]} />
            <meshStandardMaterial color={gray} roughness={0.5} />
          </mesh>
        </group>
      ))}
      {/* 颈部（平直切口的圆柱） */}
      <mesh position={[0, -0.2, 0]}>
        <cylinderGeometry args={[0.075, 0.08, 0.09, 24]} />
        <meshStandardMaterial color={grayDark} roughness={0.55} />
      </mesh>
      {/* 立杆 + 落地脚盘 */}
      <mesh position={[0, -0.43, 0]}>
        <cylinderGeometry args={[0.014, 0.014, 0.37, 12]} />
        <meshStandardMaterial color="#3d4457" roughness={0.4} metalness={0.4} />
      </mesh>
      <mesh position={[0, FLOOR_Y + 0.016, 0]}>
        <cylinderGeometry args={[0.09, 0.11, 0.024, 32]} />
        <meshStandardMaterial color="#3d4457" roughness={0.5} metalness={0.3} />
      </mesh>
    </group>
  );
}

function ObjectDot({ obj }: { obj: VisualObject }) {
  const ref = useRef<THREE.Group>(null);
  const target = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    if (!ref.current) return;
    // Smooth toward the latest event position (renderer ramps audio; we ease the view).
    target.set(...admToScene(obj.pos));
    ref.current.position.lerp(target, Math.min(1, dt * 20));
  });
  const height = obj.pos[2]; // ADM z = up
  const color = new THREE.Color().setHSL(0.55 - height * 0.25, 0.9, 0.6);
  // ADM size[0]（宽度 0..1）→ 半透明扩散光晕半径
  const spread = Math.min(1, Math.max(0, obj.size?.[0] ?? 0));
  return (
    <group ref={ref}>
      <mesh>
        <sphereGeometry args={[0.06, 16, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {/* 尺寸光晕：对象越大，halo 越大 */}
      <mesh>
        <sphereGeometry args={[0.09 + spread * 0.3, 24, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.16} depthWrite={false} />
      </mesh>
    </group>
  );
}

export function ObjectView({
  objects,
  layout,
  theme = "dark",
}: {
  objects: VisualObject[];
  layout: readonly VirtualSpeaker[];
  theme?: Theme;
}) {
  const p = PALETTE[theme];
  return (
    <Canvas
      camera={{ position: [0, 1.3, 4.2], fov: 55 }}
      style={{ background: p.bg }}
      gl={{ antialias: true }}
    >
      <Room p={p} />
      <SpeakerRing layout={layout} />
      <Listener />
      {objects.map((o) => (
        <ObjectDot key={o.id} obj={o} />
      ))}
      <gridHelper args={[ROOM * 2, 10, p.gridMain, p.floorGrid]} position={[0, FLOOR_Y, 0]} />
      {/* 听者半身像的光照 */}
      <ambientLight intensity={0.75} />
      <directionalLight position={[2.5, 4, 2]} intensity={1.2} />
      {/* 左键拖动旋转视角 / 右键拖动平移 / 滚轮缩放空间 */}
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.9}
        minDistance={0.5}
        maxDistance={12}
      />
    </Canvas>
  );
}
