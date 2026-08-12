# Sony MDR-7506 average-measurement profile

This built-in profile is derived from the public AutoEq `Super Review` result for
Sony MDR-7506, revision `36b1afcdf161c8a52b5093daefbbd335272508f3`:

- Measurement reference: <https://github.com/jaakkopasanen/AutoEq/tree/master/results/Super%20Review/over-ear/Sony%20MDR-7506>
- Target: AutoEq Harman over-ear target.
- Derivation: `scripts/build-sony-mdr-7506-average-profile.mjs` synthesizes the
  public 10-band Parametric EQ at 48 kHz into an 8192-tap float32 FIR.
- Reference: the resulting FIR is normalized to 0 dB at 1 kHz.
- Integrity: `average.f32` is SHA-256
  `f50ff5e89cc7e3a535543f661edb8a17976cc80025b746ce6882b77e186148f8`.

## Scope and limits

The source is a public single/average response, not independent measurements of
an individual headphone's left and right drivers. SDA runs the same immutable
FIR through two separate final-output `ConvolverNode` instances, one per output
channel. It preserves channel identity and adds no crossfeed, but it is not an
L/R balance calibration and cannot correct unit variation, pad wear, seal, or
fit differences.

AutoEq's published Parametric EQ includes a `-4.1 dB` preamp recommendation.
That preamp is deliberately excluded from this FIR and is not installed as a
profile-level output gain. This profile adds no compressor, limiter, loudness
control, or other dynamics processing. SDA's existing binaural makeup and
emergency peak guard retain their own independent behavior.

The FIR is referenced to `0 dB` at 1 kHz, not loudness-matched to the bypass
path. Its low-frequency boosts and presence-band cuts can make some music or
speech sound quieter than bypass at the same master-volume setting. Match A/B
listening with the application's master volume; do not interpret the difference
as independent channel attenuation or compensation failure.
