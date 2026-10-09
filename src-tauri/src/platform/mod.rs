#[cfg(any(target_os = "macos", target_os = "windows"))]
mod frame;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(all(unix, not(target_os = "macos")))]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub use frame::rect_covers;
#[cfg(target_os = "macos")]
pub use macos::{
    replace_file, reveal_in_file_manager, reveal_without_focus, start_fullscreen_observer,
};
#[cfg(all(unix, not(target_os = "macos")))]
pub use unix::{
    replace_file, reveal_in_file_manager, reveal_without_focus, start_fullscreen_observer,
};
#[cfg(windows)]
pub use windows::{
    replace_file, reveal_in_file_manager, reveal_without_focus, start_fullscreen_observer,
};
