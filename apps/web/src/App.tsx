import { useCallback, useEffect, useRef, useState } from "react";
import { SdaPlayer, type VisualObject } from "@sda/player";
import { LAYOUTS, type LayoutId, type OutputMode } from "@sda/renderer";
// @ts-ignore — plain JS asset served by Vite
import workletUrl from "@sda/renderer/worklet/sda-renderer.worklet.js?url";
import { ObjectView, type Theme } from "./components/ObjectView";
import { MiniPlayer, type TrackInfo } from "./components/MiniPlayer";

export function App() {
  const playerRef = useRef<SdaPlayer | null>(null);
  const [mode, setMode] = useState<OutputMode>("binaural");
  const [layoutId, setLayoutId] = useState<LayoutId>("7.1.4");
  const [theme, setTheme] = useState<Theme>("dark");
  const [track, setTrack] = useState<TrackInfo | null>(null);
  const [objects, setObjects] = useState<VisualObject[]>([]);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [debug, setDebug] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [volume, setVolume] = useState(1);
  const [dragOver, setDragOver] = useState(false);
  const lastFileRef = useRef<File | null>(null);
  /** 当前文件名，容器没有标题元数据时给 miniplayer 兜底用。 */
  const fileNameRef = useRef<string | null>(null);

  const createPlayer = useCallback(
    async (m: OutputMode, lid: LayoutId) => {
      await playerRef.current?.dispose();
      const player = new SdaPlayer({
        onTrack: (t) => setTrack({ ...t, title: t.title ?? fileNameRef.current ?? undefined }),
        onVisualState: (objs, t) => {
          setObjects(objs);
          setPosition(t);
          const p = playerRef.current;
          setDuration(p?.durationSeconds() ?? 0);
          setDebug(p ? `#${p.id} 已解码 ${p.durationSeconds().toFixed(1)}s / 播放头 ${t.toFixed(1)}s` : "");
        },
        onError: (m) => setErrors((prev) => [...prev.slice(-19), m]),
        onEnded: () => setPlaying(false),
      });
      await player.init(m, workletUrl, LAYOUTS[lid]);
      playerRef.current = player;
      return player;
    },
    [],
  );

  useEffect(() => () => void playerRef.current?.dispose(), []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const play = useCallback(
    async (file: File) => {
      setErrors([]);
      setTrack(null);
      setObjects([]);
      setPosition(0);
      setDuration(0);
      setPlaying(true);
      setPaused(false);
      lastFileRef.current = file;
      fileNameRef.current = file.name.replace(/\.[^.]+$/, "");
      try {
        // Always rebuild with the currently selected output mode and layout.
        const player = await createPlayer(mode, layoutId);
        player.setVolume(volume);
        await player.playFile(file, "auto");
      } catch (e) {
        setErrors((prev) => [...prev, String(e)]);
        setPlaying(false);
      }
    },
    [createPlayer, mode, layoutId, volume],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) void play(file);
    },
    [play],
  );

  /** Demo: bundled E-AC-3 JOC (Atmos) test vector from the harletty repo. */
  const playDemo = useCallback(async () => {
    const blob = await (await fetch("/demo-joc.ec3")).blob();
    await play(new File([blob], "demo-joc.ec3"));
  }, [play]);

  /** 播放中 → 暂停；暂停中 → 继续；已播完 → 重播（macOS 播放键行为）。
   *  UI 状态立即切换（乐观更新），不等 suspend/resume 的 promise —
   *  某些环境下这些 promise 不 resolve，会表现为按钮"没反应"。 */
  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (playing && !paused) {
      setPaused(true);
      void player?.pause();
    } else if (paused) {
      setPaused(false);
      void player?.resume();
    } else if (lastFileRef.current) {
      void play(lastFileRef.current);
    }
  }, [playing, paused, play]);

  const changeVolume = useCallback((v: number) => {
    setVolume(v);
    playerRef.current?.setVolume(v);
  }, []);

  const replay = useCallback(() => {
    const file = lastFileRef.current;
    if (file) void play(file);
  }, [play]);

  return (
    <div
      className={`app ${dragOver ? "drag" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <header>
        <h1>SDA · 空间音频解码器</h1>
        <div className="controls">
          <select value={mode} onChange={(e) => setMode(e.target.value as OutputMode)}>
            <option value="binaural">双耳 (耳机 HRTF)</option>
            <option value="stereo">立体声</option>
            <option value="multichannel">多声道</option>
          </select>
          <select value={layoutId} onChange={(e) => setLayoutId(e.target.value as LayoutId)}>
            {(Object.keys(LAYOUTS) as LayoutId[]).map((id) => (
              <option key={id} value={id}>
                布局 {id}
              </option>
            ))}
          </select>
          <button
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <button
            onClick={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = ".mkv,.mka,.mp4,.m4a,.thd,.mlp,.ec3,.eac3,.ac3,.dts";
              input.onchange = () => input.files?.[0] && void play(input.files[0]);
              input.click();
            }}
          >
            打开文件
          </button>
          <button disabled={!playing} onClick={() => playerRef.current?.stop()}>
            停止
          </button>
          <button onClick={() => void playDemo()}>演示流 (JOC)</button>
        </div>
      </header>

      <main>
        <section className="view">
          <ObjectView objects={objects} layout={LAYOUTS[layoutId]} theme={theme} />
          <div className={`view-hint ${track ? "shifted" : ""}`}>拖动旋转 · 右键平移 · 滚轮缩放</div>
          <MiniPlayer
            track={track}
            position={position}
            duration={duration}
            playing={playing}
            paused={paused}
            objectCount={objects.length}
            volume={volume}
            onTogglePlay={togglePlay}
            onStop={() => playerRef.current?.stop()}
            onReplay={replay}
            onVolume={changeVolume}
          />
        </section>
        <aside>
          <div className="panel">
            <h2>码流</h2>
            {track ? (
              <dl>
                <dt>编码</dt>
                <dd>{track.codec}</dd>
                <dt>采样率</dt>
                <dd>{track.sampleRate} Hz</dd>
                <dt>声道</dt>
                <dd>{track.channels}</dd>
                <dt>容器</dt>
                <dd>{track.container}</dd>
                <dt>播放</dt>
                <dd>{position.toFixed(1)} s</dd>
                <dt>诊断</dt>
                <dd>{debug || "—"}</dd>
              </dl>
            ) : (
              <p className="dim">拖入 .mkv / .mp4 / .thd / .ec3 / .dts 文件开始</p>
            )}
          </div>
          <div className="panel">
            <h2>对象 ({objects.length})</h2>
            <ul className="objects">
              {objects.map((o) => (
                <li key={o.id}>
                  <b>#{o.id}</b>{" "}
                  {o.hasPos
                    ? `(${o.pos.map((v) => v.toFixed(2)).join(", ")})`
                    : "—"}
                  {o.gainDb !== 0 && ` ${o.gainDb}dB`}
                </li>
              ))}
            </ul>
          </div>
          {errors.length > 0 && (
            <div className="panel errors">
              <h2>日志</h2>
              <ul>
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
