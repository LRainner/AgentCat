#[cfg(target_os = "macos")]
mod macos;
#[cfg(all(unix, not(target_os = "macos")))]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "macos")]
pub use macos::{replace_file, reveal_in_file_manager};
#[cfg(all(unix, not(target_os = "macos")))]
pub use unix::{replace_file, reveal_in_file_manager};
#[cfg(windows)]
pub use windows::{replace_file, reveal_in_file_manager};
