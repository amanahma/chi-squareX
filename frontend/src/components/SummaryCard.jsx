import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import './SummaryCard.css';

function SummaryCard({ session, index, onRetry, onDelete }) {
  const [retryTranscript, setRetryTranscript] = useState('');
  const [showRetryInput, setShowRetryInput] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const STATUS_CONFIG = {
    pending:                 { label: 'Starting...',          icon: '⏳' },
    launching_browser:       { label: 'Launching Browser',    icon: '🌐' },
    opening_meet:            { label: 'Opening Meet',         icon: '📡' },
    joining:                 { label: 'Joining Meet',         icon: '🔄' },
    joining_meet:            { label: 'Joining Meeting',      icon: '🚪' },
    waiting_for_admission:   { label: 'Waiting for Host',     icon: '⏳' },
    capturing_transcript:    { label: 'Capturing...',         icon: '🎤' },
    recording_audio:         { label: 'Recording Audio',      icon: '🎙️' },
    transcribing_audio:      { label: 'Transcribing Audio',   icon: '📝' },
    merging_transcript:      { label: 'Merging Transcript',   icon: '🔗' },
    generating_summary:      { label: 'Generating Summary',   icon: '🧠' },
    transcribing:            { label: 'Capturing...',         icon: '🎤' },
    summarizing:             { label: 'AI Summarizing',       icon: '🧠' },
    chunking_transcript:     { label: 'Splitting Transcript', icon: '✂️' },
    summarizing_chunks:      { label: 'Summarizing Segments', icon: '🧠' },
    merging_summaries:       { label: 'Merging Summaries',    icon: '🔀' },
    processing:              { label: 'Processing',           icon: '⚙️' },
    completed:               { label: 'Completed',            icon: '✅' },
    partial_summary:         { label: 'Partial Summary',      icon: '⚠️' },
    failed:                  { label: 'Failed',               icon: '❌' },
    parse_failed:            { label: 'Parse Failed',         icon: '⚠️' },
    google_sign_in_required: { label: 'Sign-In Required',     icon: '🔐' },
    browser_profile_in_use:  { label: 'Profile Locked',       icon: '🔒' },
    needs_manual_transcript: { label: 'Needs Transcript',     icon: '📝' },
    summary_quota_exceeded:  { label: 'Quota Exceeded',       icon: '⚠️' },
    no_transcript:           { label: 'No Transcript',        icon: '📭' },
  };

  const config = STATUS_CONFIG[session.status] || { label: session.status, icon: '❓' };
  const isInProgress = [
    'pending', 'joining', 'transcribing', 'summarizing', 'processing',
    'launching_browser', 'opening_meet', 'joining_meet', 'waiting_for_admission',
    'capturing_transcript', 'recording_audio', 'transcribing_audio', 'merging_transcript',
    'generating_summary', 'chunking_transcript', 'summarizing_chunks', 'merging_summaries',
  ].includes(session.status);
  const isFailed = [
    'failed', 'no_transcript', 'needs_manual_transcript', 'google_sign_in_required',
    'browser_profile_in_use', 'summary_quota_exceeded', 'parse_failed',
  ].includes(session.status);
  const isPartial = session.status === 'partial_summary';

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getSummaryTitle = () => {
    if (session.summary && typeof session.summary === 'object') {
      return session.summary.title || session.title || 'Meeting Summary';
    }
    return session.title || 'Meeting Summary';
  };

  const getSummaryPreview = () => {
    // Completed — show the summary text
    if (session.status === 'completed' && session.summary && typeof session.summary === 'object') {
      const text = session.summary.summary || session.summary.overview;
      return text || 'Summary is available. Click to view details.';
    }
    // Partial summary — show what we have
    if (isPartial) {
      const text = session.summary?.summary || session.summary?.overview;
      return text ? `⚠️ Partial: ${text}` : (session.errorMessage || 'Partial summary available — some segments failed.');
    }
    // Parse failed — transcript is saved
    if (session.status === 'parse_failed') {
      return 'Transcript saved — AI returned unexpected output. Click Retry to try again.';
    }
    // Other failures
    if (isFailed) {
      if (session.failureReasonCode === 'CAPTIONS_NOT_ENABLED') return 'Bot joined, but captions were not detected.';
      if (session.failureReasonCode === 'TRANSCRIPT_BELOW_THRESHOLD' || session.failureReasonCode === 'TRANSCRIPT_TOO_SHORT') return 'Meeting ended, but transcript was below threshold.';
      if (session.failureReasonCode === 'PARTIAL_CAPTIONS_ONLY') return 'Only part of the meeting had detectable captions.';
      if (session.failureReasonCode === 'CAPTION_WATCHER_STOPPED' || session.failureReasonCode === 'WATCHER_STALE') return 'Caption watcher became inactive during meeting.';
      if (session.failureReasonCode === 'WATCHER_RECOVERY_FAILED') return 'Caption watcher recovery failed during meeting.';
      if (session.failureReasonCode === 'CAPTION_CONTAINER_REPLACED') return 'Meet replaced caption container; watcher had to recover.';
      if (session.failureReasonCode === 'CAPTIONS_DISABLED') return 'Captions seem disabled in this meeting.';
      if (session.failureReasonCode === 'AUDIO_FALLBACK_FAILED') return 'Audio fallback failed, and no caption transcript was captured.';
      return session.errorMessage || 'This meeting encountered an error.';
    }
    // In progress
    if (isInProgress) {
      return `${config.label} — please wait...`;
    }
    return 'No summary available.';
  };

  const handleRetry = async () => {
    setActionLoading(true);
    await onRetry(session.id, retryTranscript || undefined);
    setShowRetryInput(false);
    setRetryTranscript('');
    setActionLoading(false);
  };

  const handleDelete = async () => {
    if (!confirm('Delete this meeting? This cannot be undone.')) return;
    setActionLoading(true);
    await onDelete(session.id);
    setActionLoading(false);
  };

  return (
    <div
      className={`summary-card card ${isInProgress ? 'card-in-progress' : ''}`}
      style={{ animationDelay: `${index * 0.05}s` }}
    >
      <div className="summary-card-header">
        <div className="summary-card-meta">
          <span className={`status-badge status-${session.status}`}>
            {config.icon} {config.label}
          </span>
          <span className="summary-card-date">{formatDate(session.createdAt || session.created_at)}</span>
        </div>
      </div>

      <h3 className="summary-card-title">{getSummaryTitle()}</h3>
      <p className={`summary-card-preview ${isFailed ? 'preview-error' : isPartial ? 'preview-warn' : ''}`}>{getSummaryPreview()}</p>

      <div className="summary-card-footer">
        <span className="summary-card-link-preview" title={session.meetLink || session.meet_link}>
          🔗 {(session.meetLink || session.meet_link || '').replace('https://meet.google.com/', '')}
        </span>
        {session.transcriptMeta?.source && (
          <span className="summary-card-link-preview" title="Transcript source">
            📄 {session.transcriptMeta.source}
          </span>
        )}
        {session.transcriptMeta?.captionChunkCount != null && (
          <span className="summary-card-link-preview" title="Caption chunk count">
            🧩 {session.transcriptMeta.captionChunkCount}
          </span>
        )}

        <div className="summary-card-actions">


          {(isFailed || isPartial) && (
            <>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => setShowRetryInput(!showRetryInput)}
                disabled={actionLoading}
              >
                🔄 Retry
              </button>
              <button
                className="btn btn-sm btn-ghost"
                onClick={handleDelete}
                disabled={actionLoading}
                title="Delete meeting"
              >
                🗑
              </button>
            </>
          )}
          {(session.status === 'completed' || isPartial) && (
            <Link to={`/summary/${session.id}`} className="btn btn-outline btn-sm">
              View →
            </Link>
          )}
        </div>
      </div>

      {/* Retry with transcript input */}
      {showRetryInput && (
        <div className="retry-section">
          {session.transcript && !retryTranscript && (
            <p className="retry-saved-hint">
              💾 Transcript saved — click <strong>Retry Now</strong> to re-summarize, or paste a different one below.
            </p>
          )}
          <textarea
            className="input-field retry-transcript-input"
            placeholder={
              session.transcript
                ? 'Optional: paste a different transcript instead of the saved one…'
                : 'Paste a transcript to retry with AI summarization...'
            }
            value={retryTranscript}
            onChange={(e) => setRetryTranscript(e.target.value)}
            rows={3}
          />
          <div className="retry-actions">
            <button className="btn btn-primary btn-sm" onClick={handleRetry} disabled={actionLoading}>
              {actionLoading ? 'Retrying...' : 'Retry Now'}
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => setShowRetryInput(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default SummaryCard;
