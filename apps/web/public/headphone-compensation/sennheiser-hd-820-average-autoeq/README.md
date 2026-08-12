# Sennheiser HD 820 average-measurement profile

This built-in profile is derived from AutoEq's public HypetheSonics over-ear
result for Sennheiser HD 820, revision
`7ae0f56d53074872b028649617a22bbb4232feb7`:

- Measurement reference: <https://github.com/jaakkopasanen/AutoEq/tree/7ae0f56d53074872b028649617a22bbb4232feb7/results/HypetheSonics/over-ear/Sennheiser%20HD%20820>
- Target: AutoEq over-ear target.
- Derivation: `scripts/build-sennheiser-hd-820-average-profile.mjs` synthesizes
  the public 10-band Parametric EQ at 48 kHz into an 8192-tap float32 FIR.
- Reference: the resulting FIR is normalized to 0 dB at 1 kHz.
- Integrity: `average.f32` is SHA-256
  `bb8cfeda1590571e49779512fff804c4671c3eb4d98fa5a598972434539a3440`.

## Scope and limits

This profile is for HD 820 only, not HD 800 or HD 800 S. The source is a public
single/average response, not independent measurements of an individual
headphone's left and right drivers. SDA runs the same immutable FIR through two
separate final-output `ConvolverNode` instances, one per output channel. It
preserves channel identity and adds no crossfeed, but is not an L/R balance
calibration and cannot correct unit variation, pad wear, seal, or fit
differences.

AutoEq's published Parametric EQ includes a `-6.4 dB` preamp recommendation.
That preamp is deliberately excluded from this FIR and is not installed as a
profile-level output gain. This profile adds no compressor, limiter, loudness
control, or other dynamics processing. SDA's existing binaural makeup and
emergency peak guard retain their own independent behavior.

The FIR is referenced to `0 dB` at 1 kHz, not loudness-matched to the bypass
path. Match A/B listening with the application's master volume; do not
interpret a loudness difference as independent channel attenuation or
compensation failure.
