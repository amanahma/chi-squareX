/**
 * summarizationService.js
 *
 * Gemini-powered meeting transcript summarization with:
 *  - Runtime model discovery (no hardcoded availability assumptions)
 *  - Three strategies based on transcript length:
 *      short     (<  8 000 chars) → single Gemini call
 *      long      (< 60 000 chars) → chunked: split → summarize each → merge
 *      very_long (≥ 60 000 chars) → hierarchical: chunk → group-merge → final merge
 *  - 4-step JSON recovery ladder on every model response
 *  - Per-field normalization — safe defaults always returned
 *  - Partial results preserved when individual chunks fail
 */

// ─── Model Discovery Cache ────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
let _modelCache = null; // { models: string[], ts: number }

/**
 * Preferred model ordering — checked against the *discovered* list.
 * No name here is assumed to exist; it is only a preference order.
 */
const PREFERRED_MODEL_ORDER = [
  'gemini-2.5-flash-preview-04-17',
  'gemini-2.5-flash',
  'gemini-2.5-pro-preview-03-25',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',
];

// ─── Transcript Thresholds ────────────────────────────────────────────────────

const MIN_TRANSCRIPT_CHARS  = 30;        // Too short to summarize
const SHORT_CUTOFF_CHARS    = 8_000;     // Direct single-call below this
const LONG_CUTOFF_CHARS     = 60_000;    // Hierarchical at or above this
const MAX_CHUNK_SIZE        = 6_000;     // Max chars per chunk (token headroom)
const HIERARCHICAL_GROUP    = 5;         // Chunk summaries per group in very_long mode

// ─── Retry Config ─────────────────────────────────────────────────────────────

// 503 overload: retry twice with fixed back-off (usually clears quickly).
const RETRY_DELAYS_MS = [8000, 20000];

// 429 rate-limit: only ONE retry using Gemini's own suggested wait (parsed from body).
// Multiple retries would burn RPM slots across all chunks — wasteful on free tier.
const QUOTA_MAX_RETRIES = 1;

// Per-request fetch timeout — prevents a silent network hang from blocking forever.
// Must be longer than Gemini's own server-side timeout (~50s) to let it respond first.
const FETCH_TIMEOUT_MS = 58_000;  // 58 seconds

// ─── API Version Selection ────────────────────────────────────────────────────

/**
 * gemini-1.x → v1  (no responseMimeType support)
 * gemini-2.x / 2.5-x → v1beta (supports responseMimeType: application/json)
 * gemma-*   → v1beta, but NO responseMimeType (JSON mode not supported)
 */
function getApiConfig(model) {
  if (/^gemini-1[.\-]/.test(model)) {
    return { apiVersion: 'v1', supportsJsonMime: false };
  }
  if (/^gemma-/i.test(model)) {
    // Gemma supports generateContent but NOT JSON mime type.
    // We still call it and rely on the 4-step JSON recovery ladder.
    return { apiVersion: 'v1beta', supportsJsonMime: false };
  }
  return { apiVersion: 'v1beta', supportsJsonMime: true };
}

// ─── Transcript Cleaning ──────────────────────────────────────────────────────

/**
 * Clean and normalize a raw transcript string.
 *  - Trims outer whitespace
 *  - Normalizes line endings to \n
 *  - Removes null bytes and most control characters (keeps \t and \n)
 *  - Collapses 3+ consecutive blank lines to 2
 *
 * @param {string} raw
 * @returns {string}
 */
export function cleanTranscript(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Remove control chars except \t (0x09) and \n (0x0A)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\n{3,}/g, '\n\n'); // max 2 blank lines
}

// ─── Transcript Classification ────────────────────────────────────────────────

/**
 * Classify a cleaned transcript by length.
 * @param {string} transcript
 * @returns {'short' | 'long' | 'very_long'}
 */
export function classifyTranscript(transcript) {
  const len = transcript.length;
  if (len < SHORT_CUTOFF_CHARS) return 'short';
  if (len < LONG_CUTOFF_CHARS)  return 'long';
  return 'very_long';
}

// ─── Chunking ─────────────────────────────────────────────────────────────────

/**
 * Split a transcript into manageable chunks respecting natural boundaries.
 *
 * Priority order:
 *   1. Blank-line paragraph boundaries
 *   2. Speaker-label lines ("Alice: ", "Bob: ", etc.)
 *   3. Sentence boundaries (". ") when a paragraph is still too large
 *
 * Speaker labels are never orphaned — they stay with their following text.
 *
 * @param {string} transcript  Already-cleaned transcript
 * @param {number} [maxChunkSize=MAX_CHUNK_SIZE]
 * @returns {string[]}  Non-empty chunk strings
 */
