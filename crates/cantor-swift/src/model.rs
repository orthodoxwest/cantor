//! SwiftF0's graph in plain Rust, its weights read from the bundled model. Each step follows
//! the ONNX graph's own: three short-time Fourier transforms (1024, 2048 and 512 points, hop
//! 256, centred, zero-padded), each computed as the graph computes it, a two-stage
//! factorisation into matrix products with the same twiddle factors; their magnitudes through
//! the model's filterbanks into 128 log bins; the convolutional network over the three; and
//! the decoding of pitch and confidence.
//!
//! The spectrograms are tract's to the bit: their sums run in tract's order, fused as its
//! kernels fuse them, and their log is tract's. The log of a nearly silent bin magnifies the
//! last bit of its sum, enough to move the pitch the network picks. The network's sums are
//! rounded as plain products and sums, so it agrees with tract's to rounding; matching it to
//! the bit as well would mean following tract's choice of algorithm for each convolution, at
//! about three times the cost.

use std::f32::consts::TAU;

use crate::onnx::{Tensor, initializers};

/// Samples per frame.
pub const HOP: usize = 256;
/// Bins of each spectrogram, and of the network's input.
const BINS: usize = 128;
/// Pitch bins the network scores.
const PITCHES: usize = 95;
/// The network's spectrogram rows kept for pitch, from the lowest.
const PITCH_ROWS: usize = 96;
/// The graph's floor under each filterbank sum before its log.
const LOG_FLOOR: f32 = 1e-8;

/// One short-time Fourier transform, `outer` × `inner` points, and its filterbank.
struct Spectrum {
    window: Vec<f32>,
    outer: usize,
    inner: usize,
    /// Stage one, `outer` × `outer`: cos and -sin of 2πka/outer.
    first: (Vec<f32>, Vec<f32>),
    /// The twiddle factors, `outer` × `inner`: cos and -sin of 2πkb/n.
    twiddle: (Vec<f32>, Vec<f32>),
    /// Stage two, `inner` × `inner`: cos and -sin of 2πbk/inner.
    second: (Vec<f32>, Vec<f32>),
    /// The filterbank, for each of the [`BINS`] its rows and weights, rows ascending.
    filters: Vec<Vec<(usize, f32)>>,
}

/// cos and -sin of 2π((i·j) mod n)/n over `rows` × `cols`, as the graph makes them: the
/// product reduced modulo `n` in integers, then scaled in f32.
fn angles(rows: usize, cols: usize, n: usize) -> (Vec<f32>, Vec<f32>) {
    let step = TAU / n as f32;
    let angle = |i: usize| ((i / cols * (i % cols)) % n) as f32 * step;
    let cos = (0..rows * cols).map(|i| angle(i).cos()).collect();
    let nsin = (0..rows * cols).map(|i| -angle(i).sin()).collect();
    (cos, nsin)
}

impl Spectrum {
    fn new(window: Vec<f32>, outer: usize, inner: usize, scatter: (Vec<i32>, Vec<f32>)) -> Result<Spectrum, String> {
        let n = outer * inner;
        if window.len() != n {
            return Err(format!("a window of {} for {n} points", window.len()));
        }
        let rows = n / 2 + 1;
        let mut filters = vec![Vec::new(); BINS];
        let mut cells: Vec<(usize, f32)> = scatter.0.iter().zip(&scatter.1).map(|(&i, &w)| (i as usize, w)).collect();
        // Rows ascending within each bin, as the graph's matrix product sums them.
        cells.sort_by_key(|c| c.0);
        for (i, w) in cells {
            if i >= rows * BINS {
                return Err(format!("filterbank cell {i} outside {rows} × {BINS}"));
            }
            filters[i % BINS].push((i / BINS, w));
        }
        Ok(Spectrum {
            window,
            outer,
            inner,
            first: angles(outer, outer, outer),
            twiddle: angles(outer, inner, n),
            second: angles(inner, inner, inner),
            filters,
        })
    }

