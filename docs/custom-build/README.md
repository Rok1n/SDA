# SDA custom Windows build

This workspace adds a System Audio monitor/control application without removing the existing SDA local-file player.

## Current executable capability

- Builds a separate `SDA System Audio` Electron/NSIS executable from the same repository.
- Reuses the SDA renderer speaker-layout semantics and an Omniphony-style 3D room.
- Reads the verified SoundStage shared AirPods head-pose state at `C:\\ProgramData\\SoundStage\\head-tracking-state.bin` when SoundStage is installed and running.
- Displays real yaw/pitch and rotates only the listener model; the 3D inspection camera remains independent.
- Connects to the versioned local named pipe `\\.\\pipe\\SDA.GlobalAudio` when the SDA native global audio bridge is installed.
- Rendering/head-tracking controls remain disabled when the native bridge is absent instead of pretending to control Windows audio.
- Global channel/object dots are shown only from native telemetry. The UI does not invent Atmos object XYZ from a stereo mix.

## GlobalAudio bridge JSON-lines contract (v1 development contract)

Client requests:

```json
{"type":"getStatus","requestId":1,"payload":{}}
{"type":"setRenderingEnabled","requestId":2,"payload":{"enabled":true}}
{"type":"setHeadTrackingEnabled","requestId":3,"payload":{"enabled":true}}
{"type":"recenterHeadTracking","requestId":4,"payload":{}}
```

Server may push:

```json
{"type":"scene","payload":{"renderingEnabled":true,"headTrackingEnabled":true,"layoutId":"7.1","activeStereoStreams":1,"activeMultichannelStreams":1,"objectMetadataAvailable":false,"sources":[]}}
```

The Electron process validates and bounds source arrays before forwarding data to React.

## Production boundary

The repository did not contain a Windows global SDA SFX/APO/driver implementation when this custom work started. A normal-Windows global multichannel implementation still requires the Microsoft-signed native package described in the project plan. The UI intentionally reports the bridge as unavailable until it actually exists.

The current SoundStage AirPods motion path uses SoundStage's existing driver/service. Replacing that dependency with an SDA-owned Microsoft-signed AirPods motion driver is a separate native/signing step.
