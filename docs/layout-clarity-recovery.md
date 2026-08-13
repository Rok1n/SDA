# 7.x / 9.x 双耳模糊自主修复

## 目标

修复 calibration v1 发布后 7.x 与 9.x 双耳布局相对 5.x 发糊的问题，同时保留：

- 对象/床层 -> 虚拟音箱 -> VBAP -> KU100 HRIR/BRIR -> 耳机 L/R；
- 5.x、7.x、9.x 手动布局与各自合理的宽度、包围和定位差异；
- 同一个房间、同一个 KU100 头位；
- 每个虚拟音箱的方向性 ILD、ITD、耳廓频谱和房间反射；
- calibration v1 的可审计来源、hash 和 staging 发布流程。

不针对 `01. KiLLKiSS.m4a` 写歌曲 EQ。该文件只作为真实 5.1-core + 15-object JOC 回归输入；修复必须同时通过独立合成对象场。

## 复现与诊断

1. 无损提取并解码 `C:/Users/legendshop/Downloads/01. KiLLKiSS.m4a` 的 E-AC-3 JOC presentation。
2. 对相同 PCM、OAMD 事件和时间轴离线渲染 5.1.4、7.1.4、9.1.4，匹配运行时 VBAP、每源增益、Near 校准 IR、双耳汇总和 linked limiter 前信号。
3. 对每个布局报告：
   - 宽带、20–250 Hz、250 Hz–4 kHz、4–20 kHz能量；
   - 1/3 倍频程差异、谱质心和低中/高频比；
   - 左右相关、短时相关和相干峰值；
   - 直达、2–20 ms、20–50 ms、50 ms 后能量；
   - C50/C80、瞬态峰均比和 limiter 预计增益衰减；
   - 布局切换前后对象轨迹的音色阶跃。
4. 分别隔离 dry HRIR、原始 room tail、房间校正 FIR、共同 TOF、逐音箱电平和 Wide/Surround 路由，确定模糊由哪一层引入。

## 修复边界

- 不增加布局专属或节目专属 EQ/固定增益。
- 不对每方向 HRTF 拉平，不分别对齐左右耳，不抹掉 ITD/ILD。
- 不改成每对象直接 HRTF，不删除虚拟音箱层。
- 如果稀疏 BRIR 被多个目标方向复用导致相干尾声叠加，必须在房间分量内用固定、确定、全布局一致的去相关/插值策略修复，并保留目标 HRIR 直达路径。
- 如果共同 TOF 或运行时归一破坏多音箱 VBAP 相干性，修复校准定义或运行时实现，而不是补偿 7.x/9.x 输出。
- 所有资产先写 `tmp` staging，自动验收通过后才替换 `apps/web/public/hrtf`。

## 自动验收

- 17 方向资产契约、SHA-256、finite、tap 数和 provenance 通过。
- 双耳共同到达离散不超过 0.1 ms；目标 HRIR ITD 误差不超过 1 sample。
- 500–2000 Hz 直达参考电平逐方向离散不超过 1 dB；逐音箱修正不超过 +/-3 dB。
- 同一去相关 15-object 合成场下，5.1.4/7.1.4/9.1.4：
  - 宽带差异不超过 0.5 dB；
  - 低/中/高频共同偏差不超过 1 dB；
  - 不允许 7.x/9.x 的早期/晚期比或短时相关系统性恶化。
- `KiLLKiSS.m4a` 的 7.1.4/9.1.4 相对 5.1.4 不得出现系统性低中频堆积、谱质心下降、瞬态峰均比下降或 limiter 工作量显著增加。
- Near/Mid/Far 分别通过；Near 必须保持清晰直达，Far 可增加房间感但不能由布局数量决定浑浊程度。
- renderer/player/demux 类型检查、DBMD、VBAP、布局切换、PCM 连续性、limiter、HRTF 契约和 Web 生产构建通过。

## 校准 v2 结论

根因不是某首歌或某个布局需要 EQ，而是 calibration v1 的阈值 onset TOF 不足以代表多音箱叠加时的直达能量时间中心；此外 `+/-30 deg` 与 `+/-60 deg` 复用稀疏 BRIR，使 9.x 新增前宽时重复的房间尾声高度相干。

calibration v2 做以下全方向、全节目一致的修正：

- 直达参考改为完整消声 HRIR 的双耳总能量，左右耳只使用共同标量；
- 共同 onset 只作为粗对齐，最终 TOF 使用 4 ms 双耳直达能量质心，dry 与 room residual 使用同一个整数 fine shift；
- 4–50 ms room residual 能量逐虚拟音箱对齐到同一稳健中位数；
- 只有复用同一 BRIR 的非 canonical `+/-60 deg` room tail 使用左右共用、确定性的 8 级二阶全通去相关；不处理目标 HRIR 直达，不改变每个布局的 VBAP 或 EQ；
- manifest 记录 coarse shift、质心 before/target/fine shift/after、总 delay、full-HRIR 能量、residual 能量、全通参数与前后 C50/C80/总能量。

正式 staging 结果：

- 17 方向直达能量质心 `169.66..170.52 samples`，离散小于 1 sample；
- full-HRIR 双耳总能量目标 `0.338 dB`，逐方向数值精度内一致；
- 4–50 ms room residual 目标 `-8.614 dB`，全方向输出离散 `0.056 dB`；
- variant 去相关 C50/C80 最大变化 `0.284 dB`，总能量最大变化 `0.003 dB`；
- 相同输入和 manifest 的 35 个 staging 文件确定性重建逐字节一致。

15-object 独立合成场在 Near/Mid/Far 下均通过：5/7/9 Group 宽带最大离散 `0.23 dB`，低/中/高最大离散分别 `0.40/0.62/0.14 dB`。

`01. KiLLKiSS.m4a` 55–70 秒真实 JOC 段只作为回归输入。相对 5.1.4：

| 布局 | 宽带 | 低频 | 中频 | 高频 | Crest | limiter 平均衰减差 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 7.1.4 | -0.05 dB | -0.03 dB | -0.11 dB | +0.46 dB | +0.07 dB | +0.0016 dB |
| 9.1.4 | -0.25 dB | -0.71 dB | +0.41 dB | +0.94 dB | +0.21 dB | -0.0048 dB |

三频带和宽带均进入既定门禁，crest 未下降，limiter 没有因音箱数量系统性增加工作量。没有加入歌曲专属或布局专属参数。

## 发布

完成修复后：

1. 发布通过验收的资产/代码；
2. 重建 `apps/web/dist`；
3. 确认 `4173` 提供新 manifest/hash；
4. 重启 Electron；
5. 留下基线、修复后报告和全部命令结果。
