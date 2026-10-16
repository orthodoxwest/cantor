//! A hand-written C ABI over `cantor-core` for the browser, in the style of neuma-wasm.

#![forbid(unsafe_code)]

#[unsafe(no_mangle)]
pub extern "C" fn cantor_hz_to_midi(hz: f32) -> f32 {
    cantor_core::hz_to_midi(hz)
}
