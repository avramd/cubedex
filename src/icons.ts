// Shared UI icon glyphs. Use these constants in TS so we never have
// the same action shown with two different icons across the app.
//
// HTML usages can't import these, so when changing a value here, also
// update any literal in index.html. Current HTML usages:
//   #net-copy-btn, #fs-copy-scramble-btn    → COPY_ICON
//   #net-paste-btn, #fs-paste-scramble-btn  → PASTE_ICON

export const COPY_ICON = '⧉';
export const PASTE_ICON = '📋';