export function chunkTranscript(transcript, maxChunkSize = MAX_CHUNK_SIZE) {
  // Regex: line that looks like a speaker label ("Alice:", "John Smith:", "Speaker 1:")
  const SPEAKER_RE = /^[A-Z][A-Za-z0-9 ]{0,30}:\s/;

  // Phase 1 — split into paragraphs on blank lines
  const rawParagraphs = transcript.split(/\n\n+/);

  // Phase 2 — further split paragraphs that contain embedded speaker labels
  const paragraphs = [];
  for (const para of rawParagraphs) {
    const lines = para.split('\n');
    let current = [];
    for (const line of lines) {
      if (SPEAKER_RE.test(line) && current.length > 0) {
        paragraphs.push(current.join('\n'));
        current = [line];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) paragraphs.push(current.join('\n'));
  }

  // Phase 3 — accumulate paragraphs into chunks up to maxChunkSize
  const chunks = [];
  let currentChunk = '';

  const flushCurrent = () => {
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
    }
  };

  for (const para of paragraphs) {
    const text = para.trim();
    if (!text) continue;

    // A single paragraph is larger than the limit — split at sentence boundaries
    if (text.length > maxChunkSize) {
      flushCurrent();

      const sentences = text.match(/[^.!?]+[.!?]+["'\u201d]?\s*/g) || [text];
      let sentenceChunk = '';
      for (const sentence of sentences) {
        if ((sentenceChunk + sentence).length > maxChunkSize && sentenceChunk) {
          chunks.push(sentenceChunk.trim());
          sentenceChunk = sentence;
        } else {
          sentenceChunk += sentence;
        }
      }
      if (sentenceChunk.trim()) currentChunk = sentenceChunk; // carry remainder
      continue;
    }

    // Adding this paragraph would overflow the current chunk — flush first
    const separator = currentChunk ? '\n\n' : '';
    if (currentChunk && (currentChunk + separator + text).length > maxChunkSize) {
      flushCurrent();
      currentChunk = text;
    } else {
      currentChunk = currentChunk + separator + text;
    }
  }

  flushCurrent();
  return chunks.filter(c => c.length > 0);
}

// ─── Model Discovery ──────────────────────────────────────────────────────────

/**
 * Fetch all generateContent-capable model IDs for the given API key.
 * Results are cached for CACHE_TTL_MS to avoid repeated discovery calls.
 *
 * @returns {Promise<string[]>}
 */
async function discoverModels(apiKey, log) {
  const now = Date.now();

  // ── Diagnostic: always log API key status ──
  log(`[gemini:discovery] API key: ${apiKey ? `LOADED (${String(apiKey).slice(0, 8)}...)` : 'NOT SET — check GEMINI_API_KEY in backend/.env'}`);

  if (_modelCache && now - _modelCache.ts < CACHE_TTL_MS) {
    log(`[gemini:discovery] Using cached model list (${_modelCache.models.length} models, refreshes in ${Math.round((CACHE_TTL_MS - (now - _modelCache.ts)) / 1000)}s)`);
    return _modelCache.models;
  }

  log('[gemini:discovery] Querying Gemini Models API...');

  let data;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`;

    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log(`[gemini:discovery] Models API returned HTTP ${res.status}: ${errText.slice(0, 300)}`);
      if (res.status === 400 || res.status === 403) {
        log('[gemini:discovery] ⚠️  HTTP 400/403 usually means the API key is invalid or the Gemini API is not enabled for this project.');
        log('[gemini:discovery]     Check: https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com');
      }
      return [];
    }
    data = await res.json();
  } catch (netErr) {
    log(`[gemini:discovery] Network/timeout error: ${netErr.message}`);
    return [];
  }

  const allModels = data.models || [];
  log(`[gemini:discovery] Total models returned by API: ${allModels.length}`);

  // ── Filter 1: must support generateContent ──
  const withGenerateContent = allModels.filter(m =>
    Array.isArray(m.supportedGenerationMethods) &&
    m.supportedGenerationMethods.includes('generateContent')
  );
  log(`[gemini:discovery] Models supporting generateContent: ${withGenerateContent.length}`);

  // ── Filter 2: exclude non-text-generation model families ──
  // Some models expose generateContent but are TTS, embedding, or image-only.
  // Calling them with a plain text summarization prompt gets a 400 error.
  const EXCLUDE_PATTERNS = [
    { pattern: /tts|text-to-speech|speech/i,  reason: 'TTS/audio model' },
    { pattern: /embed|embedding/i,             reason: 'embedding model' },
    { pattern: /imagen|image-gen|imagegenerat/i, reason: 'image-generation model' },
    { pattern: /aqa/i,                         reason: 'AQA (question-answering only) model' },
  ];

  const capable = [];
  const excluded = [];
  for (const m of withGenerateContent) {
    const name = m.name.replace(/^models\//, '');
    const hit  = EXCLUDE_PATTERNS.find(({ pattern }) => pattern.test(name));
    if (hit) {
      excluded.push(`${name} (${hit.reason})`);
    } else {
      capable.push(name);
    }
  }

  if (excluded.length > 0) {
    log(`[gemini:discovery] Excluded ${excluded.length} non-text model(s): ${excluded.join(', ')}`);
  }
  log(`[gemini:discovery] Usable text-generation models (${capable.length}): [${capable.join(', ')}]`);

  if (capable.length === 0) {
    log('[gemini:discovery] ⚠️  No usable text-generation models found.');
    log('[gemini:discovery]     If the API returned models but all were excluded, open a GitHub issue with your model list.');
    log('[gemini:discovery]     If the API returned 0 models total, enable the Gemini API:');
    log('[gemini:discovery]     https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com');
  }

  _modelCache = { models: capable, ts: now };
  return capable;
}

/**
 * Build the priority-ordered model queue to try.
 * Priority: env var → preference list → any remaining discovered models.
 *
 * @returns {Promise<string[]>}
 */
async function buildModelQueue(apiKey, log) {
  const envModel   = process.env.GEMINI_MODEL;
  log(`[gemini] GEMINI_MODEL env var: ${envModel || '(not set — will use best discovered model)'}`);

  const discovered = await discoverModels(apiKey, log);
  log(`[gemini] Discovered ${discovered.length} usable text-generation model(s)`);

  if (discovered.length === 0) {
    // Fall back to env var if set — let the API itself reject it with a clear error
    const queue = envModel ? [envModel] : [];
    log(`[gemini] Discovery returned no usable models. Fallback queue: [${queue.join(', ') || 'EMPTY — cannot summarize'}]`);
    return queue;
  }

  const discoveredSet = new Set(discovered);
  const queue = [];

  // Priority 1: GEMINI_MODEL env var (if set and available)
  if (envModel) {
    if (discoveredSet.has(envModel)) {
      queue.push(envModel);
      discoveredSet.delete(envModel);
      log(`[gemini] GEMINI_MODEL="${envModel}" — confirmed available, using as primary`);
    } else {
      log(`[gemini] GEMINI_MODEL="${envModel}" — NOT in discovered list, skipping (available: [${discovered.join(', ')}])`);
    }
  }

  // Priority 2: Preferred models (in preference order)
  const preferredAdded = [];
  for (const preferred of PREFERRED_MODEL_ORDER) {
    if (discoveredSet.has(preferred)) {
      queue.push(preferred);
      discoveredSet.delete(preferred);
      preferredAdded.push(preferred);
    }
  }
  if (preferredAdded.length > 0) {
    log(`[gemini] Preferred models added: [${preferredAdded.join(', ')}]`);
  } else {
    log(`[gemini] No preferred models matched discovered list — will use all discovered models`);
  }

  // Priority 3: Any remaining discovered models not in the preference list
  const extra = [...discoveredSet];
  for (const m of extra) queue.push(m);
  if (extra.length > 0) {
    log(`[gemini] Additional discovered models added: [${extra.join(', ')}]`);
  }

  if (queue.length === 0) {
    log(`[gemini] ⚠️  Model queue is EMPTY after building. This should not happen if discovery returned models.`);
  } else {
    log(`[gemini] Final model queue (${queue.length} candidates): [${queue.join(', ')}]`);
  }

  return queue;
}

// ─── Gemini REST Caller ───────────────────────────────────────────────────────

/**
 * Make one generateContent REST call.
 * Selects correct API version + responseMimeType per model family.
 * Returns raw Response on 2xx. Throws annotated Error otherwise.
 */
async function callGeminiAPI(apiKey, model, prompt) {
  const { apiVersion, supportsJsonMime } = getApiConfig(model);
  const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${apiKey}`;

  const generationConfig = {
    temperature: 0.4,
    maxOutputTokens: 2048,
    ...(supportsJsonMime && { responseMimeType: 'application/json' }),
  };

  // ── Per-request timeout ───────────────────────────────────────────────────────────
  // An AbortController ensures a silently-hanging request (no response at all)
  // never blocks the chunk loop. On abort, fetch throws AbortError → we rethrow
  // it as a skipToNextModel error so the caller tries the next candidate model.
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
      }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    const isAbort =
      fetchErr.name === 'AbortError' ||
      fetchErr.cause?.name === 'AbortError' ||
      String(fetchErr.message).toLowerCase().includes('abort');

    throw Object.assign(
      new Error(
        isAbort
          ? `Gemini API request timed out after ${FETCH_TIMEOUT_MS / 1000}s for model "${model}" — trying next model.`
          : `Gemini API network error for model "${model}": ${fetchErr.message}`
      ),
      // Treat timeouts as transient — skip to next model; treat other network
      // failures similarly so one bad model doesn’t block the whole queue.
      { skipToNextModel: true, isTimeoutError: isAbort }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.ok) return response;

  const rawBody = await response.text().catch(() => '');
  let errorJson = null;
  try { errorJson = JSON.parse(rawBody); } catch (_) {}

  const geminiMessage = errorJson?.error?.message || rawBody.slice(0, 400);
  const status = response.status;

  console.error(`[gemini] HTTP ${status} from "${model}" (${apiVersion}):\n  ${geminiMessage}`);

  if (status === 404) {
    throw Object.assign(
      new Error(`Model "${model}" is not found on this API key (404). It may not be available in your region or project.`),
      { skipToNextModel: true }
    );
  }

  if (status === 429) {
    const isZeroQuota = geminiMessage.includes('limit: 0');

    // Parse Gemini's own suggested retry delay, e.g. "Please retry in 18.5s."
    const retryMatch = geminiMessage.match(/Please retry in ([\d.]+)s/);
    const suggestedRetryMs = retryMatch
      ? Math.min(Math.ceil(parseFloat(retryMatch[1]) * 1000) + 1500, 65_000)
      : null; // +1.5s buffer; cap at 65s

    throw Object.assign(
      new Error(
        isZeroQuota
          ? `Model "${model}" has zero free-tier quota on this API key — skipping.`
          : `Gemini rate-limit (429) for "${model}"${
              retryMatch ? ` — suggested wait: ${retryMatch[1]}s` : ''
            }.`
      ),
      isZeroQuota
        ? { skipToNextModel: true }
        : { retryable: true, isQuotaError: true, suggestedRetryMs }
    );
  }

  if (status === 503) {
    throw Object.assign(
      new Error(`Model "${model}" is temporarily overloaded (503).`),
      { retryable: true, isOverloadError: true }
    );
  }

  if (status === 400) {
    // 400 can mean: wrong content type for this model (e.g. TTS model called with text prompt),
    // prompt too long for this model's context window, or malformed request.
    // Either way, skip to the next model — another model may handle it fine.
    throw Object.assign(
      new Error(`Gemini rejected request (400) for "${model}" — skipping to next model. Details: ${geminiMessage}`),
      { skipToNextModel: true, is400Error: true }
    );
  }

  if (status === 403) {
    // 403 likely means the API key is invalid or the Gemini API is not enabled.
    // This will probably fail for every model, so propagate as a hard error.
    throw Object.assign(
      new Error(`Gemini API access denied (403). Your API key may be invalid or the Gemini API may not be enabled. Details: ${geminiMessage}`),
      { isConfigError: true }
    );
  }

  throw Object.assign(
    new Error(`Gemini API error ${status} from "${model}": ${geminiMessage}`),
    { skipToNextModel: status >= 500 } // 5xx = server-side, try next model
  );
}

/**
 * Try one model with retry for transient errors.
 *
 * - 429 quota/rate-limit: ONE retry using Gemini's suggested wait time.
 *   Waiting more than once per chunk would consume the entire RPM budget.
 * - 503 overload: up to RETRY_DELAYS_MS.length retries with fixed backoff.
 *
 * Retries exhausted → sets err.skipToNextModel so caller moves on.
 */
async function tryModelWithRetry(apiKey, model, prompt, log) {
  let lastErr;
  let quotaAttempts = 0;     // count of 429 retries for this model+call
  let overloadAttempts = 0;  // count of 503 retries for this model+call

  // Max total tries = 1 (503) or 2 (quota), guard against infinite loops
  const MAX_TOTAL = RETRY_DELAYS_MS.length + 1 + QUOTA_MAX_RETRIES + 1;

  for (let totalAttempt = 0; totalAttempt < MAX_TOTAL; totalAttempt++) {
    try {
      const attemptLabel = totalAttempt + 1;
      log(`[gemini] Trying "${model}" (attempt ${attemptLabel})`);
      return await callGeminiAPI(apiKey, model, prompt);
    } catch (err) {
      lastErr = err;

      // ── 429 Rate-limit: one retry using Gemini's suggested delay ──────────
      if (err.isQuotaError && quotaAttempts < QUOTA_MAX_RETRIES) {
        quotaAttempts++;
        const delay = err.suggestedRetryMs ?? 30_000; // fallback 30s
        log(`[gemini] 429 rate-limit for "${model}" — waiting ${(delay / 1000).toFixed(1)}s (retry ${quotaAttempts}/${QUOTA_MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // ── 503 Overload: up to RETRY_DELAYS_MS.length retries ───────────────
      if (err.isOverloadError && overloadAttempts < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[overloadAttempts];
        overloadAttempts++;
        log(`[gemini] 503 overload for "${model}" — waiting ${(delay / 1000).toFixed(1)}s (retry ${overloadAttempts}/${RETRY_DELAYS_MS.length})...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // Retries exhausted (or non-retryable error) — let caller try next model
      if (err.retryable) err.skipToNextModel = true;
      throw err;
    }
  }
  throw lastErr;
}


// ─── JSON Parsing & Normalization ─────────────────────────────────────────────

/**
 * Normalize a full summary so all expected fields have safe defaults.
 */
function normalizeSummary(parsed) {
  const ensureArray  = (v) => (Array.isArray(v) ? v : []);
  const ensureString = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);

  return {
    title:        ensureString(parsed.title,   'Meeting Summary'),
    summary:      ensureString(parsed.summary,  parsed.overview || parsed.description || ''),
    keyPoints:    ensureArray(parsed.keyPoints   ?? parsed.key_takeaways ?? parsed.topics),
    actionItems:  ensureArray(parsed.actionItems ?? parsed.action_items  ?? parsed.decisions),
    participants: ensureArray(parsed.participants),
  };
}

/**
 * Normalize a per-chunk result so all fields have safe defaults.
 */
function normalizeChunkResult(parsed) {
  const ensureArray  = (v) => (Array.isArray(v) ? v : []);
  const ensureString = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);

  return {
    chunkSummary: ensureString(parsed.chunkSummary || parsed.summary || parsed.overview, ''),
    keyPoints:    ensureArray(parsed.keyPoints   ?? parsed.key_points ?? parsed.key_takeaways),
    actionItems:  ensureArray(parsed.actionItems ?? parsed.action_items),
    participants: ensureArray(parsed.participants),
  };
}

/**
 * 5-step JSON recovery ladder.
 *
 * Step 1  — direct JSON.parse (trimmed)
 * Step 2  — strip markdown code fences
 * Step 3  — auto-wrap bare object (model omitted the outer { })
 * Step 3b — same + trailing-comma fix
 * Step 4  — brace extraction: find outermost { } in prose-wrapped output
 *
 * @throws Error with { isParseError: true, skipToNextModel: true, rawText } on total failure
 * @returns {{ parsed: object, method: string }}
 */
function attemptJsonParse(rawText, model, log) {
  const original = String(rawText);
  const trimmed  = original.trim();

  // Step 1: direct
  try { return { parsed: JSON.parse(trimmed), method: 'direct' }; } catch (_) {}

  // Step 2: strip ALL code-fence variants
  log(`[gemini] Direct JSON parse failed for "${model}" — stripping code fences`);
  const fenceStripped = trimmed
    .replace(/^`{3,}(?:json)?[ \t]*\r?\n?/i, '') // opening fence
    .replace(/`{3,}[ \t]*\r?\n?$/, '')             // closing fence
    .trim();
  try {
    const parsed = JSON.parse(fenceStripped);
    log(`[gemini] JSON recovered after fence strip`);
    return { parsed, method: 'fence-stripped' };
  } catch (_) {}

  // Step 3: auto-wrap bare object
  const knownFields = [
    'title', 'summary', 'keyPoints', 'actionItems', 'participants',
    'chunkSummary', 'overview', 'key_takeaways', 'action_items', 'topics', 'decisions',
  ];
  const startsWithField = knownFields.some(f => fenceStripped.startsWith(`"${f}":`));
  if (startsWithField) {
    log(`[gemini] Output appears to be a bare object — auto-wrapping in { }`);
    try {
      const parsed = JSON.parse(`{${fenceStripped}}`);
      log(`[gemini] JSON recovered after auto-wrapping`);
      return { parsed, method: 'auto-wrapped' };
    } catch (_) {}

    // Step 3b: trailing-comma fix
    try {
      const parsed = JSON.parse(`{${fenceStripped.replace(/,\s*$/, '')}}`);
      log(`[gemini] JSON recovered after auto-wrap + trailing-comma fix`);
      return { parsed, method: 'auto-wrapped-comma-fixed' };
    } catch (_) {}
  }

  // Step 4: Extract outermost {…} block from prose.
  // Handles models that wrap JSON in text: "Sure! Here is the JSON: { \"title\": ... }"
  const firstBrace = trimmed.indexOf('{');
  const lastBrace  = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const extracted = trimmed.slice(firstBrace, lastBrace + 1);
    if (extracted !== fenceStripped) { // avoid re-trying what we already tried
      log(`[gemini] Attempting brace extraction from prose response`);
      try {
        const parsed = JSON.parse(extracted);
        log(`[gemini] JSON recovered via brace extraction`);
        return { parsed, method: 'brace-extracted' };
      } catch (_) {}

      // Step 4b: brace extraction + trailing-comma fix
      try {
        const parsed = JSON.parse(extracted.replace(/,\s*([}\]])/g, '$1'));
        log(`[gemini] JSON recovered via brace extraction + comma fix`);
        return { parsed, method: 'brace-extracted-comma-fixed' };
      } catch (_) {}
    }
  }

  // All recovery attempts exhausted — mark skipToNextModel so callers try another model
  log(`[gemini] All JSON parse attempts failed for "${model}". Snippet: ${original.slice(0, 200)}`);
  throw Object.assign(
    new Error(`Model "${model}" returned non-JSON output. First 150 chars: ${original.slice(0, 150)}`),
    { isParseError: true, skipToNextModel: true, rawText: original }
  );
}

