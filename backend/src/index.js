/**
 * Google Meet AI Scribe — Backend API Server
 *
 * Features:
 * - SQLite persistent storage
 * - JWT authentication
 * - Real browser automation via puppeteer-core + system Chrome
 * - Gemini API integration for transcript summarization
 * - Honest status lifecycle — no fake transcripts or summaries
 */

import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import http from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import puppeteer from 'puppeteer';
import { summarizeTranscript, validateAndTrimTranscript } from './services/summarizationService.js';
import { createMeetingAudioRecorder } from './services/audioRecordingService.js';
import { createTranscriptionService } from './services/transcription/transcriptionService.js';
import { mergeTranscriptSources, serializeCaptionChunks, formatChunksAsPlainText } from './services/transcriptMergeService.js';
import {
  CAPTION_CONTAINER_SELECTOR,
  CAPTION_CONTAINER_SELECTORS,
  CAPTION_STRICT_SELECTOR,
  CAPTION_STRICT_SELECTORS,
  CAPTION_TEXT_SELECTOR,
  CAPTION_TEXT_SELECTORS,
  CAPTION_UI_EXCLUDE_SELECTOR,
  CAPTION_UI_EXCLUDE_SELECTORS,
  CAPTION_SPEAKER_SIBLING_SELECTORS,
  CAPTION_DISCOVERY_SCORE_RULES,
  REJECT_REASON,
  UI_NOISE_EXACT_TERMS,
  UI_NOISE_REGEX_PATTERNS,
  CAPTION_CLASSIFICATION,
  MEET_SYSTEM_ANNOUNCEMENT_PATTERNS,
  SHARED_VIDEO_FAILURE_REASONS,
} from './services/meetCaptionSelectors.js';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEV_PORT_FILE = join(__dirname, '..', '.dev-port');

const PORT = Number(process.env.PORT || 5001);
const SECRET_KEY = process.env.SECRET_KEY || 'dev-secret-key';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const DB_PATH = process.env.DATABASE_PATH || join(__dirname, '..', 'meetai.db');
const transcriptionService = createTranscriptionService({
  openAiApiKey: process.env.OPENAI_API_KEY || '',
});
const DEBUG_ENDPOINT = 'http://127.0.0.1:7508/ingest/1fbf82a7-26e0-4f30-88c3-f3997b9523be';
const DEBUG_SESSION_ID = 'fdd05c';
let isProcessShuttingDown = false;

// ─── Chrome Detection ─────────────────────────────────────────────────────────

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  // Edge (Chromium) — works identically for puppeteer-core
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}/Microsoft/Edge/Application/msedge.exe`,
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

function findChromePath() {
  // 1. Check hardcoded candidates (local dev / system Chrome)
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  // 2. Fallback to Puppeteer's own downloaded browser (necessary for Render/Linux)
  try {
    const pPath = puppeteer.executablePath();
    if (pPath && existsSync(pPath)) return pPath;
  } catch (_) {}
  
  return null;
}

// CHROME_PATH is resolved lazily inside the bot worker so that
// puppeteer's browser download (during build) completes before we look for it.
let _chromePath = undefined; // undefined = not yet resolved, null = not found
function getChromePath() {
  if (_chromePath !== undefined) return _chromePath;
  _chromePath = findChromePath();
  console.log(_chromePath
    ? `[chrome] Found browser: ${_chromePath}`
    : '[chrome] No system browser found — will rely on puppeteer bundled Chromium'
  );
  return _chromePath;
}

// ─── Database Setup ───────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meetings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    meet_link TEXT NOT NULL,
    meeting_code TEXT,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    transcript TEXT,
    raw_caption_transcript TEXT,
    raw_caption_chunks_json TEXT,
    raw_audio_transcript TEXT,
    merged_transcript TEXT,
    preview_transcript TEXT,
    transcript_metadata_json TEXT,
    failure_reason_code TEXT,
    last_stage TEXT,
    audio_file_path TEXT,
    summary_json TEXT,
    raw_output TEXT,
    error_message TEXT,
    bot_log TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    joined_at TEXT,
    completed_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_meetings_user_id ON meetings(user_id);
`);

// Migrate existing DBs
try { db.exec('ALTER TABLE meetings ADD COLUMN bot_log TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE meetings ADD COLUMN joined_at TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE meetings ADD COLUMN completed_at TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE meetings ADD COLUMN raw_caption_transcript TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE meetings ADD COLUMN raw_caption_chunks_json TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE meetings ADD COLUMN raw_audio_transcript TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE meetings ADD COLUMN merged_transcript TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE meetings ADD COLUMN preview_transcript TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE meetings ADD COLUMN transcript_metadata_json TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE meetings ADD COLUMN failure_reason_code TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE meetings ADD COLUMN last_stage TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE meetings ADD COLUMN audio_file_path TEXT'); } catch (_) {}

// ─── Stale Meeting Cleanup (on startup) ──────────────────────────────────────
// If the server crashed or was restarted while meetings were in progress,
// those meetings would be stuck. Mark them as failed with useful messages.
{
  const IN_PROGRESS = ['pending', 'launching_browser', 'opening_meet', 'joining', 'joining_meet',
    'waiting_for_admission', 'capturing_transcript', 'transcribing', 'summarizing', 'processing',
    'chunking_transcript', 'summarizing_chunks', 'merging_summaries',
    'recording_audio', 'transcribing_audio', 'merging_transcript', 'generating_summary'];
  const ph = IN_PROGRESS.map(() => '?').join(',');

  // Meetings that already have a transcript (interrupted during summarization):
  // tell the user their transcript is safe and they can retry to re-summarize.
  const staleWithTranscript = db.prepare(
    `UPDATE meetings
     SET status = 'failed',
         error_message = 'Server was restarted during summarization. Your transcript is saved — click Retry to re-summarize without re-joining.',
         updated_at = ?, completed_at = ?
     WHERE status IN (${ph})
       AND transcript IS NOT NULL AND length(transcript) > 0`
  ).run(now(), now(), ...IN_PROGRESS);

  // Meetings with no transcript (interrupted during bot join / capture):
  // generic restart message.
  const staleNoTranscript = db.prepare(
    `UPDATE meetings
     SET status = 'failed',
         error_message = 'Server was restarted while the bot was joining the meeting. Use Retry to try again, or paste your transcript manually.',
         updated_at = ?, completed_at = ?
     WHERE status IN (${ph})
       AND (transcript IS NULL OR length(transcript) = 0)`
  ).run(now(), now(), ...IN_PROGRESS);

  const total = staleWithTranscript.changes + staleNoTranscript.changes;
  if (total > 0) {
    console.log(`[startup] Cleaned up ${total} stale meeting(s): ${staleWithTranscript.changes} with transcript, ${staleNoTranscript.changes} without.`);
  }
}

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
process.once('SIGTERM', () => {
  isProcessShuttingDown = true;
  console.warn('[process] SIGTERM received — dev reload or shutdown in progress');
});
process.once('SIGINT', () => {
  isProcessShuttingDown = true;
  console.warn('[process] SIGINT received — shutdown in progress');
});

app.use(
  cors({
    origin: [
      'http://localhost:5173', 'http://localhost:5174',
      'http://127.0.0.1:5173', 'http://127.0.0.1:5174',
      'http://localhost:3000',
      'https://amanahmad.netlify.app',
    ],
    credentials: true,
  })
);
app.use(express.json({ limit: '5mb' }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function meetingCodeFromLink(meetLink) {
  if (!isNonEmptyString(meetLink)) return null;
  const match = meetLink.match(/meet\.google\.com\/([a-zA-Z0-9-]+)/);
  return match?.[1] || null;
}

function getUserIdFromJwtPayload(payload) {
  return payload?.user_id || payload?.userId || null;
}

function now() {
  return new Date().toISOString();
}

function extractSpeakersFromTranscript(transcript) {
  if (!isNonEmptyString(transcript)) return [];
  const speakers = new Set();
  for (const line of transcript.split('\n')) {
    const match = line.match(/\]\s*([^:\n]{1,60}):/);
    if (match) speakers.add(match[1].trim());
  }
  return [...speakers];
}

function getTranscriptThresholdConfig() {
  return {
    minChars: Number(process.env.MIN_TRANSCRIPT_CHARS || 80),
    minLines: Number(process.env.MIN_TRANSCRIPT_LINES || 2),
    minChunks: Number(process.env.MIN_TRANSCRIPT_CHUNKS || 2),
  };
}

function isTranscriptValidForSummary(transcript, metrics = {}) {
  if (!isNonEmptyString(transcript)) return false;
  const cleaned = transcript.trim();
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
  const { minChars, minLines, minChunks } = getTranscriptThresholdConfig();
  // Use spokenCaptionCount if available (only real speech counts toward threshold),
  // otherwise fall back to captionChunkCount for backwards compat.
  const chunkCount = Number(metrics.spokenCaptionCount ?? metrics.captionChunkCount ?? 0);
  // Integrity guard: very short captures often produce hallucinated summaries.
  return cleaned.length >= minChars && lines.length >= minLines && chunkCount >= minChunks;
}

function shouldAppendCaptionChunk(text, chunks) {
  if (!isNonEmptyString(text)) return false;
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length < 2) return false;
  // Conservative dedupe: only drop exact immediate duplicates.
  const prev = chunks[chunks.length - 1];
  if (prev && prev.text === normalized) return false;
  return true;
}

/**
 * Categorized UI noise detection.
 * Returns { isNoise: boolean, reason: REJECT_REASON | null }.
 * Uses EXACT patterns from meetCaptionSelectors.js — does NOT use broad includes().
 * Max text length enforced here: captions > 280 chars are accumulated DOM blobs.
 */
function classifyCaption(rawText) {
  const t = String(rawText || '').trim();
  if (!t || t.length === 0) return { isNoise: true, reason: REJECT_REASON.EMPTY_AFTER_NORMALIZATION };
  if (t.length < 2)          return { isNoise: true, reason: REJECT_REASON.SHORTTEXT };
  // Accumulated text blobs from DOM: real utterances are < 280 chars
  if (t.length > 280)        return { isNoise: true, reason: REJECT_REASON.EXCESSIVE_LENGTH };

  const lower = t.toLowerCase();

  // Exact match against known UI noise terms
  if (UI_NOISE_EXACT_TERMS.has(lower)) return { isNoise: true, reason: REJECT_REASON.UI_MENU_TEXT };

  // Regex pattern match
  for (const re of UI_NOISE_REGEX_PATTERNS) {
    if (re.test(lower)) return { isNoise: true, reason: REJECT_REASON.UI_MENU_TEXT };
  }

  // Button/label heuristic: very short text that looks like a UI label
  if (t.length <= 12 && /^[A-Z][a-z]+$/.test(t)) {
    // Single capitalized word ≤ 12 chars → likely a button label
    return { isNoise: true, reason: REJECT_REASON.BUTTON_LABEL };
  }

  return { isNoise: false, reason: null };
}

/**
 * Classify a caption event into one of:
 *   spoken_caption          — real meeting speech
 *   ui_system_announcement  — Google Meet status/accessibility text
 *   unknown_text            — noise that doesn't match a known pattern
 *
 * Returns { classification, isNoise, reason }.
 * This wraps and extends classifyCaption() by first checking
 * MEET_SYSTEM_ANNOUNCEMENT_PATTERNS.
 */
function classifyCaptionEvent(rawText) {
  const t = String(rawText || '').trim();
  if (!t) {
    return {
      classification: CAPTION_CLASSIFICATION.UNKNOWN_TEXT,
      isNoise: true,
      reason: REJECT_REASON.EMPTY_AFTER_NORMALIZATION,
    };
  }

  // 1. Check Meet system/accessibility announcement patterns first
  const lower = t.toLowerCase();
  for (const re of MEET_SYSTEM_ANNOUNCEMENT_PATTERNS) {
    if (re.test(lower)) {
      return {
        classification: CAPTION_CLASSIFICATION.UI_SYSTEM_ANNOUNCEMENT,
        isNoise: true,
        reason: REJECT_REASON.SYSTEM_ANNOUNCEMENT,
      };
    }
  }

  // 2. Run existing noise classifier
  const { isNoise, reason } = classifyCaption(t);
  if (isNoise) {
    // UI menu text and button labels are system-level noise
    const isSystemLike = reason === REJECT_REASON.UI_MENU_TEXT || reason === REJECT_REASON.BUTTON_LABEL;
    return {
      classification: isSystemLike
        ? CAPTION_CLASSIFICATION.UI_SYSTEM_ANNOUNCEMENT
        : CAPTION_CLASSIFICATION.UNKNOWN_TEXT,
      isNoise: true,
      reason,
    };
  }

  // 3. Passed all checks → real spoken caption
  return {
    classification: CAPTION_CLASSIFICATION.SPOKEN_CAPTION,
    isNoise: false,
    reason: null,
  };
}

// Keep old name as a boolean wrapper for callers that don't need the reason
function isLikelyUiCaptionNoise(rawText) {
  return classifyCaption(rawText).isNoise;
}

function normalizeCaptionText(rawText) {
  let text = String(rawText || '').replace(/\s+/g, ' ').trim();
  text = text
    .replace(/arrow_downward/gi, '')
    .replace(/jump to bottom/gi, '')
    .replace(/\b(button|menu|settings)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

function normalizeSpeakerName(rawSpeaker) {
  return String(rawSpeaker || '').replace(/\s+/g, ' ').trim();
}

function splitSpeakerAndText({ rawText, rawSpeaker }) {
  const speaker = normalizeSpeakerName(rawSpeaker);
  let text = normalizeCaptionText(rawText);
  if (speaker && text.toLowerCase().startsWith(speaker.toLowerCase())) {
    text = text.slice(speaker.length).trim();
  }
  return { speaker, text };
}

/**
 * Normalize text for fuzzy comparison:
 * - lowercase
 * - strip trailing punctuation (.,!?;:)
 * - collapse whitespace
 * This allows "That's a bad." and "That's a bad sequence" to be compared correctly.
 */
function normalizeForComparison(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[.,!?;:'"]+$/g, '')   // strip trailing punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute a simple prefix-similarity ratio.
 * Returns the fraction of `shorter` that is a prefix of `longer` (0–1).
 * Used to catch minor punctuation differences in incremental captions.
 */
function prefixSimilarity(a, b) {
  const na = normalizeForComparison(a);
  const nb = normalizeForComparison(b);
  if (!na || !nb) return 0;
  const shorter = na.length <= nb.length ? na : nb;
  const longer  = na.length <= nb.length ? nb : na;
  // How many chars of `shorter` match a prefix of `longer`?
  let i = 0;
  while (i < shorter.length && shorter[i] === longer[i]) i++;
  return shorter.length > 0 ? i / shorter.length : 0;
}

/**
 * Utterance merge decision:
 * Returns one of:
 *   'merged_extension'   — new text is a longer version of previous utterance
 *   'merged_replacement' — new text replaces previous (correction / shortersame)
 *   'merged_duplicate'   — exact duplicate
 *   'new_utterance'      — new text is a separate utterance (append as new chunk)
 *
 * Merge happens when ALL conditions hold:
 *   (a) same speaker (or both null), AND
 *   (b) < UTTERANCE_MERGE_WINDOW_MS elapsed since last update, AND
 *   (c) text is an extension, correction, or near-duplicate of previous
 *
 * UTTERANCE_MERGE_WINDOW_MS = 30s — Google Meet can keep building one utterance
 * for up to ~20–25s before finalizing it, so we need a generous window.
 */
const UTTERANCE_MERGE_WINDOW_MS = 30_000;

function classifyMerge(prev, text, speaker, nowMs) {
  if (!prev) return 'new_utterance';

  // Speaker mismatch → new utterance (never merge across speakers)
  const prevSpeaker = prev.speaker || '';
  const curSpeaker  = speaker || '';
  if (prevSpeaker !== curSpeaker) return 'new_utterance';

  // Time gap exceeded → finalize previous utterance, start fresh
  const elapsed = nowMs - (prev.tsMs || 0);
  if (elapsed > UTTERANCE_MERGE_WINDOW_MS) return 'new_utterance';

  const prevNorm = normalizeForComparison(prev.text);
  const curNorm  = normalizeForComparison(text);

  // Exact duplicate
  if (prev.text === text) return 'merged_duplicate';

  // Normalized duplicate (only punctuation/case differs)
  if (prevNorm === curNorm) return 'merged_duplicate';

  // Extension: new text starts with prev text (after stripping trailing punct)
  // e.g. prev="That's a bad" → cur="That's a bad sequence and moreover"
  if (curNorm.startsWith(prevNorm) && curNorm.length > prevNorm.length) return 'merged_extension';

  // Also try raw startsWith (exact prefix)
  if (text.startsWith(prev.text) && text.length > prev.text.length) return 'merged_extension';

  // Reverse extension: prev text starts with new text (caption got shorter — correction)
  // e.g. prev="That's a bad sequence." → cur="That's a bad sequence" (trimmed punct)
  if (prevNorm.startsWith(curNorm) && curNorm.length >= prevNorm.length * 0.6) return 'merged_replacement';

  // Fuzzy prefix: new text shares >= 75% prefix similarity with prev
  // Catches minor mid-word corrections, punctuation changes
  const sim = prefixSimilarity(prev.text, text);
  if (sim >= 0.75) {
    // Pick the longer version as the "winner"
    return text.length >= prev.text.length ? 'merged_extension' : 'merged_replacement';
  }

  // No merge condition met → new utterance
  return 'new_utterance';
}

function appendOrMergeCaptionChunk({ captionChunks, captionTexts, speaker, text, source }) {
  if (!text) return { action: 'skip_empty', index: -1 };
  const nowMs  = Date.now();
  const nowIso = new Date().toISOString();
  const prev   = captionChunks[captionChunks.length - 1];

  const decision = classifyMerge(prev, text, speaker, nowMs);

  if (decision === 'merged_extension' || decision === 'merged_replacement') {
    // Update the active utterance in-place
    const keepText = decision === 'merged_replacement' && prev.text.length > text.length
      ? prev.text   // keep longer version when new text is a trimmed correction
      : text;       // otherwise take the newer (longer) text
    prev.text      = keepText;
    prev.ts        = nowIso;
    prev.tsMs      = nowMs;
    prev.updateCount  = (prev.updateCount || 0) + 1;
    prev.partialCount = (prev.partialCount || 0) + 1;
    prev.source    = `${prev.source || source}_${decision}`;
    const formatted = speaker ? `[${nowIso}] ${speaker}: ${keepText}` : keepText;
    captionTexts[captionTexts.length - 1] = formatted;
    return { action: decision, index: captionChunks.length - 1 };
  }

  if (decision === 'merged_duplicate') {
    // Refresh timestamp so window keeps extending for this utterance
    prev.tsMs = nowMs;
    prev.partialCount = (prev.partialCount || 0) + 1;
    return { action: 'merged_duplicate', index: captionChunks.length - 1 };
  }

  // New utterance: finalize previous (it's already in captionTexts as-is) and append
  captionChunks.push({
    ts: nowIso,
    tsMs: nowMs,
    text,
    speaker: speaker || null,
    source,
    updateCount: 0,
    partialCount: 0,
  });
  captionTexts.push(speaker ? `[${nowIso}] ${speaker}: ${text}` : text);
  return { action: 'appended', index: captionChunks.length - 1 };
}


function emitDebugLog(payload) {
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': DEBUG_SESSION_ID,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      timestamp: Date.now(),
      ...payload,
    }),
  }).catch(() => {});
  // #endregion
}

