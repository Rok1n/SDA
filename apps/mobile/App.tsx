/**
 * SDA mobile (Expo). UI shell: file pick + 3D object view.
 *
 * Decoding on mobile does NOT use the wasm core (RN has no real wasm JIT);
 * it goes through the `sda-core` Expo native module (Rust decoders built as
 * a static library — same crates as packages/core). See
 * docs/mobile-native-module.md for the build + AVAudioEngine/AAudio
 * rendering design. Until the native module is linked, the app runs in
 * "visualizer demo" mode with synthetic object motion.
 */

import React, { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { StatusBar } from "react-native";

interface VisualObject {
  id: number;
  pos: [number, number, number];
}

export default function App() {
  const [objects, setObjects] = useState<VisualObject[]>([]);
  const [demo, setDemo] = useState(true);

  // Demo mode: two objects orbiting, proving the metadata→view pipeline.
  useEffect(() => {
    if (!demo) return;
    const t = setInterval(() => {
      const now = Date.now() / 1000;
      setObjects([
        { id: 10, pos: [Math.sin(now), Math.cos(now), 0.2] },
        { id: 11, pos: [Math.sin(now * 0.7 + 2), Math.cos(now * 0.7 + 2), -0.3] },
      ]);
    }, 50);
    return () => clearInterval(t);
  }, [demo]);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <Text style={styles.title}>SDA · 空间音频解码器</Text>
      <View style={styles.room}>
        {/* 2D projection of the room until R3F canvas is wired in:
            x = ADM x (left+), y = ADM z (up). */}
        {objects.map((o) => (
          <View
            key={o.id}
            style={[
              styles.dot,
              {
                left: `${50 + o.pos[0] * 40}%`,
                top: `${50 - o.pos[2] * 40}%`,
                backgroundColor: `hsl(${200 - o.pos[2] * 90}, 90%, 60%)`,
              },
            ]}
          />
        ))}
        <View style={styles.listener} />
      </View>
      <Text style={styles.status}>
        {demo
          ? "演示模式 — 原生解码模块未链接（见 docs/mobile-native-module.md）"
          : `${objects.length} 个对象`}
      </Text>
      <TouchableOpacity style={styles.button} onPress={() => setDemo((d) => !d)}>
        <Text style={styles.buttonText}>{demo ? "停止演示" : "开始演示"}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0c101c",
    alignItems: "center",
    paddingTop: 64,
  },
  title: { color: "#dbe2f0", fontSize: 18, fontWeight: "600" },
  room: {
    width: 300,
    height: 300,
    marginVertical: 24,
    borderWidth: 1,
    borderColor: "#2a3550",
    borderRadius: 8,
  },
  dot: {
    position: "absolute",
    width: 12,
    height: 12,
    borderRadius: 6,
    marginLeft: -6,
    marginTop: -6,
  },
  listener: {
    position: "absolute",
    left: "50%",
    top: "50%",
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "#e8ecf4",
    marginLeft: -8,
    marginTop: -8,
  },
  status: { color: "#6f80a8", fontSize: 12, paddingHorizontal: 32, textAlign: "center" },
  button: {
    marginTop: 20,
    backgroundColor: "#182238",
    borderColor: "#2a3a5f",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  buttonText: { color: "#dbe2f0", fontSize: 14 },
});
