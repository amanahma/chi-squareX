// ─── Reject Reason Categories ─────────────────────────────────────────────────
// Used for per-category rejection tracking in the caption pipeline.
export const REJECT_REASON = Object.freeze({
  UI_MENU_TEXT:              'UI_MENU_TEXT',
  BUTTON_LABEL:              'BUTTON_LABEL',
  DUPLICATE_INCREMENTAL:     'DUPLICATE_INCREMENTAL',
  INVALID_CANDIDATE_NODE:    'INVALID_CANDIDATE_NODE',
  EMPTY_AFTER_NORMALIZATION: 'EMPTY_AFTER_NORMALIZATION',
  EXCESSIVE_LENGTH:          'EXCESSIVE_LENGTH',
  STALE_REPEAT:              'STALE_REPEAT',
  SHORTTEXT:                 'SHORTTEXT',
  SYSTEM_ANNOUNCEMENT:       'SYSTEM_ANNOUNCEMENT',
});

// ─── Strict Caption Selectors (high-confidence live caption nodes only) ────────
// These are ordered from most-specific (safest) to least-specific.
// The observer will only attach to nodes matching these selectors.
// Do NOT include broad containers like [aria-live="polite"] in this list —
// those are used for scoring/discovery only, never for direct observation targets.
export const CAPTION_STRICT_SELECTORS = [
  // Semantic: aria-live + caption/subtitle class (highest confidence)
  '[aria-live="polite"][class*="caption"]',
  '[aria-live="assertive"][class*="caption"]',
  '[aria-live="polite"][class*="subtitle"]',
  '[aria-live="assertive"][class*="subtitle"]',
  // aria-atomic caption-class blocks (Google Meet pattern)
  '[class*="caption"][aria-atomic]',
  '[class*="subtitle"][aria-atomic]',
  // Known Google Meet obfuscated class names (rotated periodically)
  '.a4cQT',
  '.TBMuR',
  '.iOzk7',
  '.bh44bd',
  '.zs7s8d',
  '.iTTPOb',
  // jsname + aria-live (Meet-specific combined pattern)
  '[jsname][aria-live="polite"]',
  '[jsname][aria-live="assertive"]',
];

// ─── Caption Container Selectors ───────────────────────────────────────────────
// Used for broad discovery scanning only — NOT for observer attachment.
// Ordered by specificity (most precise first).
export const CAPTION_CONTAINER_SELECTORS = [
  ...CAPTION_STRICT_SELECTORS,
  // Broad aria-live capture (any live region — for discovery fallback only)
  '[aria-live="polite"][role="region"]',
  '[aria-live="assertive"][role="region"]',
  // Generic aria-live (very broad — discovery only, never used for observer target)
  '[aria-live="polite"]',
  '[aria-live="assertive"]',
];

// ─── Caption Text Selectors ────────────────────────────────────────────────────
// Used to extract the actual spoken text node within a caption container.
// These are inner-node selectors, not container selectors.
export const CAPTION_TEXT_SELECTORS = [
  '[aria-live="polite"][class*="caption"] span',
  '[aria-live="assertive"][class*="caption"] span',
  '[aria-live="polite"][class*="subtitle"] span',
  '[aria-live="assertive"][class*="subtitle"] span',
  '[data-message-text][class*="caption"]',
  '.a4cQT span',
  '.TBMuR span',
  '.iOzk7 span',
  '.bh44bd .zs7s8d',
  '.zs7s8d',
  '.iTTPOb span',
  '[jsname][aria-live="polite"] span',
  '[jsname][aria-live="assertive"] span',
  // Note: broad [aria-live] span selectors are intentionally omitted here
];

// ─── Caption UI Exclusion Selectors ───────────────────────────────────────────
// Nodes matching these are UI chrome, not live caption text.
// Used both in the observer filter and the polling loop.
export const CAPTION_UI_EXCLUDE_SELECTORS = [
  '[role="dialog"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="tooltip"]',
  '[role="navigation"]',
  '[role="toolbar"]',
  '[aria-label*="settings" i]',
  '[aria-label*="caption settings" i]',
  '[data-tooltip*="settings" i]',
  '[data-tooltip*="caption settings" i]',
  '[class*="menu"]',
  '[class*="Menu"]',
  '[class*="settings"]',
  '[class*="Settings"]',
  '[class*="tooltip"]',
  '[class*="Tooltip"]',
  '[class*="toolbar"]',
  '[class*="Toolbar"]',
  'button',
  'label',
  '[role="button"]',
  'header',
  'nav',
];

