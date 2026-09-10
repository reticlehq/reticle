/**
 * Which of Reticle's own layers sits above which, on the page.
 *
 * One number, alone in a file with nothing imported, and the reason is worth stating. It used to
 * live beside the panel's stylesheet, and the annotator needed it -- so naming a z-index dragged the
 * whole panel's CSS into every page load, whether or not anybody ever opened the panel. That was a
 * hundred kilobytes reached through one integer.
 *
 * Anything that has to sit above the panel adds to this rather than picking its own big number, so
 * there is one place to look when two things fight over who is on top.
 */

/**
 * The panel's own layer.
 *
 * It holds the shield that stops clicks reaching the page while an agent is driving, so anything
 * meant to stay usable must be above it. That is not theoretical: the note-taking box was buried
 * underneath it once, and its buttons could not be clicked at all.
 */
export const Z_OVERLAY = 2147483600;