function updateMeeting(id, fields) {
  const sets = Object.keys(fields).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE meetings SET ${sets}, updated_at = @_now WHERE id = @_id`).run({
    ...fields, _now: now(), _id: id,
  });
}

function asMeetingResponse(row) {
  if (!row) return null;
  let summary = null;
  try { summary = row.summary_json ? JSON.parse(row.summary_json) : null; } catch (_) {}
  let transcriptMeta = null;
  try { transcriptMeta = row.transcript_metadata_json ? JSON.parse(row.transcript_metadata_json) : null; } catch (_) {}

  // Parse bot_log — new meetings store a JSON array (activity log);
  // old meetings store plain text. Both must work without crashing.
  let activityLog = null;
  let botLog = null;
  if (row.bot_log) {
    try {
      const parsed = JSON.parse(row.bot_log);
      if (Array.isArray(parsed)) activityLog = parsed;
      else botLog = row.bot_log; // valid JSON but not an array — treat as text
    } catch (_) {
      botLog = row.bot_log; // plain text (old format)
    }
  }

  return {
    id: row.id,
    userId: row.user_id,
    meetLink: row.meet_link,
    meetingCode: row.meeting_code,
    title: row.title,
    status: row.status,
    transcript: row.transcript || null,
    rawCaptionTranscript: row.raw_caption_transcript || null,
    rawCaptionChunksJson: row.raw_caption_chunks_json || null,
    rawAudioTranscript: row.raw_audio_transcript || null,
    mergedTranscript: row.merged_transcript || null,
    previewTranscript: row.preview_transcript || null,
    transcriptMeta,
    failureReasonCode: row.failure_reason_code || null,
    lastStage: row.last_stage || null,
    audioFilePath: row.audio_file_path || null,
    summary,
    // Flat schema fields (new summaries)
    summaryText:  summary?.summary      ?? null,
    keyPoints:    summary?.keyPoints     ?? null,
    actionItems:  summary?.actionItems   ?? null,
    participants: summary?.participants  ?? null,
    // Legacy nested fields (backwards compat for old summaries)
    topics:       summary?.topics        ?? null,
    decisions:    summary?.decisions     ?? null,
    keyTakeaways: summary?.key_takeaways ?? null,
    // Activity log: JSON array (new) OR plain text string (old)
    activityLog,
    botLog,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    joinedAt: row.joined_at || null,
    completedAt: row.completed_at || null,
  };
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Token is missing' });

  try {
    const payload = jwt.verify(token, SECRET_KEY);
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Gemini Summarization ─────────────────────────────────────────────────────
// Model selection and fallback is handled at runtime by summarizationService.js
// via the Gemini Models API discovery. No model names are hardcoded here.
// Override primary model via GEMINI_MODEL in backend/.env.

// Startup log for Gemini config
console.log(`  Gemini Model: ${process.env.GEMINI_MODEL || '(runtime discovery)'} — fallbacks provided by Gemini Models API`);
console.log(`  Gemini Key:   ${GEMINI_API_KEY ? 'Loaded (' + GEMINI_API_KEY.slice(0, 8) + '...)' : 'NOT SET'}`);

// ─── Bot Worker ───────────────────────────────────────────────────────────────
/*
 * ARCHITECTURE: The bot worker launches a real Chrome browser via puppeteer-core
 * and navigates to the Google Meet link.
 *
 * KNOWN LIMITATION: Google Meet requires an authenticated Google account to join.
 * The bot will navigate to the Meet URL but will be stopped at Google's sign-in
 * page unless a pre-authenticated Chrome user profile is configured.
 *
 * With the right Google account profile (CHROME_USER_DATA_DIR env var), the bot
 * can potentially join, enable captions, and capture transcript text from the DOM.
 *
 * Without auth: The bot honestly reports that sign-in is required.
 * With transcript paste: Users can manually paste a transcript for AI summarization.
 */

async function runBotWorker(meetingId) {
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  if (!meeting) return;

  const logs = [];
  const addLog = (msg) => {
    logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    updateMeeting(meetingId, { bot_log: logs.join('\n') });
  };
  const stageContext = {
    meetingId,
    meetCode: meeting.meeting_code || null,
    meetLink: meeting.meet_link || null,
    transcriptLength: 0,
    captionChunkCount: 0,
    audioFallbackAttempted: false,
    audioFallbackSuccess: false,
  };
  const logStage = (stage, meta = {}) => {
    const payload = {
      ...stageContext,
      ts: now(),
      stage,
      ...meta,
    };
    addLog(`[stage] ${JSON.stringify(payload)}`);
    emitDebugLog({
      hypothesisId: 'H-TRANSCRIPT-PIPELINE',
      location: 'index.js:runBotWorker:stage',
      message: stage,
      data: payload,
    });
    updateMeeting(meetingId, { last_stage: stage });
  };

  let browser = null;
  let page = null;
  let browserClosedExplicitly = false;
  const lifecycle = {
    browserDisconnected: false,
    pageClosed: false,
    pageError: null,
    pageRuntimeError: null,
    lastException: null,
  };

  try {
    // ── Phase 1: Check if we already have a transcript (manual paste) ──
    if (isNonEmptyString(meeting.transcript)) {
      addLog('Transcript provided manually — skipping browser automation');
      addLog(`Transcript length: ${meeting.transcript.length} characters`);

      // Record metadata so runSummarization knows this is a manual source (bypasses captionChunkCount threshold)
      updateMeeting(meetingId, {
        transcript_metadata_json: JSON.stringify({
          transcriptSource: 'manual_paste',
          manualTranscriptProvided: true,
          liveMeetingEmpty: false,  // not attempted
          captionChunkCount: null,  // N/A — not from live capture
          transcriptLength: meeting.transcript.length,
          statusMessage: 'Used pasted transcript — live meeting capture was skipped.',
        }),
      });

      // Go straight to summarization
      await runSummarization(meetingId, meeting.transcript, addLog, 'manual_paste');
      return;
    }

    // ── Phase 2: Launch browser ──
    updateMeeting(meetingId, { status: 'launching_browser' });
    addLog('Starting bot workflow...');
    logStage('bot_launch_started');

    const CHROME_PATH = getChromePath();
    const isProduction = process.env.NODE_ENV === 'production';

    if (!CHROME_PATH && !isProduction) {
      // In production, puppeteer will use its bundled Chromium — no CHROME_PATH needed
      addLog('ERROR: Chrome/Chromium not found on this system');
      addLog('Searched paths: ' + CHROME_CANDIDATES.slice(0, 4).join(', '));
      addLog('Set CHROME_PATH environment variable to your Chrome executable');
      updateMeeting(meetingId, {
        status: 'failed',
        error_message: 'Chrome browser not found. Install Google Chrome or set CHROME_PATH in backend/.env',
        completed_at: now(),
      });
      return;
    }

    addLog(`Browser: ${CHROME_PATH || 'puppeteer bundled Chromium'}`);
    addLog('Launching browser...');


    const launchArgs = [
      // Required for running Chrome in containers / Linux without root
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--use-fake-ui-for-media-stream',      // Auto-accept mic/camera permission prompts
      '--use-fake-device-for-media-stream',  // Provide fake audio/video devices
      '--disable-infobars',
      // ── Silence: mute ALL browser audio output (prevents echo / meeting disturbance) ──
      '--mute-audio',
      // ── Startup stability: suppress Chrome dialogs that steal focus before Meet loads ──
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-translate',
      '--disable-notifications',
      '--disable-popup-blocking',
      '--disable-save-password-bubble',
      '--disable-extensions',
      '--hide-crash-restore-bubble',
      '--suppress-message-center-popups',
      // ── Allow Meet's autoplay / audio context to start without gesture ──
      '--autoplay-policy=no-user-gesture-required',
    ];

    // Chrome profile setup — allows using an already-signed-in Google account
    // IMPORTANT: The user data dir must NOT be the same one used by an open Chrome window.
    // Use a DEDICATED bot profile directory to avoid lock conflicts.
    let userDataDir = process.env.CHROME_USER_DATA_DIR;
    const profileDir = process.env.PROFILE_DIRECTORY || 'Default';

    // If no user data dir configured, create a bot-specific one
    if (!userDataDir) {
      userDataDir = join(__dirname, '..', 'bot-chrome-profile');
      addLog(`No CHROME_USER_DATA_DIR set — using bot-specific profile: ${userDataDir}`);
      addLog('NOTE: This profile has no Google sign-in. To enable Meet join:');
      addLog('  1. Create a dedicated Chrome profile for the bot (see .env.example)');
      addLog('  2. Set CHROME_USER_DATA_DIR in backend/.env');
    }

    if (existsSync(userDataDir)) {
      launchArgs.push(`--profile-directory=${profileDir}`);
      addLog(`Using Chrome profile: ${userDataDir} (profile: ${profileDir})`);
    } else {
      addLog(`Profile directory will be created: ${userDataDir}`);
    }

    const launchOptions = {
      // On Render/Linux: let puppeteer auto-find its bundled Chromium.
      // On local dev: use system Chrome if found, otherwise puppeteer's Chromium.
      ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
      // Use headless in production (Render has no display server).
      // Use headful locally so Google Meet does not block the bot.
      headless: isProduction,
      args: launchArgs,
      defaultViewport: { width: 1280, height: 720 },
      ignoreDefaultArgs: ['--enable-automation'],
      // Only set userDataDir in local dev — Render doesn't need a signed-in profile
      ...(isProduction ? {} : { userDataDir }),
    };

    try {
      browser = await puppeteer.launch(launchOptions);
    } catch (launchErr) {
      const errMsg = launchErr.message || '';

      // Detect profile lock: Chrome is already running with this profile
      if (errMsg.includes('already running') || errMsg.includes('user data directory is already in use') || errMsg.includes('SingletonLock')) {
        addLog('ERROR: Chrome profile is locked — another Chrome instance is using it');
        addLog(`Profile path: ${userDataDir}`);
        addLog('');
        addLog('FIX: Either:');
        addLog('  a) Close ALL Chrome windows and check system tray/Task Manager');
        addLog('  b) Use a DEDICATED bot profile (recommended — see .env.example)');
        updateMeeting(meetingId, {
          status: 'browser_profile_in_use',
          error_message: 'Chrome profile is locked by another browser instance. Close Chrome completely (check Task Manager), or set up a dedicated bot profile. See backend/.env.example for instructions.',
          completed_at: now(),
        });
        return;
      }

      addLog(`Browser launch failed: ${errMsg}`);

      // Try headless as fallback (only for non-lock errors)
      addLog('Retrying with headless mode...');
      launchOptions.headless = 'new';
      try {
        browser = await puppeteer.launch(launchOptions);
        addLog('Headless browser launched successfully');
      } catch (retryErr) {
        addLog(`Headless launch also failed: ${retryErr.message}`);
        updateMeeting(meetingId, {
          status: 'failed',
          error_message: `Could not launch Chrome: ${retryErr.message}. Ensure Chrome is installed and accessible.`,
          completed_at: now(),
        });
        return;
      }
    }

    addLog('Browser launched successfully');
    addLog(`[lifecycle] Browser connected: ${browser?.connected ? 'yes' : 'no'}`);
    browser.on('disconnected', () => {
      lifecycle.browserDisconnected = true;
      addLog(`[lifecycle] browser.on('disconnected') fired (explicitClose=${browserClosedExplicitly ? 'yes' : 'no'})`);
    });

    // ── Phase 3: Navigate to Google Meet ──
    addLog('[lifecycle] Creating new page...');
    page = await browser.newPage();
    addLog('[lifecycle] Page created');
    page.on('close', () => {
      lifecycle.pageClosed = true;
      addLog(`[lifecycle] page.on('close') fired (explicitClose=${browserClosedExplicitly ? 'yes' : 'no'})`);
    });
    page.on('pageerror', (err) => {
      lifecycle.pageError = err?.message || String(err);
      addLog(`[lifecycle] page.on('pageerror'): ${lifecycle.pageError}`);
    });
    page.on('error', (err) => {
      lifecycle.pageRuntimeError = err?.message || String(err);
      addLog(`[lifecycle] page.on('error'): ${lifecycle.pageRuntimeError}`);
    });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    // ── Silent-bot injection: runs before any page scripts ──────────────────────
    // This is the definitive fix for the 440Hz sine-wave noise produced by
    // --use-fake-device-for-media-stream. We intercept the two WebRTC APIs
    // that transmit audio so the bot is a completely silent observer.
    await page.evaluateOnNewDocument(() => {
      // 1. Hide Puppeteer's automation fingerprint
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

      // 2. Override getUserMedia — mute ALL audio tracks before returning stream
      if (navigator.mediaDevices?.getUserMedia) {
        const _origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async function (constraints) {
          const stream = await _origGUM(constraints);
          // Disable every audio track — the track still EXISTS (Meet won't error)
          // but enabled=false means it transmits complete silence.
          stream.getAudioTracks().forEach(track => {
            track.enabled = false;
          });
          return stream;
        };
      }

      // 3. Patch RTCPeerConnection.addTrack as belt-and-suspenders:
      //    even if Meet acquires audio through another path, it won't transmit.
      const _OrigRTC = window.RTCPeerConnection;
      if (_OrigRTC) {
        const _origAddTrack = _OrigRTC.prototype.addTrack;
        _OrigRTC.prototype.addTrack = function (track, ...streams) {
          if (track?.kind === 'audio') {
            track.enabled = false; // Mute before RTC even sees it
          }
          return _origAddTrack.call(this, track, ...streams);
        };
      }
    });

    updateMeeting(meetingId, { status: 'opening_meet' });
    addLog(`Navigating to: ${meeting.meet_link}`);
    logStage('meet_page_opened');

    try {
      await page.goto(meeting.meet_link, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (navErr) {
      addLog(`Navigation error: ${navErr.message}`);
      // Continue anyway — page may have partially loaded
    }

    await sleep(3000); // Brief initial settle

    const currentUrl = page.url();
    addLog(`Page URL: ${currentUrl}`);

    // ── Phase 4: URL-based redirect detection (instant checks) ──

    // Only fail on actual URL redirect to sign-in page
    if (currentUrl.includes('accounts.google.com') || currentUrl.includes('/signin')) {
      addLog('Redirected to Google Sign-In page — authentication required');
      await failWithSignInMessage(meetingId, addLog, browser);
      browser = null;
      return;
    }

    // ── Phase 5: Robust pre-join loop ──
    // Poll the page every 5 seconds for up to 90 seconds.
    // States we handle:
    //   "Getting ready..." → wait patiently
    //   Notification popup  → dismiss and continue
    //   "Ready to join?"   → proceed to click Join
    //   Join button visible → click it
    //   Terminal errors     → fail immediately

    addLog('Entering pre-join loop (up to 90s)...');
    updateMeeting(meetingId, { status: 'opening_meet' });

    let joined = false;
    let joinClicked = false;
    const PRE_JOIN_TIMEOUT = 90000; // 90 seconds
    const preJoinStart = Date.now();

    while (Date.now() - preJoinStart < PRE_JOIN_TIMEOUT) {
      // Get fresh page text each iteration
      const pageText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      const lowerText = pageText.toLowerCase();

      // ─ Terminal failures: fail immediately ─
      if (lowerText.includes('check your meeting code') || lowerText.includes('invalid link') ||
          lowerText.includes('meeting doesn\'t exist') || lowerText.includes('no longer available')) {
        addLog('Meeting link is invalid or expired');
        await browser.close(); browser = null;
        updateMeeting(meetingId, {
          status: 'failed',
          error_message: 'The meeting link is invalid, has expired, or the code is incorrect.',
          completed_at: now(),
        });
        return;
      }

      if (lowerText.includes('you can\'t join this video call') || lowerText.includes('not allowed to join') ||
          lowerText.includes('unable to join')) {
        addLog('Meeting restricts who can join');
        await browser.close(); browser = null;
        updateMeeting(meetingId, {
          status: 'failed',
          error_message: 'You cannot join this video call. The meeting may restrict access or require a specific Google Workspace account.',
          completed_at: now(),
        });
        return;
      }

      if (lowerText.includes('no longer supported') || lowerText.includes('upgrade to a supported browser')) {
        addLog('Browser reported as unsupported');
        await browser.close(); browser = null;
        updateMeeting(meetingId, {
          status: 'failed',
          error_message: 'Google Meet says this browser version is unsupported.',
          completed_at: now(),
        });
        return;
      }

      // ─ Already in meeting? (we may have joined already) ─
      const leaveBtn = await page.$('[aria-label*="Leave call"], [aria-label*="End call"], [data-tooltip*="Leave call"]').catch(() => null);
      if (leaveBtn) {
        addLog('Already in meeting! (Leave call button detected)');
        joined = true;
        break;
      }

      // ─ Dismiss notification popups and dialogs ─
      await dismissMeetPopups(page, addLog);

      // ─ "Getting ready..." — just wait ─
      if (lowerText.includes('getting ready')) {
        addLog('Page shows "Getting ready..." — waiting...');
        updateMeeting(meetingId, { status: 'opening_meet' });
        await sleep(5000);
        continue;
      }

      // ─ Check for sign-in prompt ON the Meet page (after URL check passed) ─
      // Only trigger if we see sign-in text AND there's no join button at all
      const hasJoinText = lowerText.includes('join now') || lowerText.includes('ask to join') || lowerText.includes('ready to join');
      if (!hasJoinText) {
        const signInOnPage = lowerText.includes('use your google account') ||
                             lowerText.includes('choose an account') ||
                             lowerText.includes('enter your email');
        if (signInOnPage) {
          addLog('Sign-in prompt detected on Meet page (no join button available)');
          await failWithSignInMessage(meetingId, addLog, browser);
          browser = null;
          return;
        }
      }

      // ─ Guest name input ─
      try {
        const nameInput = await page.$('input[aria-label="Your name"], input[placeholder*="name"], input[type="text"][jsname]');
        if (nameInput) {
          const currentVal = await page.evaluate(el => el.value, nameInput);
          if (!currentVal || currentVal.trim().length === 0) {
            addLog('Guest join mode — entering bot name...');
            await nameInput.click({ clickCount: 3 });
            await nameInput.type('AI Scribe Bot', { delay: 50 });
            addLog('Bot name entered');
            await sleep(1000);
          }
        }
      } catch (_) {}

      // ─ Mute mic and camera via UI before clicking Join ─────────────────────
      // Uses a single page.evaluate() call covering all known Google Meet button
      // selectors — more reliable than separate puppeteer per-element calls which
      // fail silently when buttons haven't rendered yet.
      if (!joinClicked) {
        const muteResult = await page.evaluate(() => {
          const tryClick = (selectors) => {
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el) { try { el.click(); return true; } catch (_) {} }
            }
            return false;
          };

          const micMuted = tryClick([
            '[aria-label*="Turn off microphone"]',
            '[aria-label*="Mute microphone"]',
            '[data-is-muted="false"][aria-label*="microphone" i]',
            '[jsname="BOHaEe"]',  // Known Google Meet mic jsname (pre-join)
          ]);

          const camOff = tryClick([
            '[aria-label*="Turn off camera"]',
            '[aria-label*="Stop camera"]',
            '[data-is-muted="false"][aria-label*="camera" i]',
            '[jsname="bwPHEd"]',  // Known Google Meet camera jsname (pre-join)
          ]);

          // Also directly disable any active audio tracks in existing streams
          try {
            if (navigator.mediaDevices && window.__localStream) {
              window.__localStream.getAudioTracks().forEach(t => { t.enabled = false; });
            }
          } catch (_) {}

          return { micMuted, camOff };
        }).catch(() => ({ micMuted: false, camOff: false }));

        addLog(muteResult.micMuted
          ? '✓ Microphone muted via UI before join'
          : 'ⓘ Mic button not found yet (audio already silenced via track override)');
        addLog(muteResult.camOff
          ? '✓ Camera turned off via UI before join'
          : 'ⓘ Camera button not found yet (camera off by default in bot profile)');
      }

      // ─ Find and click Join button ─
      if (!joinClicked) {
        updateMeeting(meetingId, { status: 'joining_meet' });

        const clickedJoin = await findAndClickJoinButton(page, addLog);
        if (clickedJoin) {
          joinClicked = true;
          addLog('Join button clicked! Waiting for meeting to load...');
          await sleep(5000); // Give time for meeting to load after click
          continue; // Re-enter loop to verify join
        }
      }

      // ─ After join was clicked, check if we're in waiting room ─
      if (joinClicked) {
        if (lowerText.includes('waiting for the host') || lowerText.includes('someone in the meeting') ||
            lowerText.includes('ask the host') || lowerText.includes('you\'ll join the meeting')) {
          addLog('In waiting room — waiting for host to admit...');
          updateMeeting(meetingId, { status: 'waiting_for_admission' });
          logStage('admission_wait_started');
        }
        if (lowerText.includes('removed') || lowerText.includes('denied') || lowerText.includes('meeting has ended')) {
          addLog('Removed from waiting room or meeting ended');
          await browser.close(); browser = null;
          updateMeeting(meetingId, {
            status: 'failed',
            error_message: 'The bot was removed or denied entry. The host may need to admit the bot manually.',
            completed_at: now(),
          });
          return;
        }
      }

      await sleep(5000);
    }

    // ── Pre-join loop finished ──
    if (!joined && !joinClicked) {
      // Never found join button in 90 seconds
      try {
        const allBtnTexts = await page.$$eval('button, [role="button"]', els =>
          els.map(el => el.textContent?.trim()).filter(Boolean)
        );
        addLog(`All buttons found: [${allBtnTexts.join(', ')}]`);
      } catch (_) {}

      const finalText = await page.evaluate(() => document.body?.innerText?.slice(0, 400) || '').catch(() => '');
      addLog(`Page text: "${finalText.replace(/\n/g, ' ')}"`);

      await browser.close(); browser = null;
      updateMeeting(meetingId, {
        status: 'failed',
        error_message: 'Could not find the Join button after 90 seconds. The meeting page may have changed or requires different access. Use Retry to paste a transcript manually.',
        completed_at: now(),
      });
      return;
    }

    if (!joined && joinClicked) {
      // Join was clicked but never confirmed — might still work
      addLog('Join was clicked but meeting entry not confirmed after 90s. Proceeding optimistically...');
    }

    addLog('Join flow complete!');
    logStage('bot_joined_successfully');
    updateMeeting(meetingId, { joined_at: now() });

    // Post-join: verify we're in the meeting
    const inMeeting = await page.$('[aria-label*="Leave call"], [aria-label*="End call"], [data-tooltip*="Leave call"]').catch(() => null);
    if (inMeeting) {
      addLog('✓ Confirmed: in the meeting (Leave call button visible)');
      addLog('[lifecycle] Join success confirmed by leave button');
      updateMeeting(meetingId, { status: 'capturing_transcript' });
    } else {
      addLog('Join was clicked — proceeding to capture (may be in waiting room or loading)');
      addLog('[lifecycle] Join not conclusively confirmed, but entering capture mode');
      updateMeeting(meetingId, { status: 'capturing_transcript' });
    }

    // ── Belt-and-suspenders: force-kill audio tracks post-join ───────────────
    // The evaluateOnNewDocument patch handles new tracks. This handles any track
    // that was created before our patch was applied (e.g. eager Meet loading).
    const audioKillResult = await page.evaluate(() => {
      let killed = 0;
      try {
        // Stop audio on all media elements
        document.querySelectorAll('audio, video').forEach(el => {
          if (!el.muted) { el.muted = true; killed++; }
        });
        // Re-apply our getUserMedia patch in case Meet replaced it
        if (navigator.mediaDevices?.getUserMedia) {
          const _gumRef = navigator.mediaDevices.getUserMedia;
          if (!_gumRef.__botPatched) {
            const _orig = _gumRef.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = async function (c) {
              const s = await _orig(c);
              s.getAudioTracks().forEach(t => { t.enabled = false; });
              return s;
            };
            navigator.mediaDevices.getUserMedia.__botPatched = true;
          }
        }
      } catch (_) {}
      return killed;
    }).catch(() => 0);
    addLog(`✓ Post-join audio kill: ${audioKillResult} element(s) muted. Bot is now a silent observer.`);

    // ── Phase 6: Enable captions ──
    addLog('Attempting to enable captions...');
    logStage('captions_toggle_attempted');
    let captionsEnabled = false;

    // Strategy 1: Keyboard shortcut 'c' (most reliable — works in current Google Meet)
    try {
      await page.keyboard.press('c');
      addLog('Pressed "c" key to toggle captions');
      await sleep(2000);

      // Verify captions appeared by checking for caption-related elements
      const hasCaptionUI = await page.evaluate((captionSelector) => {
        const body = document.body?.innerHTML || '';
        // Check for caption container or closed-caption indicator
        return body.includes('caption') || body.includes('subtitle') ||
               !!document.querySelector('[jscontroller] [class*="caption"]') ||
               !!document.querySelector('[jscontroller] [class*="subtitle"]') ||
               !!document.querySelector(captionSelector);
      }, CAPTION_CONTAINER_SELECTOR).catch(() => false);

      if (hasCaptionUI) {
        captionsEnabled = true;
        addLog('Captions appear to be enabled (UI detected after keyboard shortcut)');
      } else {
        addLog('Keyboard shortcut sent but caption UI not confirmed — trying other methods...');
      }
    } catch (kErr) {
      addLog(`Keyboard shortcut error: ${kErr.message}`);
    }

    // Strategy 2: Direct caption/CC button (bottom toolbar)
    if (!captionsEnabled) {
      try {
        const captionBtn = await page.$([
          '[aria-label*="captions" i]',
          '[aria-label*="subtitle" i]',
          '[aria-label*="Turn on captions" i]',
          '[aria-label*="closed caption" i]',
          '[data-tooltip*="captions" i]',
          '[data-tooltip*="subtitle" i]',
        ].join(', '));
        if (captionBtn) {
          await captionBtn.click();
          captionsEnabled = true;
          addLog('Captions button clicked (toolbar)');
          await sleep(1500);
        }
      } catch (_) {}
    }

    // Strategy 3: Three-dot menu → captions
    if (!captionsEnabled) {
      try {
        const moreBtn = await page.$('[aria-label*="More options" i], [aria-label*="more option" i], [data-tooltip*="More option" i]');
        if (moreBtn) {
          await moreBtn.click();
          await sleep(1500);
          const menuItems = await page.$$('[role="menuitem"], [role="menuitemcheckbox"], li');
          for (const item of menuItems) {
            const text = await page.evaluate(el => el.textContent?.trim()?.toLowerCase(), item).catch(() => '');
            if (text && (text.includes('caption') || text.includes('subtitle'))) {
              await item.click();
              captionsEnabled = true;
              addLog(`Captions toggled via menu: "${text}"`);
              break;
            }
          }
          if (!captionsEnabled) {
            await page.keyboard.press('Escape');
            addLog('Captions not found in More options menu');
          }
        }
      } catch (menuErr) {
        addLog(`Menu caption error: ${menuErr.message}`);
      }
    }

    // Strategy 4: Try 'c' again — sometimes the first press toggles something else
    if (!captionsEnabled) {
      try {
        // Click on the meeting body first to ensure focus
        await page.click('body').catch(() => {});
        await sleep(500);
        await page.keyboard.press('c');
        addLog('Pressed "c" key again after focusing body');
        captionsEnabled = true; // Optimistic — we'll verify in capture
        await sleep(2000);
      } catch (_) {}
    }

    addLog(captionsEnabled ? 'Caption enable attempts complete (at least one method used)' : 'WARNING: Could not confirm captions are enabled');
    logStage(captionsEnabled ? 'captions_enabled' : 'captions_not_enabled');

    const captionContainerFoundHandle = await page.$(CAPTION_CONTAINER_SELECTOR).catch(() => null);
    const captionContainerFound = !!captionContainerFoundHandle;
    logStage(captionContainerFound ? 'caption_container_found' : 'caption_container_not_found');

    // ── Phase 7: Capture caption text (presence-based — stays until meeting ends) ──
    //
    // EXIT CONDITIONS (in priority order):
    //   1. [meeting_ended]        — Explicit end-of-call text persists across multiple checks + leave button absent
    //   2. [removed_from_meeting] — Page shows "removed", "denied", "kicked"
    //   3. [browser_closed]       — Page/browser becomes inaccessible
    //   4. [max_duration_reached] — MAX_MEETING_DURATION_MS elapsed (safety net; default 4 h)
    //
    // NOT an exit condition:
    //   - No new captions for any length of time (silent meeting is still a meeting)
    //
    // CAPTURE_DURATION_MS is intentionally removed — it was the root cause of early exit.
    const MAX_MEETING_DURATION_MS = Number(process.env.MAX_MEETING_DURATION_MS) || 4 * 60 * 60 * 1000; // 4 h
    const PRESENCE_CHECK_INTERVAL_MS = 5000; // check presence every 5 s
    const CAPTION_POLL_INTERVAL_MS   = 2000; // poll captions every 2 s

    addLog(`Starting transcript capture — bot will stay until meeting ends (max ${Math.round(MAX_MEETING_DURATION_MS / 60000)} min)`);
    const captureThresholdConfig = {
      ...getTranscriptThresholdConfig(),
      watcherInactivityMs: Number(process.env.CAPTION_WATCHER_INACTIVITY_MS || 60000),
    };
    addLog(
      `[threshold] capture config: chars=${captureThresholdConfig.minChars}, lines=${captureThresholdConfig.minLines}, chunks=${captureThresholdConfig.minChunks}, watcherInactivityMs=${captureThresholdConfig.watcherInactivityMs}`
    );
    updateMeeting(meetingId, { status: 'capturing_transcript' });

    // ── HOIST: variables referenced by closures defined below ────────────────
    // These MUST be declared before attachCaptionWatcher, validateWatcherReattach,
    // and activatePollFallback — all of which close over them. Declaring them
    // after the closures creates a Temporal Dead Zone (TDZ) crash at runtime.
    let validatedCaptionSel = null;   // selector of the validated caption node; written by attachCaptionWatcher
    const captionChunks     = [];     // cleaned utterance chunks; read by validateWatcherReattach
    const rawCaptionEvents  = [];     // raw unfiltered events; read by validateWatcherReattach

    // ── Caption discovery: score live DOM candidates ─────────────────────────
    // Returns an array of candidate nodes sorted by heuristic score (highest first).
    // Called fresh on every recovery attempt — never reuses a cached node reference.
    const discoverCaptionCandidates = async () => {
      return page.evaluate((containerSelectors, scoreRules, uiExcludeSelector) => {
        const seen = new Set();
        const candidates = [];
        for (const sel of containerSelectors) {
          let nodes;
          try { nodes = Array.from(document.querySelectorAll(sel)); } catch (_) { continue; }
          for (const node of nodes) {
            if (seen.has(node)) continue;
            seen.add(node);
            // Skip excluded UI chrome
            if (node.closest(uiExcludeSelector)) continue;
            // Position scoring: must be in bottom 60% of screen
            const rect = node.getBoundingClientRect();
            if (rect.width < 8 || rect.height < 1) continue;
            const positionPct = rect.top / (window.innerHeight || 800);
            const positionBonus = positionPct > 0.4 ? 20 : (positionPct > 0.2 ? 5 : 0);
            // Attribute scoring
            let score = positionBonus;
            for (const rule of scoreRules) {
              try {
                if (node.matches(rule.selector)) score += rule.score;
              } catch (_) {}
            }
            // Text content bonus: prefer short live text over accumulated blobs
            const textContent = (node.textContent || '').trim();
            if (textContent.length > 0 && textContent.length <= 280) score += 15;
            if (textContent.length > 10) score += 10;
            // Summary for diagnostics
            const summary = {
              sel,
              tag: node.tagName,
              cls: (node.className?.toString() || '').slice(0, 80),
              ariaLive: node.getAttribute('aria-live') || null,
              ariaAtomic: node.getAttribute('aria-atomic') || null,
              jsname: node.getAttribute('jsname') || null,
              textPreview: textContent.slice(0, 60),
              rectTop: Math.round(rect.top),
              rectWidth: Math.round(rect.width),
              positionPct: Math.round(positionPct * 100),
              score,
            };
            candidates.push(summary);
          }
        }
        candidates.sort((a, b) => b.score - a.score);
        return candidates;
      }, CAPTION_CONTAINER_SELECTORS, CAPTION_DISCOVERY_SCORE_RULES, CAPTION_UI_EXCLUDE_SELECTOR).catch(() => []);
    };

    // ── Watcher attach: attach observer to validated caption node ONLY ────────
    // KEY FIX: Rather than watching document.body (which captures everything),
    // we attach the MutationObserver to the specific validated caption node found
    // by discoverCaptionCandidates(). This is the root fix for the noise problem.
    const attachCaptionWatcher = async (reason = 'initial_attach', candidates = []) => {

      // Use the best strict-selector candidate if available, else first candidate
      const strictCandidates = candidates.filter(c => {
        try {
          return CAPTION_STRICT_SELECTORS.some(s => {
            if (c.sel === s) return true;
            return false;
          });
        } catch (_) { return false; }
      });
      const bestCandidate = strictCandidates[0] || candidates[0] || null;

      const attachResult = await page.evaluate((
        strictSelector,
        allContainerSelector,
        uiExcludeSelector,
        attachReason,
        bestCandidateSel,
        bestCandidateSummary,
        siblingSelectors,
      ) => {
        window.__capturedCaptions = window.__capturedCaptions || [];
        window.__captionSeen = window.__captionSeen || new Set();
        window.__captionValidatedSel = bestCandidateSel || null;

        const isInsideExcludedUi = (el) => !!el?.closest?.(uiExcludeSelector);

        /**
         * Speaker extraction — sibling-based (Google Meet specific).
         * The speaker label is a SIBLING of the text node inside a common parent,
         * NOT an ancestor. So we can't use closest() — we must traverse siblings.
         */
        const readSpeaker = (textEl) => {
          if (!textEl) return null;
          // Strategy 1: Check immediate parent's children for a speaker sibling
          const parent = textEl.parentElement;
          if (parent) {
            for (const sibSel of siblingSelectors) {
              try {
                const speakerNode = parent.querySelector(sibSel);
                if (speakerNode && speakerNode !== textEl) {
                  const v = (speakerNode.textContent || '').trim();
                  if (v && v.length > 0 && v.length < 80) return v;
                }
              } catch (_) {}
            }
            // Strategy 2: Check grandparent's children
            if (parent.parentElement) {
              for (const sibSel of siblingSelectors) {
                try {
                  const speakerNode = parent.parentElement.querySelector(sibSel);
                  if (speakerNode && speakerNode !== textEl && !speakerNode.contains(textEl)) {
                    const v = (speakerNode.textContent || '').trim();
                    if (v && v.length > 0 && v.length < 80) return v;
                  }
                } catch (_) {}
              }
            }
          }
          // Strategy 3: Ancestor data-participant-name (original approach — last resort)
          const ancestor = textEl.closest?.('[data-participant-name], [data-self-name]');
          if (ancestor) {
            const v = ancestor.getAttribute('data-participant-name') ||
                      ancestor.getAttribute('data-self-name');
            if (v && v.trim().length > 0) return v.trim();
          }
          return null;
        };

        /**
         * Extract spoken text from a caption node.
         * Tries to find the innermost text-bearing child rather than using textContent
         * of the whole container (which accumulates all history).
         * Max length: 280 chars — real utterances are short.
         */
        const extractText = (el) => {
          if (!el) return '';
          // Try known Meet innermost text selectors first
          const innerSelectors = [
            '.zs7s8d',
            '[jsname="tgaKEf"]',
            '[data-message-text]',
            'span:last-child',
          ];
          for (const sel of innerSelectors) {
            try {
              const inner = el.querySelector(sel);
              if (inner) {
                const t = (inner.textContent || '').trim();
                if (t.length > 1 && t.length <= 280) return t;
              }
            } catch (_) {}
          }
          // Fallback: direct text content of this node only (no children aggregation)
          const t = (el.textContent || '').trim();
          if (t.length > 1 && t.length <= 280) return t;
          return '';
        };

        /**
         * Determine if a node is within our validated caption container.
         * KEY: We do NOT fall back to the broad aria-live selector.
         */
        const isLiveCaptionNode = (node) => {
          if (!node || !node.getBoundingClientRect) return false;
          const rect = node.getBoundingClientRect();
          if (rect.width < 8) return false;
          if (isInsideExcludedUi(node)) return false;

          // If we have a specific validated selector, ONLY accept nodes inside it
          if (bestCandidateSel) {
            try {
              // Is this node inside the validated caption container?
              if (node.closest(bestCandidateSel)) return true;
              if (node.matches?.(bestCandidateSel)) return true;
            } catch (_) {}
            return false; // strict: don't fall through to broad selector
          }

          // No validated selector — use strict set (NOT the broad aria-live)
          try {
            return !!node.closest(strictSelector);
          } catch (_) { return false; }
        };

        const handleNode = (node, mutationType) => {
          const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
          if (!el || !isLiveCaptionNode(el)) return;
          const text = extractText(el);
          if (!text || text.length < 2) return;
          // De-duplicate against recently-seen texts
          if (window.__captionSeen.has(text)) return;
          window.__captionSeen.add(text);
          const speaker = readSpeaker(el);
          window.__capturedCaptions.push({
            text,
            speaker,
            ts: new Date().toISOString(),
            source: `observer_${mutationType}`,
          });
          window.__captionWatcherLastEventAt = Date.now();
        };

        // Disconnect old observer
        try { window.__captionObserver?.disconnect?.(); } catch (_) {}

        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (mutation.type === 'characterData') {
              handleNode(mutation.target, 'char_data');
            } else {
              for (const node of mutation.addedNodes) {
                handleNode(node, node.nodeType === Node.TEXT_NODE ? 'text_node' : 'element_node');
              }
            }
          }
          window.__captionWatcherLastMutationAt = Date.now();
        });

        // ── KEY CHANGE: Attach to specific caption node, NOT document.body ──
        // If we have a specific validated target, observe that; otherwise observe body
        // with strict subtree filtering (handled in isLiveCaptionNode above).
        let observeTarget = document.body;
        let observeDesc = 'document.body (fallback)';
        if (bestCandidateSel) {
          try {
            const captionNode = document.querySelector(bestCandidateSel);
            if (captionNode) {
              observeTarget = captionNode;
              observeDesc = `specific_node: ${bestCandidateSel}`;
            }
          } catch (_) {}
        }

        observer.observe(observeTarget, { childList: true, subtree: true, characterData: true });
        window.__captionObserver = observer;
        window.__captionObserveTarget = observeDesc;
        window.__captionWatcherAttachedAt = Date.now();
        window.__captionWatcherLastMutationAt = Date.now();
        window.__captionWatcherLastEventAt = window.__captionWatcherLastEventAt || null;

        const containerExists = !!document.querySelector(allContainerSelector);
        const bestNodeExists = bestCandidateSel
          ? !!document.querySelector(bestCandidateSel)
          : false;

        return {
          ok: true,
          containerExists,
          bestNodeExists,
          attachReason,
          bestCandidateSel,
          bestCandidateSummary,
          observeTarget: observeDesc,
        };
      }, CAPTION_STRICT_SELECTOR, CAPTION_CONTAINER_SELECTOR, CAPTION_UI_EXCLUDE_SELECTOR, reason,
        bestCandidate ? bestCandidate.sel : null,
        bestCandidate || null,
        CAPTION_SPEAKER_SIBLING_SELECTORS,
      ).catch((err) => ({ ok: false, error: err?.message || String(err) }));

      if (attachResult?.ok) {
        // Update the outer validatedCaptionSel so poll fallback can use it
        if (attachResult.bestCandidateSel) {
          validatedCaptionSel = attachResult.bestCandidateSel;
        }
        logStage('watcher_attached', {
          reason,
          containerExists: !!attachResult.containerExists,
          bestCandidateSel: attachResult.bestCandidateSel || null,
          bestNodeExists: !!attachResult.bestNodeExists,
          candidateCount: candidates.length,
          observeTarget: attachResult.observeTarget || null,
          strictCandidateCount: strictCandidates.length,
        });
        addLog(`[watcher:attach] node="${attachResult.observeTarget || 'document.body'}" sel="${attachResult.bestCandidateSel || 'none'}" strict=${strictCandidates.length}`);
      } else {
        logStage('watcher_recovery_failed', { reason, error: attachResult?.error || 'attach_failed' });
      }
      return attachResult;
    };



    // ── Validate reattach: check if new events arrived ────────────────────────
    // Returns true only if caption chunks or raw events grew during the window.
    const validateWatcherReattach = async (chunkCountBefore, rawEventCountBefore, windowMs) => {
      const deadline = Date.now() + windowMs;
      while (Date.now() < deadline) {
        await sleep(1500);
        const chunkCountNow = captionChunks.length;
        const rawCountNow = rawCaptionEvents.length;
        if (chunkCountNow > chunkCountBefore || rawCountNow > rawEventCountBefore) {
          return { validated: true, chunkDelta: chunkCountNow - chunkCountBefore, rawDelta: rawCountNow - rawEventCountBefore };
        }
      }
      return { validated: false, chunkDelta: 0, rawDelta: 0 };
    };

    // ── Activate poll fallback ─────────────────────────────────────────────────
    // KEY FIX: Only polls the single VALIDATED caption node (window.__captionValidatedSel).
    // Does NOT scan broad DOM areas. If no validated node, logs explicitly.
    const activatePollFallback = async () => {
      // Pass the current validatedCaptionSel to the browser context
      const currentValidatedSel = validatedCaptionSel;
      const activated = await page.evaluate((validatedSel, uiExcludeSelector, siblingSelectors) => {
        if (window.__captionPollFallbackActive) return { alreadyActive: true };

        // If there is no validated caption node, do not poll — log instead
        const effectiveSel = validatedSel || window.__captionValidatedSel || null;
        if (!effectiveSel) {
          return { alreadyActive: false, noValidatedNode: true, startedAt: null };
        }

        window.__captionPollFallbackActive = true;
        window.__captionPollSeen = window.__captionPollSeen || new Set();
        window.__captionPollStartedAt = Date.now();
        window.__captionPollValidatedSel = effectiveSel;

        const readSpeakerFromNode = (el) => {
          if (!el) return null;
          const parent = el.parentElement;
          if (parent) {
            for (const sibSel of siblingSelectors) {
              try {
                const speakerNode = parent.querySelector(sibSel);
                if (speakerNode && speakerNode !== el) {
                  const v = (speakerNode.textContent || '').trim();
                  if (v && v.length > 0 && v.length < 80) return v;
                }
              } catch (_) {}
            }
          }
          return null;
        };

        const POLL_INTERVAL_MS = 2000;
        window.__captionPollTimer = setInterval(() => {
          const seen = window.__captionPollSeen;

          // Only query the specific validated selector
          let nodes;
          try { nodes = document.querySelectorAll(effectiveSel); }
          catch (_) { return; }

          for (const node of nodes) {
            // Reject if inside excluded UI
            try { if (node.closest(uiExcludeSelector)) continue; } catch (_) {}
            const rect = node.getBoundingClientRect();
            if (rect.width < 8) continue;

            // Use innermost text nodes, not full container textContent
            const innerSelectors = ['.zs7s8d', '[jsname="tgaKEf"]', '[data-message-text]', 'span:last-child'];
            let text = '';
            for (const sel of innerSelectors) {
              try {
                const inner = node.querySelector(sel);
                if (inner) {
                  const t = (inner.textContent || '').trim();
                  if (t.length > 1 && t.length <= 280) { text = t; break; }
                }
              } catch (_) {}
            }
            if (!text) {
              const t = (node.textContent || '').trim();
              if (t.length > 1 && t.length <= 280) text = t;
            }
            if (!text || seen.has(text)) continue;
            seen.add(text);
            const speaker = readSpeakerFromNode(node);
            window.__capturedCaptions = window.__capturedCaptions || [];
            window.__capturedCaptions.push({
              text,
              speaker,
              ts: new Date().toISOString(),
              source: 'poll_fallback',
            });
            window.__captionPollLastEventAt = Date.now();
          }
        }, POLL_INTERVAL_MS);
        return { alreadyActive: false, startedAt: window.__captionPollStartedAt, validatedSel: effectiveSel };
      }, currentValidatedSel, CAPTION_UI_EXCLUDE_SELECTOR, CAPTION_SPEAKER_SIBLING_SELECTORS).catch(() => null);

      if (activated?.noValidatedNode) {
        addLog('[watcher:fallback] No validated caption node found — poll fallback will not scan broad DOM. Waiting for node discovery.');
      }
      return activated;
    };

    // ── Initial attach ────────────────────────────────────────────────────────
    const initialCandidates = await discoverCaptionCandidates();
    addLog(`[watcher:discovery] Initial scan: ${initialCandidates.length} candidate(s) found`);
    if (initialCandidates.length > 0) {
      addLog(`[watcher:discovery] Top candidate: sel=${initialCandidates[0].sel} score=${initialCandidates[0].score} text="${initialCandidates[0].textPreview}" pos=${initialCandidates[0].positionPct}%`);
    }
    await attachCaptionWatcher('initial_attach', initialCandidates);

    // ── Presence-based capture loop ───────────────────────────────────────────
    const captionTexts = [];  // formatted text lines (used for transcript output)
    // captionChunks and rawCaptionEvents are declared above (hoisted).
    const captureStart = Date.now();
    let firstCaptionTime = null;
    let lastLoggedCount = 0;
    let domSnapshotDone = false;
    let lastCheckpointAt = 0;
    let lastCaptionCaptureAt = Date.now();
    let dedupRejectedCount = 0;
    let dedupMergedCount = 0;
    let uiFilteredCount = 0;
    let acceptedChunkCount = 0;
    let rejectedChunkCount = 0;
    let speakerExtractedCount = 0;
    let speakerNullCount = 0;
    let incrementalMergedCount = 0;    // merged_extension + merged_replacement
    let prefixMergedCount = 0;         // specifically fuzzy/prefix merges (vs exact startsWith)
    let partialUpdatesDiscarded = 0;   // total partial updates collapsed (sum of partialCount on chunks)
    // ── Classification counters ──
    let spokenCaptionCount = 0;        // real speech events accepted
    let systemAnnouncementCount = 0;   // Meet system/accessibility announcements filtered
    let unknownTextCount = 0;          // noise that doesn't match a known pattern
    // NOTE: validatedCaptionSel, captionChunks, and rawCaptionEvents are
    // declared above (hoisted before the closures that reference them).

    const rejectReasons = {                   // per-category rejection histogram
      [REJECT_REASON.UI_MENU_TEXT]:              0,
      [REJECT_REASON.BUTTON_LABEL]:              0,
      [REJECT_REASON.DUPLICATE_INCREMENTAL]:     0,
      [REJECT_REASON.INVALID_CANDIDATE_NODE]:    0,
      [REJECT_REASON.EMPTY_AFTER_NORMALIZATION]: 0,
      [REJECT_REASON.EXCESSIVE_LENGTH]:          0,
      [REJECT_REASON.STALE_REPEAT]:              0,
      [REJECT_REASON.SHORTTEXT]:                 0,
      [REJECT_REASON.SYSTEM_ANNOUNCEMENT]:       0,
    };
    let captionWatcherInactiveLogged = false;
    let captionWatcherStopped = false;
    const WATCHER_INACTIVITY_MS       = Number(process.env.CAPTION_WATCHER_INACTIVITY_MS        || 60000);
    const WATCHER_HEARTBEAT_MS        = Number(process.env.CAPTION_WATCHER_HEARTBEAT_MS         || 15000);
    const MAX_WATCHER_RECOVERY_ATTEMPTS = Number(process.env.CAPTION_WATCHER_MAX_RECOVERY_ATTEMPTS || 4);
    const WATCHER_VALIDATION_WINDOW_MS = Number(process.env.CAPTION_WATCHER_VALIDATION_MS        || 8000);
    const WATCHER_RECOVERY_BACKOFF_MS  = Number(process.env.CAPTION_WATCHER_BACKOFF_MS           || 5000);
    let watcherRecoveryAttempts = 0;
    let lastWatcherHeartbeatAt = 0;
    let watcherRecoveryFailed = false;
    let watcherRecoveredSuccessfully = false;
    let watcherContainerReplaced = false;
    let watcherReattachNoEvents = false;           // reattach happened but produced zero events
    let watcherAttachedToStaleNode = false;        // reattach node was stale/replaced
    let pollFallbackActivated = false;             // poll fallback mode is active
    let pollFallbackUsed = false;                  // poll fallback produced at least one caption
    let lastSuccessfulCaptionTs = null;            // ISO timestamp of last accepted caption
    let captionsDisabledAfterJoin = false;         // captions turned off mid-meeting
    const watcherDebugSnapshots = [];              // per-attempt diagnostics
    const watcherReattachResults = [];             // { attempt, validated, candidates, chunkDelta }
    let captionsDisabledDetected = !captionsEnabled;
    let meetingSilentTooLong = false;
    let captureExitReason = 'capture_loop_ended'; // default fallback
    let lastPresenceCheck = Date.now();
    let consecutiveBrowserErrors = 0;
    const MAX_BROWSER_ERRORS = 3; // tolerate transient puppeteer errors
    let consecutiveMeetingEndSignals = 0;
    const REQUIRED_MEETING_END_SIGNALS = 4; // require repeated explicit confirmation (~20s)
    let consecutiveLeaveButtonMissing = 0;
    let lastPresentationState = null;
    let lastPresentationStopAt = null;
    const POST_PRESENTATION_STABILIZATION_MS = 45_000;
    let stabilizationUntilMs = 0;
    let lastDomSignals = null;
    let consecutiveRemovedSignals = 0;
    let consecutiveDeniedSignals = 0;
    let consecutiveBrowserClosedSignals = 0;
    const REQUIRED_REMOVED_SIGNALS = 2;
    const REQUIRED_DENIED_SIGNALS = 2;
    const REQUIRED_BROWSER_CLOSED_SIGNALS = 3;
    let audioRecorder = null;
    let finalizedAudioFilePath = null;
    let audioRecorderStartAttempted = false;
    let audioRecorderStartDeferredLogged = false;
    let audioFallbackAvailable = false;
    let audioRecordingFailed = false;
    let audioRecordingFailureReason = null;
    let audioRecorderStrategy = null;

    const readDomSignals = async () => {
      const signal = {
        ts: new Date().toISOString(),
        pageUrl: null,
        leaveButtonExists: false,
        joinButtonExists: false,
        captionsContainerExists: false,
        meetingEndedTextExists: false,
        removedTextExists: false,
        waitingRoomTextExists: false,
        deniedTextExists: false,
        participantCountEstimate: null,
        presentationActive: false,
        removedPhraseMatched: null,
      };
      try {
        signal.pageUrl = page.url();
      } catch (_) {}
      try {
        const dom = await page.evaluate((captionSelector) => {
          const bodyTextRaw = document.body?.innerText || '';
          const bodyText = bodyTextRaw.toLowerCase();

          const leaveButtonExists = !!document.querySelector(
            '[aria-label*="Leave call"], [aria-label*="End call"], [data-tooltip*="Leave call"]'
          );
          const joinButtonExists = !!document.querySelector(
            'button[jsname="Qx7uuf"], button[jsname="lKxP2d"], button[jsname="Nc2IHb"], button[aria-label*="Join"], [role="button"][aria-label*="Join"]'
          );
          const captionsContainerExists = !!document.querySelector(captionSelector);

          const hasStrongEndedPhrase =
            bodyText.includes('this meeting has ended') ||
            bodyText.includes('the meeting has ended') ||
            bodyText.includes('this call has ended') ||
            bodyText.includes('the call has ended');
          const hasPostCallUiHint =
            bodyText.includes('rejoin') ||
            bodyText.includes('return to home screen') ||
            bodyText.includes('back to home') ||
            bodyText.includes('join again');
          const meetingEndedTextExists = hasStrongEndedPhrase && hasPostCallUiHint;

          // Very strict removal detection to avoid false positives during
          // screen-share/layout transitions (e.g. "removed from stage").
          const removalPhrases = [
            'you have been removed from the meeting',
            'you were removed from the meeting',
            'you\'ve been removed from the meeting',
            'removed you from the meeting',
            'you can\'t join this call anymore',
            'the host removed you',
          ];
          let removedPhraseMatched = null;
          for (const phrase of removalPhrases) {
            if (bodyText.includes(phrase)) {
              removedPhraseMatched = phrase;
              break;
            }
          }
          const removedTextExists = !!removedPhraseMatched;

          const deniedTextExists =
            bodyText.includes('your request to join was denied') ||
            bodyText.includes('host denied') ||
            bodyText.includes('couldn\'t let you in');

          const waitingRoomTextExists =
            bodyText.includes('waiting for the host') ||
            bodyText.includes('ask to join') ||
            bodyText.includes('you\'ll join the meeting') ||
            bodyText.includes('someone in the meeting');

          const presentationActive =
            bodyText.includes('presenting') ||
            bodyText.includes('is presenting') ||
            bodyText.includes('you are presenting') ||
            bodyText.includes('presentation') ||
            bodyText.includes('screen sharing') ||
            bodyText.includes('stop presenting');

          const participantCountEstimate = Math.max(
            document.querySelectorAll('[data-participant-id]').length,
            document.querySelectorAll('[role="listitem"][data-self-name], [role="listitem"][data-participant-id]').length,
            document.querySelectorAll('video').length
          ) || 0;

          return {
            leaveButtonExists,
            joinButtonExists,
            captionsContainerExists,
            meetingEndedTextExists,
            removedTextExists,
            removedPhraseMatched,
            waitingRoomTextExists,
            deniedTextExists,
            participantCountEstimate,
            presentationActive,
          };
        }, CAPTION_CONTAINER_SELECTOR).catch(() => null);
        if (dom) Object.assign(signal, dom);
      } catch (_) {}
      return signal;
    };

    addLog('[presence] Keep-alive loop started — waiting for meeting to end naturally');
    addLog('[lifecycle] Caption polling started');
    addLog('[audio] Audio fallback service armed (will start only after join is confirmed and stream is ready)');
    updateMeeting(meetingId, { status: 'capturing_transcript' });

    while (true) {
      if (!audioRecorderStartAttempted) {
        const canStartAudioNow = await page.$(
          '[aria-label*="Leave call"], [aria-label*="End call"], [data-tooltip*="Leave call"]'
        ).catch(() => null);
        if (canStartAudioNow) {
          audioRecorderStartAttempted = true;
          stageContext.audioFallbackAttempted = true;
          addLog('[audio] Join confirmed. Starting audio fallback recorder...');
          logStage('audio_recording_attempted');
          updateMeeting(meetingId, { status: 'recording_audio' });
          audioRecorder = createMeetingAudioRecorder({ meetingId, addLog });
          const startResult = await audioRecorder.start(page).catch((err) => ({
            ok: false,
            reason: 'start_threw',
            error: err?.message || String(err),
            errorStack: err?.stack || null,
            friendlyMessage: 'Audio fallback could not start. Continuing with captions only.',
          }));
          audioRecorderStrategy = audioRecorder?.getStrategy?.() || startResult?.strategy || null;
          audioFallbackAvailable = !!startResult?.ok;
          audioRecordingFailed = !startResult?.ok;
          stageContext.audioFallbackSuccess = !!startResult?.ok;
          audioRecordingFailureReason = startResult?.reason || startResult?.error || null;
          if (!startResult?.ok) {
            logStage('audio_recording_failed', {
              error: startResult?.error || null,
              errorStack: startResult?.errorStack || null,
              failureReason: audioRecordingFailureReason,
            });
            addLog(`[audio] ${startResult?.friendlyMessage || 'Audio fallback could not start. Continuing with captions only.'}`);
            if (startResult?.error) addLog(`[audio] start error detail: ${startResult.error}`);
            if (startResult?.errorStack) addLog(`[audio] start error stack: ${startResult.errorStack}`);
            audioRecorder = null;
          } else {
            addLog('[audio] Audio fallback recorder is active');
            logStage('audio_recording_started', { strategy: audioRecorderStrategy || null });
          }
          updateMeeting(meetingId, { status: 'capturing_transcript' });
        } else if (!audioRecorderStartDeferredLogged) {
          addLog('[audio] Deferring audio recorder start until bot is fully admitted (leave button not visible yet)');
          audioRecorderStartDeferredLogged = true;
        }
      }

      // ── Max duration safety net ──
      const elapsed = Date.now() - captureStart;
      if (elapsed >= MAX_MEETING_DURATION_MS) {
        captureExitReason = 'max_duration_reached';
        addLog(`[exit:max_duration_reached] Bot has been in the meeting for ${Math.round(elapsed / 60000)} minutes — exiting (configurable via MAX_MEETING_DURATION_MS)`);
        break;
      }

      // ── Periodic presence check (every PRESENCE_CHECK_INTERVAL_MS) ──
      const now_ms = Date.now();
      if (now_ms - lastPresenceCheck >= PRESENCE_CHECK_INTERVAL_MS) {
        lastPresenceCheck = now_ms;

        try {
          if (isProcessShuttingDown) {
            captureExitReason = 'process_restarted';
            addLog('[exit:process_restarted] Process shutdown detected (likely dev reload) during capture');
            break;
          }

          // 1. Check if browser/page is still alive
          if (!browser?.connected) {
            consecutiveBrowserClosedSignals++;
            if (consecutiveBrowserClosedSignals >= REQUIRED_BROWSER_CLOSED_SIGNALS) {
              captureExitReason = 'browser_disconnected';
              addLog('[exit:browser_disconnected] Browser disconnected unexpectedly (repeated checks)');
              break;
            }
            addLog(`[presence] browser.connected=false (${consecutiveBrowserClosedSignals}/${REQUIRED_BROWSER_CLOSED_SIGNALS})`);
            await sleep(CAPTION_POLL_INTERVAL_MS);
            continue;
          }
          if (page?.isClosed?.()) {
            consecutiveBrowserClosedSignals++;
            if (consecutiveBrowserClosedSignals >= REQUIRED_BROWSER_CLOSED_SIGNALS) {
              captureExitReason = 'page_closed';
              addLog('[exit:page_closed] Page closed unexpectedly during capture (repeated checks)');
              break;
            }
            addLog(`[presence] page.isClosed()=true (${consecutiveBrowserClosedSignals}/${REQUIRED_BROWSER_CLOSED_SIGNALS})`);
            await sleep(CAPTION_POLL_INTERVAL_MS);
            continue;
          }
          consecutiveBrowserClosedSignals = 0;

          let pageUrl = null;
          try {
            pageUrl = page.url();
          } catch (urlErr) {
            consecutiveBrowserErrors++;
            lifecycle.lastException = urlErr?.message || String(urlErr);
            addLog(`[presence] page.url() failed (${consecutiveBrowserErrors}/${MAX_BROWSER_ERRORS}): ${lifecycle.lastException}`);
            if (consecutiveBrowserErrors >= MAX_BROWSER_ERRORS) {
              captureExitReason = 'browser_closed';
              addLog('[exit:browser_closed] Too many page.url() failures — browser/page likely unstable');
              break;
            }
            await sleep(CAPTION_POLL_INTERVAL_MS);
            continue;
          }
          if (!pageUrl) {
            consecutiveBrowserErrors++;
            addLog(`[presence] Empty page URL (${consecutiveBrowserErrors}/${MAX_BROWSER_ERRORS})`);
            if (consecutiveBrowserErrors >= MAX_BROWSER_ERRORS) {
              captureExitReason = 'browser_closed';
              addLog('[exit:browser_closed] Too many empty page URLs — exiting');
              break;
            }
            await sleep(CAPTION_POLL_INTERVAL_MS);
            continue;
          }

          if (lifecycle.pageRuntimeError && /crash|target closed|session closed/i.test(lifecycle.pageRuntimeError)) {
            captureExitReason = 'browser_crashed';
            addLog(`[exit:browser_crashed] Page runtime error indicates crash: ${lifecycle.pageRuntimeError}`);
            break;
          }

          // 2. Build DOM presence signals snapshot
          const domSignals = await readDomSignals();
          lastDomSignals = domSignals;
          addLog(
            `[presence:signals] url=${domSignals.pageUrl || 'n/a'} leave=${domSignals.leaveButtonExists ? 1 : 0} join=${domSignals.joinButtonExists ? 1 : 0} captions=${domSignals.captionsContainerExists ? 1 : 0} ended=${domSignals.meetingEndedTextExists ? 1 : 0} removed=${domSignals.removedTextExists ? 1 : 0} denied=${domSignals.deniedTextExists ? 1 : 0} waiting=${domSignals.waitingRoomTextExists ? 1 : 0} participants=${domSignals.participantCountEstimate ?? 'n/a'} presenting=${domSignals.presentationActive ? 1 : 0}`
          );

          if (!domSignals.pageUrl) {
            consecutiveBrowserErrors++;
            addLog(`[presence] DOM signal read incomplete (${consecutiveBrowserErrors}/${MAX_BROWSER_ERRORS})`);
            if (consecutiveBrowserErrors >= MAX_BROWSER_ERRORS) {
              captureExitReason = 'browser_closed';
              addLog('[exit:browser_closed] Too many consecutive DOM read failures — browser/page likely closed');
              break;
            }
            await sleep(CAPTION_POLL_INTERVAL_MS);
            continue;
          }

          consecutiveBrowserErrors = 0; // reset on success

          // 3. Detect removal / denial
          const isRemoved = domSignals.removedTextExists;
          const likelyOutOfMeetingState = !domSignals.leaveButtonExists || domSignals.joinButtonExists || domSignals.waitingRoomTextExists;
          if (isRemoved) {
            if (!likelyOutOfMeetingState) {
              // Exact false-positive guard seen in repro: "removed" text with leave button still present.
              addLog(
                `[presence] removed_text_ignored_in_call_state phrase="${domSignals.removedPhraseMatched || 'unknown'}" leave=${domSignals.leaveButtonExists ? 1 : 0} join=${domSignals.joinButtonExists ? 1 : 0} waiting=${domSignals.waitingRoomTextExists ? 1 : 0}`
              );
              consecutiveRemovedSignals = 0;
            } else {
              consecutiveRemovedSignals++;
              addLog(
                `[presence] Removed text detected (${consecutiveRemovedSignals}/${REQUIRED_REMOVED_SIGNALS}) phrase="${domSignals.removedPhraseMatched || 'unknown'}"`
              );
            }
            if (consecutiveRemovedSignals >= REQUIRED_REMOVED_SIGNALS) {
              captureExitReason = 'removed_from_meeting';
              addLog('[exit:removed_from_meeting] Bot was removed from the meeting by the host (confirmed repeatedly)');
              updateMeeting(meetingId, { status: 'capturing_transcript' }); // keep status; will resolve below
              break;
            }
          } else {
            consecutiveRemovedSignals = 0;
          }

          const isDenied = domSignals.deniedTextExists;
          if (isDenied) {
            consecutiveDeniedSignals++;
            addLog(`[presence] Denied text detected (${consecutiveDeniedSignals}/${REQUIRED_DENIED_SIGNALS})`);
            if (consecutiveDeniedSignals >= REQUIRED_DENIED_SIGNALS) {
              captureExitReason = 'denied_entry';
              addLog('[exit:denied_entry] Host denied the bot entry (confirmed repeatedly)');
              break;
            }
          } else {
            consecutiveDeniedSignals = 0;
          }

          // 4. Strong end-screen detection.
          // Avoid generic fragments that can appear in non-terminal UI transitions.
          const meetingEndedByText = domSignals.meetingEndedTextExists;
          addLog(`[presence] Meeting-ended text check: ${meetingEndedByText ? 'FOUND' : 'NOT_FOUND'}`);
          if (meetingEndedByText) {
            consecutiveMeetingEndSignals++;
            addLog(
              `[presence] Meeting-ended text detected (${consecutiveMeetingEndSignals}/${REQUIRED_MEETING_END_SIGNALS})`
            );
          } else if (consecutiveMeetingEndSignals > 0) {
            addLog('[presence] Meeting-ended text no longer present — reset confirmation counter');
            consecutiveMeetingEndSignals = 0;
          }

          // 4b. Detect presentation/screen-share state transitions for diagnostics only.
          // IMPORTANT: never treat this as an exit signal.
          const presentationActive = domSignals.presentationActive;
          if (lastPresentationState === null) {
            lastPresentationState = presentationActive;
            addLog(`[presence] Presentation state initial: ${presentationActive ? 'active' : 'inactive'}`);
          } else if (presentationActive !== lastPresentationState) {
            addLog(
              `[presence] Presentation state changed: ${lastPresentationState ? 'active' : 'inactive'} -> ${presentationActive ? 'active' : 'inactive'}`
            );
            if (lastPresentationState && !presentationActive) {
              lastPresentationStopAt = Date.now();
              stabilizationUntilMs = Math.max(stabilizationUntilMs, Date.now() + POST_PRESENTATION_STABILIZATION_MS);
              addLog(`[presence] Screen sharing stopped detected — starting ${Math.round(POST_PRESENTATION_STABILIZATION_MS / 1000)}s stabilization window`);
            }
            lastPresentationState = presentationActive;
          }

          // Guard for unobserved share-stop/layout transitions:
          // if leave button disappears without strong end-text, extend stabilization.
          const leaveBtnExists = !!domSignals.leaveButtonExists;
          if (!leaveBtnExists && !meetingEndedByText) {
            stabilizationUntilMs = Math.max(stabilizationUntilMs, Date.now() + 20_000);
          }

          // 5. Check if leave-call button is still present (primary presence indicator)

          if (!leaveBtnExists) {
            consecutiveLeaveButtonMissing++;
            addLog(`[presence] Leave-call button missing (${consecutiveLeaveButtonMissing} check(s))`);

            const inPostPresentationStabilization =
              lastPresentationStopAt &&
              (Date.now() - lastPresentationStopAt) < POST_PRESENTATION_STABILIZATION_MS;
            const inGeneralStabilization = Date.now() < stabilizationUntilMs;
            const stabilizationRemainingSec = inPostPresentationStabilization
              ? Math.ceil((POST_PRESENTATION_STABILIZATION_MS - (Date.now() - lastPresentationStopAt)) / 1000)
              : 0;
            const generalStabilizationRemainingSec = inGeneralStabilization
              ? Math.ceil((stabilizationUntilMs - Date.now()) / 1000)
              : 0;

            if (meetingEndedByText && consecutiveMeetingEndSignals >= REQUIRED_MEETING_END_SIGNALS && !inPostPresentationStabilization && !inGeneralStabilization) {
              captureExitReason = 'meeting_ended';
              addLog(
                `[exit:meeting_ended] Explicit meeting-ended text persisted for ${REQUIRED_MEETING_END_SIGNALS} checks and leave button is absent`
              );
              break;
            }

            // Do NOT exit on missing leave button alone — layout changes during/after screen-share
            // can temporarily hide/re-render controls.
            if (meetingEndedByText && (inPostPresentationStabilization || inGeneralStabilization)) {
              addLog(
                `[presence] Leave button missing + end text present, but within stabilization (post-presentation ${stabilizationRemainingSec}s, general ${generalStabilizationRemainingSec}s) — keeping bot alive`
              );
            } else if (meetingEndedByText) {
              addLog('[presence] Leave button missing + end text present, waiting for repeated confirmation...');
            } else {
              addLog('[presence] Leave button missing without end text — treating as transient UI/layout change');
            }
          } else {
            if (consecutiveLeaveButtonMissing > 0) {
              addLog(`[presence] Leave-call button reappeared after ${consecutiveLeaveButtonMissing} missing check(s)`);
            }
            consecutiveLeaveButtonMissing = 0;
            // Still in meeting — log keep-alive every 5 minutes
            const minutesIn = Math.round(elapsed / 60000);
            if (minutesIn > 0 && minutesIn % 5 === 0 && elapsed % 60000 < PRESENCE_CHECK_INTERVAL_MS) {
              addLog(`[presence] Still in meeting (${minutesIn} min, ${captionTexts.length} segments captured)`);
            }
          }

        } catch (presenceErr) {
          consecutiveBrowserErrors++;
          lifecycle.lastException = presenceErr?.stack || presenceErr?.message || String(presenceErr);
          addLog(`[presence] Presence check error (${consecutiveBrowserErrors}/${MAX_BROWSER_ERRORS}): ${presenceErr.message}`);
          if (consecutiveBrowserErrors >= MAX_BROWSER_ERRORS) {
            captureExitReason = 'browser_closed';
            addLog('[exit:browser_closed] Too many presence check failures — browser/page likely unstable');
            break;
          }
        }
      }

      // ── Caption collection (every CAPTION_POLL_INTERVAL_MS) ──
      try {
        // ── Helper: process one raw caption event into the transcript ──────────
        const processCaptionEvent = (rawText, rawSpeaker, sourceLabel) => {

          if (!rawText) return;
          // Store raw event (with classification for debug)
          const rawEventEntry = {
            ts: new Date().toISOString(),
            source: sourceLabel,
            text: String(rawText),
            speaker: rawSpeaker ? String(rawSpeaker) : null,
          };

          addLog(`[caption:raw_event] source=${sourceLabel} text="${String(rawText).slice(0, 180)}" speaker="${String(rawSpeaker || '').slice(0, 60)}"`);

          const { speaker, text } = splitSpeakerAndText({ rawText, rawSpeaker });

          // Track speaker extraction stats
          if (speaker) speakerExtractedCount++;
          else speakerNullCount++;

          // ── Full classification: system announcement → noise → spoken ──
          const { classification, isNoise, reason } = classifyCaptionEvent(text);
          rawEventEntry.classification = classification;
          rawCaptionEvents.push(rawEventEntry);

          if (isNoise) {
            const cat = reason || REJECT_REASON.UI_MENU_TEXT;
            rejectReasons[cat] = (rejectReasons[cat] || 0) + 1;

            // Track per-classification counters
            if (classification === CAPTION_CLASSIFICATION.UI_SYSTEM_ANNOUNCEMENT) {
              systemAnnouncementCount++;
              addLog(`[caption:system_announcement] "${text.slice(0, 180)}"`);
            } else {
              unknownTextCount++;
              addLog(`[caption:rejected:${cat}] "${text.slice(0, 180)}"`);
            }
            uiFilteredCount++;
            rejectedChunkCount++;
            return;
          }

          // ── Spoken caption — process normally ──
          spokenCaptionCount++;

          if (shouldAppendCaptionChunk(text, captionChunks) || captionChunks.length === 0) {
            const mergeResult = appendOrMergeCaptionChunk({
              captionChunks,
              captionTexts,
              speaker,
              text,
              source: sourceLabel,
            });
            stageContext.captionChunkCount = captionChunks.length;
            stageContext.transcriptLength = captionTexts.join('\n').length;
            logStage('caption_chunk_captured', {
              source: sourceLabel,
              speaker: speaker || null,
              chunkPreview: text.slice(0, 120),
              chunkCount: captionChunks.length,
            });
            if (mergeResult.action === 'merged_extension' || mergeResult.action === 'merged_replacement') {
              dedupMergedCount++;
              incrementalMergedCount++;
              // If the merge wasn't a plain exact-startsWith, it was a fuzzy/prefix merge
              const prevChunk = captionChunks[mergeResult.index];
              if (prevChunk && (prevChunk.source || '').includes('merged_replacement')) {
                prefixMergedCount++;
              }
              addLog(`[caption:incremental_update] mode=${mergeResult.action} speaker="${speaker || ''}" text="${text.slice(0, 180)}"`);
            } else if (mergeResult.action === 'merged_duplicate') {
              dedupMergedCount++;
              addLog(`[caption:dedup] speaker="${speaker || ''}" text="${text.slice(0, 60)}"`);
            } else {
              // 'appended' — new utterance finalized
              acceptedChunkCount++;
              addLog(`[caption:new_utterance] source=${sourceLabel} speaker="${speaker || ''}" text="${text.slice(0, 180)}"`);
            }
            logStage('transcript_buffer_updated', {
              transcriptLength: stageContext.transcriptLength,
              chunkCount: captionChunks.length,
            });
            lastCaptionCaptureAt = Date.now();
            lastSuccessfulCaptionTs = new Date().toISOString();
            captionWatcherInactiveLogged = false;
            if (!firstCaptionTime) {
              firstCaptionTime = new Date().toISOString();
              addLog(`First caption captured at ${firstCaptionTime}: "${text.slice(0, 80)}"`);
            }
          } else if (text) {
            rejectReasons[REJECT_REASON.DUPLICATE_INCREMENTAL]++;
            dedupRejectedCount++;
            rejectedChunkCount++;
          }
        };

        // Collect from MutationObserver
        const observerCaptions = await page.evaluate(() => {
          const caps = window.__capturedCaptions || [];
          window.__capturedCaptions = []; // Drain
          return caps;
        }).catch(() => []);

        for (const cap of observerCaptions) {
          const rawText = typeof cap === 'string' ? cap : (cap?.text || '');
          const rawSpeaker = typeof cap === 'object' ? (cap?.speaker || null) : null;
          const sourceLabel = cap?.source || 'observer';
          if (cap?.source === 'poll_fallback') pollFallbackUsed = true;
          processCaptionEvent(rawText, rawSpeaker, sourceLabel);
        }

        // ── Backup DOM poll: only from validated node, not broad DOM ──────────
        // This complements the observer for cases where mutations are missed.
        // Only runs against the validated caption selector, not broad selectors.
        const validatedSel = validatedCaptionSel;
        if (validatedSel) {
          const polledCaptions = await page.evaluate((selStr, uiExcludeSelector, siblingSelectors) => {
            const results = [];
            let nodes;
            try { nodes = document.querySelectorAll(selStr); }
            catch (_) { return results; }

            for (const node of nodes) {
              try { if (node.closest(uiExcludeSelector)) continue; } catch (_) {}
              const rect = node.getBoundingClientRect();
              if (rect.width < 8) continue;

              // Innermost text extraction
              const innerSelectors = ['.zs7s8d', '[jsname="tgaKEf"]', '[data-message-text]', 'span:last-child'];
              let text = '';
              for (const sel of innerSelectors) {
                try {
                  const inner = node.querySelector(sel);
                  if (inner) {
                    const t = (inner.textContent || '').trim();
                    if (t.length > 1 && t.length <= 280) { text = t; break; }
                  }
                } catch (_) {}
              }
              if (!text) {
                const t = (node.textContent || '').trim();
                if (t.length > 1 && t.length <= 280) text = t;
              }
              if (!text) continue;

              // Sibling-based speaker extraction
              let speaker = null;
              const parent = node.parentElement;
              if (parent) {
                for (const sibSel of siblingSelectors) {
                  try {
                    const sib = parent.querySelector(sibSel);
                    if (sib && sib !== node) {
                      const v = (sib.textContent || '').trim();
                      if (v && v.length > 0 && v.length < 80) { speaker = v; break; }
                    }
                  } catch (_) {}
                }
              }
              results.push({ text, speaker, source: 'poll_validated_node' });
            }
            return results;
          }, validatedSel, CAPTION_UI_EXCLUDE_SELECTOR, CAPTION_SPEAKER_SIBLING_SELECTORS).catch(() => []);

          for (const cap of polledCaptions) {
            processCaptionEvent(cap.text, cap.speaker, cap.source || 'poll_validated_node');
          }
        }

        if (Date.now() - lastWatcherHeartbeatAt > WATCHER_HEARTBEAT_MS) {

          lastWatcherHeartbeatAt = Date.now();
          const watcherHealth = await page.evaluate((captionSelector) => {
            return {
              watcherAttached:     !!window.__captionObserver,
              watcherAttachedAt:   window.__captionWatcherAttachedAt || null,
              lastMutationAt:      window.__captionWatcherLastMutationAt || null,
              lastEventAt:         window.__captionWatcherLastEventAt || null,
              containerExists:     !!document.querySelector(captionSelector),
              pollFallbackActive:  !!window.__captionPollFallbackActive,
              pollLastEventAt:     window.__captionPollLastEventAt || null,
            };
          }, CAPTION_CONTAINER_SELECTOR).catch(() => ({ watcherAttached: false, containerExists: false }));
          logStage('watcher_heartbeat', {
            watcherAttached:        watcherHealth.watcherAttached,
            lastCaptionReceivedAt:  new Date(lastCaptionCaptureAt).toISOString(),
            lastSuccessfulCaptionTs,
            watcherLastMutationAt:  watcherHealth.lastMutationAt ? new Date(watcherHealth.lastMutationAt).toISOString() : null,
            watcherLastEventAt:     watcherHealth.lastEventAt ? new Date(watcherHealth.lastEventAt).toISOString() : null,
            containerExists:        watcherHealth.containerExists,
            recoveryAttempts:       watcherRecoveryAttempts,
            pollFallbackActive:     watcherHealth.pollFallbackActive,
          });

          // Detect if captions were disabled mid-meeting (container gone, no text for a while)
          if (!watcherHealth.containerExists && firstCaptionTime && (Date.now() - lastCaptionCaptureAt > WATCHER_INACTIVITY_MS)) {
            captionsDisabledAfterJoin = true;
            addLog('[watcher:heartbeat] Caption container gone after initial success — likely disabled mid-meeting');
          }
        }

        if (!captionWatcherInactiveLogged && Date.now() - lastCaptionCaptureAt > WATCHER_INACTIVITY_MS) {
          captionWatcherInactiveLogged = true;
          const inactiveForMs = Date.now() - lastCaptionCaptureAt;
          logStage('caption_watcher_inactive', {
            inactiveForMs,
            chunkCount: captionChunks.length,
            thresholdMs: WATCHER_INACTIVITY_MS,
          });
          addLog(`[watcher:recovery] Inactive for ${Math.round(inactiveForMs / 1000)}s — starting recovery (attempt ${watcherRecoveryAttempts + 1}/${MAX_WATCHER_RECOVERY_ATTEMPTS})`);

          // ── Step 1: Fresh DOM rediscovery ──
          const candidates = await discoverCaptionCandidates();
          addLog(`[watcher:discovery] Recovery scan: ${candidates.length} candidate(s) found`);
          candidates.slice(0, 3).forEach((c, i) => {
            addLog(`[watcher:discovery]   #${i + 1}: sel=${c.sel} score=${c.score} text="${c.textPreview}" pos=${c.positionPct}%`);
          });

          // ── Step 2: Check if container was replaced ──
          const domWatcherState = await page.evaluate((captionSelector) => ({
            containerExists:  !!document.querySelector(captionSelector),
            watcherAttached:  !!window.__captionObserver,
            lastEventAt:      window.__captionWatcherLastEventAt || null,
          }), CAPTION_CONTAINER_SELECTOR).catch(() => ({ containerExists: false, watcherAttached: false }));

          if (!domWatcherState.containerExists) {
            watcherContainerReplaced = true;
            watcherAttachedToStaleNode = true;
            addLog('[watcher:recovery] CAPTION_CONTAINER_REPLACED — container not found in DOM');
            logStage('caption_container_lost', { reason: 'CAPTION_CONTAINER_REPLACED' });
          } else if (candidates.length === 0) {
            addLog('[watcher:recovery] CAPTION_CONTAINER_NOT_FOUND — no candidates discovered');
            logStage('caption_container_lost', { reason: 'CAPTION_CONTAINER_NOT_FOUND' });
          } else {
            addLog(`[watcher:recovery] Container present but watcher inactive — likely WATCHER_ATTACHED_TO_STALE_NODE`);
            watcherAttachedToStaleNode = true;
          }

          // Save debug snapshot for this attempt
          watcherDebugSnapshots.push({
            attempt: watcherRecoveryAttempts + 1,
            ts: new Date().toISOString(),
            inactiveForMs,
            candidateCount: candidates.length,
            topCandidates: candidates.slice(0, 5),
            containerExists: domWatcherState.containerExists,
            watcherAttached: domWatcherState.watcherAttached,
          });

          if (watcherRecoveryAttempts < MAX_WATCHER_RECOVERY_ATTEMPTS) {
            watcherRecoveryAttempts++;

            // Backoff between retries (attempt 1=5s, 2=10s, 3=15s…)
            const backoffMs = WATCHER_RECOVERY_BACKOFF_MS * (watcherRecoveryAttempts - 1);
            if (backoffMs > 0) {
              addLog(`[watcher:recovery] Backoff ${backoffMs}ms before reattach (attempt ${watcherRecoveryAttempts})`);
              await sleep(backoffMs);
            }

            // ── Step 3: Reattach to best candidate ──
            const chunkCountBefore = captionChunks.length;
            const rawCountBefore   = rawCaptionEvents.length;
            const recovery = await attachCaptionWatcher('inactivity_recovery', candidates);

            if (!recovery?.ok) {
              addLog(`[watcher:recovery] WATCHER_RECOVERY_FAILED — attach threw: ${recovery?.error || 'unknown'}`);
              logStage('watcher_recovery_failed', { attempt: watcherRecoveryAttempts, reason: 'WATCHER_RECOVERY_FAILED', error: recovery?.error });
              watcherDebugSnapshots[watcherDebugSnapshots.length - 1].attachError = recovery?.error;
            } else {
              addLog(`[watcher:recovery] Reattached (attempt ${watcherRecoveryAttempts}). Validating over ${WATCHER_VALIDATION_WINDOW_MS}ms…`);
              logStage('watcher_reattached', {
                attempt: watcherRecoveryAttempts,
                containerExists: !!recovery.containerExists,
                bestCandidateSel: recovery.bestCandidateSel || null,
              });

              // ── Step 4: Validation window — only call success if events arrive ──
              const validation = await validateWatcherReattach(chunkCountBefore, rawCountBefore, WATCHER_VALIDATION_WINDOW_MS);
              watcherReattachResults.push({
                attempt: watcherRecoveryAttempts,
                validated: validation.validated,
                chunkDelta: validation.chunkDelta,
                rawDelta: validation.rawDelta,
                bestCandidateSel: recovery.bestCandidateSel || null,
              });
              watcherDebugSnapshots[watcherDebugSnapshots.length - 1].validation = validation;

              if (validation.validated) {
                addLog(`[watcher:recovery] ✓ RECOVERY VALIDATED — ${validation.chunkDelta} new chunk(s), ${validation.rawDelta} raw event(s) in window`);
                logStage('watcher_recovery_succeeded', { attempt: watcherRecoveryAttempts, chunkDelta: validation.chunkDelta });
                watcherRecoveredSuccessfully = true;
                watcherReattachNoEvents = false;
                captionWatcherInactiveLogged = false;
                lastSuccessfulCaptionTs = new Date().toISOString();

                // Deactivate poll fallback if observer is healthy again
                if (pollFallbackActivated) {
                  await page.evaluate(() => {
                    if (window.__captionPollTimer) {
                      clearInterval(window.__captionPollTimer);
                      window.__captionPollTimer = null;
                    }
                    window.__captionPollFallbackActive = false;
                  }).catch(() => {});
                  addLog('[watcher:recovery] Poll fallback deactivated — observer healthy');
                }
              } else {
                addLog(`[watcher:recovery] ✗ WATCHER_REATTACH_NO_EVENTS — reattach produced no captions in ${WATCHER_VALIDATION_WINDOW_MS}ms`);
                logStage('watcher_recovery_failed', { attempt: watcherRecoveryAttempts, reason: 'WATCHER_REATTACH_NO_EVENTS' });
                watcherReattachNoEvents = true;

                // Activate poll fallback after 2 failed validated reattaches
                const failedReattaches = watcherReattachResults.filter(r => !r.validated).length;
                if (failedReattaches >= 2 && !pollFallbackActivated) {
                  pollFallbackActivated = true;
                  const fallbackResult = await activatePollFallback();
                  addLog(`[watcher:fallback] Poll fallback ACTIVATED (${failedReattaches} failed reattaches) — result: ${JSON.stringify(fallbackResult)}`);
                  logStage('poll_fallback_activated', { failedReattaches, result: fallbackResult });
                }

                // Allow loop to re-check inactivity on next tick
                captionWatcherInactiveLogged = false;
              }
            }
          } else {
            watcherRecoveryFailed = true;
            captionWatcherStopped = true;
            addLog('[watcher:recovery] WATCHER_RECOVERY_FAILED — max attempts exhausted');
            logStage('watcher_recovery_failed', { attempt: watcherRecoveryAttempts, reason: 'max_recovery_attempts_exceeded', snapshots: watcherDebugSnapshots });

            // Ensure poll fallback is running as last resort
            if (!pollFallbackActivated) {
              pollFallbackActivated = true;
              const fallbackResult = await activatePollFallback();
              addLog(`[watcher:fallback] Poll fallback activated after max recovery exhausted: ${JSON.stringify(fallbackResult)}`);
              logStage('poll_fallback_activated', { reason: 'max_recovery_exhausted', result: fallbackResult });
            }
          }
        }

        if (Date.now() - lastCheckpointAt > 15000) {
          lastCheckpointAt = Date.now();
          // Plain text transcript for human-readable fields
          const checkpointPlainTranscript = formatChunksAsPlainText(captionChunks);
          const previewTranscript = captionTexts.slice(-12).join('\n');
          const avgChunkSize = captionChunks.length
            ? Math.round(captionChunks.reduce((acc, c) => acc + (c?.text?.length || 0), 0) / captionChunks.length)
            : 0;
          // Compute partial updates collapsed from per-chunk counters
          partialUpdatesDiscarded = captionChunks.reduce((acc, c) => acc + (c?.partialCount || 0), 0);
          const finalUtteranceCount = captionChunks.length;
          logStage('transcript_growth_stats', {
            transcriptLength: checkpointPlainTranscript.length,
            chunkCount: captionChunks.length,
            avgChunkSize,
            dedupRejectedCount,
            incrementalMergedCount,
            partialUpdatesDiscarded,
            finalUtteranceCount,
            spokenCaptionCount,
            systemAnnouncementCount,
            unknownTextCount,
          });
          const watcherHealth2 = await page.evaluate(() => ({
            observeTarget: window.__captionObserveTarget || null,
            validatedSel: window.__captionValidatedSel || null,
          })).catch(() => ({}));

          updateMeeting(meetingId, {
            raw_caption_transcript: checkpointPlainTranscript || null,
            raw_caption_chunks_json: JSON.stringify({
              rawEvents: rawCaptionEvents.slice(-1000),
              cleanedChunks: captionChunks.slice(-500),
            }),
            preview_transcript: previewTranscript || null,
            transcript: checkpointPlainTranscript || null,
            transcript_metadata_json: JSON.stringify({
              checkpoint: true,
              transcriptLength: checkpointPlainTranscript.length,
              captionChunkCount: captionChunks.length,
              spokenCaptionCount,
              systemAnnouncementCount,
              unknownTextCount,
              rawCaptionChars: rawCaptionEvents.reduce((acc, ev) => acc + String(ev?.text || '').length, 0),
              cleanedCaptionChars: checkpointPlainTranscript.length,
              mergedTranscriptChars: checkpointPlainTranscript.length,
              rawChunkCount: rawCaptionEvents.length,
              acceptedChunkCount,
              rejectedChunkCount,
              dedupMergedCount,
              uiFilteredCount,
              rejectReasons,
              speakerExtractedCount,
              speakerNullCount,
              incrementalMergedCount,
              prefixMergedCount,
              finalUtteranceCount,
              partialUpdatesDiscarded,
              validatedCaptionSel: validatedCaptionSel || watcherHealth2.validatedSel || null,
              observeTarget: watcherHealth2.observeTarget || null,
              minTranscriptThresholdUsed: {
                ...getTranscriptThresholdConfig(),
                watcherInactivityMs: WATCHER_INACTIVITY_MS,
              },
              totalCaptureDurationMs: Date.now() - captureStart,
              lastCaptionTimestamp: lastCaptionCaptureAt ? new Date(lastCaptionCaptureAt).toISOString() : null,
              watcherRecoveredSuccessfully,
              avgChunkSize,
              dedupRejectedCount,
              captionWatcherStopped,
              watcherRecoveryAttempts,
              watcherRecoveryFailed,
              watcherContainerReplaced,
              watcherReattachNoEvents,
              watcherAttachedToStaleNode,
              pollFallbackActivated,
              pollFallbackUsed,
              captionsDisabledAfterJoin,
              lastSuccessfulCaptionTs,
              watcherReattachResults,
              watcherDebugSnapshots,
              watcherInactivityMs: WATCHER_INACTIVITY_MS,
              lastCheckpointAt: new Date(lastCheckpointAt).toISOString(),
            }),
          });
        }

        // Periodic progress log
        if (captionTexts.length > lastLoggedCount) {
          if (captionTexts.length >= lastLoggedCount + 5 || (captionTexts.length > 0 && lastLoggedCount === 0)) {
            addLog(`Transcript progress: ${captionTexts.length} segments captured`);
            lastLoggedCount = captionTexts.length;
          }
        }

        // If 30 seconds in and nothing captured, dump DOM info for debugging
        if (!domSnapshotDone && Date.now() - captureStart > 30000 && captionTexts.length === 0) {
          domSnapshotDone = true;
          const debugInfo = await page.evaluate(() => {
            const allElements = document.querySelectorAll('*');
            const bottomElements = [];
            for (const el of allElements) {
              const rect = el.getBoundingClientRect();
              if (rect.top > window.innerHeight * 0.6 && el.textContent?.trim() && el.children.length === 0) {
                bottomElements.push({
                  tag: el.tagName,
                  class: el.className?.toString()?.slice(0, 60) || '',
                  text: el.textContent.trim().slice(0, 50),
                });
              }
            }
            return {
              bottomElementCount: bottomElements.length,
              samples: bottomElements.slice(0, 10),
              hasCaptionClass: !!document.querySelector('[class*="caption"]'),
              hasSubtitleClass: !!document.querySelector('[class*="subtitle"]'),
            };
          }).catch(() => ({ error: 'could not snapshot' }));
          addLog(`DOM snapshot (30s, no captions): ${JSON.stringify(debugInfo)}`);
        }

      } catch (captionErr) {
        lifecycle.lastException = captionErr?.stack || captionErr?.message || String(captionErr);
        addLog(`[caption] Poll error (continuing): ${captionErr.message}`);
        // Caption collection error — do NOT break the loop, just skip this tick
        // The presence check above handles real disconnection
      }

      if (audioRecorder) {
        await audioRecorder.drain(page).catch((err) => {
          addLog(`[audio] drain warning: ${err.message}`);
        });
      }

      await sleep(CAPTION_POLL_INTERVAL_MS);
    }

    addLog(`[exit] Capture loop exited — reason: ${captureExitReason}`);

    // Cleanup observer
    await page.evaluate(() => {
      if (window.__captionObserver) { window.__captionObserver.disconnect(); }
    }).catch(() => {});

    addLog(`Capture complete.`);
    addLog(`  Exit reason:    ${captureExitReason}`);
    if (lastDomSignals) {
      addLog(`  Exit snapshot:  ${JSON.stringify(lastDomSignals)}`);
    }
    addLog(`  Total segments: ${captionTexts.length}`);
    addLog(`  First caption:  ${firstCaptionTime || 'none'}`);
    addLog(`  Duration:       ${Math.round((Date.now() - captureStart) / 1000)}s`);
    if (lifecycle.pageError) addLog(`  pageerror:      ${lifecycle.pageError}`);
    if (lifecycle.pageRuntimeError) addLog(`  page error:     ${lifecycle.pageRuntimeError}`);
    if (lifecycle.lastException) addLog(`  last exception: ${String(lifecycle.lastException).slice(0, 500)}`);

    if (audioRecorder) {
      addLog('[audio] Finalizing recorder before browser teardown...');
      finalizedAudioFilePath = await audioRecorder.stop(page).catch((err) => {
        addLog(`[audio] Stop failed: ${err.message}`);
        return null;
      });
    }

    // Leave the meeting
    try {
      const leaveBtn = await page.$('[aria-label*="Leave call"], [aria-label*="End call"]');
      if (leaveBtn) { await leaveBtn.click(); addLog('Left the meeting'); }
    } catch (_) {}

    await sleep(1000);
    if (browser?.connected) {
      addLog("[lifecycle] Calling browser.close() after capture end");
      browserClosedExplicitly = true;
      try {
        await browser.close();
      } catch (closeErr) {
        addLog(`[lifecycle] browser.close() error: ${closeErr.message}`);
      }
    } else {
      addLog('[lifecycle] Browser already disconnected before explicit close');
    }
    browser = null;

    // ── Phase 8: Process transcript (captions + audio fallback) ──
    const meetingDurationSec = Math.max(1, Math.round((Date.now() - captureStart) / 1000));
    let audioTranscriptText = '';
    let usedAudioFallback = false;
    const audioFilePath = finalizedAudioFilePath;

    if (audioFilePath) {
      updateMeeting(meetingId, { status: 'transcribing_audio', audio_file_path: audioFilePath });
      addLog(`[audio] Saved: ${audioFilePath}`);
      addLog('[audio] Starting speech-to-text...');
      logStage('audio_transcription_started', { audioFilePath });
      const sttResult = await transcriptionService.transcribeAudio({
        filePath: audioFilePath,
        meetingId,
        addLog,
      }).catch((err) => {
        addLog(`[audio] Transcription failed: ${err.message}`);
        return null;
      });
      if (sttResult?.chunks?.length) {
        audioTranscriptText = sttResult.chunks.map((c) => c.text).join('\n');
        addLog(`[audio] Transcription complete (${audioTranscriptText.length} chars, ${sttResult.chunks.length} chunks)`);
        logStage('audio_transcription_completed', {
          audioTranscriptLength: audioTranscriptText.length,
          audioChunkCount: sttResult.chunks.length,
        });
      }
    }

    const captionPlainTranscript = formatChunksAsPlainText(captionChunks);
    logStage('transcript_merge_started', {
      captionChunkCount: captionChunks.length,
      captionTranscriptLength: captionPlainTranscript.length,
      audioTranscriptLength: audioTranscriptText.length,
      spokenCaptionCount,
      systemAnnouncementCount,
    });
    const merged = mergeTranscriptSources({
      captionChunks,
      audioChunks: audioTranscriptText
        ? [{ ts: new Date().toISOString(), text: audioTranscriptText, source: 'audio_stt' }]
        : [],
      meetingDurationSec,
    });
    usedAudioFallback = merged.metadata.audioFallbackUsed;

    const mergedTranscript = merged.mergedTranscript;
    const avgChunkSize = captionChunks.length
      ? Math.round(captionChunks.reduce((acc, c) => acc + (c?.text?.length || 0), 0) / captionChunks.length)
      : 0;

    // ── Determine caption failure reason for shared-video diagnostics ──
    const audioFallbackUnavailable = !audioFallbackAvailable && audioRecorderStartAttempted;
    let captionFailureReason = null;
    if (spokenCaptionCount === 0 && systemAnnouncementCount > 0) {
      captionFailureReason = SHARED_VIDEO_FAILURE_REASONS.ONLY_UI_ANNOUNCEMENTS_CAPTURED;
    } else if (spokenCaptionCount === 0 && systemAnnouncementCount === 0 && audioFallbackUnavailable) {
      captionFailureReason = SHARED_VIDEO_FAILURE_REASONS.SHARED_VIDEO_AUDIO_NOT_CAPTIONED;
    }

    updateMeeting(meetingId, {
      status: 'merging_transcript',
      raw_caption_transcript: captionPlainTranscript || null,
      raw_caption_chunks_json: JSON.stringify({
        rawEvents: rawCaptionEvents,
        cleanedChunks: captionChunks,
      }),
      raw_audio_transcript: audioTranscriptText || null,
      merged_transcript: mergedTranscript || null,
      preview_transcript: mergedTranscript ? mergedTranscript.slice(0, 4000) : null,
      transcript_metadata_json: JSON.stringify({
        ...merged.metadata,
        meetingDurationSec,
        audioFilePath,
        spokenCaptionCount,
        systemAnnouncementCount,
        unknownTextCount,
        captionFailureReason,
        audioFallbackUnavailable,
        rawCaptionChars: rawCaptionEvents.reduce((acc, ev) => acc + String(ev?.text || '').length, 0),
        cleanedCaptionChars: captionPlainTranscript.length,
        mergedTranscriptChars: mergedTranscript?.length || 0,
        rawChunkCount: rawCaptionEvents.length,
        acceptedChunkCount,
        rejectedChunkCount,
        dedupMergedCount,
        uiFilteredCount,
        minTranscriptThresholdUsed: {
          ...getTranscriptThresholdConfig(),
          watcherInactivityMs: WATCHER_INACTIVITY_MS,
        },
        totalCaptureDurationMs: Date.now() - captureStart,
        lastCaptionTimestamp: lastCaptionCaptureAt ? new Date(lastCaptionCaptureAt).toISOString() : null,
        lastSuccessfulCaptionTs,
        audioFallbackAttempted: audioRecorderStartAttempted,
        audioFallbackAvailable,
        audioFallbackFailed: audioRecordingFailed,
        audioRecordingFailed,
        audioRecordingFailureReason,
        audioRecorderStrategy,
        transcriptLength: mergedTranscript?.length || 0,
        captionChunkCount: captionChunks.length,
        avgChunkSize,
        dedupRejectedCount,
        captionWatcherStopped,
        watcherRecoveryAttempts,
        watcherRecoveryFailed,
        watcherRecoveredSuccessfully,
        watcherContainerReplaced,
        watcherReattachNoEvents,
        watcherAttachedToStaleNode,
        pollFallbackActivated,
        pollFallbackUsed,
        captionsDisabledAfterJoin,
        watcherReattachResults,
        watcherDebugSnapshots: watcherDebugSnapshots.slice(-6), // keep last 6 attempts
        watcherInactivityMs: WATCHER_INACTIVITY_MS,
        rejectReasons,
        speakerExtractedCount,
        speakerNullCount,
        incrementalMergedCount,
        prefixMergedCount,
        finalUtteranceCount: captionChunks.length,
        partialUpdatesDiscarded: captionChunks.reduce((acc, c) => acc + (c?.partialCount || 0), 0),
        validatedCaptionSel,
        meetingSilentTooLong,
        captionsEnabled,
      }),
      transcript: mergedTranscript || null,
    });
    logStage('transcript_merge_completed', {
      mergedTranscriptLength: mergedTranscript?.length || 0,
      source: merged.metadata?.source || null,
    });
    logStage('transcript_saved', {
      mergedTranscriptLength: mergedTranscript?.length || 0,
      captionChunkCount: captionChunks.length,
    });

    if (isNonEmptyString(mergedTranscript)) {
      addLog(
        `Merged transcript saved (${mergedTranscript.length} chars). ` +
        `captions=${merged.metadata.captionTranscriptLength}, audio=${merged.metadata.audioTranscriptLength}, fallback=${usedAudioFallback ? 'yes' : 'no'}`
      );
      emitDebugLog({
        hypothesisId: 'H-ID-CONSISTENCY',
        location: 'index.js:runBotWorker:capture-saved',
        message: 'capture_saved',
        data: {
          meetingId,
          transcriptLength: mergedTranscript.length,
          segmentCount: captionTexts.length,
          transcriptSource: usedAudioFallback ? 'audio_fallback_used' : 'captions_primary',
        },
      });

      updateMeeting(meetingId, { status: 'generating_summary' });
      logStage('summary_generation_started', {
        transcriptLength: mergedTranscript.length,
        source: usedAudioFallback ? 'audio_fallback' : 'captions_primary',
      });
      await runSummarization(meetingId, mergedTranscript, addLog, usedAudioFallback ? 'audio_fallback' : 'live_capture');
      logStage('summary_generation_completed');
    } else {
      addLog('No transcript could be produced from captions or audio.');

      // ── PRIORITY CHECK: Fall back to manual transcript if one exists in DB ──
      // This handles the scenario where: an old/empty meeting is submitted with a
      // manual transcript pasted alongside the Meet link. The bot joins (or tries),
      // finds an empty meeting, captures nothing — but the manual transcript is
      // already saved and must NOT be ignored.
      const freshMeetingRow = db.prepare('SELECT transcript FROM meetings WHERE id = ?').get(meetingId);
      const manualTranscriptFallback = freshMeetingRow?.transcript || null;

      if (isNonEmptyString(manualTranscriptFallback)) {
        addLog('[manual_transcript_fallback] Live meeting was empty/unavailable, but a manual transcript is present.');
        addLog(`[manual_transcript_fallback] Manual transcript length: ${manualTranscriptFallback.length} characters`);
        addLog('[manual_transcript_fallback] Using manual transcript as primary source for summarization.');
        logStage('manual_transcript_fallback_used', {
          liveTranscriptEmpty: true,
          manualTranscriptLength: manualTranscriptFallback.length,
          captureExitReason,
        });

        // Persist metadata so runSummarization can bypass captionChunkCount threshold
        updateMeeting(meetingId, {
          transcript_metadata_json: JSON.stringify({
            transcriptSource: 'manual_paste',
            manualTranscriptProvided: true,
            liveMeetingEmpty: true,
            liveMeetingEmptyReason: captureExitReason,
            captionChunkCount: captionChunks.length,
            transcriptLength: manualTranscriptFallback.length,
            statusMessage: 'Used pasted transcript because live meeting was unavailable.',
            thresholdValidationSource: 'manual_paste',
          }),
        });

        await runSummarization(meetingId, manualTranscriptFallback, addLog, 'manual_paste');
        return;
      }

      addLog('Diagnosis:');
      addLog('  - Captions may be disabled in the meeting (host setting)');
      addLog('  - Audio transcription provider may be unavailable or missing credentials');
      addLog('  - Google Meet DOM structure may have changed');
      addLog('  - Try enabling captions manually in the meeting');
      addLog('');
      addLog('ACTION: Use the Retry button to paste a transcript manually');

      // Map exit reason to a helpful error message
      const noTranscriptReasonCode = captureExitReason === 'removed_from_meeting'
        ? 'BOT_NOT_ADMITTED'
        : captureExitReason === 'denied_entry'
        ? 'BOT_NOT_ADMITTED'
        // Priority: most specific failure first
        : captionsDisabledAfterJoin
        ? 'CAPTIONS_DISABLED_AFTER_JOIN'
        : watcherAttachedToStaleNode && watcherReattachNoEvents
        ? 'WATCHER_ATTACHED_TO_STALE_NODE'
        : watcherReattachNoEvents
        ? 'WATCHER_REATTACH_NO_EVENTS'
        : watcherRecoveryFailed
        ? 'WATCHER_RECOVERY_FAILED'
        : watcherContainerReplaced
        ? 'CAPTION_CONTAINER_REPLACED'
        : captionWatcherStopped
        ? 'WATCHER_STALE'
        : !captionContainerFound
        ? 'CAPTION_CONTAINER_NOT_FOUND'
        : !captionsEnabled
        ? 'CAPTIONS_DISABLED'
        : meetingSilentTooLong
        ? 'MEETING_SILENT_TOO_LONG'
        : !captionChunks.length
        ? 'NO_CAPTION_CHUNKS_CAPTURED'
        : dedupRejectedCount > (captionChunks.length * 1.5)
        ? 'DEDUP_REMOVED_TOO_MUCH'
        : captionChunks.length > 0
        ? 'PARTIAL_CAPTIONS_ONLY'
        : audioRecordingFailed
        ? 'AUDIO_FALLBACK_FAILED'
        : 'TRANSCRIPT_BELOW_THRESHOLD';
      const noTranscriptMsg = captureExitReason === 'removed_from_meeting'
        ? 'Bot was removed from the meeting by the host before any captions were captured. Use Retry to paste a transcript manually.'
        : captureExitReason === 'denied_entry'
        ? 'Host denied the bot entry. No captions were captured. Use Retry to paste a transcript manually.'
        : captureExitReason === 'browser_disconnected'
        ? 'Browser disconnected unexpectedly during meeting capture. Check backend logs for lifecycle events and Chrome stability.'
        : captureExitReason === 'page_closed'
        ? 'Meet page closed unexpectedly during capture. Check lifecycle logs for the close cause.'
        : captureExitReason === 'browser_crashed'
        ? 'Chrome/renderer crashed during capture. Check page error lifecycle logs and profile stability.'
        : captureExitReason === 'process_restarted'
        ? 'Backend process restarted during capture (dev reload). Run backend without auto-reload for long bot sessions.'
        : captureExitReason === 'browser_closed'
        ? 'Browser closed unexpectedly before any captions were captured. Use Retry to paste a transcript manually.'
        : captureExitReason === 'max_duration_reached'
        ? `Bot reached maximum session duration (${Math.round(MAX_MEETING_DURATION_MS / 60000)} min) with no captions. Captions may not be enabled in this meeting. Use Retry to paste a transcript manually.`
        : 'Bot joined the meeting successfully but no captions were captured. Captions may not be enabled in this meeting. Use Retry to paste a transcript manually for AI summarization.';

      const isBrowserStabilityFailure = [
        'browser_disconnected',
        'page_closed',
        'browser_crashed',
        'process_restarted',
        'browser_closed',
      ].includes(captureExitReason);
      updateMeeting(meetingId, {
        status: isBrowserStabilityFailure ? 'failed' : 'needs_manual_transcript',
        failure_reason_code: noTranscriptReasonCode,
        error_message: noTranscriptMsg,
        completed_at: now(),
      });
      logStage('final_status_set', {
        finalStatus: isBrowserStabilityFailure ? 'failed' : 'needs_manual_transcript',
        failureReasonCode: noTranscriptReasonCode,
        finalReason: captureExitReason,
      });
      emitDebugLog({
        hypothesisId: 'H-SHORT-TRANSCRIPT',
        location: 'index.js:runBotWorker:no-transcript',
        message: 'no_valid_transcript_captured',
        data: {
          meetingId,
          transcriptLength: 0,
          segmentCount: 0,
          transcriptSource: 'live_capture',
          captureExitReason,
          browserDisconnected: lifecycle.browserDisconnected,
          pageClosed: lifecycle.pageClosed,
          pageError: lifecycle.pageError,
          pageRuntimeError: lifecycle.pageRuntimeError,
          lastException: lifecycle.lastException,
        },
      });
    }

  } catch (outerError) {
    addLog(`Fatal error: ${outerError.message}`);
    updateMeeting(meetingId, {
      status: 'failed',
      error_message: `Unexpected error: ${outerError.message}`,
      completed_at: now(),
    });
  } finally {
    if (browser) {
      browserClosedExplicitly = true;
      try { await browser.close(); } catch (_) {}
    }
  }
}