    /// The log filterbank of frame `f` of `audio`, into `out` ([`BINS`] values).
    fn frame(&self, audio: &[f32], f: usize, out: &mut [f32]) {
        let (outer, inner) = (self.outer, self.inner);
        let n = outer * inner;
        // The frame is centred on hop `f`, zero beyond the audio.
        let start = (f * HOP) as isize - (n / 2) as isize;
        let x: Vec<f32> = (0..n)
            .map(|i| {
                let at = start + i as isize;
                let s = if at >= 0 {
                    audio.get(at as usize).copied().unwrap_or(0.0)
                } else {
                    0.0
                };
                s * self.window[i]
            })
            .collect();
        // Stage one: over `a` of x[a·inner + b], for each `k1` and `b`.
        let mut re = vec![0.0f32; outer * inner];
        let mut im = vec![0.0f32; outer * inner];
        for k1 in 0..outer {
            let (c, s) = (&self.first.0[k1 * outer..][..outer], &self.first.1[k1 * outer..][..outer]);
            let (r, m) = (&mut re[k1 * inner..][..inner], &mut im[k1 * inner..][..inner]);
            for a in 0..outer {
                let row = &x[a * inner..][..inner];
                fused_axpy(c[a], row, r);
                fused_axpy(s[a], row, m);
            }
        }
        // The twiddle factors, a complex product.
        for i in 0..outer * inner {
            let (c, s) = (self.twiddle.0[i], self.twiddle.1[i]);
            let (r, m) = (re[i], im[i]);
            re[i] = r * c - m * s;
            im[i] = r * s + m * c;
        }
        // Stage two: over `b`, for each `k1` and `k2`; bin k = k2·outer + k1. Each of the
        // graph's four matrix products is summed on its own.
        let rows = n / 2 + 1;
        let mut magnitude = vec![0.0f32; rows];
        let mut sums = vec![0.0f32; 4 * inner];
        for k1 in 0..outer {
            let (r, m) = (&re[k1 * inner..][..inner], &im[k1 * inner..][..inner]);
            sums.fill(0.0);
            let (rc, rest) = sums.split_at_mut(inner);
            let (ms, rest) = rest.split_at_mut(inner);
            let (rs, mc) = rest.split_at_mut(inner);
            for b in 0..inner {
                let (c, s) = (&self.second.0[b * inner..][..inner], &self.second.1[b * inner..][..inner]);
                fused_axpy(r[b], c, rc);
                fused_axpy(m[b], s, ms);
                fused_axpy(r[b], s, rs);
                fused_axpy(m[b], c, mc);
            }
            for k2 in 0..inner {
                let k = k2 * outer + k1;
                if k < rows {
                    let (real, imag) = (rc[k2] - ms[k2], rs[k2] + mc[k2]);
                    magnitude[k] = (real * real + imag * imag).sqrt();
                }
            }
        }
        for (bin, filter) in out.iter_mut().zip(&self.filters) {
            let sum = filter.iter().fold(0.0f32, |s, &(row, w)| fma(magnitude[row], w, s));
            *bin = ln(sum + LOG_FLOOR);
        }
    }
}

/// `a·b + c` rounded once, as a fused multiply-add gives it, whether or not the machine has
/// one. The product is exact in f64; the sum, if it rounds there, is rounded to odd instead,
/// so that rounding it again to f32 rounds as once.
#[inline(always)]
fn fma(a: f32, b: f32, c: f32) -> f32 {
    let p = f64::from(a) * f64::from(b);
    let c = f64::from(c);
    let s = p + c;
    let t = s - p;
    let error = (p - (s - t)) + (c - t);
    // An inexact sum that is even moves one ulp toward the exact one: up in magnitude when
    // the error has the sum's sign, down when not. Written without branches, to vectorise.
    let bits = s.to_bits();
    let toward = 1u64.wrapping_sub(((error.to_bits() ^ bits) >> 63) << 1);
    let odd = 0u64.wrapping_sub(u64::from(error != 0.0) & !bits & 1);
    f64::from_bits(bits.wrapping_add(toward & odd)) as f32
}

/// `y += k·x` elementwise, each fused.
#[inline(always)]
fn fused_axpy(k: f32, x: &[f32], y: &mut [f32]) {
    for (y, x) in y.iter_mut().zip(x) {
        *y = fma(k, *x, *y);
    }
}

/// `y += k·x` elementwise, each product rounded before its sum.
#[inline(always)]
fn axpy(k: f32, x: &[f32], y: &mut [f32]) {
    for (y, x) in y.iter_mut().zip(x) {
        *y += k * x;
    }
}

