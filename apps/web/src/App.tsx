import { useCallback, useEffect, useRef, useState } from "react";
import { SdaPlayer, nextSoloMuteSet, type VisualObject } from "@sda/player";
import {
  availableHeadphoneCompensationProfiles,
  registerLocalHeadphoneCompensation,
  type LocalHeadphoneCompensationData,
  LAYOUTS,
  detectLayoutId,
  type LayoutId,
  type OutputMode,
} from "@sda/renderer";
// @ts-ignore — plain JS asset served by Vite
import workletUrl from "@sda/renderer/worklet/sda-renderer.worklet.js?url";
import { ObjectView, type Theme } from "./components/ObjectView";
import { MiniPlayer, type TrackInfo } from "./components/MiniPlayer";

const assetUrl = (path: string): string => new URL(path, document.baseURI).toString();

export function App() {
  const playerRef = useRef<SdaPlayer | null>(null);
  const [playerReady, setPlayerReady] = useState<SdaPlayer | null>(null);
  const [mode, setMode] = useState<OutputMode>("binaural");
  /** "auto" = 按码流内容自动检测（床标签 + 是否有动态对象）。 */
  const [layoutId, setLayoutId] = useState<LayoutId | "auto">("auto");
  /** 自动模式下首帧检测出的布局（用于界面回显 + 3D 视图）。 */
  const [detectedLayout, setDetectedLayout] = useState<LayoutId | null>(null);
  const [theme, setTheme] = useState<Theme>("dark");
  const [track, setTrack] = useState<TrackInfo | null>(null);
  const [objects, setObjects] = useState<VisualObject[]>([]);
  /** 被静音的对象 id（Omniphony Studio 语义：mute 独立切换；
   *  solo = mute 其他全部对象，独奏态由"只剩一个未静音"导出）。 */
  const [mutedIds, setMutedIds] = useState<ReadonlySet<number>>(new Set());
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [debug, setDebug] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  /** 暂停意图的 ref 镜像：player 还在创建中（createPlayer 未 resolve）时按暂停，
   *  playerRef 是空的、pause() 会丢 —— play() 建好 player 后按此补发。 */
  const pausedRef = useRef(false);
  const [volume, setVolume] = useState(1);
  /** null = 不改写 KU100 空间化后的最终双耳信号。 */
  const [headphoneProfileId, setHeadphoneProfileId] = useState<string | null>(null);
  const [headphoneProfiles, setHeadphoneProfiles] = useState(() => availableHeadphoneCompensationProfiles());
  const [profileBusy, setProfileBusy] = useState(false);
  const coverUrlRef = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const lastFileRef = useRef<File | null>(null);
  /** 静音推送回调用的最新对象列表（避免闭包拿旧 state）。 */
  const objectsRef = useRef<VisualObject[]>([]);
  /** 当前文件名，容器没有标题元数据时给 miniplayer 兜底用。 */
  const fileNameRef = useRef<string | null>(null);

  const createPlayer = useCallback(
    async (m: OutputMode, lid: LayoutId | "auto") => {
      await playerRef.current?.dispose();
      const player = new SdaPlayer({
        onTrack: (t) => {
          if (coverUrlRef.current) URL.revokeObjectURL(coverUrlRef.current);
          const coverUrl = t.coverArt
            ? URL.createObjectURL(new Blob([t.coverArt.bytes], { type: t.coverArt.mimeType }))
            : undefined;
          coverUrlRef.current = coverUrl ?? null;
          setTrack({ ...t, coverUrl, title: t.title ?? fileNameRef.current ?? undefined });
        },
        onDecodedFormat: ({ rawBedLabels, bedLabels, objectChannels }) => setTrack((current) => current && { ...current, rawBedLabels, bedLabels, objectChannels }),
        onVisualState: (objs, t) => {
          objectsRef.current = objs;
          setObjects(objs);
          setPosition(t);
          const p = playerRef.current;
          setDuration(p?.durationSeconds() ?? 0);
          setDebug(p ? `#${p.id} 已解码 ${p.durationSeconds().toFixed(1)}s / 播放头 ${t.toFixed(1)}s` : "");
        },
        onError: (m) => setErrors((prev) => [...prev.slice(-19), m]),
        onEnded: () => setPlaying(false),
      });
      if (lid === "auto") {
        // 自动布局：先以 7.1.4 兜底初始化，首帧到达后按码流内容重建渲染器
        await player.init(m, workletUrl, LAYOUTS["7.1.4"], assetUrl("hrtf"), (labels, hasDynamics) => {
          const id = detectLayoutId(labels, hasDynamics);
          setDetectedLayout(id);
          return LAYOUTS[id];
        });
      } else {
        await player.init(m, workletUrl, LAYOUTS[lid]);
      }
      playerRef.current = player;
      setPlayerReady(player);
      return player;
    },
    [],
  );

  useEffect(
    () => () => {
      if (coverUrlRef.current) URL.revokeObjectURL(coverUrlRef.current);
      void playerRef.current?.dispose();
      setPlayerReady(null);
    },
    [],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const desktop = window.sdaDesktop;
    if (!desktop?.listHeadphoneProfiles || !desktop.readHeadphoneProfile) return;
    void desktop.listHeadphoneProfiles()
      .then(async (manifests) => {
        const entries = await Promise.all(manifests.map(async (profile) => {
          const data = await desktop.readHeadphoneProfile!(profile.id);
          return {
            profile: data.profile,
            leftFir: data.leftFir.buffer.slice(data.leftFir.byteOffset, data.leftFir.byteOffset + data.leftFir.byteLength),
            rightFir: data.rightFir.buffer.slice(data.rightFir.byteOffset, data.rightFir.byteOffset + data.rightFir.byteLength),
          } satisfies LocalHeadphoneCompensationData;
        }));
        for (const entry of entries) registerLocalHeadphoneCompensation(entry);
        setHeadphoneProfiles(availableHeadphoneCompensationProfiles());
        localStorage.removeItem("sda-headphone-profile-id");
      })
      .catch((error) => setErrors((prev) => [...prev, `加载本地耳机档案失败: ${String(error)}`]));
  }, []);

  const importHeadphoneProfile = useCallback(async () => {
    const desktop = window.sdaDesktop;
    if (!desktop?.importHeadphoneProfile) return;
    setProfileBusy(true);
    try {
      const data = await desktop.importHeadphoneProfile();
      if (!data) return;
      registerLocalHeadphoneCompensation({
        profile: data.profile,
        leftFir: data.leftFir.buffer.slice(data.leftFir.byteOffset, data.leftFir.byteOffset + data.leftFir.byteLength),
        rightFir: data.rightFir.buffer.slice(data.rightFir.byteOffset, data.rightFir.byteOffset + data.rightFir.byteLength),
      });
      setHeadphoneProfiles(availableHeadphoneCompensationProfiles());
    } catch (error) {
      setErrors((prev) => [...prev, `导入耳机档案失败: ${String(error)}`]);
    } finally {
      setProfileBusy(false);
    }
  }, []);

  /** 动态对象全部静音时，独立的 LFE 床声道也必须一起静音。 */
  const allObjectsMuted = objects.length > 0 && objects.every((object) => mutedIds.has(object.id));
  useEffect(() => {
    playerReady?.setLfeMuted(allObjectsMuted);
  }, [playerReady, allObjectsMuted]);

  // React state and worker frames are asynchronous. Keep the player's durable
  // mute set synchronized whenever either the active player or the UI set changes.
  useEffect(() => {
    playerReady?.syncObjectMutes(mutedIds);
  }, [playerReady, mutedIds]);

  /** 把整组静音状态推到播放器（新建播放器后也要重放一遍）。 */
  const applyMutes = useCallback((muted: ReadonlySet<number>) => {
    const player = playerRef.current;
    console.log(
      `[SDA] applyMutes: 静音集=[${[...muted].join(",")}] 面板对象=[${objectsRef.current
        .map((o) => o.id)
        .join(",")}] player=${player ? `#${player.id}` : "无"}`,
    );
    player?.syncObjectMutes(muted);
  }, []);

  const toggleMute = useCallback(
    (id: number) => {
      const next = new Set(mutedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setMutedIds(next);
      applyMutes(next);
    },
    [mutedIds, applyMutes],
  );

  /** Omniphony Studio 的 solo：不是独立状态，而是"mute 其他全部" —
   *  只剩一个未静音对象时它就是独奏者；再按一次 S 取消（全部解除静音）。 */
  const soloTarget =
    objects.length > 1 && objects.filter((o) => !mutedIds.has(o.id)).length === 1
      ? objects.find((o) => !mutedIds.has(o.id))!.id
      : null;

  const toggleSolo = useCallback(
    (id: number) => {
      const next = nextSoloMuteSet(
        objects.map((object) => object.id),
        mutedIds,
        id,
      );
      setMutedIds(next);
      applyMutes(next);
    },
    [objects, mutedIds, applyMutes],
  );

  const play = useCallback(
    async (file: File) => {
      setErrors([]);
      setTrack(null);
      objectsRef.current = [];
      setObjects([]);
      setPosition(0);
      setDuration(0);
      setDetectedLayout(null);
      setPlaying(true);
      setPaused(false);
      pausedRef.current = false;
      lastFileRef.current = file;
      fileNameRef.current = file.name.replace(/\.[^.]+$/, "");
      try {
        // Always rebuild with the currently selected output mode and layout.
        const player = await createPlayer(mode, layoutId);
        player.setVolume(volume);
        player.setHeadphoneCompensation(headphoneProfileId);
        applyMutes(mutedIds); // 恢复静音/solo 状态（新播放器默认全不静音）
        // 建 player 期间用户已按暂停：补发暂停意图
        if (pausedRef.current) void player.pause();
        await player.playFile(file, "auto");
      } catch (e) {
        setErrors((prev) => [...prev, String(e)]);
        setPlaying(false);
      }
    },
    [createPlayer, mode, layoutId, volume, headphoneProfileId, applyMutes, mutedIds],
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

  /** Demo: harletty 的 1.5s JOC 测试矢量 ×20 拼接（E-AC-3 按同步帧
   *  自同步，拼接即合法长流）→ 30s 15 对象 Atmos 演示。 */
  const playDemo = useCallback(async () => {
    const blob = await (await fetch(assetUrl("demo-joc.ec3"))).blob();
    await play(new File([blob], "demo-joc.ec3"));
  }, [play]);

  /** 播放中 → 暂停；暂停中 → 继续；已播完 → 重播（macOS 播放键行为）。
   *  UI 状态立即切换（乐观更新），不等 suspend/resume 的 promise —
   *  某些环境下这些 promise 不 resolve，会表现为按钮"没反应"。 */
  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (playing && !paused) {
      pausedRef.current = true;
      setPaused(true);
      void player?.pause();
    } else if (paused) {
      pausedRef.current = false;
      setPaused(false);
      void player?.resume();
    } else if (lastFileRef.current) {
      void play(lastFileRef.current);
    }
  }, [playing, paused, play]);

  const changeOutputMode = useCallback((next: OutputMode) => {
    playerRef.current?.setOutputMode(next);
    setMode(next);
  }, []);

  const changeLayout = useCallback((next: LayoutId | "auto") => {
    setLayoutId(next);
    if (next === "auto") {
      playerRef.current?.setAutoLayout();
      return;
    }
    setDetectedLayout(null);
    playerRef.current?.setLayout(LAYOUTS[next]);
  }, []);

  const changeVolume = useCallback((v: number) => {
    setVolume(v);
    playerRef.current?.setVolume(v);
  }, []);

  const changeHeadphoneCompensation = useCallback((id: string) => {
    const next = id || null;
    setHeadphoneProfileId(next);
    if (next) localStorage.setItem("sda-headphone-profile-id", next);
    else localStorage.removeItem("sda-headphone-profile-id");
    playerRef.current?.setHeadphoneCompensation(next);
  }, []);

  const selectedHeadphoneProfile = headphoneProfiles.find((profile) => profile.id === headphoneProfileId) ?? null;

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
          <select value={mode} onChange={(e) => changeOutputMode(e.target.value as OutputMode)}>
            <option value="binaural">双耳 (耳机 HRTF)</option>
            <option value="stereo">立体声</option>
            <option value="multichannel">多声道</option>
          </select>
          <select value={layoutId} onChange={(e) => changeLayout(e.target.value as LayoutId | "auto")}>
            <option value="auto">自动{detectedLayout ? `（${detectedLayout}）` : ""}</option>
            {(Object.keys(LAYOUTS) as LayoutId[]).map((id) => (
              <option key={id} value={id}>
                布局 {id}
              </option>
            ))}
          </select>
          <select
            value={headphoneProfileId ?? ""}
            disabled={mode !== "binaural"}
            title={mode === "binaural" ? "应用经完整性校验的最终双耳 EQ；平均测量档案会明确标注其限制" : "耳机补偿仅用于双耳输出"}
            onChange={(e) => changeHeadphoneCompensation(e.target.value)}
          >
            <option value="">耳机补偿：无</option>
            {headphoneProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>{profile.name}</option>
            ))}
          </select>
          {window.sdaDesktop?.importHeadphoneProfile && (
            <button disabled={profileBusy} onClick={() => void importHeadphoneProfile()} title="导入经 FIR、SHA-256、测量类别和来源证明验证的 profile.json">
              导入耳机档案
            </button>
          )}
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
          <ObjectView objects={objects} layout={LAYOUTS[layoutId === "auto" ? detectedLayout ?? "7.1.4" : layoutId]} theme={theme} mutedIds={mutedIds} />
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
                <dt>原始声道</dt>
                <dd>{track.rawBedLabels?.length ? `${track.rawBedLabels.length} 声道 (${track.rawBedLabels.join(", ")})` : "等待首帧"}</dd>
                <dt>解码床层</dt>
                <dd>{track.bedLabels?.length ? `${track.bedLabels.length} 声道 (${track.bedLabels.join(", ")})` : "等待首帧"}</dd>
                <dt>对象 PCM</dt>
                <dd>{track.objectChannels === undefined ? "等待首帧" : `${track.objectChannels} 路动态对象`}</dd>
                <dt>渲染</dt>
                <dd>{mode === "multichannel"
                  ? `物理 ${layoutId === "auto" ? detectedLayout ?? "7.1.4" : layoutId} → 系统声卡`
                  : `虚拟 ${layoutId === "auto" ? detectedLayout ?? "7.1.4" : layoutId} → ${mode === "binaural" ? "耳机 L/R" : "立体声 L/R"}`}</dd>
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
                <li key={o.id} className={mutedIds.has(o.id) ? "obj-muted" : ""}>
                  <b>#{o.id}</b>{" "}
                  {o.hasPos
                    ? `(${o.pos.map((v) => v.toFixed(2)).join(", ")})`
                    : "—"}
                  {o.gainDb !== 0 && ` ${o.gainDb}dB`}
                  <span className="obj-ms">
                    <button
                      className={`obj-ms-btn ${mutedIds.has(o.id) ? "m-on" : ""}`}
                      title={mutedIds.has(o.id) ? "取消静音" : "静音此对象"}
                      onClick={() => toggleMute(o.id)}
                    >
                      M
                    </button>
                    <button
                      className={`obj-ms-btn ${soloTarget === o.id ? "s-on" : ""}`}
                      title={soloTarget === o.id ? "取消独奏" : "独奏此对象（静音其他全部）"}
                      onClick={() => toggleSolo(o.id)}
                    >
                      S
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {selectedHeadphoneProfile && (
            <div className="panel">
              <h2>耳机补偿</h2>
              <dl>
                <dt>模式</dt>
                <dd>{selectedHeadphoneProfile.measurementMode === "average-dual-mono" ? "平均测量，L/R 同一曲线" : "独立 L/R 测量"}</dd>
                <dt>来源</dt>
                <dd>{selectedHeadphoneProfile.source}</dd>
                {selectedHeadphoneProfile.channelClaim && <><dt>限制</dt><dd>{selectedHeadphoneProfile.channelClaim}</dd></>}
                {selectedHeadphoneProfile.measurementMode === "average-dual-mono" && <><dt>电平参考</dt><dd>1 kHz 频响参考，不与无补偿响度匹配；A/B 比较请用主音量匹配。</dd></>}
              </dl>
            </div>
          )}
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