// ─── Summarization helper ─────────────────────────────────────────────────────

async function runSummarization(meetingId, transcript, addLog, source = 'unknown') {
  const logSummaryStage = (stage, meta = {}) => {
    emitDebugLog({
      hypothesisId: 'H-TRANSCRIPT-PIPELINE',
      location: 'index.js:runSummarization:stage',
      message: stage,
      data: { meetingId, ts: now(), source, stage, ...meta },
    });
    updateMeeting(meetingId, { last_stage: stage });
  };
  // Clear stale summarize artifacts before each new run for this meeting.
  updateMeeting(meetingId, {
    summary_json: null,
    raw_output: null,
    bot_log: null,
  });
  emitDebugLog({
    runId: `summarize-${meetingId}-${Date.now()}`,
    hypothesisId: 'H-ID-CONSISTENCY',
    location: 'index.js:runSummarization:start',
    message: 'summarization_start',
    data: {
      meetingId,
      source,
      transcriptLength: typeof transcript === 'string' ? transcript.length : 0,
    },
  });
  logSummaryStage('summary_generation_started', {
    transcriptLength: typeof transcript === 'string' ? transcript.length : 0,
  });

  if (!GEMINI_API_KEY) {
    addLog('GEMINI_API_KEY is not configured — cannot summarize');
    updateMeeting(meetingId, {
      status: 'failed',
      error_message: 'GEMINI_API_KEY is not configured in backend/.env — cannot generate AI summary.',
      completed_at: now(),
    });
    return;
  }

  // ── Structured Activity Log ───────────────────────────────────────────────
  // Each entry: { ts, step, status: 'ok'|'warn'|'fail', detail? }
  // Stored as a JSON array in bot_log so the frontend can render a clean timeline.
  // Raw technical output still goes to addLog (server console / plain botLog fallback).
  const activityLog = [];

  const logActivity = (step, status, detail) => {
    const entry = { ts: new Date().toISOString(), step, status };
    if (detail) entry.detail = String(detail).slice(0, 300);
    activityLog.push(entry);
    // Server-side debug log
    addLog(`[activity:${status}] ${step}${detail ? ': ' + detail : ''}`);
    // Persist to DB after every step so the UI can poll progress
    updateMeeting(meetingId, { bot_log: JSON.stringify(activityLog) });
  };

  updateMeeting(meetingId, { status: 'summarizing' });
  logActivity('Transcript received', 'ok', `${transcript.length} characters`);

  try {
    const summaryMetaRow = db.prepare('SELECT transcript_metadata_json FROM meetings WHERE id = ?').get(meetingId);
    let summaryMeta = {};
    try {
      summaryMeta = summaryMetaRow?.transcript_metadata_json ? JSON.parse(summaryMetaRow.transcript_metadata_json) : {};
    } catch (_) {
      summaryMeta = {};
    }

    // ── Transcript source priority & threshold bypass ──────────────────────────
    // Manual transcripts (source = 'manual_paste' | 'pasted' | 'saved_transcript')
    // must bypass the captionChunkCount requirement — they have no live chunks.
    // Only chars + lines thresholds apply.
    const MANUAL_SOURCES = new Set(['manual_paste', 'pasted', 'saved_transcript']);
    const isManualSource = MANUAL_SOURCES.has(source) || summaryMeta.manualTranscriptProvided === true ||
                           summaryMeta.transcriptSource === 'manual_paste';
    const chunkCountForValidation = isManualSource ? Infinity : Number(summaryMeta.captionChunkCount || 0);
    // Use spokenCaptionCount for threshold if available — ensures system announcements don't help pass
    const spokenCountForValidation = isManualSource ? Infinity : Number(summaryMeta.spokenCaptionCount ?? chunkCountForValidation);
    const thresholdSource = isManualSource ? 'manual_paste (chunk threshold bypassed)' : 'live_capture';

    const thresholdConfig = getTranscriptThresholdConfig();
    const transcriptValid = isTranscriptValidForSummary(transcript, { spokenCaptionCount: spokenCountForValidation, captionChunkCount: chunkCountForValidation });
    addLog(
      `[threshold] source=${source} isManualSource=${isManualSource} thresholdSource=${thresholdSource} ` +
      `MIN_TRANSCRIPT_CHARS=${thresholdConfig.minChars}, ` +
      `MIN_TRANSCRIPT_LINES=${thresholdConfig.minLines}, ` +
      `MIN_TRANSCRIPT_CHUNKS=${thresholdConfig.minChunks} (bypassed=${isManualSource}), ` +
      `CAPTION_WATCHER_INACTIVITY_MS=${Number(process.env.CAPTION_WATCHER_INACTIVITY_MS || 60000)}`
    );
    if (!transcriptValid) {
      const minChars = thresholdConfig.minChars;
      const minLines = thresholdConfig.minLines;
      const minChunks = thresholdConfig.minChunks;
      const lineCount = transcript.split('\n').filter(Boolean).length;
      emitDebugLog({
        hypothesisId: 'H-SHORT-TRANSCRIPT',
        location: 'index.js:runSummarization:invalid',
        message: 'invalid_transcript_no_summary',
        data: {
          meetingId,
          source,
          transcriptLength: transcript.length,
          lineCount,
          minChars,
          minLines,
          minChunks,
        },
      });
      logActivity('Transcript validation failed', 'warn', `Below threshold (${transcript.length}/${minChars} chars, ${lineCount}/${minLines} lines, ${chunkCountForValidation}/${minChunks} chunks).`);
      let existingMeta = {};
      try {
        existingMeta = summaryMetaRow?.transcript_metadata_json
          ? JSON.parse(summaryMetaRow.transcript_metadata_json)
          : {};
      } catch (_) {
        existingMeta = {};
      }
      const existingChunkCount = Number(existingMeta.captionChunkCount || 0);
      const existingDedupRejectedCount = Number(existingMeta.dedupRejectedCount || 0);
      const shortReasonCode = existingMeta.watcherRecoveryFailed
        ? 'WATCHER_RECOVERY_FAILED'
        : existingMeta.watcherContainerReplaced
        ? 'CAPTION_CONTAINER_REPLACED'
        : existingMeta.captionWatcherStopped
        ? 'WATCHER_STALE'
        : existingMeta.meetingSilentTooLong
        ? 'MEETING_SILENT_TOO_LONG'
        : existingDedupRejectedCount > existingChunkCount * 1.5 && existingChunkCount > 0
        ? 'DEDUP_REMOVED_TOO_MUCH'
        : existingChunkCount > 0
        ? 'PARTIAL_CAPTIONS_ONLY'
        : 'TRANSCRIPT_BELOW_THRESHOLD';
      updateMeeting(meetingId, {
        status: 'needs_manual_transcript',
        failure_reason_code: shortReasonCode,
        error_message: `Meeting ended, but transcript was below threshold (${transcript.length} chars, ${lineCount} lines).`,
        transcript_metadata_json: JSON.stringify({
          ...existingMeta,
          transcriptSource: isManualSource ? 'manual_paste' : (existingMeta.transcriptSource || 'live_capture'),
          manualTranscriptProvided: isManualSource,
          thresholdValidationSource: thresholdSource,
          transcriptLength: transcript.length,
          lineCount,
          minChars,
          minLines,
          minChunks,
          thresholdUsed: {
            minChars,
            minLines,
            minChunks,
            chunkCountBypassed: isManualSource,
            watcherInactivityMs: Number(process.env.CAPTION_WATCHER_INACTIVITY_MS || 60000),
          },
          shortTranscript: true,
        }),
        completed_at: now(),
      });
      logSummaryStage('final_status_set', { finalStatus: 'needs_manual_transcript', failureReasonCode: shortReasonCode });
      return;
    }

    // Wrap the internal log so we can intercept key milestones and
    // convert them to user-friendly activity log entries.
    const geminiLog = (msg) => {
      addLog(msg); // always pass through to server logs

      if (msg.includes('strategy: short') || msg.includes('Using direct summarization')) {
        logActivity('Transcript cleaned', 'ok', 'Ready for single-call summarization');

      } else if (msg.includes('Chunking transcript')) {
        logActivity('Transcript cleaned', 'ok', 'Long transcript — splitting into segments');
        updateMeeting(meetingId, { status: 'chunking_transcript' });

      } else if (/Created \d+ chunks/.test(msg)) {
        const m = msg.match(/Created (\d+) chunks/);
        if (m) logActivity('Transcript split into segments', 'ok', `${m[1]} segments created`);

      } else if (/\[gemini:chunk\] START chunk 1\//.test(msg)) {
        // First chunk starting — transition status to summarizing_chunks
        updateMeeting(meetingId, { status: 'summarizing_chunks' });
        const m = msg.match(/START chunk 1\/(\d+)/);
        logActivity('Summarizing segments', 'ok', m ? `Processing ${m[1]} segments…` : undefined);

      } else if (/\[gemini:chunk\] SUCCESS chunk/.test(msg)) {
        const m = msg.match(/SUCCESS chunk (\d+)\/(\d+)/);
        if (m) logActivity(`Segment ${m[1]} of ${m[2]} summarized`, 'ok');

      } else if (/\[gemini:chunk\] EXHAUSTED chunk/.test(msg)) {
        const m = msg.match(/EXHAUSTED chunk (\d+)\/(\d+)/);
        if (m) logActivity(`Segment ${m[1]} could not be summarized`, 'warn', 'Continuing with remaining segments');

      } else if (/\[gemini:chunk\] HARD FAIL/.test(msg)) {
        const m = msg.match(/HARD FAIL chunk (\d+)\/(\d+)/);
        if (m) logActivity(`Segment ${m[1]} hard failure`, 'warn', 'Continuing with remaining segments');

      } else if (/\[gemini:merge\] Merging \d+ chunk summaries/.test(msg)) {
        updateMeeting(meetingId, { status: 'merging_summaries' });
        logActivity('Merging segment summaries', 'ok');

      } else if (/Hierarchical mode/.test(msg)) {
        logActivity('Hierarchical grouping', 'ok', 'Large transcript — grouping segments before final merge');

      } else if (/Merging group \d+\/\d+/.test(msg)) {
        const m = msg.match(/Merging group (\d+)\/(\d+)/);
        if (m) logActivity(`Merging segment group ${m[1]} of ${m[2]}`, 'ok');

      } else if (/\[gemini:merge\] Merge complete/.test(msg)) {
        logActivity('Summaries merged', 'ok');

      } else if (/Direct success/.test(msg)) {
        logActivity('Summary generated', 'ok');
      }
    };

    const { summary, rawOutput, modelUsed, strategy, chunkCount, partialFailures } =
      await summarizeTranscript(transcript, GEMINI_API_KEY, geminiLog);

    if (summary) {
      // Data-integrity guard: participants must come from THIS transcript only.
      const transcriptSpeakers = extractSpeakersFromTranscript(transcript);
      const transcriptSpeakerSet = new Set(transcriptSpeakers.map(s => s.toLowerCase()));
      const aiParticipants = Array.isArray(summary.participants) ? summary.participants : [];
      summary.participants = aiParticipants.filter((p) => transcriptSpeakerSet.has(String(p).toLowerCase()));

      const title     = summary.title || 'Meeting Summary';
      const isPartial = partialFailures > 0;

      if (strategy !== 'direct' && summary.participants?.length > 0) {
        logActivity('Participants extracted', 'ok', `${summary.participants.length} found`);
      }

      const strategyLabel =
        strategy === 'direct'       ? 'single-call' :
        strategy === 'chunked'      ? `${chunkCount} segments` :
        /* hierarchical */            `${chunkCount} segments, hierarchical`;

      // Enrich existing transcript metadata with source/summary info
      const completedMetaRow = db.prepare('SELECT transcript_metadata_json FROM meetings WHERE id = ?').get(meetingId);
      let completedMeta = {};
      try { completedMeta = completedMetaRow?.transcript_metadata_json ? JSON.parse(completedMetaRow.transcript_metadata_json) : {}; } catch (_) {}
      const statusMessageForCompletion = isManualSource && completedMeta.liveMeetingEmpty
        ? 'Used pasted transcript because live meeting was unavailable.'
        : isManualSource
        ? 'Used pasted transcript for summarization.'
        : null;

      updateMeeting(meetingId, {
        status: isPartial ? 'partial_summary' : 'completed',
        title,
        summary_json: JSON.stringify(summary),
        raw_output:   JSON.stringify(rawOutput),
        error_message: isPartial
          ? `Summary generated with ${partialFailures} of ${chunkCount} segment(s) unavailable. Transcript is fully saved.`
          : null,
        completed_at: now(),
        failure_reason_code: null,
        transcript_metadata_json: JSON.stringify({
          ...completedMeta,
          transcriptSource: isManualSource ? 'manual_paste' : (completedMeta.transcriptSource || source || 'live_capture'),
          manualTranscriptProvided: isManualSource,
          liveMeetingEmpty: completedMeta.liveMeetingEmpty ?? false,
          thresholdValidationSource: thresholdSource,
          statusMessage: statusMessageForCompletion || completedMeta.statusMessage || null,
          summarySource: source,
        }),
      });
      logSummaryStage('summary_generation_completed', { finalStatus: isPartial ? 'partial_summary' : 'completed' });
      logSummaryStage('final_status_set', { finalStatus: isPartial ? 'partial_summary' : 'completed' });
      emitDebugLog({
        hypothesisId: 'H-ID-CONSISTENCY',
        location: 'index.js:runSummarization:save',
        message: 'summary_saved',
        data: {
          meetingId,
          source,
          transcriptLength: transcript.length,
          chunkCount,
          strategy,
          transcriptSpeakerCount: transcriptSpeakers.length,
          participantCountSaved: summary.participants?.length || 0,
        },
      });

      logActivity(
        isPartial ? 'Summary saved (partial)' : 'Summary saved',
        isPartial ? 'warn' : 'ok',
        `"${title}" · ${strategyLabel}${isPartial ? ` · ${partialFailures} segment(s) failed` : ''}`
      );

      addLog(`Summary generated with model "${modelUsed}" [${strategy}]: "${title}"`);
      addLog('Meeting processing complete!');
    } else {
      logActivity('Summarization returned empty result', 'warn');
      updateMeeting(meetingId, {
        status: 'failed',
        failure_reason_code: 'TRANSCRIPT_BELOW_THRESHOLD',
        error_message: 'Gemini returned an empty summary. The transcript may be too short or unclear. Try pasting a longer transcript.',
        completed_at: now(),
      });
      logSummaryStage('final_status_set', { finalStatus: 'failed', failureReasonCode: 'TRANSCRIPT_BELOW_THRESHOLD' });
    }

  } catch (err) {
    addLog(`Summarization error: ${err.message}`);

    if (err.isValidationError) {
      logActivity('Transcript validation failed', 'fail', err.message);
      updateMeeting(meetingId, { status: 'failed', error_message: err.message, completed_at: now() });
      logSummaryStage('final_status_set', { finalStatus: 'failed', failureReasonCode: 'TRANSCRIPT_SAVE_FAILED' });

    } else if (err.isQuotaError) {
      logActivity('API quota exceeded', 'warn', 'Transcript saved — retry after quota resets');
      updateMeeting(meetingId, {
        status: 'summary_quota_exceeded',
        error_message: 'Gemini API quota exceeded. Your transcript is saved — use Retry after a few minutes. Check your quota at https://aistudio.google.com/apikey',
        completed_at: now(),
      });
      logSummaryStage('final_status_set', { finalStatus: 'summary_quota_exceeded' });

    } else if (err.isNoModelsError) {
      logActivity('No AI model available', 'warn', 'Transcript saved — retry later');
      updateMeeting(meetingId, {
        status: 'failed',
        error_message: 'Transcript saved, but no currently available Gemini text model was found for this API key. Ensure the Gemini API is enabled at https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com — then use Retry.',
        completed_at: now(),
      });
      logSummaryStage('final_status_set', { finalStatus: 'failed', failureReasonCode: 'TRANSCRIPT_SAVE_FAILED' });

    } else if (err.isConfigError) {
      logActivity('Configuration error', 'fail', err.message);
      updateMeeting(meetingId, { status: 'failed', error_message: err.message, completed_at: now() });
      logSummaryStage('final_status_set', { finalStatus: 'failed', failureReasonCode: 'TRANSCRIPT_SAVE_FAILED' });

    } else if (err.isParseError) {
      logActivity('Summary parse failed', 'warn', 'Transcript saved — use Retry');
      addLog(`Raw output stored for debugging (first 300 chars): ${String(err.rawText || '').slice(0, 300)}`);
      updateMeeting(meetingId, {
        status: 'parse_failed',
        error_message:
          'The AI model returned a response but it was not valid JSON. ' +
          'Your transcript is saved — use Retry to attempt summarization again. ' +
          `Detail: ${err.message}`,
        raw_output: err.rawText ? String(err.rawText).slice(0, 8000) : null,
        completed_at: now(),
      });
      logSummaryStage('final_status_set', { finalStatus: 'parse_failed' });

    } else {
      logActivity('Summarization error', 'fail', err.message.slice(0, 200));
      updateMeeting(meetingId, {
        status: 'failed',
        error_message: `Summarization failed: ${err.message}`,
        completed_at: now(),
      });
      logSummaryStage('final_status_set', { finalStatus: 'failed', failureReasonCode: 'TRANSCRIPT_SAVE_FAILED' });
    }
  } finally {
    // Safety net: if any unexpected exception escapes the catch block (or if
    // the process is resumed from a partial state), ensure the meeting is
    // never permanently stuck in an in-progress status.
    const currentRow = db.prepare('SELECT status FROM meetings WHERE id = ?').get(meetingId);
    const inProgressStatuses = [
      'summarizing', 'chunking_transcript', 'summarizing_chunks', 'merging_summaries',
    ];
    if (currentRow && inProgressStatuses.includes(currentRow.status)) {
      addLog(`[safety] Meeting ${meetingId} still in-progress status "${currentRow.status}" after runSummarization — forcing to failed`);
      logActivity('Summarization interrupted', 'fail', 'Pipeline did not complete cleanly — transcript is saved, use Retry');
      updateMeeting(meetingId, {
        status: 'failed',
        error_message: 'Summarization was interrupted unexpectedly. Your transcript is saved — use Retry.',
        completed_at: now(),
        failure_reason_code: 'TRANSCRIPT_SAVE_FAILED',
      });
      logSummaryStage('final_status_set', { finalStatus: 'failed', failureReasonCode: 'TRANSCRIPT_SAVE_FAILED' });
    }
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Dismiss notification popups, permission dialogs, and other overlays on Google Meet.
 * Handles: "Got it", "Dismiss", "OK", "Not now", "Block", "Close", "No thanks"
 *
 * Uses a single page.evaluate() call for all buttons — avoids N puppeteer round-trips.
 */
async function dismissMeetPopups(page, addLog) {
  try {
    const dismissed = await page.evaluate(() => {
      const DISMISS_TEXTS = ['Got it', 'Dismiss', 'OK', 'Not now', 'Block', 'Close', 'No thanks', 'Maybe later'];
      const DISMISS_LOWER = DISMISS_TEXTS.map(t => t.toLowerCase());
      const clicked = [];
      for (const btn of document.querySelectorAll('button, [role="button"]')) {
        const text = btn.textContent?.trim();
        if (!text) continue;
        const lower = text.toLowerCase();
        const matchIdx = DISMISS_LOWER.indexOf(lower);
        if (matchIdx === -1) continue;
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          try { btn.click(); clicked.push(DISMISS_TEXTS[matchIdx]); } catch (_) {}
        }
      }
      return clicked;
    }).catch(() => []);
    for (const text of dismissed) {
      addLog(`Dismissed popup: "${text}"`);
    }
  } catch (_) {}
}

/**
 * Find and click the Join button using a single page.evaluate() call.
 * Returns true if a join button was found and clicked.
 *
 * Two strategies inside the evaluate:
 *   1. Text match — most reliable, works across Meet UI changes
 *   2. jsname attribute — only correct join-button jsnames (Qx7uuf, lKxP2d)
 *      NOTE: BOHaEe is the MIC button and must NOT be in this list.
 */
async function findAndClickJoinButton(page, addLog) {
  const result = await page.evaluate(() => {
    const JOIN_TEXTS = ['Join now', 'Ask to join', 'Join meeting', 'Request to join', 'Join'];
    const JOIN_JSNAMES = [
      'Qx7uuf',  // "Join now"
      'lKxP2d',  // "Ask to join" / "Request to join"
      'Nc2IHb',  // Additional known join variant
    ];

    // Strategy 1: visible button with matching text
    for (const btn of document.querySelectorAll('button, [role="button"]')) {
      const text = btn.textContent?.trim();
      if (!text) continue;
      const rect = btn.getBoundingClientRect();
      const style = window.getComputedStyle(btn);
      const isVisible = rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden';
      if (!isVisible) continue;
      for (const joinText of JOIN_TEXTS) {
        if (text === joinText || text.startsWith(joinText)) {
          try { btn.click(); return { clicked: true, method: 'text', label: text }; } catch (_) {}
        }
      }
    }

    // Strategy 2: jsname attribute fallback
    for (const jsname of JOIN_JSNAMES) {
      const btn = document.querySelector(`button[jsname="${jsname}"]`);
      if (btn) {
        try {
          btn.click();
          return { clicked: true, method: 'jsname', label: btn.textContent?.trim() || jsname };
        } catch (_) {}
      }
    }

    return { clicked: false };
  }).catch(() => ({ clicked: false }));

  if (result.clicked) {
    addLog(`✓ Join button clicked (${result.method}): "${result.label}"`);
    return true;
  }
  return false;
}

async function failWithSignInMessage(meetingId, addLog, browser) {
  const userDataDir = process.env.CHROME_USER_DATA_DIR;
  const hasProfile = userDataDir && existsSync(userDataDir);

  addLog('');
  addLog('BLOCKER: Google Meet requires a signed-in Google account.');
  if (hasProfile) {
    addLog(`Chrome profile IS configured: ${userDataDir}`);
    addLog('But sign-in was still detected. Possible causes:');
    addLog('  - Chrome is open elsewhere using this profile (close it first)');
    addLog('  - The profile is not signed into Google');
    addLog('  - Google session expired — reopen Chrome manually and sign in again');
  } else {
    addLog('FIX: Set these in backend/.env:');
    addLog('  CHROME_USER_DATA_DIR=C:/Users/YourName/AppData/Local/Google/Chrome/User Data');
    addLog('  PROFILE_DIRECTORY=Default');
    addLog('');
    addLog('Then:');
    addLog('  1. Open Chrome normally and sign into your Google account');
    addLog('  2. Close Chrome completely (check system tray)');
    addLog('  3. Restart the backend: npm run dev');
  }
  addLog('');
  addLog('WORKAROUND: Use Retry and paste your meeting transcript manually');

  if (browser) { try { await browser.close(); } catch (_) {} }

  const errorMsg = hasProfile
    ? 'Google Sign-In page appeared despite Chrome profile being configured. Close Chrome completely (check system tray), verify you are signed into Google in that profile, then try again. Or use Retry to paste a transcript manually.'
    : 'Google Sign-In required. Set CHROME_USER_DATA_DIR and PROFILE_DIRECTORY in backend/.env to use a logged-in Chrome profile. See backend/.env.example for details. Or use Retry to paste a transcript manually.';

  updateMeeting(meetingId, {
    status: 'google_sign_in_required',
    error_message: errorMsg,
    completed_at: now(),
  });
}

// ─── Profile Setup: Manual Google Login ────────────────────────────────────────
// This endpoint launches Chrome with the configured profile so the user can
// manually sign into Google. The session is preserved for future bot runs.

let setupBrowserInstance = null;

app.post('/api/setup-profile', async (_req, res) => {
  if (!CHROME_PATH) {
    return res.status(500).json({ error: 'Chrome not found. Install Google Chrome or set CHROME_PATH.' });
  }

  if (setupBrowserInstance) {
    return res.status(409).json({ error: 'Setup browser is already open. Close it first or wait for it to finish.' });
  }

  const userDataDir = process.env.CHROME_USER_DATA_DIR || join(__dirname, '..', 'bot-chrome-profile');
  const profileDir = process.env.PROFILE_DIRECTORY || 'Default';

  console.log(`[setup-profile] Launching Chrome for manual login...`);
  console.log(`[setup-profile] Profile: ${userDataDir} (${profileDir})`);

  try {
    setupBrowserInstance = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        `--profile-directory=${profileDir}`,
      ],
      defaultViewport: null, // Use full window size
      ignoreDefaultArgs: ['--enable-automation'],
      userDataDir,
    });

    const page = await setupBrowserInstance.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    // Navigate to Google sign-in
    await page.goto('https://accounts.google.com', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    console.log('[setup-profile] Browser open — waiting for manual login (5 min timeout)...');

    res.json({
      success: true,
      message: 'Browser opened for Google sign-in. Log in manually, then close the browser window when done. It will auto-close after 5 minutes.',
      profilePath: userDataDir,
      profileDirectory: profileDir,
    });

    // Keep browser open for 5 minutes, then auto-close
    const SETUP_TIMEOUT = 300000; // 5 minutes
    const startTime = Date.now();

    const checkInterval = setInterval(async () => {
      try {
        // Check if browser was closed manually
        if (!setupBrowserInstance || !setupBrowserInstance.isConnected()) {
          console.log('[setup-profile] Browser closed by user. Session saved.');
          clearInterval(checkInterval);
          setupBrowserInstance = null;
          return;
        }

        // Auto-close after timeout
        if (Date.now() - startTime > SETUP_TIMEOUT) {
          console.log('[setup-profile] 5-minute timeout reached. Closing browser.');
          await setupBrowserInstance.close().catch(() => {});
          setupBrowserInstance = null;
          clearInterval(checkInterval);
        }
      } catch (_) {
        setupBrowserInstance = null;
        clearInterval(checkInterval);
      }
    }, 3000);

  } catch (launchErr) {
    setupBrowserInstance = null;
    const msg = launchErr.message || '';
    if (msg.includes('already running') || msg.includes('user data directory')) {
      return res.status(409).json({
        error: 'Chrome profile is locked. Close all Chrome windows first, then try again.',
      });
    }
    return res.status(500).json({ error: `Failed to launch Chrome: ${msg}` });
  }
});

