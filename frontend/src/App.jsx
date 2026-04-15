import React, { useState, useEffect, useRef, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Navbar from './components/Navbar';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import SummaryView from './components/SummaryView';
import './App.css';

// In production, VITE_API_URL points to the deployed backend (e.g. https://chi-square-x.onrender.com).
// In local dev, we fall back to '/api' which Vite proxies to the backend.
const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

// Statuses that indicate work is still in progress
const IN_PROGRESS_STATUSES = new Set([
  'pending', 'joining', 'transcribing', 'summarizing', 'processing',
  'launching_browser', 'opening_meet', 'joining_meet', 'waiting_for_admission',
  'capturing_transcript', 'recording_audio', 'transcribing_audio', 'merging_transcript',
  'generating_summary', 'chunking_transcript', 'summarizing_chunks', 'merging_summaries',
]);

function App() {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [authError, setAuthError] = useState('');
  const pollRef = useRef(null);

  // ── Logout helper (clears everything) ──
  const clearSession = useCallback(() => {
    setUser(null);
    setToken('');
    setMeetings([]);
    setAuthError('');
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  }, []);

  // ── On mount: validate stored token ──
  useEffect(() => {
    const savedUser = localStorage.getItem('user');
    const savedToken = localStorage.getItem('token');

    if (savedUser && savedToken) {
      // Validate the token by calling a protected endpoint
      fetch(`${API_BASE}/meetings`, {
        headers: { Authorization: `Bearer ${savedToken}` },
      })
        .then((res) => {
          if (res.ok) {
            setUser(JSON.parse(savedUser));
            setToken(savedToken);
            return res.json();
          } else {
            // Token is invalid/expired — clear it
            console.warn('Stored token is invalid, clearing session');
            clearSession();
            return null;
          }
        })
        .then((data) => {
          if (data) setMeetings(data);
        })
        .catch(() => {
          // Network error — keep stored session, will retry
          setUser(JSON.parse(savedUser));
          setToken(savedToken);
        });
    }
  }, [clearSession]);

  // ── Polling: re-fetch meetings when any are in progress ──
  useEffect(() => {
    const hasInProgress = meetings.some(m => IN_PROGRESS_STATUSES.has(m.status));

    if (hasInProgress && token) {
      pollRef.current = setInterval(() => fetchMeetings(token), 3000);
    } else {
      if (pollRef.current) clearInterval(pollRef.current);
    }

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [meetings, token]);

  // ── Auth-aware fetch: auto-handles 401 ──
  const authFetch = useCallback(async (url, options = {}) => {
    const res = await fetch(`${API_BASE}${url}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });

    if (res.status === 401) {
      clearSession();
      setAuthError('Your session has expired. Please log in again.');
      return null; // Signal to callers that auth failed
    }

    return res;
  }, [token, clearSession]);

  // ── Auth handlers ──
  const handleLogin = async (email, password) => {
    setAuthError('');
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok) {
        setUser(data.user);
        setToken(data.token);
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
        fetchMeetings(data.token);
        return { success: true };
      }
      return { success: false, error: data.error };
    } catch {
      return { success: false, error: 'Cannot connect to server. Is the backend running?' };
    }
  };

  const handleSignup = async (name, email, password) => {
    setAuthError('');
    try {
      const res = await fetch(`${API_BASE}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (res.ok) {
        setUser(data.user);
        setToken(data.token);
        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));
        return { success: true };
      }
      return { success: false, error: data.error };
    } catch {
      return { success: false, error: 'Cannot connect to server. Is the backend running?' };
    }
  };

  const handleLogout = () => {
    clearSession();
  };

  // ── Data fetchers ──
  const fetchMeetings = async (authToken) => {
    try {
      const t = authToken || token;
      if (!t) return;
      const res = await fetch(`${API_BASE}/meetings`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (res.ok) {
        const data = await res.json();
        setMeetings(data);
      } else if (res.status === 401) {
        clearSession();
      }
    } catch (err) {
      console.error('Failed to fetch meetings:', err);
    }
  };

  const sendBot = async (meetLink, transcript) => {
    setLoading(true);
    try {
      const body = { meetLink };
      if (transcript && transcript.trim()) body.transcript = transcript.trim();

      const res = await authFetch('/meetings', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!res) return { success: false, error: 'Session expired. Please log in again.' };

      const data = await res.json();
      if (res.ok) {
        setMeetings((prev) => [data, ...prev]);
        return { success: true, meeting: data };
      }
      return { success: false, error: data.error };
    } catch (err) {
      return { success: false, error: 'Network error — is the backend running?' };
    } finally {
      setLoading(false);
    }
  };

  const retryMeeting = async (meetingId, transcript) => {
    try {
      const body = {};
      if (transcript && transcript.trim()) body.transcript = transcript.trim();

      const res = await authFetch(`/meetings/${meetingId}/retry`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!res) return { success: false, error: 'Session expired.' };

      const data = await res.json();
      if (res.ok) {
        setMeetings((prev) => prev.map(m => m.id === meetingId ? data : m));
        return { success: true };
      }
      return { success: false, error: data.error };
    } catch (err) {
      return { success: false, error: 'Network error' };
    }
  };

  const deleteMeeting = async (meetingId) => {
    try {
      const res = await authFetch(`/meetings/${meetingId}`, {
        method: 'DELETE',
      });

      if (!res) return { success: false, error: 'Session expired.' };

      if (res.ok) {
        setMeetings((prev) => prev.filter(m => m.id !== meetingId));
        return { success: true };
      }
      const data = await res.json();
      return { success: false, error: data.error };
    } catch (err) {
      return { success: false, error: 'Network error' };
    }
  };

  return (
    <Router>
      <div className="app">
        <Navbar user={user} onLogout={handleLogout} />
        <main className="main-content">
          {/* Show auth error banner when session expires */}
          {authError && (
            <div className="auth-error-banner animate-fade-in-up">
              ⚠️ {authError}
            </div>
          )}
          <Routes>
            <Route
              path="/"
              element={
                user ? (
                  <Dashboard
                    user={user}
                    sessions={meetings}
                    onSendBot={sendBot}
                    onRetry={retryMeeting}
                    onDelete={deleteMeeting}
                    loading={loading}
                  />
                ) : (
                  <Navigate to="/login" />
                )
              }
            />
            <Route
              path="/login"
              element={
                user ? (
                  <Navigate to="/" />
                ) : (
                  <Login onLogin={handleLogin} onSignup={handleSignup} />
                )
              }
            />
            <Route
              path="/summary/:id"
              element={
                user ? (
                  <SummaryView
                    sessions={meetings}
                    onRetry={retryMeeting}
                    onDelete={deleteMeeting}
                  />
                ) : (
                  <Navigate to="/login" />
                )
              }
            />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