/// The natural log as tract computes it in f32, a polynomial fit within an ulp of the true
/// log, so that the port's spectrograms are tract's to the bit.
#[allow(clippy::excessive_precision)]
fn ln(x: f32) -> f32 {
    const POLY: [f32; 9] = [
        7.0376836292e-2,
        -1.1514610310e-1,
        1.1676998740e-1,
        -1.2420140846e-1,
        1.4249322787e-1,
        -1.6668057665e-1,
        2.0000714765e-1,
        -2.4999993993e-1,
        3.3333331174e-1,
    ];
    const LN2_HI: f32 = 0.693_359_375;
    const LN2_LO: f32 = -2.121_944_4e-4;
    if x.is_nan() || x <= 0.0 {
        return if x == 0.0 { f32::NEG_INFINITY } else { f32::NAN };
    }
    if x.is_infinite() {
        return f32::INFINITY;
    }
    let subnormal = x < f32::MIN_POSITIVE;
    let bits = if subnormal { x * 16_777_216.0 } else { x }.to_bits();
    let mut e = ((bits >> 23) & 0xff) as i32 - 127 - if subnormal { 24 } else { 0 };
    let mut m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000);
    if m > std::f32::consts::SQRT_2 {
        m *= 0.5;
        e += 1;
    }
    let f = m - 1.0;
    let f2 = f * f;
    let p = POLY[1..].iter().fold(POLY[0], |p, &c| fma(p, f, c));
    let e = e as f32;
    let y = fma(e, LN2_LO, p * f2 * f);
    let y = fma(-0.5, f2, y) + f;
    fma(e, LN2_HI, y)
}

/// Channels × height × width, width (time) innermost.
#[derive(Clone)]
pub(crate) struct Map {
    c: usize,
    h: usize,
    w: usize,
    pub(crate) data: Vec<f32>,
}

impl Map {
    fn at(&self, c: usize, y: usize) -> &[f32] {
        &self.data[(c * self.h + y) * self.w..][..self.w]
    }

    fn relu(mut self) -> Map {
        self.data.iter_mut().for_each(|v| *v = v.max(0.0));
        self
    }

    fn add(mut self, other: &Map) -> Map {
        self.data.iter_mut().zip(&other.data).for_each(|(a, b)| *a += b);
        self
    }
}

/// A two-dimensional convolution: kernel `kh` × `kw`, dilated `dh` in height, padded `ph`
/// above and below and `pw` either side.
struct Conv {
    out: usize,
    inp: usize,
    kh: usize,
    kw: usize,
    dh: usize,
    ph: (usize, usize),
    pw: usize,
    weight: Vec<f32>,
    bias: Vec<f32>,
}

impl Conv {
    fn apply(&self, x: &Map) -> Map {
        assert_eq!(x.c, self.inp);
        let h = x.h + self.ph.0 + self.ph.1 - self.dh * (self.kh - 1);
        let w = x.w;
        let mut out = Map {
            c: self.out,
            h,
            w,
            data: vec![0.0; self.out * h * w],
        };
        for o in 0..self.out {
            let plane = &mut out.data[o * h * w..][..h * w];
            plane.fill(self.bias[o]);
            for i in 0..self.inp {
                for a in 0..self.kh {
                    for b in 0..self.kw {
                        let k = self.weight[((o * self.inp + i) * self.kh + a) * self.kw + b];
                        // Output column t reads input column t + b - pw.
                        let (to, from, len) = if b < self.pw {
                            (self.pw - b, 0, w - (self.pw - b))
                        } else {
                            (0, b - self.pw, w - (b - self.pw))
                        };
                        for y in 0..h {
                            let Some(src) = (y + a * self.dh).checked_sub(self.ph.0).filter(|s| *s < x.h) else {
                                continue;
                            };
                            axpy(k, &x.at(i, src)[from..][..len], &mut plane[y * w + to..][..len]);
                        }
                    }
                }
            }
        }
        out
    }
}

/// The model's lowest and highest pitch, in hertz, which the graph takes as inputs.
pub const FMIN: f32 = 46.875;
pub const FMAX: f32 = 2093.75;

pub struct Model {
    spectra: [Spectrum; 3],
    /// The network up to its pitch head, in order: the stem, then pairs around a residual.
    stem: Conv,
    blocks: Vec<(Conv, Conv)>,
    head: (Conv, Conv),
    /// The 1 × 1 convolution scoring each pitch bin.
    score: Conv,
    /// The confidence head, over the head's maxima and the input's mean.
    confidence: (Conv, Conv),
    /// Each pitch bin's frequency, and its log in f64.
    hz: Vec<f32>,
    log_hz: Vec<f64>,
}

