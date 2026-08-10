# SDA — Spatial Decoder App

把 [harletty-bridge](https://github.com/harletty/harletty-bridge) 的
Dolby TrueHD / E-AC-3(Atmos JOC) / DTS 解码器带到网页、桌面和移动端：
解码出**每对象 PCM + 3D 空间元数据**，用 VBAP + HRTF 双耳渲染到耳机，
或多声道渲染到音箱，并实时可视化每个声音对象的运动（对标
Omniphony Studio 的 3D 视图）。

```
文件 (.mkv/.mp4/.thd/.ec3/.dts)
   │  @sda/demux    解封装 → 访问单元 (AU)
   ▼
@sda/core (Rust→WASM, harletty 解码 crate)
   │  解码 → 平面 PCM (bed + 每对象一路) + 对象事件 {位置,增益,size,ramp}
   ▼
@sda/renderer (Web Audio AudioWorklet)
   │  VBAP 3D → N 条虚拟扬声器总线 →
   │    双耳: BRIR 卷积 (KEMAR) / PannerNode HRTF 降级
   │    多声道: 直通音箱 | 立体声: 下混
   ▼
@sda/player  调度（worker 解码、ring buffer、元数据时间轴）
   │
   ▼  React UI + three.js 3D 对象视图
```

## 目录

| 路径 | 说明 |
|---|---|
| `packages/core` | Rust→WASM 解码核心（truehd/eac3/dca crate 来自 harletty-bridge） |
| `packages/demux` | MKV (EBML) / MP4 流式解封装 |
| `packages/renderer` | VBAP 3D panning + AudioWorklet 混音 + 双耳/多声道输出 |
| `packages/player` | 解码 worker + 播放调度 + 可视化状态 |
| `apps/web` | 网页版（Vite + React + TS + three.js） |
| `apps/desktop` | 桌面版（Electron，复用 web 构建产物） |
| `apps/mobile` | 手机版（Expo；解码走原生模块，见 docs） |
| `harletty-bridge` | 上游解码器仓库（clone/submodule） |
| `Omniphony` | 上游渲染器仓库（参考实现，含 BINAURAL.md） |
| `docs/binaural-rendering.md` | 双耳渲染设计（Dolby/Apple 官方调研） |
| `docs/mobile-native-module.md` | Expo 原生模块设计 |

## 新电脑从零开始（完整搭建指南）

本项目**没有后端**，所有解码在浏览器/本机完成（Rust 解码器编译成 WASM）。
只需一次性装好工具链即可正常开发。

### 1. 安装工具链

| 工具 | 版本要求 | 安装 |
|---|---|---|
| Node.js | ≥ 20（开发用 24） | https://nodejs.org |
| pnpm | ≥ 9 | `npm install -g pnpm`（或 `corepack enable && corepack prepare pnpm@latest --activate`） |
| Rust | 稳定版（开发用 1.96） | https://rustup.rs 一键安装 |
| wasm target | — | `rustup target add wasm32-unknown-unknown` |
| wasm-bindgen-cli | **必须 = 0.2.127**（与 `packages/core/Cargo.lock` 一致） | `cargo install wasm-bindgen-cli --version 0.2.127` |

> wasm-bindgen-cli 版本和 Cargo.lock 里的 wasm-bindgen crate 不一致会报错；
> 若升级了 crate，重新 `cargo install wasm-bindgen-cli --version <新版本>`。

### 2. 拿代码

本项目是 git 仓库（https://github.com/fengluoxiao/SDA），`harletty-bridge` 以
**git submodule** 形式挂在仓库里（fork 自上游，锁定在 `fcf1c00`，
地址 https://github.com/fengluoxiao/harletty-bridge），克隆时一条命令一起拉下来：

```bash
# 克隆主项目 + 自动克隆 harletty-bridge（必须带 --recurse-submodules）
git clone --recurse-submodules https://github.com/fengluoxiao/SDA.git SDA

# 如果已经克隆了但没带子模块，补拉：
git submodule update --init --recursive
```

`Omniphony`（~24 MB）是上游渲染器参考实现，只在文档/注释里提及，
构建和运行都不依赖，**没有纳入仓库**，不需要拷。

> WASM 产物（`packages/core/pkg-web`、`pkg-node`）不入库，克隆后需要
> 按第 1 步装好 Rust 工具链，再执行第 4 步 `pnpm core:build` 生成。

### 3. 安装依赖

```bash
pnpm install
```

### 4. 构建 WASM 解码核心（仅当没有 pkg-web/pkg-node 时）

```bash
pnpm core:build        # cargo build --target wasm32 + wasm-bindgen → pkg-web(浏览器) / pkg-node(测试)
```

可选验证：`cd packages/core && pnpm test`（用 harletty-bridge 仓库里的 JOC 测试向量冒烟）。

### 5. 日常使用

```bash
# 网页版开发（热更新）
pnpm web:dev                 # http://localhost:5173

# 网页版生产构建 + 本地预览
pnpm web:build               # 产物在 apps/web/dist
cd apps/web && npx vite preview   # http://localhost:4173

# 桌面版（Electron，复用 web 产物）
pnpm web:build && pnpm desktop:dev

# 手机版（Expo 壳）
pnpm mobile:start
```

### 6. 打包桌面安装包（Windows）

```bash
cd apps/desktop

# 国内网络先设 Electron 下载镜像（否则 GitHub 下不动）
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

# 先构建 web 产物再打包
pnpm --filter @sda/web build
npx electron-builder --win nsis
```

产物在 `apps/desktop/dist/`：

- `SDA Setup x.y.z.exe` —— NSIS 安装包（推荐分发）
- `win-unpacked/` —— 免安装绿色版，直接运行里面的 `SDA.exe`

**注意：不要设 `ELECTRON_BUILDER_BINARIES_MIRROR`**。electron-builder 每次运行都会
重新下载 winCodeSign 工具包，其中包含 macOS 的 `.dylib` 符号链接，Windows 无
开发者模式/管理员权限时 7zip 解压必然报「客户端没有所需的特权」。已在
`apps/desktop/package.json` 里设了 `win.signAndEditExecutable: false` 跳过该步骤
（代价：exe 用 Electron 默认图标、无数字签名）。要加图标/签名时，需开启
Windows「开发者模式」后去掉该选项再配 `win.icon` / 证书。

用法：拖入含 TrueHD/Atmos 或 E-AC-3 JOC 音轨的 `.mkv`（或裸 `.thd`/`.ec3`/`.dts`），
主视图是实时 3D 对象位置，底栏是迷你播放器（暂停/重播/音量），
顶栏可切换输出模式（双耳/立体声/多声道）、音箱布局（5.1 ~ 9.1.6）和深浅色主题。

### 常见问题

- **端口被占用**：5173 是 dev server（热更新），4173 是 preview（需先 build）。
  两者可以同时存在，注意别看错标签页。
- **改了 Rust 解码代码**：重新 `pnpm core:build` 再刷新页面。
- **改了 TS/React 代码**：dev server 自动热更新；preview 需要重新 `pnpm web:build`。
- **worklet 改了不生效**：`packages/renderer/worklet/*.js` 是静态资源，
  build 后浏览器可能缓存，强制刷新（Ctrl+F5）。

## 构建与运行（简版）

前置：Rust (+ `wasm32-unknown-unknown` target)、wasm-bindgen-cli、Node ≥ 20、pnpm。

```bash
# 1. 构建 wasm 解码核心（pkg-web + pkg-node）
pnpm core:build          # = node scripts/build-core.mjs

# 2. 验证解码（Node 冒烟测试，用 harletty 仓库的 JOC 测试向量）
cd packages/core && pnpm test

# 3. 安装依赖 & 启动网页版
pnpm install
pnpm web:dev             # http://localhost:5173

# 4. 桌面版
pnpm --filter @sda/web build
pnpm desktop:dev         # 或 SDA_DEV_URL 指向 vite dev server

# 5. 手机版（UI 壳；原生解码模块见 docs/mobile-native-module.md）
pnpm mobile:start
```

用法：拖入含 TrueHD/Atmos 或 E-AC-3 JOC 音轨的 `.mkv`（或裸 `.thd`/`.ec3`），
右侧看到对象列表和码流信息，主视图是实时 3D 对象位置。
输出模式：双耳（耳机）/ 立体声 / 多声道。

## 关键技术决策

- **解码器不重写**：harletty 的三个纯 Rust 解码 crate 直接编到 wasm
  （已验证：JOC 测试向量解出 5.1 bed + 15 对象 + 15 条空间事件）；
  移动端同一份 Rust 编静态库。
- **bridge ABI 不搬**：`bridge/` 是 Omniphony 私有 ABI 的胶水，网页版用
  干净的 `push(bytes) → nextFrame()` 接口重写（事件模型对齐
  `bridge_api::REvent`，坐标为 ADM 笛卡尔）。
- **渲染器自研**：Omniphony 的 VBAP 渲染不在 harletty 仓库，按其
  `BINAURAL.md` 与 EBU BEAR 的架构（虚拟扬声器 + BRIR 卷积）重写。
- **坐标系**：事件流是 ADM 约定（x+左, y+前, z+上），Web Audio/three.js
  是右手系（x+右, y+上, z+朝听者），转换集中在 `renderer/src/coords.ts`。

## 许可

解码 crate 上游为 Apache-2.0（truehdd 项目及 harletty-bridge），
本仓库代码同 Apache-2.0。Dolby/DTS 商标与相关专利归各自所有者；
本项目是解码与渲染技术研究，不提供任何受版权保护的测试内容。
MIT KEMAR HRTF 数据集 "free with no restrictions on use"（需引用）。
