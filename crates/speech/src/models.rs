//! The files voice input needs, fetched once into a folder the shell names:
//! a Whisper model the reader picks, and Silero's voice detector, which
//! comes with whichever model is fetched first. The size and digest are
//! those of the published files; a download that does not match them is
//! thrown away rather than handed to the C++ that reads it.
//!
//! The shells fetch the bytes their own way (the desktop with the updater's
//! HTTP client, which knows the reader's proxy); `Download` is what they
//! write them through, so that every shell checks and keeps a file alike.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, ErrorKind, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// What the page is told of a model; each shell hands it on in its own form.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelInfo {
    pub id: &'static str,
    /// The model's size once it is here; before, what is left to fetch.
    pub bytes: u64,
    pub present: bool,
}

/// A file voice input reads.
#[derive(Debug)]
pub struct Model {
    pub id: &'static str,
    pub file: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
    /// Where it is published, the file's name added.
    source: &'static str,
}

impl Model {
    pub fn url(&self) -> String {
        format!("{}{}", self.source, self.file)
    }
}

/// The models the page can choose. Both are whisper.cpp's own, quantised to
/// five bits: two fifths of the full size, and on forty recordings of
/// Russian speech the quantised base model got as many words right as the
/// full one. The files there have not changed in years; the digests would
/// notice if they did.
pub const MODELS: [Model; 2] = [
    // Hears Russian noticeably better (a fifth fewer words wrong than base on
    // the same forty recordings), so it is the one offered first.
    Model {
        id: "small",
        file: "ggml-small-q5_1.bin",
        bytes: 190_085_487,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        source: WHISPER,
    },
    // A third of the download and some four times as quick, for a slow device.
    Model {
        id: "base",
        file: "ggml-base-q5_1.bin",
        bytes: 59_707_625,
        sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
        source: WHISPER,
    },
];

/// Silero's voice detector in whisper.cpp's format: under a megabyte, and
/// what tells a pause from a word.
pub const VAD: Model = Model {
    id: "vad",
    file: "ggml-silero-v5.1.2.bin",
    bytes: 885_098,
    sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
    source: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/",
};

const WHISPER: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

/// A speech model by its id; the voice detector is not one to pick.
pub fn model(id: &str) -> Result<&'static Model, String> {
    MODELS.iter().find(|model| model.id == id).ok_or_else(|| format!("no speech model is called {id:?}"))
}

/// A file of the right size is taken as whole: it gets its name only once its digest has been checked.
pub fn present(folder: &Path, model: &Model) -> bool {
    std::fs::metadata(folder.join(model.file)).is_ok_and(|meta| meta.len() == model.bytes)
}

