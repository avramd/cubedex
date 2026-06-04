// Shared UI icon glyphs. Use these constants in TS so we never have
// the same action shown with two different icons across the app.
//
// HTML usages can't import these, so when changing a value here, also
// update any literal in index.html. Current HTML usages:
//   #net-copy-btn, #fs-copy-scramble-btn    → COPY_ICON
//   #net-paste-btn, #fs-paste-scramble-btn  → PASTE_ICON
//   #fs-receive-share-btn                    → SHARE_IN_SVG

export const COPY_ICON = '⧉';
export const PASTE_ICON = '📋';

// Line-art tray + arrow icons matching the iOS / Material share +
// download convention. Stroke uses `currentColor` so they inherit the
// button text color in both light and dark themes.
const SHARE_SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4 inline-block">';
const SHARE_SVG_CLOSE = '</svg>';
const SHARE_TRAY = '<path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8"/>';
// Box with up-arrow — "send / share out".
export const SHARE_OUT_SVG =
  SHARE_SVG_OPEN + SHARE_TRAY + '<polyline points="7,8 12,3 17,8"/><line x1="12" y1="3" x2="12" y2="15"/>' + SHARE_SVG_CLOSE;
// Box with down-arrow — "receive / share in".
export const SHARE_IN_SVG =
  SHARE_SVG_OPEN + SHARE_TRAY + '<polyline points="7,10 12,15 17,10"/><line x1="12" y1="3" x2="12" y2="15"/>' + SHARE_SVG_CLOSE;
