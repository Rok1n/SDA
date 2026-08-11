//! E-AC-3 (incl. JOC/Atmos) streaming pipeline — a WASM-facing port of
//! harletty-bridge's `bridge/src/eac3_pipeline.rs`, minus the Omniphony ABI.
//!
//! Strategy per access unit (same as the bridge): try the object decoder
//! first (JOC + OAMD), fall back to the plain core PCM decoder.

use std::collections::VecDeque;

use eac3::{BedChannel, CorePcmFrame, OamdElementKind, OamdPayload, ObjectPcmPushResult};

use crate::{FrameData, ObjectChannelDecl, ObjectEvent, Pipeline};

pub struct Eac3Pipeline {
    extractor: eac3::Extractor,
    object_decoder: eac3::ObjectPcmDecoder,
    pcm_decoder: eac3::PcmDecoder,
    total_samples: u64,
    declared: Option<Vec<ObjectChannelDecl>>,
}

impl Eac3Pipeline {
    pub fn new() -> Self {
        Self {
            extractor: eac3::Extractor::default(),
            object_decoder: eac3::ObjectPcmDecoder::new(),
            pcm_decoder: eac3::PcmDecoder::new(),
            total_samples: 0,
            declared: None,
        }
    }

    fn process_frame(
        &mut self,
        frame: &[u8],
        out: &mut VecDeque<FrameData>,
        errors: &mut Vec<String>,
    ) {
        match self.object_decoder.push_access_unit(frame) {
            Ok(Some(result)) => {
                out.push_back(self.build_object_frame(result));
                return;
            }
            Ok(None) => {}
            Err(_) => {}
        }

        match self.pcm_decoder.push_access_unit(frame) {
            Ok(result) => {
                let pcm = result.pcm;
                let sample_pos = self.total_samples;
                self.total_samples += pcm.samples_per_channel() as u64;
                out.push_back(bed_frame(
                    "eac3",
                    pcm,
                    Vec::new(),
                    Vec::new(),
                    sample_pos,
                    &[],
                ));
            }
            Err(e) => {
                // Legacy AC-3 and other rejects: surfaced, playback continues.
                errors.push(format!("E-AC-3 frame rejected: {e}"));
            }
        }
    }

    fn build_object_frame(&mut self, result: ObjectPcmPushResult) -> FrameData {
        let pcm = result.pcm;
        let sample_pos = self.total_samples;
        self.total_samples += pcm.samples_per_channel() as u64;

        let core = pcm.core;
        let object_count = pcm.object_channels.len();
        let Some((oamd, _)) = pcm.oamd_payloads.first() else {
            // JOC without OAMD has no provable object-id/channel mapping.
            // Keep the decoded core as a fixed bed instead of routing audio to
            // guessed moving objects.
            let object_channels = self.sparse_declare(Vec::new());
            return bed_frame("eac3", core, Vec::new(), object_channels, sample_pos, &[]);
        };

        // Pure-bed JOC is a separate presentation: reconstructed slots are bed
        // channels, not Obj_* sources. The core fullband is not emitted here;
        // JOC reconstructs the non-LFE bed members and the core carries LFE.
        if oamd.dynamic_objects == 0 {
            let Some(bed_labels) = pure_bed_labels(oamd, object_count) else {
                let object_channels = self.sparse_declare(Vec::new());
                return bed_frame("eac3", core, Vec::new(), object_channels, sample_pos, &[]);
            };
            let mut channels = Vec::new();
            let mut labels = Vec::new();
            if let Some(lfe) = &core.lfe_channel {
                channels.push(lfe.clone());
                labels.push("LFE".to_string());
            }
            for (obj, label) in pcm.object_channels.iter().zip(bed_labels) {
                channels.push(obj.clone());
                labels.push(format!("{label:?}"));
            }
            let object_channels = self.sparse_declare(Vec::new());
            return FrameData {
                codec: "eac3",
                sample_rate: core.sample_rate,
                sample_pos,
                channels,
                labels,
                ramp_duration: 0,
                events: Vec::new(),
                object_channels,
            };
        }

        let Some(dynamic_range) = dynamic_object_range(oamd, object_count) else {
            // A malformed or incomplete OAMD/JOC object table must not be
            // partially mapped: a partial map can bind speech to another
            // object's trajectory. Fall back to the fixed core bed.
            let object_channels = self.sparse_declare(Vec::new());
            return bed_frame("eac3", core, Vec::new(), object_channels, sample_pos, &[]);
        };
        let dynamics = dynamic_range.len();

        // JOC output is dynamic-only: slot j corresponds to OAMD object
        // bed_or_isf_objects + j. A presentation with bed/ISF members must keep
        // the core fullband bed; only B=0 is the duplicate-free all-object path.
        let full_dynamic = oamd.bed_or_isf_objects == 0;
        let mut channels: Vec<Vec<f32>> = if full_dynamic {
            Vec::new()
        } else {
            core.fullband_channels.clone()
        };
        let mut labels: Vec<String> = if full_dynamic {
            Vec::new()
        } else {
            core.fullband_channel_order
                .iter()
                .map(|b| format!("{b:?}"))
                .collect()
        };
        if let Some(lfe) = &core.lfe_channel {
            channels.push(lfe.clone());
            labels.push("LFE".to_string());
        }
        let obj_channel_base = channels.len();
        for (dynamic_idx, obj) in pcm.object_channels.iter().enumerate() {
            channels.push(obj.clone());
            labels.push(format!("Obj_{}", 10 + dynamic_idx));
        }

        let events = extract_events(oamd, sample_pos, dynamics);
        let decl = dynamic_object_declarations(dynamic_range, obj_channel_base);
        let object_channels = self.sparse_declare(decl);

        FrameData {
            codec: "eac3",
            sample_rate: core.sample_rate,
            sample_pos,
            channels,
            labels,
            ramp_duration: events.first().map_or(0, |e| e.ramp_duration),
            events,
            object_channels,
        }
    }

