# AirPods Pro 2 Local Calibration Profile

SDA does not ship an AirPods Pro 2 average EQ. A profile is accepted only when it contains independently measured left and right correction FIRs.

## Required measurement state

Record all of the following in `profile.json`:

- Exact AirPods Pro 2 revision and serial/revision label.
- ANC, Adaptive Audio, Transparency, and head-tracking state. Use one fixed state for both measurements.
- Ear-tip size, firmware version, and reseat/fit procedure.
- Measurement coupler or ear simulator, microphone calibration, playback sample rate, and target curve.
- Independent raw left/right measurement references and verified channel mapping.
- The balance reference band and the procedure used to validate it.

A laptop microphone, phone microphone, or an averaged third-party graph is not sufficient to create a profile. They cannot measure the response at the eardrum or establish left/right balance for binaural programme material.

## Package layout

Keep these three files together in one directory:

```text
my-airpods-pro-2/
  profile.json
  left.f32
  right.f32
```

`left.f32` and `right.f32` are separate little-endian IEEE-754 float32 mono FIR files. They are correction EQ only: do not include a global volume offset, channel crossfeed, limiter, or compressor. Each file must have a distinct SHA-256 hash.

Validate before importing:

```bash
node scripts/validate-headphone-profile.mjs path/to/profile.json
```

Then use **Import headphone profile** in the Electron desktop app. The app copies the validated package into its application data directory and rechecks both FIR hashes before every load. The browser build intentionally does not access arbitrary local paths.

## Playback behaviour

SDA applies the two FIRs independently after the final KU100 binaural L/R merge. It does not alter HRIR/BRIR assets, object positions, bed/LFE routing, stereo or multichannel output, decoder state, PCM buffers, playback position, the fixed binaural makeup gain, or the shared emergency sample-peak guard.
