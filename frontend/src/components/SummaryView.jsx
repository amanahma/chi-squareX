import React, { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import './SummaryView.css';

// ─── Activity Timeline ────────────────────────────────────────────────────────

function ActivityTimeline({ activityLog, isInProgress }) {
  const icons = { ok: '✅', warn: '⚠️', fail: '❌' };
  const inProgressIcon = '⏳';

  return (
    <div className="activity-timeline">
      {activityLog.map((entry, i) => {
        const isLast     = i === activityLog.length - 1;
        const isSpinner  = isLast && isInProgress;
        const icon       = isSpinner ? inProgressIcon : (icons[entry.status] || '•');
        const stepClass  = `activity-step activity-step-${entry.status}${isSpinner ? ' activity-step-spinning' : ''}`;
        const ts         = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        return (
          <div key={i} className={stepClass}>
            <div className="activity-step-left">
              <span className="activity-step-icon" aria-hidden="true">{icon}</span>
              {i < activityLog.length - 1 && <div className="activity-step-line" />}
            </div>
            <div className="activity-step-body">
              <div className="activity-step-header">
                <span className="activity-step-label">{entry.step}</span>
                <span className="activity-step-ts">{ts}</span>
              </div>
              {entry.detail && (
                <div className="activity-step-detail">{entry.detail}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

function SummaryView({ sessions, onRetry, onDelete }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const session = sessions.find((s) => s.id === id);
  const [retryTranscript, setRetryTranscript] = useState('');
  const [showRetry, setShowRetry]             = useState(false);
  const [actionLoading, setActionLoading]     = useState(false);
  const [showRawLog, setShowRawLog]           = useState(false);

  if (!session) {
    return (
      <div className="summary-view-empty animate-fade-in-up">
        <div className="summary-view-empty-icon">🔍</div>
        <h2>Session not found</h2>
        <p>The session you're looking for doesn't exist or is still loading.</p>
        <Link to="/" className="btn btn-primary">Back to Dashboard</Link>
      </div>
    );
  }

  const summary    = typeof session.summary === 'object' ? session.summary : null;
  const createdAt  = session.createdAt || session.created_at;
  const meetLink   = session.meetLink || session.meet_link;

  const isFailed = [
    'failed', 'no_transcript', 'needs_manual_transcript', 'google_sign_in_required',
    'browser_profile_in_use', 'summary_quota_exceeded', 'parse_failed',
  ].includes(session.status);

  const isPartial = session.status === 'partial_summary';

  const isInProgress = [
    'pending', 'joining', 'transcribing', 'summarizing', 'processing',
    'launching_browser', 'opening_meet', 'joining_meet', 'waiting_for_admission',
    'capturing_transcript', 'recording_audio', 'transcribing_audio', 'merging_transcript',
    'generating_summary', 'chunking_transcript', 'summarizing_chunks', 'merging_summaries',
  ].includes(session.status);

  const handleRetry = async () => {
    setActionLoading(true);
    await onRetry(session.id, retryTranscript || undefined);
    setShowRetry(false);
    setRetryTranscript('');
    setActionLoading(false);
  };

  const handleDelete = async () => {
    if (!confirm('Delete this meeting permanently?')) return;
    setActionLoading(true);
    await onDelete(session.id);
    navigate('/');
  };

  const STATUS_LABELS = {
    pending:                 '⏳ Pending',
    launching_browser:       '🌐 Launching Browser…',
    opening_meet:            '📡 Opening Meet…',
    joining:                 '🔄 Joining Meeting…',
    joining_meet:            '🚪 Joining Meeting…',
    waiting_for_admission:   '⏳ Waiting for Host Approval…',
    capturing_transcript:    '🎤 Capturing Transcript…',
    recording_audio:         '🎙️ Recording Audio…',
    transcribing_audio:      '📝 Transcribing Audio…',
    merging_transcript:      '🔗 Merging Transcript Sources…',
    generating_summary:      '🧠 Generating Summary…',
    transcribing:            '🎤 Transcribing…',
    summarizing:             '🧠 Summarizing with AI…',
    chunking_transcript:     '✂️ Splitting Transcript…',
    summarizing_chunks:      '🧠 Summarizing Segments…',
    merging_summaries:       '🔀 Merging Summaries…',
    processing:              '⚙️ Processing…',
    completed:               '✅ Completed',
    partial_summary:         '⚠️ Partial Summary',
    failed:                  '❌ Failed',
    parse_failed:            '⚠️ Parse Failed — Transcript Saved',
    google_sign_in_required: '🔐 Google Sign-In Required',
    browser_profile_in_use:  '🔒 Chrome Profile Locked — Close Browser',
    needs_manual_transcript: '📝 Needs Transcript — Paste Manually',
    summary_quota_exceeded:  '⚠️ Quota Exceeded — Transcript Saved, Retry Later',
    no_transcript:           '📭 No Transcript',
  };

  // Resolve the summary text field — handle both new flat schema and old schema
  const summaryText = summary?.summary || summary?.overview || null;

  // Resolve arrays — new flat schema first, then legacy field names
  const keyPoints   = summary?.keyPoints   || summary?.key_takeaways || null;
  const actionItems = summary?.actionItems || null;
  // Legacy action_items was an array of objects {assignee, task, deadline}
  const legacyActionItems = summary?.action_items || null;
  const participants = summary?.participants || null;
  const topics       = summary?.topics      || null;
  const decisions    = summary?.decisions   || null;

  const canRetry = isFailed || isPartial;
  let rawCaptionDebug = null;
  try {
    rawCaptionDebug = session.rawCaptionChunksJson ? JSON.parse(session.rawCaptionChunksJson) : null;
  } catch (_) {
    rawCaptionDebug = null;
  }
  const reasonLabels = {
    BOT_NOT_ADMITTED:              'Bot was not admitted by host.',
    CAPTIONS_NOT_ENABLED:          'Bot joined, but captions were not detected.',
    CAPTION_CONTAINER_NOT_FOUND:   'Caption container not found in Meet DOM on any scan.',
    CAPTION_CONTAINER_REPLACED:    'Caption container was replaced mid-meeting — reattach attempted.',
    WATCHER_ATTACHED_TO_STALE_NODE:'Observer attached but node was stale/replaced — no events received.',
    WATCHER_REATTACH_NO_EVENTS:    'Reattachment succeeded but produced zero caption events in validation window.',
    WATCHER_RECOVERY_FAILED:       'All caption watcher recovery attempts exhausted without valid events.',
    CAPTIONS_DISABLED_AFTER_JOIN:  'Captions were disabled by host mid-meeting.',
    NO_CAPTION_CHUNKS_CAPTURED:    'No caption chunks were captured during meeting.',
    AUDIO_FALLBACK_FAILED:         'Audio fallback failed, and no caption transcript was captured.',
    TRANSCRIPT_BELOW_THRESHOLD:    'Meeting ended, but transcript was below minimum threshold.',
    PARTIAL_CAPTIONS_ONLY:         'Only partial captions were captured during the meeting.',
    CAPTION_WATCHER_STOPPED:       'Caption watcher became inactive before meeting ended.',
    WATCHER_STALE:                 'Caption watcher became stale.',
    CAPTIONS_DISABLED:             'Captions appear to be disabled in this meeting.',
    MEETING_SILENT_TOO_LONG:       'Meeting stayed silent for a long period.',
    DEDUP_REMOVED_TOO_MUCH:        'Caption deduplication removed too many repeated lines.',
    TRANSCRIPT_TOO_SHORT:          'Meeting ended, but transcript was too short.',
    TRANSCRIPT_SAVE_FAILED:        'Transcript could not be saved reliably.',
    MANUAL_TRANSCRIPT_USED:        'Manual (pasted) transcript was used as the primary source.',
    SHARED_VIDEO_AUDIO_NOT_CAPTIONED: 'Shared video audio was not captioned — Meet only captions microphone speech.',
    ONLY_UI_ANNOUNCEMENTS_CAPTURED:   'Only system/UI announcements were captured — no real speech detected.',
  };

  return (
    <div className="summary-view animate-fade-in-up">
      {/* Back Navigation */}
      <Link to="/" className="summary-back-link">
        ← Back to Dashboard
      </Link>

      {/* Header */}
      <div className="summary-view-header glass-panel">
        <div className="summary-view-header-top">
          <span className={`status-badge status-${session.status}`}>
            {STATUS_LABELS[session.status] || session.status}
          </span>
          <span className="summary-view-date">
            {new Date(createdAt).toLocaleDateString('en-US', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
              hour: '2-digit', minute: '2-digit',
            })}
          </span>
        </div>

        <h1 className="summary-view-title">
          {summary?.title || session.title || 'Meeting Summary'}
        </h1>

        {summaryText && (
          <p className="summary-view-overview">{summaryText}</p>
        )}

        <div className="summary-view-meta">
          {summary?.duration_estimate && (
            <div className="meta-chip">⏱ {summary.duration_estimate}</div>
          )}
          {participants?.length > 0 && (
            <div className="meta-chip">👥 {participants.length} participants</div>
          )}
          <div className="meta-chip" title={meetLink}>
            🔗 {meetLink?.replace('https://meet.google.com/', 'meet/')}
          </div>
          {session.joinedAt && (
            <div className="meta-chip">📅 Joined: {new Date(session.joinedAt).toLocaleTimeString()}</div>
          )}
          {session.transcriptMeta?.source && (
            <div className="meta-chip">📄 Source: {session.transcriptMeta.source}</div>
          )}
          {session.lastStage && (
            <div className="meta-chip">🧭 Stage: {session.lastStage}</div>
          )}
          {session.failureReasonCode && (
            <div className="meta-chip">⚠️ Reason: {session.failureReasonCode}</div>
          )}
          {session.transcriptMeta?.captionChunkCount != null && (
            <div className="meta-chip">🧩 Caption chunks: {session.transcriptMeta.captionChunkCount}</div>
          )}
          {session.transcriptMeta?.rawCaptionChars != null && (
            <div className="meta-chip">🧾 Raw chars: {session.transcriptMeta.rawCaptionChars}</div>
          )}
          {session.transcriptMeta?.cleanedCaptionChars != null && (
            <div className="meta-chip">✨ Cleaned chars: {session.transcriptMeta.cleanedCaptionChars}</div>
          )}
          {session.transcriptMeta?.mergedTranscriptChars != null && (
            <div className="meta-chip">📦 Merged chars: {session.transcriptMeta.mergedTranscriptChars}</div>
          )}
          {session.transcriptMeta?.rawChunkCount != null && (
            <div className="meta-chip">📥 Raw chunks: {session.transcriptMeta.rawChunkCount}</div>
          )}
          {session.transcriptMeta?.acceptedChunkCount != null && (
            <div className="meta-chip">✅ Accepted: {session.transcriptMeta.acceptedChunkCount}</div>
          )}
          {session.transcriptMeta?.rejectedChunkCount != null && (
            <div className="meta-chip">🚫 Rejected: {session.transcriptMeta.rejectedChunkCount}</div>
          )}
          {session.transcriptMeta?.dedupMergedCount != null && (
            <div className="meta-chip">🔁 Dedup merged: {session.transcriptMeta.dedupMergedCount}</div>
          )}
          {session.transcriptMeta?.uiFilteredCount != null && (
            <div className="meta-chip">🧹 UI filtered: {session.transcriptMeta.uiFilteredCount}</div>
          )}
          {session.transcriptMeta?.finalUtteranceCount != null && (
            <div className="meta-chip meta-chip-ok">💬 Final utterances: {session.transcriptMeta.finalUtteranceCount}</div>
          )}
          {session.transcriptMeta?.incrementalMergedCount != null && session.transcriptMeta.incrementalMergedCount > 0 && (
            <div className="meta-chip">🔀 Incremental merged: {session.transcriptMeta.incrementalMergedCount}</div>
          )}
          {session.transcriptMeta?.partialUpdatesDiscarded != null && session.transcriptMeta.partialUpdatesDiscarded > 0 && (
            <div className="meta-chip">🗜 Partials collapsed: {session.transcriptMeta.partialUpdatesDiscarded}</div>
          )}
          {session.transcriptMeta?.prefixMergedCount != null && session.transcriptMeta.prefixMergedCount > 0 && (
            <div className="meta-chip">🔤 Fuzzy merged: {session.transcriptMeta.prefixMergedCount}</div>
          )}
          {session.transcriptMeta?.minTranscriptThresholdUsed && (
            <div className="meta-chip">
              🎯 Threshold: c{session.transcriptMeta.minTranscriptThresholdUsed.minChars}/l{session.transcriptMeta.minTranscriptThresholdUsed.minLines}/k{session.transcriptMeta.minTranscriptThresholdUsed.minChunks}/w{session.transcriptMeta.minTranscriptThresholdUsed.watcherInactivityMs}
            </div>
          )}
          {session.transcriptMeta?.watcherRecoveryAttempts != null && (
            <div className="meta-chip">♻️ Recovery attempts: {session.transcriptMeta.watcherRecoveryAttempts}</div>
          )}
          {session.transcriptMeta?.watcherRecoveredSuccessfully != null && (
            <div className="meta-chip">🛠 Recovered: {session.transcriptMeta.watcherRecoveredSuccessfully ? 'yes' : 'no'}</div>
          )}
          {session.transcriptMeta?.watcherReattachNoEvents != null && session.transcriptMeta.watcherReattachNoEvents && (
            <div className="meta-chip meta-chip-warn">⚠️ Reattach: no events in validation window</div>
          )}
          {session.transcriptMeta?.watcherAttachedToStaleNode && (
            <div className="meta-chip meta-chip-warn">⚠️ Stale node detected</div>
          )}
          {session.transcriptMeta?.pollFallbackActivated != null && (
            <div className="meta-chip">
              {session.transcriptMeta.pollFallbackActivated ? '🔄 Poll fallback: activated' : '✅ Poll fallback: not needed'}
            </div>
          )}
          {session.transcriptMeta?.pollFallbackUsed && (
            <div className="meta-chip meta-chip-ok">✅ Poll fallback: produced captions</div>
          )}
          {session.transcriptMeta?.captionsDisabledAfterJoin && (
            <div className="meta-chip meta-chip-warn">⚠️ Captions disabled mid-meeting</div>
          )}
          {session.transcriptMeta?.lastSuccessfulCaptionTs && (
            <div className="meta-chip" title={session.transcriptMeta.lastSuccessfulCaptionTs}>
              🕐 Last caption: {new Date(session.transcriptMeta.lastSuccessfulCaptionTs).toLocaleTimeString()}
            </div>
          )}
          {Array.isArray(session.transcriptMeta?.watcherReattachResults) && session.transcriptMeta.watcherReattachResults.length > 0 && (
            <div className="meta-chip" title={JSON.stringify(session.transcriptMeta.watcherReattachResults)}>
              🔍 Reattach results: {session.transcriptMeta.watcherReattachResults.map(
                (r, i) => `#${r.attempt}:${r.validated ? '✓' : '✗'}(+${r.chunkDelta})`
              ).join(' ')}
            </div>
          )}
          {session.transcriptMeta?.transcriptLength != null && (
            <div className="meta-chip">📏 Captured chars: {session.transcriptMeta.transcriptLength}</div>
          )}
          {session.transcriptMeta?.avgChunkSize != null && (
            <div className="meta-chip">📐 Avg chunk: {session.transcriptMeta.avgChunkSize}</div>
          )}
          {session.transcriptMeta?.captionsEnabled != null && (
            <div className="meta-chip">💬 Captions active: {session.transcriptMeta.captionsEnabled ? 'yes' : 'no'}</div>
          )}
          {session.transcriptMeta?.audioFallbackAttempted != null && (
            <div className="meta-chip">🎚 Attempted: {session.transcriptMeta.audioFallbackAttempted ? 'yes' : 'no'}</div>
          )}
          {session.transcriptMeta?.audioFallbackFailed != null && (
            <div className="meta-chip">🚫 Fallback failed: {session.transcriptMeta.audioFallbackFailed ? 'yes' : 'no'}</div>
          )}
          {session.transcriptMeta?.audioFallbackUsed != null && (
            <div className="meta-chip">🎚 Fallback: {session.transcriptMeta.audioFallbackUsed ? 'used' : 'not used'}</div>
          )}
          {session.transcriptMeta?.captionTranscriptLength != null && (
            <div className="meta-chip">🔤 Caption chars: {session.transcriptMeta.captionTranscriptLength}</div>
          )}
          {/* ── Caption Classification Chips ── */}
          {session.transcriptMeta?.spokenCaptionCount != null && (
            <div className="meta-chip meta-chip-ok">🎤 Spoken captions: {session.transcriptMeta.spokenCaptionCount}</div>
          )}
          {session.transcriptMeta?.systemAnnouncementCount != null && session.transcriptMeta.systemAnnouncementCount > 0 && (
            <div className="meta-chip meta-chip-warn">📢 System announcements filtered: {session.transcriptMeta.systemAnnouncementCount}</div>
          )}
          {session.transcriptMeta?.unknownTextCount != null && session.transcriptMeta.unknownTextCount > 0 && (
            <div className="meta-chip">❓ Unknown text filtered: {session.transcriptMeta.unknownTextCount}</div>
          )}
          {session.transcriptMeta?.captionFailureReason != null && (
            <div className="meta-chip meta-chip-warn" title={reasonLabels[session.transcriptMeta.captionFailureReason] || session.transcriptMeta.captionFailureReason}>
              ⚠️ Caption issue: {reasonLabels[session.transcriptMeta.captionFailureReason] || session.transcriptMeta.captionFailureReason}
            </div>
          )}
          {session.transcriptMeta?.audioFallbackUnavailable != null && session.transcriptMeta.audioFallbackUnavailable && (
            <div className="meta-chip meta-chip-warn">🔇 Audio fallback: unavailable</div>
          )}
          {session.transcriptMeta?.audioTranscriptLength != null && (
            <div className="meta-chip">🎧 Audio chars: {session.transcriptMeta.audioTranscriptLength}</div>
          )}

          {/* ── Manual Transcript / Source Debug Chips ── */}
          {session.transcriptMeta?.transcriptSource != null && (
            <div className={`meta-chip ${
              session.transcriptMeta.transcriptSource === 'manual_paste' ? 'meta-chip-ok' : ''
            }`}>
              📋 Source: {session.transcriptMeta.transcriptSource}
            </div>
          )}
          {session.transcriptMeta?.manualTranscriptProvided != null && (
            <div className={`meta-chip ${
              session.transcriptMeta.manualTranscriptProvided ? 'meta-chip-ok' : ''
            }`}>
              {session.transcriptMeta.manualTranscriptProvided ? '✅ Manual transcript: yes' : '📡 Manual transcript: no'}
            </div>
          )}
          {session.transcriptMeta?.liveMeetingEmpty != null && (
            <div className={`meta-chip ${
              session.transcriptMeta.liveMeetingEmpty ? 'meta-chip-warn' : ''
            }`}>
              {session.transcriptMeta.liveMeetingEmpty ? '⚠️ Live meeting: empty' : '📡 Live meeting: active'}
            </div>
          )}
          {session.transcriptMeta?.liveMeetingEmptyReason != null && (
            <div className="meta-chip meta-chip-warn">
              💡 Empty reason: {session.transcriptMeta.liveMeetingEmptyReason}
            </div>
          )}
          {session.transcriptMeta?.thresholdValidationSource != null && (
            <div className="meta-chip">
              🎯 Threshold src: {session.transcriptMeta.thresholdValidationSource}
            </div>
          )}
          {session.transcriptMeta?.statusMessage != null && (
            <div className="meta-chip meta-chip-ok" title={session.transcriptMeta.statusMessage}>
              💬 {session.transcriptMeta.statusMessage}
            </div>
          )}
        </div>

        {/* Actions — shown for failed OR partial meetings */}
        {(isFailed || isPartial) && (
          <div className="summary-view-actions">
            {session.status === 'browser_profile_in_use' && (
              <div className="guidance-box guidance-warn">
                <strong>🔒 Chrome Profile is Locked</strong>
                <p>Another Chrome window is using the same profile. To fix:</p>
                <ol>
                  <li>Close <strong>all</strong> Chrome windows (check system tray)</li>
                  <li>Or set up a dedicated bot profile (see <code>backend/.env.example</code>)</li>
                </ol>
                <p>Or paste a transcript below to get your summary now.</p>
              </div>
            )}
            {session.status === 'google_sign_in_required' && (
              <div className="guidance-box guidance-blue">
                <strong>🔐 Google Sign-In Required</strong>
                <p>The bot needs a signed-in Chrome profile to join meetings.</p>
                <ol>
                  <li>Run: <code>chrome.exe --user-data-dir="C:\MeetBot"</code></li>
                  <li>Sign into Google, then close that Chrome</li>
                  <li>Set <code>CHROME_USER_DATA_DIR=C:/MeetBot</code> in <code>backend/.env</code></li>
                </ol>
                <p>Or paste a transcript below for instant AI summarization.</p>
              </div>
            )}
            {(session.status === 'needs_manual_transcript' || session.status === 'failed') && (
              <div className="guidance-box guidance-green">
                <strong>💡 Tip: Paste a Transcript</strong>
                <p>Click "Retry with Transcript" below, paste your meeting notes, and get an AI summary instantly.</p>
              </div>
            )}
            {(session.status === 'parse_failed') && (
              <div className="guidance-box guidance-warn">
                <strong>⚠️ Summary Parse Failed</strong>
                <p>Your transcript is saved. Use Retry to attempt summarization again.</p>
              </div>
            )}
            {isPartial && (
              <div className="guidance-box guidance-warn">
                <strong>⚠️ Partial Summary</strong>
                <p>Some transcript segments could not be summarized. The summary below covers the available segments. You can Retry for a complete summary.</p>
              </div>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => setShowRetry(!showRetry)} disabled={actionLoading}>
              📝 Retry with Transcript
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => onRetry(session.id)} disabled={actionLoading}>
              🔄 Retry Bot Join
            </button>
            <button className="btn btn-sm btn-ghost" onClick={handleDelete} disabled={actionLoading}>
              🗑 Delete
            </button>
          </div>
        )}

        {!canRetry && !isInProgress && (
          <div className="summary-view-actions summary-view-actions-light">
            <button className="btn btn-sm btn-ghost" onClick={handleDelete} disabled={actionLoading}>
              🗑 Delete
            </button>
          </div>
        )}

        {/* Retry transcript input */}
        {showRetry && (
          <div className="retry-section">
            {session.transcript && !retryTranscript && (
              <p className="retry-saved-hint">
                💾 Transcript already saved ({session.transcript.length.toLocaleString()} chars) — click <strong>Summarize with AI</strong> to retry with it, or paste a different transcript below.
              </p>
            )}
            <textarea
              className="input-field"
              placeholder={
                session.transcript
                  ? 'Optional: paste a different transcript to use instead of the saved one…'
                  : 'Paste your meeting transcript here… (copy from meeting chat, notes, or a recording transcript)'
              }
              value={retryTranscript}
              onChange={(e) => setRetryTranscript(e.target.value)}
              rows={6}
            />
            <div className="retry-actions">
              <button
                className="btn btn-primary btn-sm"
                onClick={handleRetry}
                disabled={actionLoading || (!retryTranscript.trim() && !session.transcript)}
              >
                {actionLoading ? 'Processing…' : '✨ Summarize with AI'}
              </button>
              <button className="btn btn-outline btn-sm" onClick={() => setShowRetry(false)}>Cancel</button>
              <span className="retry-char-count">{retryTranscript.length > 0 ? `${retryTranscript.length.toLocaleString()} chars` : ''}</span>
            </div>
          </div>
        )}
      </div>

      {/* In-progress indicator */}
      {isInProgress && (
        <div className="summary-section glass-panel">
          <h3 className="section-title">
            <span className="section-icon">⏳</span> Processing
          </h3>
          <p>This meeting is being processed. The page will update automatically.</p>
          <div className="progress-indicator">
            <div className="progress-bar" />
          </div>
        </div>
      )}

      {/* Error / Failure Details */}
      {isFailed && session.errorMessage && (
        <div className="summary-section glass-panel error-section">
          <h3 className="section-title">
            <span className="section-icon">⚠️</span> Error Details
          </h3>
          <p className="error-message-text">{session.errorMessage}</p>
          {session.failureReasonCode && (
            <p className="error-message-text">Reason: {reasonLabels[session.failureReasonCode] || session.failureReasonCode}</p>
          )}
        </div>
      )}

      {/* Partial summary warning */}
      {isPartial && session.errorMessage && (
        <div className="summary-section glass-panel warning-section">
          <h3 className="section-title">
            <span className="section-icon">⚠️</span> Partial Summary
          </h3>
          <p className="error-message-text">{session.errorMessage}</p>
        </div>
      )}

      {/* ── Activity Timeline (new structured log) ───────────────────────────── */}
      {session.activityLog?.length > 0 && (
        <details className="summary-section glass-panel" open={isInProgress}>
          <summary className="section-title clickable">
            <span className="section-icon">📋</span> Activity Log
            <span className="section-subtitle"> · {session.activityLog.length} steps</span>
          </summary>
          <ActivityTimeline activityLog={session.activityLog} isInProgress={isInProgress} />

          {/* Raw server log kept below for debug use */}
          {session.botLog && (
            <details className="raw-log-details" open={showRawLog}>
              <summary className="raw-log-toggle" onClick={() => setShowRawLog(!showRawLog)}>
                🔧 Raw Debug Log
              </summary>
              <pre className="bot-log-content">{session.botLog}</pre>
            </details>
          )}
        </details>
      )}

      {/* ── Fallback: old plain-text bot log (backwards compat) ─────────────── */}
      {!session.activityLog && session.botLog && (
        <details className="summary-section glass-panel">
          <summary className="section-title clickable">
            <span className="section-icon">🔧</span> Bot Activity Log
          </summary>
          <pre className="bot-log-content">{session.botLog}</pre>
        </details>
      )}

      {/* ── Summary Content ──────────────────────────────────────────────────── */}
      {summary && (
        <div className="summary-content-grid">

          {/* Participants */}
          {participants?.length > 0 && (
            <div className="summary-section glass-panel" style={{ animationDelay: '0.1s' }}>
              <h3 className="section-title">
                <span className="section-icon">👥</span> Participants
              </h3>
              <div className="participants-list">
                {participants.map((p, i) => (
                  <div key={i} className="participant-chip">
                    <div className="participant-avatar">{String(p).charAt(0).toUpperCase()}</div>
                    {p}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Key Points (new flat schema) */}
          {keyPoints?.length > 0 && (
            <div className="summary-section glass-panel" style={{ animationDelay: '0.13s' }}>
              <h3 className="section-title">
                <span className="section-icon">💡</span> Key Points
              </h3>
              <ul className="key-points-list">
                {keyPoints.map((pt, i) => (
                  <li key={i}>{pt}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Action Items — new flat string array */}
          {actionItems?.length > 0 && (
            <div className="summary-section glass-panel" style={{ animationDelay: '0.16s' }}>
              <h3 className="section-title">
                <span className="section-icon">📌</span> Action Items
              </h3>
              <ul className="action-items-list">
                {actionItems.map((item, i) => (
                  <li key={i} className="action-item-flat">{item}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Legacy action_items (old object-array format {assignee, task, deadline}) */}
          {!actionItems?.length && legacyActionItems?.length > 0 && (
            <div className="summary-section glass-panel" style={{ animationDelay: '0.16s' }}>
              <h3 className="section-title">
                <span className="section-icon">📌</span> Action Items
              </h3>
              <div className="action-items-list">
                {legacyActionItems.map((item, i) => (
                  <div key={i} className="action-item">
                    <div className="action-item-row">
                      <span className="action-assignee">{item.assignee}</span>
                      {item.deadline && item.deadline !== 'N/A' && (
                        <span className="action-deadline">📅 {item.deadline}</span>
                      )}
                    </div>
                    <div className="action-task">{item.task}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Legacy: Topics Discussed */}
          {topics?.length > 0 && (
            <div className="summary-section glass-panel" style={{ animationDelay: '0.19s' }}>
              <h3 className="section-title">
                <span className="section-icon">💬</span> Topics Discussed
              </h3>
              <div className="topics-list">
                {topics.map((topic, i) => (
                  <div key={i} className="topic-item">
                    <div className="topic-name">{topic.name || topic}</div>
                    {topic.summary && <div className="topic-summary">{topic.summary}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Legacy: Decisions */}
          {decisions?.length > 0 && (
            <div className="summary-section glass-panel" style={{ animationDelay: '0.22s' }}>
              <h3 className="section-title">
                <span className="section-icon">✅</span> Decisions Made
              </h3>
              <ul className="decisions-list">
                {decisions.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            </div>
          )}

          {/* Legacy: Key Takeaways */}
          {summary.key_takeaways?.length > 0 && !keyPoints?.length && (
            <div className="summary-section glass-panel" style={{ animationDelay: '0.25s' }}>
              <h3 className="section-title">
                <span className="section-icon">💡</span> Key Takeaways
              </h3>
              <ul className="takeaways-list">
                {summary.key_takeaways.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Raw Transcript (Collapsible) */}
      {session.transcript && (
        <details className="transcript-section glass-panel" style={{ animationDelay: '0.3s' }}>
          <summary className="transcript-toggle">
            📄 View Cleaned Transcript ({session.transcript.length.toLocaleString()} chars)
          </summary>
          <pre className="transcript-content">{session.transcript}</pre>
        </details>
      )}

      {session.rawAudioTranscript && (
        <details className="transcript-section glass-panel" style={{ animationDelay: '0.32s' }}>
          <summary className="transcript-toggle">
            🎧 View Audio Transcript ({session.rawAudioTranscript.length.toLocaleString()} chars)
          </summary>
          <pre className="transcript-content">{session.rawAudioTranscript}</pre>
        </details>
      )}
      {session.rawCaptionTranscript && (
        <details className="transcript-section glass-panel" style={{ animationDelay: '0.34s' }}>
          <summary className="transcript-toggle">
            💬 View Raw Caption Transcript ({session.rawCaptionTranscript.length.toLocaleString()} chars)
          </summary>
          <pre className="transcript-content">{session.rawCaptionTranscript}</pre>
        </details>
      )}
      {rawCaptionDebug && (
        <details className="transcript-section glass-panel" style={{ animationDelay: '0.36s' }}>
          <summary className="transcript-toggle">
            🧪 Caption Debug Events&nbsp;
            <span style={{ color: 'var(--brand-cyan, #06b6d4)', fontWeight: 600 }}>
              {(rawCaptionDebug.rawEvents?.length || 0).toLocaleString()} raw live updates
            </span>
            {session.transcriptMeta?.finalUtteranceCount != null && (
              <span style={{ color: 'var(--brand-green, #22c55e)', marginLeft: '0.5rem' }}>
                → {session.transcriptMeta.finalUtteranceCount} final utterances
              </span>
            )}
            {session.transcriptMeta?.partialUpdatesDiscarded != null && session.transcriptMeta.partialUpdatesDiscarded > 0 && (
              <span style={{ color: 'var(--text-muted, #94a3b8)', marginLeft: '0.5rem', fontSize: '0.8em' }}>
                ({session.transcriptMeta.partialUpdatesDiscarded} partials collapsed)
              </span>
            )}
          </summary>
          <pre className="transcript-content">{JSON.stringify(rawCaptionDebug, null, 2)}</pre>
        </details>
      )}
      <details className="transcript-section glass-panel" style={{ animationDelay: '0.38s' }}>
        <summary className="transcript-toggle">🧭 Transcript Comparison Debug</summary>
        <pre className="transcript-content">{JSON.stringify({
          rawCaptionEvents: rawCaptionDebug?.rawEvents || [],
          cleanedCaptionTranscript: session.rawCaptionTranscript || '',
          finalMergedTranscript: session.mergedTranscript || session.transcript || '',
        }, null, 2)}</pre>
      </details>
    </div>
  );
}

export default SummaryView;
