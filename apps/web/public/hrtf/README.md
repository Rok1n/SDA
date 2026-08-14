# 双耳 HRTF 资产（运行时加载）

运行时资产来自 SADIE II D1 KU100（University of York，Apache-2.0）。当前发布集为 schema v2、calibration v3：同一个 KU100 房间和头位，17 个虚拟音箱分别校准参考电平、双耳共同直达能量质心 TOF 和房间 residual；v3 在此基础上做双侧镜像对称化——KU100 头模/摆放的反对称测量偏差会让 VBAP 相干叠加在 +θ 与 -θ 之间产生最高 4.4 dB 的同侧耳能量差（±80°），听感即 7.1.x/9.1.x 左右不平衡。每个镜像对按直达窗相关最优的公共符号 + 公共整数位移对齐后取平均再镜像给两侧，正中方向双耳都给左右平均；每方向只用一个左右共用 sign/shift/标量（不单独动任何一只耳朵），dry 与房间尾声分别恢复电平，ITD/ILD 的方向性结构保留为镜像对均值。

原始档案不会由日常构建联网下载。先取得并校验官方 `D1.zip`，再只构建到 staging：

```bash
pnpm hrtf:build -- --hr tmp/sadie-source/D1.zip --br tmp/sadie-source/D1.zip \
  --hr-path D1_HRIR_WAV/48K_24bit --br-path D1_BRIR_WAV/48K_24bit \
  --out tmp/hrtf-provenance-stage

pnpm hrtf:analyze -- --manifest tmp/hrtf-provenance-stage/hrtf-set.json \
  --archive tmp/sadie-source/D1.zip --out tmp/hrtf-calibration-baseline

pnpm hrtf:calibrate -- --manifest tmp/hrtf-provenance-stage/hrtf-set.json \
  --archive tmp/sadie-source/D1.zip --out tmp/hrtf-calibrated

pnpm hrtf:verify tmp/hrtf-calibrated/hrtf-set.json
```

校准约束：

- 对同一方向左右耳施加相同延时和标量，保留 ITD 与 ILD。
- dry 参考使用完整消声 HRIR 的双耳总能量；17 方向对齐到稳健中位数。
- 共同 TOF 使用共同 onset 粗对齐后的 4 ms 双耳直达能量质心；每方向对 dry 与 room residual 施加同一个整数 fine shift，最终质心离散不超过 1 sample。
- wet 使用目标方向 HRIR 直达路径，并叠加最近实测 BRIR 的校准房间 residual；4–50 ms residual 能量逐音箱对齐到同一稳健中位数。
- 房间校正是左右共用、固定 257 taps 的线性相位 FIR，1/3 倍频程平滑，125 Hz–16 kHz，最大 +/-3 dB。
- 稀疏 BRIR 来源保留在 manifest 中；只有复用同一 BRIR 的非 canonical `+/-60 deg` 房间尾声使用确定性、左右共用的 8 级二阶全通去相关，目标 HRIR 直达路径不变。
- v3 双侧对称化（`sda-ku100-bilateral-v1`）：每镜像对（±30/±60/±100/±110/±140 el0、±45/±90/±135 el45）按直达窗相关最优的公共符号与公共整数位移对齐后取平均，-θ 侧使用镜像；正中方向双耳都给左右平均。对称化后 dry 与房间尾声分别公共缩放回校准目标电平，并再做一次双耳公共整数 shift 把直达能量质心重新对齐；尾声在本方向最终门控边界重新硬门控，wet 直达前缀保持与 dry 逐样本一致。
- 不使用布局专属或节目专属 EQ；5.x、7.x、9.x Group 只是选择同一房间中的不同已校准音箱子集。
- 校准资产禁用运行时逐 IR 总能量归一，Near/Mid/Far 只改变同一校准房间尾声比例。

产物：

- `hrtf-set.json`：采样率、官方档案 hash、源测量路径/坐标、处理参数、逐音箱校准和资产 hash。
- `az*_el*_dry.f32` / `az*_el*_wet.f32`：f32le，`[leftIR][rightIR]` 拼接。

缺失时双耳模式回退浏览器内置 PannerNode HRTF（控制台有警告），不影响播放。
