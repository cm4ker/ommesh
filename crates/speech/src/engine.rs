//! whisper.cpp and its voice detector, which only 64-bit builds carry: built
//! for 32-bit Windows (`i686` in the build workflow), ggml takes the
//! processor for an unknown one and falls back to plain C, and a computer
//! that old seldom has AVX2 anyway.

#[cfg(not(target_pointer_width = "64"))]
pub const NOT_HERE: &str = "speech recognition needs a 64-bit system";

#[cfg(target_pointer_width = "64")]
mod imp {
    use std::path::Path;
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperVadContext, WhisperVadContextParams};

    /// A model read into memory.
    pub struct Engine(WhisperContext);

    pub fn load(path: &Path) -> Result<Engine, String> {
        quiet();
        let mut params = WhisperContextParameters::default();
        // Flash attention came out slower on the processor for phrases this short.
        params.flash_attn(false);
        WhisperContext::new_with_params(path, params).map(Engine).map_err(|e| format!("the speech model did not load: {e}"))
    }

    impl Engine {
        /// The words in a phrase of 16 kHz mono speech, in `language`, with
        /// what was written before it as a clue to how it goes on.
        pub fn hear(&self, samples: &[f32], language: &str, before: &str) -> Result<String, String> {
            // The recogniser's working memory, made for each phrase and freed
            // after: it takes milliseconds to make and much memory to keep.
            let mut state = self.0.create_state().map_err(|e| e.to_string())?;
            let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
            params.set_language(Some(language));
            params.set_n_threads(threads());
            // The clue is what is in the field, not whatever this state heard last.
            params.set_no_context(true);
            if !before.is_empty() {
                params.set_initial_prompt(before);
            }
            // Whisper hears thirty seconds at a time and pads a shorter phrase
            // with silence it then works through; told the phrase's length, it
            // spends its effort on the phrase alone.
            params.set_audio_ctx(context(samples.len()));
            // A phrase is a sentence or two: one segment, no timestamps to work out.
            params.set_single_segment(true);
            params.set_no_timestamps(true);
            params.set_suppress_blank(true);
            params.set_suppress_nst(true);
            params.set_print_special(false);
            params.set_print_progress(false);
            params.set_print_realtime(false);
            params.set_print_timestamps(false);
            state.full(params, samples).map_err(|e| e.to_string())?;
            let mut text = String::new();
            for segment in state.as_iter() {
                text.push_str(&segment.to_str_lossy().map_err(|e| e.to_string())?);
            }
            Ok(text.trim().to_string())
        }
    }

    /// How much of its thirty-second window Whisper attends to for `samples`:
    /// 1500 positions for the whole, 50 a second, with a second to spare and
    /// rounded up to a multiple of 64 so that the sums stay even.
    pub fn context(samples: usize) -> i32 {
        let seconds = samples.div_ceil(crate::phrases::RATE) + 1;
        (seconds * 50).next_multiple_of(64).min(1500) as i32
    }

    /// Silero's voice detector.
    pub struct Vad(WhisperVadContext);

    impl Vad {
        pub fn load(path: &Path) -> Result<Vad, String> {
            quiet();
            let mut params = WhisperVadContextParams::new();
            // A few hundred frames a time, each a small sum: one thread, so as not to wait on the others.
            params.set_n_threads(1);
            let path = path.to_str().ok_or("the voice detector's path is not text")?;
            WhisperVadContext::new(path, params).map(Vad).map_err(|e| format!("the voice detector did not load: {e}"))
        }

        /// For each whole 32 ms frame of `samples`, the chance it is speech.
        pub fn probabilities(&mut self, samples: &[f32]) -> Result<Vec<f32>, String> {
            self.0.detect_speech(samples).map_err(|e| format!("the voice detector failed: {e}"))?;
            Ok(self.0.probabilities().to_vec())
        }
    }

    /// whisper.cpp and ggml print a page about the model on every load; this
    /// sends it to `log`, where `RUST_LOG` shows it, rather than to stderr.
    fn quiet() {
        whisper_rs::install_logging_hooks();
    }

    /// Four threads at most, for power rather than the last bit of speed: on a
    /// 12-core Snapdragon X, eight heard a message 30% sooner but spent 40%
    /// more processor time on it. A phone's four big cores are the same four.
    fn threads() -> i32 {
        std::thread::available_parallelism().map_or(1, |n| n.get().min(4)) as i32
    }
}

#[cfg(not(target_pointer_width = "64"))]
mod imp {
    use super::NOT_HERE;
    use std::path::Path;

    pub struct Engine;
    pub struct Vad;

    pub fn load(_: &Path) -> Result<Engine, String> {
        Err(NOT_HERE.into())
    }

    impl Engine {
        pub fn hear(&self, _: &[f32], _: &str, _: &str) -> Result<String, String> {
            Err(NOT_HERE.into())
        }
    }

    impl Vad {
        pub fn load(_: &Path) -> Result<Vad, String> {
            Err(NOT_HERE.into())
        }

        pub fn probabilities(&mut self, _: &[f32]) -> Result<Vec<f32>, String> {
            Err(NOT_HERE.into())
        }
    }
}

pub use imp::{load, Engine, Vad};