impl Model {
    pub fn new(onnx: &[u8]) -> Result<Model, String> {
        let init = initializers(onnx)?;
        let get = |name: &str| -> Result<&Tensor, String> { init.get(name).ok_or_else(|| format!("no initializer {name}")) };
        let f32s = |name: &str| get(name)?.f32s().map_err(|e| format!("{name}: {e}"));
        let conv = |w: &str, b: &str, dh: usize, ph: (usize, usize), pw: usize| -> Result<Conv, String> {
            let t = get(w)?;
            let (out, inp, kh, kw) = match t.dims[..] {
                [o, i, h, w] => (o, i, h, w),
                [o, i, w] => (o, i, 1, w),
                _ => return Err(format!("{w}: a kernel of shape {:?}", t.dims)),
            };
            let conv = Conv {
                out,
                inp,
                kh,
                kw,
                dh,
                ph,
                pw,
                weight: f32s(w)?,
                bias: f32s(b)?,
            };
            if conv.bias.len() != out || 2 * pw + 1 != kw {
                return Err(format!("{w}: {out} outputs, {} biases, width {kw} padded {pw}", conv.bias.len()));
            }
            Ok(conv)
        };
        let scatter = |i: &str, v: &str| -> Result<(Vec<i32>, Vec<f32>), String> { Ok((get(i)?.i32s()?, f32s(v)?)) };
        let spectra = [
            Spectrum::new(f32s("v41")?, 32, 32, scatter("v123", "v124")?)?,
            Spectrum::new(f32s("v161")?, 64, 32, scatter("v241", "v242")?)?,
            Spectrum::new(f32s("v262")?, 32, 16, scatter("v342", "v343")?)?,
        ];
        // (weight, bias, dilation, height padding, width padding) of each residual pair.
        let pair = |a: (&str, &str), b: (&str, &str), dh: usize, ph: usize, pw: usize| -> Result<(Conv, Conv), String> {
            Ok((conv(a.0, a.1, dh, (ph, ph), pw)?, conv(b.0, b.1, dh, (ph, ph), pw)?))
        };
        let blocks = vec![
            pair(("v357", "v358"), ("v361", "v362"), 1, 3, 1)?,
            pair(("v366", "v367"), ("v370", "v371"), 17, 51, 0)?,
            pair(("v375", "v376"), ("v379", "v380"), 27, 54, 0)?,
            pair(("v384", "v385"), ("v388", "v389"), 40, 40, 0)?,
            pair(("v393", "v394"), ("v397", "v398"), 48, 48, 0)?,
            pair(("v402", "v403"), ("v406", "v407"), 2, 6, 1)?,
        ];
        // The graph builds its twiddle factors from these index ranges; the port assumes them.
        for (name, len) in [("v45", 32), ("v46", 32), ("v165", 64), ("v166", 64), ("v283", 16), ("v307", 16)] {
            if get(name)?.i64s()? != (0..len).collect::<Vec<i64>>() {
                return Err(format!("{name} is not 0..{len}"));
            }
        }
        let hz = f32s("v438")?;
        let log_hz = get("v455")?.f64s()?;
        if hz.len() != PITCHES || log_hz.len() != PITCHES {
            return Err(format!("{} pitch bins", hz.len()));
        }
        Ok(Model {
            spectra,
            stem: conv("v353", "v354", 1, (1, 1), 1)?,
            blocks,
            head: (conv("v413", "v414", 1, (1, 0), 1)?, conv("v417", "v418", 1, (2, 2), 0)?),
            score: conv("v425", "v426", 1, (0, 0), 0)?,
            confidence: (conv("v430", "v431", 1, (0, 0), 1)?, conv("v434", "v435", 1, (0, 0), 0)?),
            hz,
            log_hz,
        })
    }

    /// The three log spectrograms of `audio` (16 kHz), channels × bins × frames: one frame
    /// per [`HOP`] samples, at least one.
    pub(crate) fn spectrogram(&self, audio: &[f32]) -> Map {
        let frames = (audio.len() / HOP).max(1);
        let mut input = Map {
            c: 3,
            h: BINS,
            w: frames,
            data: vec![0.0; 3 * BINS * frames],
        };
        let mut bins = [0.0f32; BINS];
        for (c, spectrum) in self.spectra.iter().enumerate() {
            for f in 0..frames {
                spectrum.frame(audio, f, &mut bins);
                for (y, v) in bins.iter().enumerate() {
                    input.data[(c * BINS + y) * frames + f] = *v;
                }
            }
        }
        input
    }

