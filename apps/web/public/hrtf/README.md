# 双耳 HRTF 资产（运行时加载）

本目录由 `pnpm hrtf:build` 生成（数据源：SADIE II D1 KU100，University of York，Apache-2.0）：

```bash
pnpm hrtf:build -- --hr <HRIR zip路径或URL> --br <BRIR zip路径或URL>
```

产物：

- `hrtf-set.json` —— 清单：采样率 + 每个音箱方向的 dry(HRIR)/wet(BRIR) 文件对
- `az*_el*_dry.f32` / `az*_el*_wet.f32` —— f32le，`[leftIR][rightIR]` 拼接

缺失时双耳模式回退浏览器内置 PannerNode HRTF（控制台有警告），不影响播放。
生成后总共约 1 MB，可随仓库提交。
