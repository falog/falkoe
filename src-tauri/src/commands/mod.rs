pub mod audio;
pub mod linking;
pub mod logs;
pub mod pitch;
pub mod recordings;
pub mod sentences;
pub mod status;
pub mod video;
pub mod temp_recordings;

// Cutter depends on Whisper/ASR internals; provide a stub when disabled.
#[cfg(feature = "whisper")]
pub mod cutter;
#[cfg(not(feature = "whisper"))]
#[path = "cutter_stub.rs"]
pub mod cutter;

// Whisper/ASR facade. When disabled, keep types/commands available but return errors.
#[cfg(feature = "whisper")]
#[path = "whisper_facade.rs"]
pub mod whisper;
#[cfg(not(feature = "whisper"))]
#[path = "whisper_stub.rs"]
pub mod whisper;
