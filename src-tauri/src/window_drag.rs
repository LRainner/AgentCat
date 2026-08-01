#[cfg(not(windows))]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(not(windows))]
use unix as platform;
#[cfg(windows)]
use windows as platform;

pub use platform::{install, start, CompletionMode, WindowDragState};
