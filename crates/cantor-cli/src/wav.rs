//! WAV files in and out: 16-bit PCM or 32-bit float in, the first channel only; 32-bit float
//! mono out.

use std::path::Path;

use hound::{SampleFormat, WavReader, WavSpec, WavWriter};

/// The first channel of `path` as f32 samples, with its sample rate.
pub fn read_mono(path: &Path) -> Result<(Vec<f32>, f32), String> {
    let err = |e: hound::Error| format!("{}: {e}", path.display());
    let mut reader = WavReader::open(path).map_err(err)?;
    let spec = reader.spec();
    let step = spec.channels.max(1) as usize;
    let samples: Vec<f32> = match (spec.sample_format, spec.bits_per_sample) {
        (SampleFormat::Float, 32) => reader.samples::<f32>().step_by(step).collect::<Result<_, _>>().map_err(err)?,
        (SampleFormat::Int, bits @ 1..=32) => {
            let scale = 1.0 / (1u64 << (bits - 1)) as f32;
            reader
                .samples::<i32>()
                .step_by(step)
                .map(|s| s.map(|v| v as f32 * scale))
                .collect::<Result<_, _>>()
                .map_err(err)?
        }
        (format, bits) => return Err(format!("{}: unsupported {bits}-bit {format:?} samples", path.display())),
    };
    Ok((samples, spec.sample_rate as f32))
}

/// Writes `samples` to `path` as a 32-bit float mono WAV file.
pub fn write_mono(path: &Path, samples: &[f32], sample_rate: f32) -> Result<(), String> {
    let err = |e: hound::Error| format!("{}: {e}", path.display());
    let spec = WavSpec {
        channels: 1,
        sample_rate: sample_rate.round() as u32,
        bits_per_sample: 32,
        sample_format: SampleFormat::Float,
    };
    let mut writer = WavWriter::create(path, spec).map_err(err)?;
    for &s in samples {
        writer.write_sample(s).map_err(err)?;
    }
    writer.finalize().map_err(err)
}