/**
 * Extract the raw text string from a Gemini API Response object (already .ok).
 * Returns { text: string|null, data: object }
 */
async function extractRawText(response) {
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  return { text, data };
}

/**
 * Parse the summary JSON from a successful Gemini API response.
 * Applies the recovery ladder + field normalization.
 */
async function extractSummary(response, model, log) {
  const { text, data } = await extractRawText(response);

  if (!text) {
    log(`[gemini] Model "${model}" returned empty response: ${JSON.stringify(data).slice(0, 200)}`);
    return { summary: null, rawOutput: data };
  }

  const { parsed, method } = attemptJsonParse(text, model, log);
  if (method !== 'direct') log(`[gemini] Parse method: "${method}"`);

  const summary = normalizeSummary(parsed);
  return { summary, rawOutput: data };
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

/** Full-transcript prompt (short strategy). */
function buildPrompt(transcript) {
  return `You are an expert meeting analyst. Analyze the following meeting transcript and return a JSON summary.

CRITICAL INSTRUCTIONS:
- Return ONLY valid JSON. No markdown. No code fences. No explanation. No extra text.
- Do NOT wrap the JSON in backticks or any other formatting.
- The VERY FIRST character of your response must be { and the VERY LAST character must be }.
- Use exactly this schema:

{
  "title": "A concise title for the meeting (3-8 words)",
  "summary": "A 2-4 sentence plain-English summary of what was discussed",
  "keyPoints": ["Key point 1", "Key point 2"],
  "actionItems": ["Action item 1", "Action item 2"],
  "participants": ["Name or identifier of each speaker found in the transcript"]
}

Rules:
- title: required string
- summary: required string
- keyPoints: required array of strings (can be empty [])
- actionItems: required array of strings (can be empty [])
- participants: required array of strings (can be empty [])

MEETING TRANSCRIPT:
${transcript}`;
}

/** Per-chunk prompt (chunked / hierarchical strategies). */
function buildChunkPrompt(chunk, chunkIndex, totalChunks) {
  return `You are analyzing part ${chunkIndex + 1} of ${totalChunks} of a meeting transcript.

CRITICAL INSTRUCTIONS:
- Return ONLY valid JSON. No markdown. No code fences. No explanation. No extra text.
- The VERY FIRST character must be { and the VERY LAST character must be }.
- Use exactly this schema:

{
  "chunkSummary": "2-3 sentence summary of this portion of the meeting",
  "keyPoints": ["Key point from this segment"],
  "actionItems": ["Action item mentioned in this segment"],
  "participants": ["Speaker names found in this segment"]
}

Rules:
- chunkSummary: required string
- keyPoints: required array of strings (can be empty [])
- actionItems: required array of strings (can be empty [])
- participants: required array of strings (can be empty [])

TRANSCRIPT SEGMENT (${chunkIndex + 1} of ${totalChunks}):
${chunk}`;
}

/** Merge prompt — combines multiple chunk/group summaries. */
function buildMergePrompt(chunkSummaries) {
  const chunksText = chunkSummaries.map((cs, i) => {
    const lines = [`--- Segment ${i + 1} ---`];
    lines.push(`Summary: ${cs.chunkSummary || cs.summary || '(none)'}`);
    if (cs.keyPoints?.length)    lines.push(`Key Points: ${cs.keyPoints.join('; ')}`);
    if (cs.actionItems?.length)  lines.push(`Action Items: ${cs.actionItems.join('; ')}`);
    if (cs.participants?.length) lines.push(`Participants: ${cs.participants.join(', ')}`);
    return lines.join('\n');
  }).join('\n\n');

  return `You are synthesizing summaries from ${chunkSummaries.length} segments of a meeting transcript.

CRITICAL INSTRUCTIONS:
- Return ONLY valid JSON. No markdown. No code fences. No explanation. No extra text.
- The VERY FIRST character must be { and the VERY LAST character must be }.
- Deduplicate: remove identical or near-identical items across segments.
- Use exactly this schema:

{
  "title": "A concise title for the overall meeting (3-8 words)",
  "summary": "A comprehensive 3-5 sentence summary of the entire meeting",
  "keyPoints": ["Deduplicated key point 1", "Key point 2"],
  "actionItems": ["Deduplicated action item 1"],
  "participants": ["All unique participant names across all segments"]
}

Rules:
- title: required string
- summary: required string
- keyPoints: required array (deduplicated, can be empty [])
- actionItems: required array (deduplicated, can be empty [])
- participants: required array (all unique names, can be empty [])

SEGMENT SUMMARIES TO MERGE:
${chunksText}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate and clean a transcript.
 * No longer truncates — chunking handles long transcripts instead.
 *
 * @throws Error with isValidationError: true on bad input
 */
export function validateAndTrimTranscript(transcript) {
  if (typeof transcript !== 'string' || transcript.trim().length === 0) {
    throw Object.assign(
      new Error('No transcript provided — paste your meeting transcript and retry.'),
      { isValidationError: true }
    );
  }

  const cleaned = cleanTranscript(transcript);

  if (cleaned.length < MIN_TRANSCRIPT_CHARS) {
    throw Object.assign(
      new Error(`Transcript is too short (${cleaned.length} chars, minimum ${MIN_TRANSCRIPT_CHARS}). Paste the full meeting transcript.`),
      { isValidationError: true }
    );
  }

  return cleaned;
}

/**
 * Summarize a single transcript chunk.
 * NEVER throws — returns { failed: true, error, chunkIndex } on any failure
 * so that the caller can continue processing other chunks.
 *
 * @param {string}   chunk
 * @param {number}   idx         0-based
 * @param {number}   total
 * @param {string}   apiKey
 * @param {string[]} modelQueue
 * @param {Function} log
 * @returns {Promise<object>}
 */
async function summarizeChunk(chunk, idx, total, apiKey, modelQueue, log, exhaustedModels = new Set()) {
  const prompt = buildChunkPrompt(chunk, idx, total);
  log(`[gemini:chunk] START chunk ${idx + 1}/${total} — ${chunk.length} chars`);

  let lastErr = null;

  for (const model of modelQueue) {
    // Skip models that already exhausted their quota in this session
    if (exhaustedModels.has(model)) {
      log(`[gemini:chunk] chunk ${idx + 1}/${total} — skipping "${model}" (quota exhausted this session)`);
      continue;
    }
    log(`[gemini:chunk] chunk ${idx + 1}/${total} — requesting model "${model}"`);

    // ── Stage 1: network request ─────────────────────────────────────────────
    let response;
    try {
      response = await tryModelWithRetry(apiKey, model, prompt, log);
    } catch (netErr) {
      lastErr = netErr;
      if (netErr.skipToNextModel) {
        // If this was a quota error, blacklist the model for the rest of this session
        if (netErr.isQuotaError) {
          exhaustedModels.add(model);
          log(`[gemini:chunk] chunk ${idx + 1}/${total} — "${model}" quota exhausted, blacklisted for remaining chunks`);
        } else {
          log(`[gemini:chunk] chunk ${idx + 1}/${total} — skipping "${model}": ${netErr.message}`);
        }
        continue; // try next model
      }
      // Hard failure (400, 403, etc.) — skip this chunk entirely
      log(`[gemini:chunk] HARD FAIL chunk ${idx + 1}/${total} on "${model}": ${netErr.message}`);
      return { failed: true, error: netErr.message, chunkIndex: idx };
    }

    // ── Stage 2: read response body ──────────────────────────────────────────
    let text;
    try {
      ({ text } = await extractRawText(response));
    } catch (readErr) {
      log(`[gemini:chunk] chunk ${idx + 1}/${total} — failed to read body from "${model}": ${readErr.message} — trying next`);
      lastErr = readErr;
      continue;
    }

    if (!text) {
      log(`[gemini:chunk] chunk ${idx + 1}/${total} — empty body from "${model}" — trying next`);
      lastErr = new Error('Empty response body');
      continue;
    }

    log(`[gemini:chunk] chunk ${idx + 1}/${total} — received ${text.length} chars from "${model}", parsing JSON`);

    // ── Stage 3: JSON parse ──────────────────────────────────────────────────
    let parsed;
    try {
      ({ parsed } = attemptJsonParse(text, model, log));
    } catch (parseErr) {
      // Parse failed on this model — try the next model before giving up
      log(`[gemini:chunk] chunk ${idx + 1}/${total} — JSON parse failed on "${model}", trying next: ${parseErr.message}`);
      lastErr = parseErr;
      continue;
    }

    const result = normalizeChunkResult(parsed);
    log(`[gemini:chunk] SUCCESS chunk ${idx + 1}/${total} via "${model}": "${result.chunkSummary?.slice(0, 80)}"`);
    return { ...result, modelUsed: model };
  }

  // All models tried — none succeeded
  const errMsg = lastErr?.message || 'All models exhausted without error detail';
  log(`[gemini:chunk] EXHAUSTED chunk ${idx + 1}/${total} — no model succeeded. Last: ${errMsg}`);
  return { failed: true, error: errMsg, chunkIndex: idx };
}

/**
 * Run the merge step — combine chunk/group summaries into a final result.
 * Tries every model in queue; throws only after all are exhausted.
 */
async function runMerge(chunkSummaries, apiKey, modelQueue, log) {
  const prompt = buildMergePrompt(chunkSummaries);
  log(`[gemini:merge] Merging ${chunkSummaries.length} chunk summaries`);

  const skipped = [];
  for (const model of modelQueue) {
    try {
      const response = await tryModelWithRetry(apiKey, model, prompt, log);
      const { text, data } = await extractRawText(response);

      if (!text) {
        log(`[gemini:merge] Empty merge response from "${model}" — trying next`);
        skipped.push(model);
        continue;
      }

      const { parsed, method } = attemptJsonParse(text, model, log);
      if (method !== 'direct') log(`[gemini:merge] Parse method: "${method}"`);
      const summary = normalizeSummary(parsed);
      log(`[gemini:merge] Merge complete via "${model}"`);
      return { summary, rawOutput: data, modelUsed: model };

    } catch (err) {
      if (err.skipToNextModel) {
        skipped.push(model);
        log(`[gemini:merge] Skipping "${model}" for merge: ${err.message}`);
        continue;
      }
      throw err; // hard failures propagate
    }
  }

  throw Object.assign(
    new Error(`Merge failed — no model succeeded. Tried: [${modelQueue.join(', ')}]`),
    { isNoModelsError: true }
  );
}

/**
 * Summarize a transcript using the best available Gemini model.
 *
 * Strategy is chosen automatically:
 *   direct      — short transcripts, single Gemini call
 *   chunked     — long transcripts, chunk → summarize each → merge
 *   hierarchical — very long transcripts, chunk → group-merge → final-merge
 *
 * @param {string}   transcript
 * @param {string}   apiKey
 * @param {Function} [log]
 * @returns {Promise<{
 *   summary: object,
 *   rawOutput: object,
 *   modelUsed: string,
 *   strategy: 'direct'|'chunked'|'hierarchical',
 *   chunkCount: number,
 *   partialFailures: number,
 * }>}
 */
export async function summarizeTranscript(transcript, apiKey, log = console.log) {
  if (!apiKey) {
    throw Object.assign(
      new Error('GEMINI_API_KEY is not configured. Add it to backend/.env to enable AI summarization.'),
      { isConfigError: true }
    );
  }

  const processedTranscript = validateAndTrimTranscript(transcript);
  const strategy = classifyTranscript(processedTranscript);

  log(`[gemini] Transcript: ${processedTranscript.length} chars, strategy: ${strategy}`);

  const modelQueue = await buildModelQueue(apiKey, log);

  if (modelQueue.length === 0) {
    throw Object.assign(
      new Error(
        'No generateContent-capable Gemini models are available for this API key. ' +
        'Check that the Gemini API is enabled in your Google Cloud project and your API key has the correct permissions. ' +
        'Visit: https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com'
      ),
      { isNoModelsError: true }
    );
  }

  // ── Strategy: direct (short transcripts) ─────────────────────────────────
  if (strategy === 'short') {
    log(`[gemini] Using direct summarization`);
    const prompt   = buildPrompt(processedTranscript);
    const skipped  = [];
    let   lastErr  = null;

    for (const model of modelQueue) {
      try {
        const response = await tryModelWithRetry(apiKey, model, prompt, log);
        const result   = await extractSummary(response, model, log);

        if (skipped.length > 0) {
          log(`[gemini] Direct success with "${model}" after skipping: [${skipped.join(', ')}]`);
        } else {
          log(`[gemini] Direct success with primary model "${model}"`);
        }

        return { ...result, modelUsed: model, strategy: 'direct', chunkCount: 1, partialFailures: 0 };

      } catch (err) {
        lastErr = err;
        if (err.skipToNextModel) {
          skipped.push(model);
          if (!err.retryable) _modelCache = null;
          log(`[gemini] Skipping "${model}" — trying next. Reason: ${err.message}`);
          continue;
        }
        log(`[gemini] Hard failure on "${model}" — stopping. Reason: ${err.message}`);
        break;
      }
    }

    if (skipped.length === modelQueue.length) {
      throw Object.assign(
        new Error(
          `No available Gemini text model found for this API key. ` +
          `Transcript is saved — you can retry when a model becomes available. ` +
          `Checked ${skipped.length} model(s): [${skipped.join(', ')}]. ` +
          `Ensure the Gemini API is enabled: https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com`
        ),
        { isNoModelsError: true }
      );
    }

    throw lastErr;
  }

  // ── Strategy: chunked / hierarchical (long or very_long transcripts) ──────
  log(`[gemini] Chunking transcript...`);
  const chunks = chunkTranscript(processedTranscript);
  log(`[gemini] Created ${chunks.length} chunks`);

  // Summarize each chunk sequentially (never concurrent — rate-limit friendly).
  // exhaustedModels: models that hit quota during THIS session — skip for all subsequent chunks.
  const chunkResults = [];
  let partialFailures = 0;
  const exhaustedModels = new Set(); // session-level quota blacklist

  for (let i = 0; i < chunks.length; i++) {
    const result = await summarizeChunk(chunks[i], i, chunks.length, apiKey, modelQueue, log, exhaustedModels);
    if (result.failed) {
      partialFailures++;
      log(`[gemini] Chunk ${i + 1} failed — inserting gap placeholder for merge`);
      chunkResults.push({
        chunkSummary: `[Segment ${i + 1} could not be summarized due to an error]`,
        keyPoints:   [],
        actionItems: [],
        participants: [],
      });
    } else {
      chunkResults.push(result);
    }
  }

  const successfulChunks = chunkResults.filter(
    r => !r.chunkSummary?.startsWith('[Segment')
  );

  if (successfulChunks.length === 0) {
    throw Object.assign(
      new Error(
        'All transcript segments failed to summarize. Transcript is saved — use Retry.'
      ),
      { isNoModelsError: true }
    );
  }

  // ── Hierarchical grouping for very_long transcripts ───────────────────────
  if (strategy === 'very_long' && chunkResults.length > HIERARCHICAL_GROUP) {
    log(`[gemini] Hierarchical mode: grouping ${chunkResults.length} chunks (${HIERARCHICAL_GROUP} per group)`);

    const groups = [];
    for (let i = 0; i < chunkResults.length; i += HIERARCHICAL_GROUP) {
      groups.push(chunkResults.slice(i, i + HIERARCHICAL_GROUP));
    }

    const groupSummaries = [];
    for (let g = 0; g < groups.length; g++) {
      log(`[gemini] Merging group ${g + 1}/${groups.length}`);
      try {
        const { summary } = await runMerge(groups[g], apiKey, modelQueue, log);
        groupSummaries.push({
          chunkSummary: summary.summary,
          keyPoints:    summary.keyPoints,
          actionItems:  summary.actionItems,
          participants: summary.participants,
        });
      } catch (err) {
        // Group merge failed — fall back to raw chunk summaries from that group
        log(`[gemini] Group ${g + 1} merge failed: ${err.message} — using raw chunk summaries`);
        groupSummaries.push(...groups[g]);
      }
    }

    log(`[gemini] Final hierarchical merge across ${groupSummaries.length} group summaries`);
    const finalResult = await runMerge(groupSummaries, apiKey, modelQueue, log);
    return {
      ...finalResult,
      strategy:        'hierarchical',
      chunkCount:      chunks.length,
      partialFailures,
    };
  }

  // ── Final merge (chunked, or very_long that didn't need group step) ───────
  log(`[gemini] Final merge with ${chunkResults.length} chunk summaries`);
  const mergeResult = await runMerge(chunkResults, apiKey, modelQueue, log);

  return {
    ...mergeResult,
    strategy:        strategy === 'very_long' ? 'hierarchical' : 'chunked',
    chunkCount:      chunks.length,
    partialFailures,
  };
}