// ─── Speaker Selectors (sibling-aware) ────────────────────────────────────────
// Google Meet puts the speaker name in a SIBLING element, not an ancestor.
// These selectors are tried on the caption node's parent to find the speaker span.
export const CAPTION_SPEAKER_SIBLING_SELECTORS = [
  // Direct Meet speaker label jsname patterns
  '[jsname="tgaKEf"]',
  '[jsname="r8qRAd"]',
  // Class-based speaker labels
  '[class*="speaker"]',
  '[class*="Speaker"]',
  '[class*="sender"]',
  '[class*="participantName"]',
];

// ─── Speaker Ancestor Selectors (fallback) ─────────────────────────────────────
// Try these on the caption node's parent (ancestor traversal)
export const CAPTION_SPEAKER_SELECTORS = [
  '[data-self-name]',
  '[data-participant-name]',
  '[class*="speaker"]',
  '[class*="Speaker"]',
];

// ─── Discovery Heuristics ──────────────────────────────────────────────────────
// Used by discoverCaptionCandidates() for scoring live DOM candidates.
// A node scores higher if it matches more of these patterns.
export const CAPTION_DISCOVERY_SCORE_RULES = [
  // Highest signal — semantic live regions
  { selector: '[aria-live="polite"]',    score: 30 },
  { selector: '[aria-live="assertive"]', score: 30 },
  // Caption-related class or attribute
  { selector: '[class*="caption"]',      score: 20 },
  { selector: '[class*="subtitle"]',     score: 20 },
  { selector: '[aria-atomic]',           score: 10 },
  // Known obfuscated class names (high confidence)
  { selector: '.a4cQT',                  score: 35 },
  { selector: '.TBMuR',                  score: 35 },
  { selector: '.iOzk7',                  score: 35 },
  { selector: '.bh44bd',                 score: 35 },
  { selector: '.zs7s8d',                 score: 35 },
  { selector: '.iTTPOb',                 score: 35 },
  // Structural jsname attribute (Meet-specific)
  { selector: '[jsname]',                score: 5  },
  // Combined jsname + aria-live (very specific)
  { selector: '[jsname][aria-live]',     score: 20 },
];

// ─── UI Noise Text Patterns ───────────────────────────────────────────────────
// These are compiled regex patterns used by isLikelyUiCaptionNoise().
// Match against lowercased, trimmed text.
// IMPORTANT: Use ^ and $ anchors or \b word boundaries — do NOT use broad includes()
// to avoid false-positives on legitimate speech (e.g., "language" in a sentence).
export const UI_NOISE_EXACT_TERMS = new Set([
  'settings',
  'caption settings',
  'captions',
  'closed captions',
  'auto-generated captions',
  'auto generated captions',
  'cc',
  'subtitle',
  'subtitles',
  'language',
  'font size',
  'text color',
  'background color',
  'open caption settings',
  'close caption settings',
  'turn on captions',
  'turn off captions',
  'enable captions',
  'disable captions',
  'white',
  'black',
  'blue',
  'red',
  'yellow',
  'cyan',
  'magenta',
  'small',
  'medium',
  'large',
  'extra large',
  'button',
  'menu',
  'tooltip',
  'label',
  'more options',
  'jump to bottom',
  'arrow_downward',
  'open',
  'close',
  'ok',
  'cancel',
  'done',
]);

export const UI_NOISE_REGEX_PATTERNS = [
  // Language names as standalone text (not in a sentence)
  /^(english|hindi|spanish|french|german|italian|portuguese|japanese|korean|chinese|arabic|russian|dutch|swedish|polish|turkish|vietnamese|thai|malay|indonesian)(\s*,\s*|\s*$)/i,
  // Font/size labels
  /^(small|medium|large|extra large)\s*(font|size|text)?$/i,
  // Color labels  
  /^(white|black|blue|red|yellow|cyan|magenta|green|gray|grey)(\s+(text|background|color))?$/i,
  // Caption control labels
  /^(caption|captions|subtitle|subtitles)\s*(settings?|style|language|options?|on|off)?$/i,
  // Auto-generated caption header
  /^auto.?generated\s+captions?.*/i,
  // Standalone button/UI labels
  /^(button|menu|label|tooltip|tab|more\s+options?)$/i,
  // Empty or only whitespace/symbols
  /^[\s\W]{0,3}$/,
  // Timestamps-only (MM:SS or HH:MM:SS)
  /^\d{1,2}:\d{2}(:\d{2})?$/,
  // Arrow symbols that leak into text content
  /^arrow_(downward|upward|forward|back)$/i,
  // Join/leave meeting labels that appear as captions
  /^(join|leave|end)\s+(meeting|call|now)$/i,
];

