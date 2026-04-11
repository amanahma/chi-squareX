import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export async function openAiWhisperTranscriber({ filePath, apiKey, addLog }) {
  addLog(`[audio] STT provider=openai_whisper file=${basename(filePath)}`);
  const bytes = readFileSync(filePath);
  const blob = new Blob([bytes], { type: 'audio/webm' });
  const form = new FormData();
  form.append('file', blob, basename(filePath));
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OpenAI STT failed (${response.status}): ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const chunks = Array.isArray(data.segments) && data.segments.length > 0
    ? data.segments.map((s) => ({
      ts: new Date(Date.now()).toISOString(),
      startSec: s.start ?? null,
      endSec: s.end ?? null,
      text: String(s.text || '').trim(),
      source: 'audio_stt',
    })).filter((s) => s.text.length > 0)
    : (typeof data.text === 'string' && data.text.trim()
      ? [{ ts: new Date().toISOString(), startSec: null, endSec: null, text: data.text.trim(), source: 'audio_stt' }]
      : []);

  return {
    provider: 'openai_whisper',
    chunks,
    raw: data,
  };
}

