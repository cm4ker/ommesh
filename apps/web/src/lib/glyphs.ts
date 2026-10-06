/**
 * The node kinds' glyphs and a private channel's lock, as SVG markup on a
 * 24-unit square, stroked at 1.75. `Icons.tsx` draws them in the page;
 * `noticeAvatar.ts` draws a notification's circle from the same markup on a
 * canvas.
 */

/** A tower on two legs with waves around its top: it stands in one place and passes everything on. The air mark is a mast on one pole, so the legs keep the two apart. */
export const REPEATER_GLYPH =
  '<circle cx="12" cy="8" r="1.5" fill="currentColor"/><path d="M8.5 21L12 10.5 15.5 21"/><path d="M9.2 5.2a4 4 0 0 0 0 5.6M14.8 5.2a4 4 0 0 1 0 5.6"/><path d="M6.7 2.7a7.5 7.5 0 0 0 0 10.6M17.3 2.7a7.5 7.5 0 0 1 0 10.6"/>';
export const ROOM_GLYPH = '<path d="M4 20V8l8-5 8 5v12z"/><path d="M10 20v-6h4v6"/>';
export const SENSOR_GLYPH = '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>';
export const LOCK_GLYPH = '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
/** The lock with its shackle open: the chat of messages sent without a key, which any radio reads. */
export const UNLOCK_GLYPH = '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 0 1 7.46-2"/>';