// ─── Caption Classification ──────────────────────────────────────────────────
// Used to classify each caption event as real speech vs system noise.
export const CAPTION_CLASSIFICATION = Object.freeze({
  SPOKEN_CAPTION:          'spoken_caption',
  UI_SYSTEM_ANNOUNCEMENT:  'ui_system_announcement',
  UNKNOWN_TEXT:             'unknown_text',
});

// ─── Shared Video Failure Reasons ────────────────────────────────────────────
// Used when a shared-screen video meeting produces no real spoken captions.
export const SHARED_VIDEO_FAILURE_REASONS = Object.freeze({
  SHARED_VIDEO_AUDIO_NOT_CAPTIONED: 'SHARED_VIDEO_AUDIO_NOT_CAPTIONED',
  ONLY_UI_ANNOUNCEMENTS_CAPTURED:   'ONLY_UI_ANNOUNCEMENTS_CAPTURED',
});

// ─── Meet System / Accessibility Announcement Patterns ───────────────────────
// These are Google Meet status, accessibility, and system-generated messages
// that appear in aria-live regions. They are NOT spoken speech.
// Each regex is tested against lowercased, trimmed text.
export const MEET_SYSTEM_ANNOUNCEMENT_PATTERNS = [
  // Camera / microphone status
  /^your (camera|microphone|mic) is (off|on|muted)$/i,
  /^your (camera|microphone|mic) is turned (off|on)$/i,
  /^(camera|microphone|mic) (is )?(off|on|muted)$/i,
  /^you('re| are) (now )?muted$/i,
  /^you('re| are) (now )?unmuted$/i,

  // Call join/leave announcements
  /^you (have |ha(ve|s) )?(joined|left) the (call|meeting)/i,
  /^.{1,60} (joined|left|has joined|has left) the (call|meeting)/i,
  /^.{1,60} (joined|left)$/i,

  // Participant count status
  /^there (is|are) \d+ other (person|people|participant)/i,
  /^you'?re the only one (here|in the (call|meeting))/i,
  /^waiting for others to join/i,
  /^no one else is here/i,

  // Hand raise status
  /^your hand is (raised|lowered)$/i,
  /^.{1,60} (raised|lowered) (their|a) hand$/i,

  // Video/screen presentation layout
  /^video for .{1,60} was (added to|removed from) the main screen/i,
  /^.{1,60} is (now )?presenting/i,
  /^you (are|'re) (now )?presenting/i,
  /^you stopped presenting/i,
  /^.{1,60} stopped presenting/i,
  /^presenting to everyone/i,
  /^screen sharing/i,

  // Recording status
  /^recording (has )?(started|stopped|is on|is off)/i,
  /^this (call|meeting) is (being )?recorded/i,

  // Captions status
  /^live captions (have been |are )?(turned on|turned off|enabled|disabled)/i,
  /^captions (are )?(now )?(on|off|active|enabled|disabled)/i,

  // Admission / waiting room
  /^.{1,60} (is asking|wants|asked) to join/i,
  /^someone (is asking|wants) to join/i,
  /^you('ve| have) been admitted/i,
  /^waiting for (the )?host/i,

  // Chat messages notification
  /^.{1,60} sent a message/i,
  /^new message from .{1,60}/i,
  /^chat message/i,

  // Network / quality warnings
  /^your (connection|network) (is )?(unstable|poor|weak)/i,
  /^(connection|network) (is )?(unstable|poor|weak)/i,

  // Breakout rooms
  /^you('ve| have) been (moved|added) to/i,
  /^breakout room/i,

  // Misc system text
  /^the meeting has been (locked|unlocked)/i,
  /^you('ve| have) been (removed|kicked|muted by)/i,
  /^the host (has )?(ended|closed) the (call|meeting)/i,
  /^this meeting (has )?ended/i,
  /^rejoin/i,
  /^return to home/i,
];

// ─── Joined selector strings ───────────────────────────────────────────────────
export const CAPTION_CONTAINER_SELECTOR  = CAPTION_CONTAINER_SELECTORS.join(', ');
export const CAPTION_STRICT_SELECTOR    = CAPTION_STRICT_SELECTORS.join(', ');
export const CAPTION_TEXT_SELECTOR       = CAPTION_TEXT_SELECTORS.join(', ');
export const CAPTION_SPEAKER_SELECTOR    = CAPTION_SPEAKER_SELECTORS.join(', ');
export const CAPTION_SPEAKER_SIBLING_SELECTOR = CAPTION_SPEAKER_SIBLING_SELECTORS.join(', ');
export const CAPTION_UI_EXCLUDE_SELECTOR = CAPTION_UI_EXCLUDE_SELECTORS.join(', ');
