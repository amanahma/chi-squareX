import React, { useState } from 'react';
import SummaryCard from './SummaryCard';
import './Dashboard.css';

function Dashboard({ user, sessions, onSendBot, onRetry, onDelete, loading }) {
  const [meetLink, setMeetLink] = useState('');
  const [transcript, setTranscript] = useState('');
  const [showTranscript, setShowTranscript] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupStatus, setSetupStatus] = useState(null); // null | 'open' | 'error' | 'done'
  const [setupMessage, setSetupMessage] = useState('');

  const handleSetupProfile = async () => {
    setSetupLoading(true);
    setSetupStatus(null);
    setSetupMessage('');
    try {
      const token = localStorage.getItem('meetai_token');
      const resp = await fetch('/api/setup-profile', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json();
      if (resp.ok) {
        setSetupStatus('open');
        setSetupMessage(data.message);
      } else {
        setSetupStatus('error');
        setSetupMessage(data.error || 'Failed to launch setup browser');
      }
    } catch (err) {
      setSetupStatus('error');
      setSetupMessage('Network error: ' + err.message);
    }
    setSetupLoading(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!meetLink.trim()) return;

    setFeedback(null);
    const result = await onSendBot(meetLink, transcript);
    if (result.success) {
      const status = result.meeting?.status;
      let message = 'Meeting submitted — bot workflow started.';
      if (status === 'failed') {
        message = result.meeting?.errorMessage || 'Meeting created but the bot encountered an error.';
      }
      setFeedback({ type: status === 'failed' ? 'warning' : 'success', message });
      setMeetLink('');
      setTranscript('');
      setShowTranscript(false);
    } else {
      setFeedback({ type: 'error', message: result.error || 'Failed to create meeting' });
    }
  };

  const inProgressCount = sessions.filter(s =>
    ['pending', 'joining', 'transcribing', 'summarizing',
     'launching_browser', 'opening_meet', 'joining_meet', 'waiting_for_admission', 'capturing_transcript'].includes(s.status)
  ).length;

  return (
    <div className="dashboard">
      {/* Welcome Header */}
      <div className="dashboard-header animate-fade-in-up">
        <div>
          <h1 className="dashboard-title">
            Welcome back, <span className="gradient-text">{user.name || 'there'}</span>
          </h1>
          <p className="dashboard-subtitle">
            Paste a Google Meet link to start. Optionally provide a transcript for AI summarization.
          </p>
        </div>
        <div className="dashboard-stats">
          <div className="stat-pill">
            <span className="stat-number">{sessions.length}</span>
            <span className="stat-label">Meetings</span>
          </div>
          <div className="stat-pill">
            <span className="stat-number">{sessions.filter(s => s.status === 'completed').length}</span>
            <span className="stat-label">Summaries</span>
          </div>
          {inProgressCount > 0 && (
            <div className="stat-pill stat-pill-active">
              <span className="stat-number">{inProgressCount}</span>
              <span className="stat-label">In Progress</span>
            </div>
          )}
        </div>
      </div>

      {/* Profile Setup */}
      <div className="glass-panel animate-fade-in-up" style={{ animationDelay: '0.05s', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.9em', opacity: 0.8 }}>🔐 Bot needs a signed-in Chrome profile to join meetings.</span>
        <button
          className="btn btn-outline btn-sm"
          onClick={handleSetupProfile}
          disabled={setupLoading || setupStatus === 'open'}
          style={{ whiteSpace: 'nowrap' }}
        >
          {setupLoading ? '⏳ Launching...' : setupStatus === 'open' ? '🟢 Browser Open' : '🔧 Setup Bot Profile'}
        </button>
        {setupStatus === 'open' && (
          <span style={{ fontSize: '0.85em', color: '#4ade80' }}>
            ✅ Sign into Google in the opened browser, then close it when done.
          </span>
        )}
        {setupStatus === 'error' && (
          <span style={{ fontSize: '0.85em', color: '#f87171' }}>
            ❌ {setupMessage}
          </span>
        )}
      </div>

      {/* Send Bot Section */}
      <div className="send-bot-section glass-panel animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
        <div className="send-bot-header">
          <div className="send-bot-icon">🤖</div>
          <div>
            <h2>New Meeting</h2>
            <p>Submit a Meet link. Paste a transcript below for instant AI summarization.</p>
          </div>
        </div>

        <form className="send-bot-form" onSubmit={handleSubmit}>
          <div className="send-bot-input-row">
            <input
              id="meet-link-input"
              className="input-field send-bot-input"
              type="url"
              placeholder="https://meet.google.com/xxx-xxxx-xxx"
              value={meetLink}
              onChange={(e) => setMeetLink(e.target.value)}
              required
            />
            <button
              type="submit"
              className="btn btn-primary send-bot-btn"
              disabled={loading || !meetLink.trim()}
            >
              {loading ? (
                <>
                  <span className="spinner"></span>
                  Processing...
                </>
              ) : (
                <>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 2L11 13" />
                    <path d="M22 2L15 22L11 13L2 9L22 2Z" />
                  </svg>
                  Submit
                </>
              )}
            </button>
          </div>

          {/* Transcript paste toggle */}
          <button
            type="button"
            className="transcript-toggle-btn"
            onClick={() => setShowTranscript(!showTranscript)}
          >
            {showTranscript ? '▾ Hide transcript input' : '▸ Paste a transcript (optional)'}
          </button>

          {showTranscript && (
            <textarea
              className="input-field transcript-input"
              placeholder="Paste your meeting transcript here for instant AI summarization..."
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              rows={6}
            />
          )}
        </form>

        {feedback && (
          <div className={`send-bot-feedback ${feedback.type}`}>
            {feedback.type === 'success' ? '✅' : feedback.type === 'warning' ? '⚠️' : '❌'} {feedback.message}
          </div>
        )}
      </div>

      {/* Sessions / Summaries List */}
      <div className="sessions-section animate-fade-in-up" style={{ animationDelay: '0.2s' }}>
        <div className="sessions-header">
          <h2>Your Meetings</h2>
          <span className="sessions-count">{sessions.length} total</span>
        </div>

        {sessions.length === 0 ? (
          <div className="sessions-empty glass-panel">
            <div className="sessions-empty-icon">📋</div>
            <h3>No meetings yet</h3>
            <p>Submit a Google Meet link above to get started!</p>
          </div>
        ) : (
          <div className="sessions-grid">
            {sessions.map((session, index) => (
              <SummaryCard
                key={session.id}
                session={session}
                index={index}
                onRetry={onRetry}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default Dashboard;
