//! Native smoke test for the TrueHD pipeline, using the example bitstream
//! embedded in the `truehd` crate. Run with `cargo test`.

#[cfg(test)]
mod tests {
    use sda_core::{Pipeline, truehd_pipeline::TruehdPipeline};
    use std::collections::VecDeque;

    #[test]
    fn decodes_truehd_example_data() {
        let mut pipe = TruehdPipeline::new();
        let mut out = VecDeque::new();
        let mut errors = Vec::new();
        pipe.push(truehd::process::EXAMPLE_DATA, &mut out, &mut errors);

        assert!(!out.is_empty(), "no frames decoded; errors: {errors:?}");
        let frame = &out[0];
        assert_eq!(frame.codec, "truehd");
        assert!(frame.sample_rate > 0);
        assert!(!frame.channels.is_empty());
        assert!(frame.channels[0].len() > 0);
        println!(
            "truehd: {} frames, first: {}Hz {}ch {} samples, labels={:?}, events={}",
            out.len(),
            frame.sample_rate,
            frame.channels.len(),
            frame.channels[0].len(),
            frame.labels,
            frame.events.len()
        );
    }
}
