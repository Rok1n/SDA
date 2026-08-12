//! DTS (DTS-HD MA core) streaming pipeline — bed-only for now.
//!
//! DTS:X object metadata lives in the EXSS extension substream (see
//! harletty-bridge `docs/dtsx-objects-campaign.md` and the `dca` crate's
//! `HdDecoder` / `XPresentation`); wiring that up is the v2 scope. Until
//! then DTS plays as a flat multichannel bed, which is exactly what the
//! bridge did in its first DTS iteration.

use std::collections::VecDeque;

use crate::{FrameData, Pipeline};

pub struct DtsPipeline {
    extractor: dca::Extractor,
    pcm_decoder: dca::PcmDecoder,
    total_samples: u64,
}

impl DtsPipeline {
    pub fn new() -> Self {
        Self {
            extractor: dca::Extractor::default(),
            pcm_decoder: dca::PcmDecoder::new(),
            total_samples: 0,
        }
    }
}

impl Pipeline for DtsPipeline {
    fn codec_name(&self) -> &'static str {
        "dts"
    }

    fn push(&mut self, data: &[u8], out: &mut VecDeque<FrameData>, errors: &mut Vec<String>) {
        self.extractor.push_bytes(data);
        for frame in &mut self.extractor {
            let frame = match frame {
                Ok(f) => f,
                Err(e) => {
                    errors.push(format!("DTS extract error: {e:?}"));
                    continue;
                }
            };
            match self.pcm_decoder.push_access_unit(frame.as_bytes()) {
                Ok(result) => {
                    let pcm = result.pcm;
                    let sample_pos = self.total_samples;
                    self.total_samples += pcm.samples_per_channel() as u64;

                    let mut channels = pcm.fullband_channels;
                    let mut labels: Vec<String> = pcm
                        .fullband_channel_order
                        .iter()
                        .map(|b| format!("{b:?}"))
                        .collect();
                    if let Some(lfe) = pcm.lfe_channel {
                        channels.push(lfe);
                        labels.push("LFE".to_string());
                    }

                    out.push_back(FrameData {
                        codec: "dts",
                        sample_rate: pcm.sample_rate,
                        sample_pos,
                        channels,
                        labels: labels.clone(),
                        raw_bed_labels: labels,
                        events: Vec::new(),
                        object_channels: Vec::new(),
                        ramp_duration: 0,
                    });
                }
                Err(e) => errors.push(format!("DTS decode error: {e}")),
            }
        }
    }

    fn reset(&mut self) {
        *self = Self::new();
    }
}