app.get('/api/setup-profile/status', (_req, res) => {
  res.json({
    browserOpen: !!(setupBrowserInstance && setupBrowserInstance.isConnected()),
  });
});

// ─── Routes: Root & Health ────────────────────────────────────────────────────

app.get('/', (_req, res) => {
  res.json({
    service: 'Google Meet AI Scribe API',
    version: '2.1.0',
    ui: 'Open http://localhost:5173 — Vite proxies /api to this server.',
  });
});

app.get('/api/health', (_req, res) => {
  const userDataDir = process.env.CHROME_USER_DATA_DIR;
  const profileDir = process.env.PROFILE_DIRECTORY || 'Default';
  res.json({
    status: 'healthy',
    service: 'Google Meet AI Scribe API',
    geminiConfigured: !!GEMINI_API_KEY,
    chromeFound: !!CHROME_PATH,
    chromePath: CHROME_PATH || 'Not found',
    chromeProfileConfigured: !!(userDataDir && existsSync(userDataDir)),
    chromeProfilePath: userDataDir || 'Not set',
    profileDirectory: profileDir,
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    geminiConfigured: !!GEMINI_API_KEY,
    chromeFound: !!CHROME_PATH,
    limitations: [
      'Google Meet requires an authenticated Google account to join meetings.',
      'Set CHROME_USER_DATA_DIR in .env to a Chrome profile with Google sign-in for auto-join.',
      'Manual transcript pasting is supported as a reliable fallback.',
      'Caption capture depends on Google Meet enabling captions in the meeting.',
    ],
  });
});

