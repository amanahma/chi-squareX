import React, { useState } from 'react';
import './Login.css';

function Login({ onLogin, onSignup }) {
  const [isSignup, setIsSignup] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    let result;
    if (isSignup) {
      result = await onSignup(name, email, password);
    } else {
      result = await onLogin(email, password);
    }

    setLoading(false);
    if (!result.success) {
      setError(result.error || 'Something went wrong');
    }
  };

  return (
    <div className="login-page">
      <div className="login-hero">
        <div className="login-hero-content animate-fade-in-up">
          <div className="login-badge">☾ AI-Powered Meeting Intelligence</div>
          <h1 className="login-hero-title">
            Never miss a <span className="gradient-text">meeting detail</span> again.
          </h1>
          <p className="login-hero-subtitle">
            Send an AI bot to your Google Meet sessions. Get structured summaries
            with key topics, decisions, and action items — automatically.
          </p>
          <div className="login-features">
            <div className="login-feature">
              <div className="login-feature-icon">🤖</div>
              <div>
                <strong>Bot Joins Meet</strong>
                <span>Automated meeting entry</span>
              </div>
            </div>
            <div className="login-feature">
              <div className="login-feature-icon">📝</div>
              <div>
                <strong>Live Transcription</strong>
                <span>Real-time caption capture</span>
              </div>
            </div>
            <div className="login-feature">
              <div className="login-feature-icon">✨</div>
              <div>
                <strong>AI Summary</strong>
                <span>Powered by Gemini</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="login-form-section">
        <form className="login-form glass-panel animate-fade-in-up" onSubmit={handleSubmit}>
          <div className="login-form-header">
            <h2>{isSignup ? 'Create Account' : 'Welcome Back'}</h2>
            <p>{isSignup ? 'Start capturing meeting intelligence' : 'Sign in to your dashboard'}</p>
          </div>

          {error && <div className="login-error">{error}</div>}

          {isSignup && (
            <div className="input-group">
              <label htmlFor="name">Full Name</label>
              <input
                id="name"
                className="input-field"
                type="text"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
          )}

          <div className="input-group">
            <label htmlFor="email">Email Address</label>
            <input
              id="email"
              className="input-field"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="input-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              className="input-field"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary login-submit-btn"
            disabled={loading}
          >
            {loading ? (
              <span className="spinner"></span>
            ) : isSignup ? (
              'Create Account'
            ) : (
              'Sign In'
            )}
          </button>

          <div className="login-toggle">
            {isSignup ? 'Already have an account?' : "Don't have an account?"}{' '}
            <button
              type="button"
              className="login-toggle-btn"
              onClick={() => {
                setIsSignup(!isSignup);
                setError('');
              }}
            >
              {isSignup ? 'Sign In' : 'Sign Up'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default Login;
