//! A hand-written C ABI over `cantor-core` for the browser, in the style of neuma-wasm.

// `no_mangle` is the one `unsafe` this crate allows: the exported symbols.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn cantor_hz_to_midi(hz: f32) -> f32 {
    cantor_core::hz_to_midi(hz)
}
