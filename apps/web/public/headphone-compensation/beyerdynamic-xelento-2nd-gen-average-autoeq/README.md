# Beyerdynamic Xelento 2nd Gen wired average-measurement profile

This built-in profile is for the wired Beyerdynamic Xelento 2nd Gen. It is
derived from AutoEq's public HypetheSonics result measured on a GRAS RA0045
in-ear fixture, revision `6c9a097626213b8cbb0973e5a4dd645f5f9e3fd4`:

- Measurement reference: <https://github.com/jaakkopasanen/AutoEq/tree/master/results/HypetheSonics/GRAS%20RA0045%20in-ear/Beyerdynamic%20Xelento%20%282nd%20Gen%29>
- Target: AutoEq in-ear target.
- Derivation: `scripts/build-beyerdynamic-xelento-2nd-gen-average-profile.mjs`
  synthesizes the public 10-band Parametric EQ at 48 kHz into an 8192-tap
  float32 FIR.
- Reference: the resulting FIR is normalized to 0 dB at 1 kHz.
- Integrity: `average.f32` is SHA-256
  `ccecb61b4eab79aaa2aeb73a9f8daa97bc6bae37c544a2d6e81ae144dc9b6d29`.

## Scope and limits

This profile is not for the first-generation Xelento or Xelento Wireless. The
source is a public single/average response, not independent measurements of an
individual IEM's left and right channels. SDA runs the same immutable FIR
through two separate final-output `ConvolverNode` instances, one per output
channel. It preserves channel identity and adds no crossfeed, but is not an
L/R balance calibration and cannot correct unit variation, nozzle insertion
depth, tips, seal, or fit differences.

AutoEq's published Parametric EQ includes a `-6.3 dB` preamp recommendation.
That preamp is deliberately excluded from this FIR and is not installed as a
profile-level output gain. This profile adds no compressor, limiter, loudness
control, or other dynamics processing. SDA's existing binaural makeup and
emergency peak guard retain their own independent behavior.

The FIR is referenced to `0 dB` at 1 kHz, not loudness-matched to the bypass
path. Match A/B listening with the application's master volume; do not
interpret a loudness difference as independent channel attenuation or
compensation failure.