// ─── Routes: Auth ─────────────────────────────────────────────────────────────

app.post('/api/auth/signup', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'User already exists' });

  const userId = uuidv4();
  const hashedPassword = await bcrypt.hash(password, 10);

  db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (@id, @email, @name, @password_hash, @created_at)').run({
    id: userId,
    email: normalizedEmail,
    name: isNonEmptyString(name) ? name.trim() : '',
    password_hash: hashedPassword,
    created_at: now(),
  });

  const token = jwt.sign({ user_id: userId, email: normalizedEmail }, SECRET_KEY, { expiresIn: '24h' });
  return res.status(201).json({
    token,
    user: { id: userId, email: normalizedEmail, name: isNonEmptyString(name) ? name.trim() : '' },
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

  const token = jwt.sign({ user_id: user.id, email: normalizedEmail }, SECRET_KEY, { expiresIn: '24h' });
  return res.status(200).json({
    token,
    user: { id: user.id, email: normalizedEmail, name: user.name },
  });
});

// ─── Routes: Meetings ─────────────────────────────────────────────────────────

app.get('/api/meetings', authMiddleware, (req, res) => {
  const userId = getUserIdFromJwtPayload(req.user);
  if (!userId) return res.status(401).json({ error: 'Invalid token payload' });

  const rows = db.prepare('SELECT * FROM meetings WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  return res.json(rows.map(asMeetingResponse));
});

app.get('/api/meetings/:id', authMiddleware, (req, res) => {
  const userId = getUserIdFromJwtPayload(req.user);
  if (!userId) return res.status(401).json({ error: 'Invalid token payload' });

  const row = db.prepare('SELECT * FROM meetings WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!row) return res.status(404).json({ error: 'Meeting not found' });
  return res.json(asMeetingResponse(row));
});

app.get('/api/meetings/:id/diagnostics', authMiddleware, (req, res) => {
  const userId = getUserIdFromJwtPayload(req.user);
  if (!userId) return res.status(401).json({ error: 'Invalid token payload' });
  const row = db.prepare('SELECT * FROM meetings WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!row) return res.status(404).json({ error: 'Meeting not found' });
  let transcriptMeta = null;
  try { transcriptMeta = row.transcript_metadata_json ? JSON.parse(row.transcript_metadata_json) : null; } catch (_) {}
  return res.json({
    id: row.id,
    status: row.status,
    failureReasonCode: row.failure_reason_code || null,
    lastStage: row.last_stage || null,
    transcriptLengths: {
      transcript: (row.transcript || '').length,
      rawCaptionTranscript: (row.raw_caption_transcript || '').length,
      rawCaptionChunksJson: (row.raw_caption_chunks_json || '').length,
      rawAudioTranscript: (row.raw_audio_transcript || '').length,
      mergedTranscript: (row.merged_transcript || '').length,
      previewTranscript: (row.preview_transcript || '').length,
    },
    transcriptMeta,
    updatedAt: row.updated_at,
    joinedAt: row.joined_at,
    completedAt: row.completed_at,
  });
});

/**
 * POST /api/meetings — Create a new meeting and start bot workflow
 * Prevents duplicate submissions for the same meeting code within 30s.
 */
app.post('/api/meetings', authMiddleware, async (req, res) => {
  const userId = getUserIdFromJwtPayload(req.user);
  if (!userId) return res.status(401).json({ error: 'Invalid token payload' });

  const meetLink = req.body?.meetLink ?? req.body?.meet_link;
  if (!isNonEmptyString(meetLink) || !meetLink.includes('meet.google.com')) {
    return res.status(400).json({ error: 'A valid Google Meet link is required' });
  }

  const meetingCode = meetingCodeFromLink(meetLink);
  if (!meetingCode) return res.status(400).json({ error: 'Could not parse meeting code from Meet link' });

  // Integrity rule: always create a new meeting row.
  // Reusing a recent row can return stale transcript/summary from another run.

  const transcript = req.body?.transcript;
  const hasManualTranscript = isNonEmptyString(transcript);
  const meetingId = uuidv4();
  const timestamp = now();
  emitDebugLog({
    hypothesisId: 'H-ID-CONSISTENCY',
    location: 'index.js:postMeetings:create',
    message: 'meeting_created',
    data: {
      meetingId,
      userId,
      meetingCode,
      transcriptSource: hasManualTranscript ? 'manual_paste' : 'live_capture',
      transcriptLength: hasManualTranscript ? transcript.trim().length : 0,
    },
  });

  // When a manual transcript is provided at meeting creation, pre-populate metadata
  // so the bot worker (Phase 1) and runSummarization can both detect it as manual.
  const initialTranscriptMeta = hasManualTranscript ? JSON.stringify({
    transcriptSource: 'manual_paste',
    manualTranscriptProvided: true,
    liveMeetingEmpty: false,
    transcriptLength: transcript.trim().length,
    statusMessage: 'Manual transcript provided at meeting creation.',
  }) : null;

  db.prepare(`INSERT INTO meetings (id, user_id, meet_link, meeting_code, title, status, transcript, transcript_metadata_json, summary_json, raw_output, error_message, bot_log, created_at, updated_at, joined_at, completed_at)
              VALUES (@id, @user_id, @meet_link, @meeting_code, @title, 'pending', @transcript, @transcript_metadata_json, NULL, NULL, NULL, NULL, @created_at, @updated_at, NULL, NULL)`).run({
    id: meetingId,
    user_id: userId,
    meet_link: meetLink,
    meeting_code: meetingCode,
    title: 'Meet ' + meetingCode,
    transcript: hasManualTranscript ? transcript.trim() : null,
    transcript_metadata_json: initialTranscriptMeta,
    created_at: timestamp,
    updated_at: timestamp,
  });
  updateMeeting(meetingId, { last_stage: 'meeting_created', failure_reason_code: null });

  // Return immediately
  const meetingRow = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  res.status(201).json(asMeetingResponse(meetingRow));

  // Fire-and-forget with global timeout
  // Global safety-net timeout: max meeting duration (default 4h) + 10 min overhead for join + summarize.
  // The bot worker exits on its own when the meeting ends — this is only a last-resort backstop.
  const MAX_MEETING_DURATION_MS = Number(process.env.MAX_MEETING_DURATION_MS) || 4 * 60 * 60 * 1000;
  const BOT_TIMEOUT_MS = MAX_MEETING_DURATION_MS + 10 * 60 * 1000; // max meeting duration + 10 min buffer
  const botPromise = runBotWorker(meetingId);
  const timeoutPromise = sleep(BOT_TIMEOUT_MS).then(() => {
    const current = db.prepare('SELECT status FROM meetings WHERE id = ?').get(meetingId);
  const terminalStatuses = [
    'completed', 'failed', 'parse_failed', 'partial_summary',
    'needs_manual_transcript', 'google_sign_in_required',
    'browser_profile_in_use', 'summary_quota_exceeded', 'no_transcript',
  ];
    if (current && !terminalStatuses.includes(current.status)) {
      console.error(`[bot-worker] Timeout for ${meetingId} after ${BOT_TIMEOUT_MS / 1000}s (stuck in '${current.status}')`);
      updateMeeting(meetingId, {
        status: 'failed',
        error_message: `Bot timed out after ${BOT_TIMEOUT_MS / 1000} seconds (last status: ${current.status}). The meeting may require manual intervention. Use Retry to paste a transcript.`,
        completed_at: now(),
      });
    }
  });
  Promise.race([botPromise, timeoutPromise]).catch(err => {
    console.error(`[bot-worker] Error for ${meetingId}:`, err);
  });
});

/**
 * POST /api/meetings/:id/retry — Retry a failed meeting (updates same record).
 *
 * Decision flow:
 *   1. Pasted transcript in request body  → use it immediately (fast path)
 *   2. Saved transcript already in DB    → use it immediately (fast path)
 *   3. No transcript anywhere            → launch bot/browser capture (slow path)
 *
 * The 360-second bot timeout ONLY applies to the slow path (live capture).
 * It must NOT run when a transcript is already available — summarization may
 * legitimately take several minutes due to rate-limit waits, and the timeout
 * would fire before summarization finishes and overwrite the real status.
 */
app.post('/api/meetings/:id/retry', authMiddleware, async (req, res) => {
  const userId = getUserIdFromJwtPayload(req.user);
  if (!userId) return res.status(401).json({ error: 'Invalid token payload' });

  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ? AND user_id = ?').get(req.params.id, userId);
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

  // ── Determine effective transcript ──────────────────────────────────────────
  // Priority: pasted (from request body) > saved in DB
  const pastedTranscript = req.body?.transcript;
  const hasPasted  = isNonEmptyString(pastedTranscript);
  const hasSaved   = isNonEmptyString(meeting.transcript);

  const effectiveTranscript = hasPasted
    ? pastedTranscript.trim()
    : (hasSaved ? meeting.transcript : null);

  const hasTranscript = !!effectiveTranscript;

  // ── Reset meeting record ────────────────────────────────────────────────────
  const updates = {
    status:        'pending',
    error_message: null,
    failure_reason_code: null,
    last_stage: 'meeting_created',
    bot_log:       null,
    summary_json:  null,
    raw_output:    null,
    raw_caption_transcript: null,
    raw_caption_chunks_json: null,
    raw_audio_transcript: null,
    merged_transcript: null,
    preview_transcript: null,
    transcript_metadata_json: null,
    audio_file_path: null,
    completed_at:  null,
  };
  // Only persist new transcript if one was pasted — never clear a saved one
  if (hasPasted) {
    updates.transcript = pastedTranscript.trim();
  }
  updateMeeting(meeting.id, updates);

  const updated = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meeting.id);
  res.json(asMeetingResponse(updated));

  // ── Path A: Transcript available — summarize directly (no bot, no timeout) ──
  if (hasTranscript) {
    const source = hasPasted ? 'pasted' : 'saved';
    console.log(`[retry] Meeting ${meeting.id}: transcript ${source} (${effectiveTranscript.length} chars) — running summarization directly, no bot timeout`);

    const retryAddLog = (msg) => console.log(`[retry:${source}] [${meeting.id}] ${msg}`);

    // Restore manual-source metadata so runSummarization can bypass captionChunkCount threshold.
    // The reset above cleared transcript_metadata_json; write it back before calling summarize.
    updateMeeting(meeting.id, {
      transcript_metadata_json: JSON.stringify({
        transcriptSource: source === 'pasted' ? 'manual_paste' : 'saved_transcript',
        manualTranscriptProvided: true,
        liveMeetingEmpty: false,
        transcriptLength: effectiveTranscript.length,
        statusMessage: source === 'pasted'
          ? 'Used pasted transcript (retry path).'
          : 'Used saved transcript (retry path).',
      }),
    });
    emitDebugLog({
      hypothesisId: 'H-ID-CONSISTENCY',
      location: 'index.js:retry:direct',
      message: 'retry_direct_summarization',
      data: {
        meetingId: meeting.id,
        source,
        transcriptLength: effectiveTranscript.length,
      },
    });

    runSummarization(meeting.id, effectiveTranscript, retryAddLog, source).catch(err => {
      console.error(`[retry:${source}] Summarization error for ${meeting.id}:`, err);
      // runSummarization already updates the meeting status in its catch blocks.
      // This outer catch is a last-resort safety net for unexpected throws.
      const current = db.prepare('SELECT status FROM meetings WHERE id = ?').get(meeting.id);
      const inProgressStatuses = [
        'pending', 'summarizing', 'chunking_transcript', 'summarizing_chunks', 'merging_summaries',
      ];
      if (current && inProgressStatuses.includes(current.status)) {
        updateMeeting(meeting.id, {
          status:        'failed',
          error_message: `Summarization failed unexpectedly. Your transcript is saved — use Retry. Detail: ${err.message}`,
          completed_at:  now(),
        });
      }
    });
    return;
  }

  // ── Path B: No transcript — launch bot/browser capture (presence-based, stays until meeting ends) ──
  console.log(`[retry] Meeting ${meeting.id}: no transcript — launching bot capture (presence-based, max ${Math.round((Number(process.env.MAX_MEETING_DURATION_MS) || 4 * 60 * 60 * 1000) / 60000)} min)`);

  // Same safety-net logic as the initial join — let the presence-based loop run until meeting ends.
  const MAX_MEETING_DURATION_MS_RETRY = Number(process.env.MAX_MEETING_DURATION_MS) || 4 * 60 * 60 * 1000;
  const BOT_TIMEOUT_MS_RETRY = MAX_MEETING_DURATION_MS_RETRY + 10 * 60 * 1000;
  const retryBotPromise = runBotWorker(meeting.id);
  const retryTimeoutPromise = sleep(BOT_TIMEOUT_MS_RETRY).then(() => {
    const current = db.prepare('SELECT status FROM meetings WHERE id = ?').get(meeting.id);
    const terminalStatuses = [
      'completed', 'failed', 'parse_failed', 'partial_summary',
      'needs_manual_transcript', 'google_sign_in_required',
      'browser_profile_in_use', 'summary_quota_exceeded', 'no_transcript',
    ];
    if (current && !terminalStatuses.includes(current.status)) {
      console.error(`[bot-worker] Retry timeout for ${meeting.id} after ${BOT_TIMEOUT_MS_RETRY / 1000}s (stuck in '${current.status}')`);
      updateMeeting(meeting.id, {
        status:        'failed',
        error_message: `Bot timed out after ${BOT_TIMEOUT_MS_RETRY / 1000} seconds while trying to join the meeting. The meeting may have ended. Use Retry to paste your transcript manually.`,
        completed_at:  now(),
      });
    }
  });
  Promise.race([retryBotPromise, retryTimeoutPromise]).catch(err => {
    console.error(`[bot-worker] Retry error for ${meeting.id}:`, err);
  });
});


/**
 * DELETE /api/meetings/:id — Delete a meeting
 */
app.delete('/api/meetings/:id', authMiddleware, (req, res) => {
  const userId = getUserIdFromJwtPayload(req.user);
  if (!userId) return res.status(401).json({ error: 'Invalid token payload' });

  const info = db.prepare('DELETE FROM meetings WHERE id = ? AND user_id = ?').run(req.params.id, userId);
  if (info.changes === 0) return res.status(404).json({ error: 'Meeting not found' });
  return res.json({ deleted: true });
});

// ─── Server Startup ──────────────────────────────────────────────────────────

function startHttpServer(port, attemptsLeft) {
  const server = http.createServer(app);

  server.on('error', (err) => {
    console.error('[listen]', err.code, err.message);
    if (err.code === 'EADDRINUSE' && attemptsLeft > 1) {
      console.warn(`Port ${port} in use, trying ${port + 1}...`);
      server.close(() => startHttpServer(port + 1, attemptsLeft - 1));
      return;
    }
    process.exit(1);
  });

  server.listen(port, () => {
    try {
      writeFileSync(DEV_PORT_FILE, String(port), 'utf8');
    } catch (e) {
      console.warn('[listen] could not write .dev-port:', e?.message || e);
    }
    console.log('');
    console.log('  Google Meet AI Scribe API');
    console.log('  ========================');
    console.log(`  Server:  http://localhost:${port}`);
    console.log(`  Gemini:  ${GEMINI_API_KEY ? 'Configured' : 'NOT configured (set GEMINI_API_KEY in .env)'}`);
    console.log(`  Chrome:  ${CHROME_PATH || 'NOT found (set CHROME_PATH in .env)'}`);
    console.log('');
  });
}

startHttpServer(Number(PORT) || 5001, 25);