/// What a speech model needs fetched still, itself and the detector: nothing once both are here.
pub fn missing(folder: &Path, model: &'static Model) -> Vec<&'static Model> {
    [&VAD, model].into_iter().filter(|file| !present(folder, file)).collect()
}

/// What the page is told of each model. A model is here once the detector
/// is too, and a model already downloaded without it (as voice messages
/// fetched them) shows the detector's size alone left to fetch.
pub fn infos(folder: &Path) -> Vec<ModelInfo> {
    MODELS
        .iter()
        .map(|model| {
            let left = missing(folder, model);
            ModelInfo {
                id: model.id,
                bytes: if left.is_empty() { model.bytes } else { left.iter().map(|file| file.bytes).sum() },
                present: left.is_empty(),
            }
        })
        .collect()
}

/// Removes a model and a part left of it, and the detector once no model is
/// left to use it. Removing what is not there is not an error.
pub fn delete(folder: &Path, model: &Model) -> Result<(), String> {
    remove(folder, model)?;
    if !MODELS.iter().any(|other| present(folder, other)) {
        remove(folder, &VAD)?;
    }
    Ok(())
}

fn remove(folder: &Path, model: &Model) -> Result<(), String> {
    // A part left by a download the app was closed in the middle of goes too,
    // unless another copy of the app is writing it now.
    let part = part_path(folder, model);
    if let Ok(file) = OpenOptions::new().write(true).open(&part) {
        if file.try_lock().is_ok() {
            drop(file);
            let _ = std::fs::remove_file(&part);
        }
    }
    match std::fs::remove_file(folder.join(model.file)) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

pub(crate) fn part_path(folder: &Path, model: &Model) -> PathBuf {
    folder.join(format!("{}.part", model.file))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A file being fetched, under its working name until `finish` has checked
/// it. Dropped before then, the part is removed: nothing resumes a broken
/// download, so a part is only disk taken.
pub struct Download {
    model: &'static Model,
    folder: PathBuf,
    path: PathBuf,
    out: Option<BufWriter<File>>,
    digest: Sha256,
    done: u64,
}

impl Download {
    pub fn begin(folder: &Path, model: &'static Model) -> Result<Self, String> {
        std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
        let path = part_path(folder, model);
        let file = OpenOptions::new().create(true).write(true).truncate(false).open(&path).map_err(|e| e.to_string())?;
        // Another copy of the app (#12) fetching the same file at the same time
        // holds the part; it is left to that copy, not emptied under it.
        if file.try_lock().is_err() {
            return Err("the speech model is being downloaded by another Ommesh window".into());
        }
        file.set_len(0).map_err(|e| e.to_string())?;
        Ok(Self { model, folder: folder.to_path_buf(), path, out: Some(BufWriter::with_capacity(1 << 20, file)), digest: Sha256::new(), done: 0 })
    }

    /// Refuses a length the server gives that is not the file's.
    pub fn expect(&self, length: Option<u64>) -> Result<(), String> {
        match length {
            Some(length) if length != self.model.bytes => Err(format!("{} is {length} bytes there, not {}", self.model.file, self.model.bytes)),
            _ => Ok(()),
        }
    }

    pub fn write(&mut self, chunk: &[u8]) -> Result<(), String> {
        self.done += chunk.len() as u64;
        if self.done > self.model.bytes {
            return Err(format!("{} is longer than it should be", self.model.file));
        }
        self.digest.update(chunk);
        self.out.as_mut().expect("written before finishing").write_all(chunk).map_err(|e| e.to_string())
    }

    pub fn done(&self) -> u64 {
        self.done
    }

    /// Checks the whole and gives it its name.
    pub fn finish(mut self) -> Result<(), String> {
        let file = self.out.take().expect("finished once").into_inner().map_err(|e| e.to_string())?;
        let digest = std::mem::take(&mut self.digest);
        if self.done != self.model.bytes || hex(&digest.finalize()) != self.model.sha256 {
            return Err(format!("{} arrived damaged; try again", self.model.file));
        }
        // On disk before it takes the model's name, so that a model found there
        // after a power cut is whole. Renamed while still locked, so no other
        // copy can start on the part in between.
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&self.path, self.folder.join(self.model.file)).map_err(|e| e.to_string())?;
        self.path = PathBuf::new();
        Ok(())
    }
}

impl Drop for Download {
    fn drop(&mut self) {
        drop(self.out.take());
        if !self.path.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Whether this device can run the recogniser as it is built. The desktop
/// build compiles whisper.cpp for a known set of instructions rather than for
/// the machine it happens to run on: AVX2 on x86 (Intel since 2013 and AMD
/// since 2015, though not their cheapest Pentiums and Celerons for some years
/// after) and the ARMv8.2 dot product on ARM. A processor without them would
/// stop the app at the first instruction it lacks, so it is told no here
/// instead, before it downloads a model it cannot use.
pub fn able() -> Result<(), String> {
    #[cfg(not(target_pointer_width = "64"))]
    return Err(crate::engine::NOT_HERE.into());
    #[cfg(target_arch = "x86_64")]
    if !(std::arch::is_x86_feature_detected!("avx2")
        && std::arch::is_x86_feature_detected!("fma")
        && std::arch::is_x86_feature_detected!("f16c")
        && std::arch::is_x86_feature_detected!("bmi2"))
    {
        return Err("speech recognition needs a processor with AVX2".into());
    }
    #[cfg(target_arch = "aarch64")]
    if !(std::arch::is_aarch64_feature_detected!("dotprod") && std::arch::is_aarch64_feature_detected!("fp16")) {
        return Err("speech recognition needs an ARMv8.2 processor".into());
    }
    #[cfg(target_pointer_width = "64")]
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "hello", for a download small enough to write in a test.
    const HELLO: Model = Model {
        id: "hello",
        file: "hello.bin",
        bytes: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        source: "https://example.invalid/",
    };

    fn folder(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("ommesh-speech-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        folder
    }

    #[test]
    fn a_model_is_found_by_its_id_alone() {
        assert_eq!(model("small").unwrap().file, "ggml-small-q5_1.bin");
        assert_eq!(model("base").unwrap().file, "ggml-base-q5_1.bin");
        for id in ["", "tiny", "vad", "SMALL", "small/../base", "ggml-small-q5_1.bin"] {
            assert!(model(id).is_err(), "{id:?}");
        }
        assert_eq!(VAD.url(), "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin");
    }

    #[test]
    fn digests_are_compared_as_lowercase_hex() {
        assert_eq!(hex(&Sha256::digest(b"")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert!(MODELS.iter().chain([&VAD]).all(|model| model.sha256.len() == 64 && model.sha256 == model.sha256.to_lowercase()));
    }

    #[test]
    fn a_whole_file_takes_its_name_and_a_damaged_one_is_thrown_away() {
        let folder = folder("download");
        let mut download = Download::begin(&folder, &HELLO).unwrap();
        assert!(download.expect(Some(6)).is_err() && download.expect(None).is_ok() && download.expect(Some(5)).is_ok());
        download.write(b"hel").unwrap();
        download.write(b"lo").unwrap();
        assert_eq!(download.done(), 5);
        download.finish().unwrap();
        assert!(present(&folder, &HELLO));
        assert!(!part_path(&folder, &HELLO).exists());

        std::fs::remove_file(folder.join(HELLO.file)).unwrap();
        let mut download = Download::begin(&folder, &HELLO).unwrap();
        download.write(b"jello").unwrap();
        assert!(download.finish().unwrap_err().contains("damaged"));
        assert!(!present(&folder, &HELLO) && !part_path(&folder, &HELLO).exists());

        let mut download = Download::begin(&folder, &HELLO).unwrap();
        assert!(download.write(b"hello!").is_err());
        drop(download);
        assert!(!part_path(&folder, &HELLO).exists());
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_model_fetched_without_the_detector_is_not_ready_and_the_detector_goes_with_the_last_model() {
        let folder = folder("infos");
        std::fs::create_dir_all(&folder).unwrap();
        let fake = |model: &Model| std::fs::write(folder.join(model.file), vec![0u8; model.bytes as usize]).unwrap();
        fake(&MODELS[1]);
        let base = infos(&folder).into_iter().find(|info| info.id == "base").unwrap();
        assert_eq!(base, ModelInfo { id: "base", bytes: VAD.bytes, present: false });
        fake(&VAD);
        assert!(infos(&folder).iter().any(|info| info.id == "base" && info.present && info.bytes == MODELS[1].bytes));
        let small = infos(&folder).into_iter().find(|info| info.id == "small").unwrap();
        assert_eq!(small, ModelInfo { id: "small", bytes: MODELS[0].bytes, present: false });
        delete(&folder, &MODELS[1]).unwrap();
        assert!(!present(&folder, &MODELS[1]) && !present(&folder, &VAD));
        delete(&folder, &MODELS[0]).unwrap();
        let _ = std::fs::remove_dir_all(&folder);
    }
}
