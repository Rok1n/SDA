# AirPods motion interoperability

`native/windows/SdaAirPodsBridge` is an SDA-owned interoperability helper. It is designed to talk to the already-installed SoundStage AACP profile driver and independently emits JSON-line AirPods head-pose telemetry.

Reference behavior was verified against `capriqqw/soundstage-for-airpods` at commit `114143c27670275a5ef6336b91047d84b8a16eb5`, especially its public description of the AAP/AACP transport, head-tracking parser and driver protocol. The SDA helper is structured separately and does not port SoundStage's stereo spatializer policy.

Important product boundary:

- SoundStage's current public KMDF driver is test-signed.
- This compatibility helper is immediately useful on a machine where that driver is already installed and working.
- The final SDA production design must replace that dependency with an SDA-owned Microsoft-signed AirPods AAP/AACP profile driver so Secure Boot can remain enabled and Test Mode can remain disabled.
- The audio architecture remains SDA-specific: stereo bypass, supported multichannel binaural rendering, head pose applied only to processed multichannel content.

The protocol byte sequences and Windows driver interface identifiers are used for interoperability with an installed implementation. Do not reuse the SoundStage driver as the final SDA production identity.
