# AirPods Pro 2 ANC averaged headphone compensation

- Profile id: `airpods-pro-2-anc-averaged`
- Runtime format: raw mono f32le, 4,800 taps at 48,000 Hz per file
- Files: `left.f32` and `right.f32`
- SHA-256 (both files): `44f91e243393f3d79d18b4dca97d3099fcd08cfd884173948d7db2eef02a1a2f`
- Source FIR: AutoEq minimum-phase 48 kHz output for `Apple AirPods Pro 2 (ANC mode)`:
  https://github.com/jaakkopasanen/AutoEq/tree/master/results/crinacle/711%20in-ear/Apple%20AirPods%20Pro%202%20%28ANC%20mode%29
- Measurement provenance: crinacle 711 in-ear measurement as identified by AutoEq.
- Target: AutoEq in-ear target used by the referenced output.
- Processing: the source FIR is normalized once at asset build time using the
  `250Hz..2kHz` inclusive 1Hz-grid power reference `sum(|H(f)|^2/f) / sum(1/f)`.
  The scalar is `1.6936370538` (`+4.576406934 dB`), establishing 0 dB reference
  gain while preserving the FIR's relative magnitude and phase. SDA applies the
  resulting raw FIRs directly to final left/right output with `normalize = false`.
  It adds no profile preamp, recovery, loudness trim, compression, or limiting.
  The normalized FIR peak is `+4.378713 dB @ 5106Hz`; shared binaural output
  calibration and final safety compression remain downstream for every profile.

The source result is an averaged response. SDA intentionally writes identical files
and applies them through two independent final-output convolvers. This is not an
independent left/right correction. Use it only with AirPods Pro 2 in ANC mode; do
not expect it to apply to Off, Transparency, another ear-tip size, another firmware,
or an individual fit. The upstream source FIR is not committed; regenerate these
files with:

```sh
node scripts/build-airpods-pro-2-profile.mjs <autoeq-48khz-minimum-phase.wav> \
  apps/web/public/headphone-compensation/airpods-pro-2-anc-averaged/left.f32 \
  apps/web/public/headphone-compensation/airpods-pro-2-anc-averaged/right.f32
```
