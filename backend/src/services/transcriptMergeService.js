function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normalizeTranscriptPreserveLines(s) {
  return String(s || '')
    .split('\n')
    .map((line) => normalizeText(line))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Format caption chunks as plain, human-readable text.
 * Output format:
 *   Speaker: text       (if speaker exists)
 *   text                (if no speaker)
 *
 * Each utterance is on its own line.
 * This is the canonical formatter for transcript, raw_caption_transcript,
 * and merged_transcript fields.
 */
export function formatChunksAsPlainText(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return '';
  return chunks
    .map((c) => {
      const text = normalizeText(c.text);
      if (!text) return null;
      const speaker = normalizeText(c.speaker);
      return speaker ? `${speaker}: ${text}` : text;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Legacy serializer — timestamped format kept ONLY for raw_caption_chunks_json debug.
 * New transcript fields should use formatChunksAsPlainText() instead.
 */
export function serializeCaptionChunks(chunks) {
  if (!Array.isArray(chunks)) return '';
  return chunks
    .map((c) => `[${c.ts || new Date().toISOString()}] ${normalizeText(c.text)}`)
    .filter((line) => line.length > 5)
    .join('\n');
}

export function mergeTranscriptSources({ captionChunks = [], audioChunks = [], meetingDurationSec = 0 }) {
  const captionLines = Array.isArray(captionChunks) ? captionChunks : [];
  const audioLines = Array.isArray(audioChunks) ? audioChunks : [];

  // Use plain text format for both caption and audio transcripts
  const captionTranscript = formatChunksAsPlainText(captionLines);
  const audioTranscript = audioLines.map((c) => normalizeText(c.text)).filter(Boolean).join('\n');

  const captionLen = captionTranscript.length;
  const audioLen = audioTranscript.length;
  const expectedMinChars = Math.max(200, meetingDurationSec * 8); // rough speech density
  const captionTooSmall = captionLen < expectedMinChars * 0.35;
  const audioFallbackUsed = audioLen > 0 && (captionLen === 0 || captionTooSmall);

  let mergedTranscript = captionTranscript;
  if (audioFallbackUsed) {
    mergedTranscript = audioTranscript;
    if (captionLen > 0) {
      mergedTranscript = `${audioTranscript}\n\n--- Caption Snippets ---\n${captionTranscript}`;
    }
  } else if (audioLen > 0) {
    // Keep captions primary; append missing audio context.
    mergedTranscript = `${captionTranscript}\n\n--- Additional Audio Context ---\n${audioTranscript}`;
  }

  return {
    mergedTranscript: normalizeTranscriptPreserveLines(mergedTranscript),
    metadata: {
      meetingDurationSec,
      captionTranscriptLength: captionLen,
      audioTranscriptLength: audioLen,
      expectedMinChars,
      captionTooSmall,
      audioFallbackUsed,
      source: audioFallbackUsed ? 'audio_fallback_used' : 'captions_primary',
      captionChunkCount: captionLines.length,
      audioChunkCount: audioLines.length,
    },
  };
}
