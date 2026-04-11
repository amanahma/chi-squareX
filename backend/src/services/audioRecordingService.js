import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function ensureDir(path) {
  try { mkdirSync(path, { recursive: true }); } catch (_) {}
}

export function createMeetingAudioRecorder({ meetingId, addLog }) {
  const recordingsDir = join(process.cwd(), 'recordings');
  ensureDir(recordingsDir);
  const filePath = join(recordingsDir, `${meetingId}-${Date.now()}.webm`);
  let started = false;
  let stopped = false;
  let startResult = null;
  let strategy = 'browser_media_recorder';

  async function start(page) {
    if (startResult) return startResult;
    addLog('[audio] Starting browser-side recorder service...');
    await page.evaluate(() => {
      window.__meetAudioRec = {
        queue: [],
        started: false,
        failed: false,
        error: null,
        errorStack: null,
        mimeType: null,
        streamMode: null,
        diagnostics: {
          streamExists: false,
          audioTrackCount: 0,
          audioTrackLabels: [],
          selectedMimeType: null,
          mediaRecorderSupported: typeof MediaRecorder !== 'undefined',
        },
      };
    });

    const browserResult = await page.evaluate(async () => {
      const state = window.__meetAudioRec;
      try {
        if (typeof MediaRecorder === 'undefined') {
          state.failed = true;
          state.error = 'MediaRecorder is not supported in this browser context';
          return {
            ok: false,
            reason: 'media_recorder_unsupported',
            error: state.error,
            errorStack: null,
            diagnostics: state.diagnostics,
          };
        }

        let stream = null;
        let streamError = null;
        try {
          // Preferred: capture tab/system audio if allowed.
          stream = await navigator.mediaDevices.getDisplayMedia({
            audio: true,
            video: true,
          });
          state.streamMode = 'display_media';
        } catch (displayErr) {
          streamError = displayErr;
          // Fallback: microphone input.
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            state.streamMode = 'user_media';
          } catch (userErr) {
            state.failed = true;
            state.error = userErr?.message || displayErr?.message || 'Could not capture any audio stream';
            state.errorStack = userErr?.stack || displayErr?.stack || null;
            return {
              ok: false,
              reason: 'stream_unavailable',
              error: state.error,
              errorStack: state.errorStack,
              diagnostics: state.diagnostics,
            };
          }
        }

        state.diagnostics.streamExists = !!stream;
        if (!stream) {
          state.failed = true;
          state.error = streamError?.message || 'Audio stream was not created';
          state.errorStack = streamError?.stack || null;
          return {
            ok: false,
            reason: 'stream_missing',
            error: state.error,
            errorStack: state.errorStack,
            diagnostics: state.diagnostics,
          };
        }

        const audioTracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
        state.diagnostics.audioTrackCount = audioTracks.length;
        state.diagnostics.audioTrackLabels = audioTracks.map((t) => t?.label || 'unlabeled');
        if (!audioTracks.length) {
          state.failed = true;
          state.error = 'Captured stream has no audio tracks';
          return {
            ok: false,
            reason: 'no_audio_tracks',
            error: state.error,
            errorStack: null,
            diagnostics: state.diagnostics,
          };
        }

        const mimeCandidates = [
          'audio/webm;codecs=opus',
          'audio/webm',
          'audio/ogg;codecs=opus',
          'audio/ogg',
        ];
        const selectedMimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported?.(m)) || null;
        state.mimeType = selectedMimeType;
        state.diagnostics.selectedMimeType = selectedMimeType;
        if (!selectedMimeType) {
          state.failed = true;
          state.error = 'No supported MediaRecorder audio mimeType found';
          return {
            ok: false,
            reason: 'unsupported_mime_type',
            error: state.error,
            errorStack: null,
            diagnostics: state.diagnostics,
          };
        }

        const recorder = new MediaRecorder(stream, { mimeType: selectedMimeType });
        recorder.ondataavailable = async (evt) => {
          if (!evt.data || evt.data.size === 0) return;
          const buf = await evt.data.arrayBuffer();
          let binary = '';
          const bytes = new Uint8Array(buf);
          for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
          state.queue.push(btoa(binary));
        };
        recorder.onerror = (e) => {
          state.failed = true;
          state.error = e?.error?.message || e?.message || 'MediaRecorder error';
          state.errorStack = e?.error?.stack || null;
        };
        try {
          recorder.start(2000);
        } catch (startErr) {
          state.failed = true;
          state.error = startErr?.message || 'MediaRecorder failed to start';
          state.errorStack = startErr?.stack || null;
          return {
            ok: false,
            reason: 'media_recorder_start_failed',
            error: state.error,
            errorStack: state.errorStack,
            diagnostics: state.diagnostics,
          };
        }
        state.started = true;
        state.recorder = recorder;
        state.stream = stream;
        return {
          ok: true,
          reason: null,
          error: null,
          errorStack: null,
          streamMode: state.streamMode,
          mimeType: selectedMimeType,
          diagnostics: state.diagnostics,
        };
      } catch (err) {
        state.failed = true;
        state.error = err?.message || String(err);
        state.errorStack = err?.stack || null;
        return {
          ok: false,
          reason: 'unexpected_start_error',
          error: state.error,
          errorStack: state.errorStack,
          diagnostics: state.diagnostics,
        };
      }
    });

    startResult = {
      ok: !!browserResult?.ok,
      reason: browserResult?.reason || null,
      streamMode: browserResult?.streamMode || null,
      mimeType: browserResult?.mimeType || null,
      diagnostics: browserResult?.diagnostics || null,
      error: browserResult?.error || null,
      errorStack: browserResult?.errorStack || null,
      strategy,
      friendlyMessage: browserResult?.ok
        ? null
        : 'Audio fallback could not start. Continuing with captions only.',
    };

    if (!startResult.ok) {
      const d = startResult.diagnostics || {};
      addLog(`[audio] Recorder start failed: ${startResult.reason || 'unknown_reason'}`);
      addLog(`[audio] Stream exists: ${d.streamExists ? 'yes' : 'no'}`);
      addLog(`[audio] Audio tracks: ${Number(d.audioTrackCount || 0)}`);
      addLog(`[audio] Track labels: ${(Array.isArray(d.audioTrackLabels) && d.audioTrackLabels.length) ? d.audioTrackLabels.join(' | ') : '(none)'}`);
      addLog(`[audio] MediaRecorder supported: ${d.mediaRecorderSupported ? 'yes' : 'no'}`);
      addLog(`[audio] Chosen mimeType: ${d.selectedMimeType || '(none)'}`);
      if (startResult.error) addLog(`[audio] Error: ${startResult.error}`);
      if (startResult.errorStack) addLog(`[audio] Error stack: ${startResult.errorStack}`);
      return startResult;
    }

    started = true;
    addLog(`[audio] Recorder started (${startResult.streamMode || 'unknown'})`);
    addLog(`[audio] Stream exists: ${startResult.diagnostics?.streamExists ? 'yes' : 'no'}`);
    addLog(`[audio] Audio tracks: ${Number(startResult.diagnostics?.audioTrackCount || 0)}`);
    addLog(`[audio] Track labels: ${(startResult.diagnostics?.audioTrackLabels || []).join(' | ') || '(none)'}`);
    addLog(`[audio] MediaRecorder supported: ${startResult.diagnostics?.mediaRecorderSupported ? 'yes' : 'no'}`);
    addLog(`[audio] Chosen mimeType: ${startResult.mimeType || '(none)'}`);
    return startResult;
  }

  async function drain(page) {
    if (!started || stopped) return;
    const chunks = await page.evaluate(() => {
      const state = window.__meetAudioRec;
      if (!state) return [];
      const out = state.queue || [];
      state.queue = [];
      return out;
    }).catch(() => []);
    for (const b64 of chunks) {
      const buf = Buffer.from(String(b64), 'base64');
      appendFileSync(filePath, buf);
    }
  }

  async function stop(page) {
    if (!started || stopped) return filePath;
    stopped = true;
    await drain(page).catch(() => {});
    await page.evaluate(() => {
      const state = window.__meetAudioRec;
      if (!state) return;
      try { state.recorder?.stop(); } catch (_) {}
      try { state.stream?.getTracks()?.forEach((t) => t.stop()); } catch (_) {}
    }).catch(() => {});
    // final drain after stop event flushed data
    await new Promise((r) => setTimeout(r, 600));
    await drain(page).catch(() => {});
    return filePath;
  }

  return {
    start: (page) => start(page),
    drain: (page) => drain(page),
    stop: (page) => stop(page),
    filePath,
    getStartResult: () => startResult,
    getStrategy: () => strategy,
  };
}

