import { openAiWhisperTranscriber } from './providers/openaiWhisperProvider.js';

export function createTranscriptionService({ openAiApiKey }) {
  return {
    async transcribeAudio({ filePath, meetingId, addLog }) {
      if (!filePath) return { chunks: [], provider: 'none' };
      if (!openAiApiKey) {
        addLog('[audio] OPENAI_API_KEY not configured — skipping STT provider');
        return { chunks: [], provider: 'none' };
      }
      return openAiWhisperTranscriber({
        filePath,
        apiKey: openAiApiKey,
        meetingId,
        addLog,
      });
    },
  };
}

