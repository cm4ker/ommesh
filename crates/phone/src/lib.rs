//! The phones' native library: the radio core (`meshcore-core`) and voice
//! input (`speech`) in one. Each brings its own bindings; naming the crates
//! here is what links them in, and the bindings are read off this library
//! (`uniffi-bindgen generate --library`), one file per crate.

pub use meshcore_core;
pub use speech;