    /// Emit the object↔channel declaration only when it changed (bridge parity).
    fn sparse_declare(&mut self, current: Vec<ObjectChannelDecl>) -> Vec<ObjectChannelDecl> {
        if self.declared.as_ref() == Some(&current) {
            Vec::new()
        } else {
            self.declared = Some(current.clone());
            current
        }
    }
}

impl Pipeline for Eac3Pipeline {
    fn codec_name(&self) -> &'static str {
        "eac3"
    }

    fn push(&mut self, data: &[u8], out: &mut VecDeque<FrameData>, errors: &mut Vec<String>) {
        self.extractor.push_bytes(data);
        loop {
            match self.extractor.next_frame() {
                Ok(Some(frame)) => self.process_frame(frame.as_bytes(), out, errors),
                Ok(None) => break,
                Err(e) => {
                    errors.push(format!("E-AC-3 extract error: {e:?}"));
                    break;
                }
            }
        }
    }

    fn reset(&mut self) {
        *self = Self::new();
    }
}

fn dynamic_object_range(
    oamd: &OamdPayload,
    object_channel_count: usize,
) -> Option<std::ops::Range<usize>> {
    // JOC exposes only dynamic slots. OAMD keeps the complete object table, so
    // its dynamic suffix must have exactly the same length as the JOC output.
    let dynamic_count = oamd.object_count.saturating_sub(oamd.bed_or_isf_objects);
    (oamd.dynamic_objects == dynamic_count && dynamic_count == object_channel_count)
        .then_some(0..dynamic_count)
}

fn dynamic_object_count(oamd: &OamdPayload, object_channel_count: usize) -> usize {
    dynamic_object_range(oamd, object_channel_count).map_or(0, |range| range.len())
}

fn pure_bed_labels(oamd: &OamdPayload, object_channel_count: usize) -> Option<Vec<BedChannel>> {
    if oamd.dynamic_objects != 0 || oamd.object_count != oamd.bed_or_isf_objects {
        return None;
    }
    let labels: Vec<BedChannel> = oamd
        .bed_assignment
        .iter()
        .flatten()
        .copied()
        .filter(|channel| {
            !matches!(
                channel,
                BedChannel::LowFrequencyEffects | BedChannel::LowFrequencyEffects2
            )
        })
        .collect();
    (labels.len() == object_channel_count).then_some(labels)
}

fn dynamic_object_declarations(
    dynamic_range: std::ops::Range<usize>,
    object_channel_base: usize,
) -> Vec<ObjectChannelDecl> {
    dynamic_range
        .enumerate()
        .map(|(dynamic_idx, _slot)| ObjectChannelDecl {
            id: (10 + dynamic_idx) as u32,
            channel: (object_channel_base + dynamic_idx) as u32,
        })
        .collect()
}

/// Port of `bridge/src/metadata.rs::extract_eac3_events`.
fn extract_events(
    oamd: &OamdPayload,
    base_sample_pos: u64,
    object_channel_count: usize,
) -> Vec<ObjectEvent> {
    let dynamic_objects = dynamic_object_count(oamd, object_channel_count);
    let mut events = Vec::with_capacity(dynamic_objects);

    for element in &oamd.elements {
        let OamdElementKind::Object(ref obj_element) = element.kind else {
            continue;
        };

        for obj_idx in 0..obj_element.object_blocks.len() {
            let Some(blocks) = obj_element.object_blocks.get(obj_idx) else {
                continue;
            };
            let Some(block) = blocks.first() else {
                continue;
            };
            if obj_idx < oamd.bed_or_isf_objects {
                continue;
            }
            let dynamic_idx = obj_idx - oamd.bed_or_isf_objects;
            if dynamic_idx >= object_channel_count {
                continue;
            }

            let id = (10 + dynamic_idx) as u32;
            let has_pos = block.valid_position;
            let pos: [f64; 3] = if has_pos {
                match block.position.as_ref() {
                    // Absolute position: x,y ∈ [0,1] → ADM [-1,1], z ∈ [-1,1].
                    Some(p) if !block.differential_position => [
                        ((p.x as f64).clamp(0.0, 1.0) - 0.5) * 2.0,
                        (0.5 - (p.y as f64).clamp(0.0, 1.0)) * 2.0,
                        (p.z as f64).clamp(-1.0, 1.0),
                    ],
                    Some(p) => [
                        (p.x as f64).clamp(-1.0, 1.0),
                        (-(p.y as f64)).clamp(-1.0, 1.0),
                        (p.z as f64).clamp(-1.0, 1.0),
                    ],
                    None => [0.0; 3],
                }
            } else {
                [0.0; 3]
            };
            let size: [f64; 3] = block
                .size
                .map(|s| [s[0] as f64, s[1] as f64, s[2] as f64])
                .unwrap_or([0.0, 0.0, 0.0]);

            let sample_offset = obj_element
                .block_updates
                .first()
                .map(|u| u.offset as u64)
                .unwrap_or(0);
            let ramp_duration = obj_element
                .block_updates
                .first()
                .map(|u| u.ramp_duration as u32)
                .unwrap_or(0);

            events.push(ObjectEvent {
                id,
                sample_pos: base_sample_pos + sample_offset,
                has_pos,
                pos,
                gain_db: block.gain.unwrap_or(0.0) as i8,
                size,
                ramp_duration,
            });
        }
    }
    events
}

