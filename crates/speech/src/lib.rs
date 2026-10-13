//! Voice input (#89): what is said into the microphone, written into the
//! message field while it is said. Everything happens on the device: the
//! sound goes from the microphone to whisper.cpp in memory, a phrase at a
//! time, and is forgotten once heard. Nothing of it leaves the machine.
//!
//! Whisper hears a stretch of sound whole, not a stream word by word, so the
//! stream is cut at the pauses: Silero's voice detector, which whisper.cpp
//! carries, tells speech from silence in 32 ms frames (`phrases` says where
//! a phrase begins and ends), and each phrase is heard once, on a thread of
//! its own, while the next is being said (`dictation`).
//!
//! The desktop shell links this crate directly; the phones' native code
//! calls it the same way. The models are downloaded once into a folder the
//! shell names (`models`).

pub mod dictation;
mod engine;
pub mod models;
pub mod phrases;

pub use dictation::{Dictation, Fed, Recognizer};
pub use models::{able, Download, Model, ModelInfo, MODELS, VAD};