    /// Pitch in hertz and confidence for each frame of `audio` (16 kHz), as the graph gives
    /// them with `fmin` [`FMIN`] and `fmax` [`FMAX`]: one frame per [`HOP`] samples, at least
    /// one.
    pub fn run(&self, audio: &[f32]) -> (Vec<f64>, Vec<f32>) {
        let input = self.spectrogram(audio);
        let frames = input.w;
        let mut x = self.stem.apply(&input).relu();
        for (a, b) in &self.blocks {
            let y = b.apply(&a.apply(&x).relu());
            x = y.add(&x).relu();
        }
        // The pitch head reads the lowest rows only.
        let rows = Map {
            c: x.c,
            h: PITCH_ROWS,
            w: frames,
            data: (0..x.c)
                .flat_map(|c| x.data[c * x.h * frames..][..PITCH_ROWS * frames].to_vec())
                .collect(),
        };
        let head = self.head.0.apply(&rows).relu();
        let peaks = self.head.1.apply(&head);
        let logits = self.score.apply(&head);
        // The confidence head: each channel's maximum over pitch, then the input's mean.
        let mut summary = Map {
            c: peaks.c + 1,
            h: 1,
            w: frames,
            data: vec![f32::NEG_INFINITY; (peaks.c + 1) * frames],
        };
        for c in 0..peaks.c {
            for y in 0..peaks.h {
                for (m, v) in summary.data[c * frames..][..frames].iter_mut().zip(peaks.at(c, y)) {
                    *m = m.max(*v);
                }
            }
        }
        let mean = &mut summary.data[peaks.c * frames..];
        mean.fill(0.0);
        for c in 0..3 {
            for y in 0..BINS {
                for (m, v) in mean.iter_mut().zip(input.at(c, y)) {
                    *m += v;
                }
            }
        }
        // The graph divides by the count, which tract makes a product with its reciprocal.
        let scale = ((3 * BINS) as f32).recip();
        mean.iter_mut().for_each(|m| *m *= scale);
        let confidence = self.confidence.1.apply(&self.confidence.0.apply(&summary).relu());

        let in_range: Vec<bool> = self.hz.iter().map(|hz| (FMIN..=FMAX).contains(hz)).collect();
        let mut pitch = Vec::with_capacity(frames);
        let mut sure = Vec::with_capacity(frames);
        for f in 0..frames {
            let logit = |p: usize| logits.at(0, p)[f];
            let masked = |p: usize| if in_range[p] { logit(p) } else { f32::NEG_INFINITY };
            let best = first_max((0..PITCHES).map(masked));
            // A softmax over the best bin and its neighbours, in f64, weighting their logs.
            let near: Vec<(usize, f64)> = [best as isize - 1, best as isize, best as isize + 1]
                .iter()
                .map(|&p| {
                    let value = if (0..PITCHES as isize).contains(&p) {
                        masked(p as usize)
                    } else {
                        f32::NEG_INFINITY
                    };
                    (p.clamp(0, PITCHES as isize - 1) as usize, f64::from(value))
                })
                .collect();
            let top = near.iter().fold(f64::NEG_INFINITY, |m, n| m.max(n.1));
            let weights: Vec<f64> = near.iter().map(|n| (n.1 - top).exp()).collect();
            let total: f64 = weights.iter().sum();
            let log_hz: f64 = near.iter().zip(&weights).map(|(n, w)| w / total * self.log_hz[n.0]).sum();
            pitch.push(log_hz.exp());
            let voiced_bin = first_max((0..PITCHES).map(logit));
            let c = confidence.at(0, 0)[f];
            sure.push(if in_range[voiced_bin] { 1.0 / (1.0 + (-c).exp()) } else { 0.0 });
        }
        (pitch, sure)
    }
}

/// The index of the first greatest value, as ONNX's ArgMax gives it.
fn first_max(values: impl Iterator<Item = f32>) -> usize {
    let mut best = (0, f32::NEG_INFINITY);
    for (i, v) in values.enumerate() {
        if i == 0 || v > best.1 {
            best = (i, v);
        }
    }
    best.0
}