/// Shared bed-frame construction (also used by the plain PCM fallback).
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dynamic_slots_match_oamd_suffix_count() {
        let range = dynamic_object_range(
            &OamdPayload {
                version: 0,
                object_count: 5,
                alternate_object_present: false,
                element_count: 0,
                beds: 2,
                bed_instances: 1,
                bed_or_isf_objects: 2,
                dynamic_objects: 3,
                isf_in_use: false,
                isf_index: None,
                bed_assignment: Vec::new(),
                elements: Vec::new(),
            },
            3,
        );
        assert_eq!(range, Some(0..3));
        assert_eq!(
            dynamic_object_declarations(range.expect("dynamic range"), 1),
            vec![
                ObjectChannelDecl { id: 10, channel: 1 },
                ObjectChannelDecl { id: 11, channel: 2 },
                ObjectChannelDecl { id: 12, channel: 3 },
            ],
        );
    }

    #[test]
    fn mixed_dynamic_slots_declare_after_core_bed_prefix() {
        let range = dynamic_object_range(
            &OamdPayload {
                version: 0,
                object_count: 3,
                alternate_object_present: false,
                element_count: 0,
                beds: 1,
                bed_instances: 1,
                bed_or_isf_objects: 1,
                dynamic_objects: 2,
                isf_in_use: false,
                isf_index: None,
                bed_assignment: Vec::new(),
                elements: Vec::new(),
            },
            2,
        )
        .expect("JOC dynamic slots");
        assert_eq!(range, 0..2);
        assert_eq!(
            dynamic_object_declarations(range, 6),
            vec![
                ObjectChannelDecl { id: 10, channel: 6 },
                ObjectChannelDecl { id: 11, channel: 7 },
            ],
        );
    }

    #[test]
    fn dynamic_slots_reject_count_mismatch() {
        let range = dynamic_object_range(
            &OamdPayload {
                version: 0,
                object_count: 5,
                alternate_object_present: false,
                element_count: 0,
                beds: 3,
                bed_instances: 1,
                bed_or_isf_objects: 3,
                dynamic_objects: 2,
                isf_in_use: false,
                isf_index: None,
                bed_assignment: Vec::new(),
                elements: Vec::new(),
            },
            4,
        );
        assert_eq!(range, None);
        assert!(dynamic_object_declarations(0..0, 2).is_empty());
    }

    #[test]
    fn no_dynamic_slots_when_all_pcm_slots_are_bed_or_isf() {
        let range = dynamic_object_range(
            &OamdPayload {
                version: 0,
                object_count: 2,
                alternate_object_present: false,
                element_count: 0,
                beds: 2,
                bed_instances: 1,
                bed_or_isf_objects: 2,
                dynamic_objects: 0,
                isf_in_use: false,
                isf_index: None,
                bed_assignment: Vec::new(),
                elements: Vec::new(),
            },
            2,
        );
        assert_eq!(range, None);
        assert!(dynamic_object_declarations(0..0, 1).is_empty());
    }
}

fn bed_frame(
    codec: &'static str,
    core: CorePcmFrame,
    events: Vec<ObjectEvent>,
    object_channels: Vec<ObjectChannelDecl>,
    sample_pos: u64,
    extra_labels: &[String],
) -> FrameData {
    let mut channels = core.fullband_channels;
    let mut labels: Vec<String> = core
        .fullband_channel_order
        .iter()
        .map(|b| format!("{b:?}"))
        .collect();
    labels.extend(extra_labels.iter().cloned());
    if let Some(lfe) = core.lfe_channel {
        channels.push(lfe);
        labels.push("LFE".to_string());
    }
    FrameData {
        codec,
        sample_rate: core.sample_rate,
        sample_pos,
        channels,
        labels,
        ramp_duration: 0,
        events,
        object_channels,
    }
}
