# Beyerdynamic Xelento wired average-measurement profile

This built-in profile is for the first-generation wired Beyerdynamic Xelento.
It is derived from AutoEq's public HypetheSonics result measured on a Bruel &
Kjaer 5128 in-ear fixture, revision
`6c9a097626213b8cbb0973e5a4dd645f5f9e3fd4`:

- Measurement reference: <https://github.com/jaakkopasanen/AutoEq/tree/master/results/HypetheSonics/Bruel%20%26%20Kjaer%205128%20in-ear/Beyerdynamic%20Xelento>
- Target: AutoEq in-ear target.
- Derivation: `scripts/build-beyerdynamic-xelento-wired-average-profile.mjs`
  synthesizes the public 10-band Parametric EQ at 48 kHz into an 8192-tap
  float32 FIR.
- Reference: the resulting FIR is normalized to 0 dB at 1 kHz.
- Integrity: `average.f32` is SHA-256
  `a714ad94c9221211ff72541d15fa546b12de366afa8da85d9e10a6af4c4b3af1`.

## Scope and limits

This profile is not for Xelento 2nd Gen or Xelento Wireless. The source is a
public single/average response, not independent measurements of an individual
IEM's left and right channels. SDA runs the same immutable FIR through two
separate final-output `ConvolverNode` instances, one per output channel. It
preserves channel identity and adds no crossfeed, but is not an L/R balance
calibration and cannot correct unit variation, nozzle insertion depth, tips,
seal, or fit differences.

AutoEq's published Parametric EQ includes a `-6.6 dB` preamp recommendation.
That preamp is deliberately excluded from this FIR and is not installed as a
profile-level output gain. This profile adds no compressor, limiter, loudness
control, or other dynamics processing. SDA's existing binaural makeup and
emergency peak guard retain their own independent behavior.

The FIR is referenced to `0 dB` at 1 kHz, not loudness-matched to the bypass
path. Match A/B listening with the application's master volume; do not
interpret a loudness difference as independent channel attenuation or
compensation failure.
