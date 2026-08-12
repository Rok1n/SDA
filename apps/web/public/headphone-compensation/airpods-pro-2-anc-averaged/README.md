# AirPods Pro 2 ANC averaged headphone compensation

- Profile id: `airpods-pro-2-anc-averaged`
- Runtime format: raw mono f32le, 4,800 taps at 48,000 Hz per file
- Files: `left.f32` and `right.f32`
- SHA-256 (both files): `00deeb91d3b4807aa9051918925b2843c77208550e24560b3fecf1d32662e2b7`
- Source FIR: AutoEq minimum-phase 48 kHz output for `Apple AirPods Pro 2 (ANC mode)`:
  https://github.com/jaakkopasanen/AutoEq/tree/master/results/crinacle/711%20in-ear/Apple%20AirPods%20Pro%202%20%28ANC%20mode%29
- Measurement provenance: crinacle 711 in-ear measurement as identified by AutoEq.
- Target: AutoEq in-ear target used by the referenced output.
- Processing: SDA applies these raw FIRs directly to the final left/right binaural
  output with `normalize = false`. It does not add profile preamp, recovery,
  loudness trim, compression, or limiting. The shared binaural output calibration
  and final safety compressor remain downstream for every binaural profile.

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
