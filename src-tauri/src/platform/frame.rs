/// Tolerance that absorbs the rounding a window manager applies to frames.
const FRAME_TOLERANCE: f64 = 1.0;

/// One screen edge as `(left, top, right, bottom)`.
pub type Edges = (f64, f64, f64, f64);

/// Reports whether a window frame covers a whole screen.
///
/// The origin is part of the comparison: a window that is merely larger than some
/// other screen must not count as covering it. Both fullscreen detectors rely on
/// that, which is why the check is shared — its tests then run wherever either
/// detector is built.
pub fn rect_covers(window: Edges, screen: Edges) -> bool {
    let (left, top, right, bottom) = window;
    let (screen_left, screen_top, screen_right, screen_bottom) = screen;
    left <= screen_left + FRAME_TOLERANCE
        && top <= screen_top + FRAME_TOLERANCE
        && right >= screen_right - FRAME_TOLERANCE
        && bottom >= screen_bottom - FRAME_TOLERANCE
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The main display, with a larger secondary display above and to the left.
    const MAIN: Edges = (0.0, 0.0, 1512.0, 982.0);
    const SECONDARY: Edges = (-895.0, -1080.0, 1025.0, 0.0);

    /// Reproduces the layout that produced a false positive in real use: a
    /// maximised window on the larger secondary display is wider and taller than
    /// the main display, so a size-only comparison wrongly called it fullscreen.
    #[test]
    fn window_larger_than_another_screen_does_not_cover_it() {
        // Maximised on the secondary display: full width, minus the menu bar.
        let maximised = (-895.0, -1080.0, 1025.0, -30.0);
        assert!(!rect_covers(maximised, SECONDARY));
        assert!(!rect_covers(maximised, MAIN));
    }

    #[test]
    fn frame_covering_its_own_screen_is_fullscreen() {
        assert!(rect_covers((0.0, 0.0, 1512.0, 982.0), MAIN));
        assert!(rect_covers((-895.0, -1080.0, 1025.0, 0.0), SECONDARY));
    }

    #[test]
    fn a_fullscreen_frame_never_matches_a_different_screen() {
        assert!(!rect_covers((0.0, 0.0, 1512.0, 982.0), SECONDARY));
        assert!(!rect_covers((-895.0, -1080.0, 1025.0, 0.0), MAIN));
    }

    #[test]
    fn slight_oversizing_still_counts_but_a_visible_menu_bar_does_not() {
        // Browsers oversize the fullscreen frame a little; that still counts.
        assert!(rect_covers((0.0, -1.0, 1512.0, 983.0), MAIN));
        // A plain maximised window leaves the menu bar (or taskbar) visible.
        assert!(!rect_covers((0.0, 25.0, 1512.0, 982.0), MAIN));
        assert!(!rect_covers((0.0, 0.0, 1512.0, 957.0), MAIN));
    }
}
