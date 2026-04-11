import React from 'react';
import { Link } from 'react-router-dom';
import './Navbar.css';

function Navbar({ user, onLogout }) {
  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <Link to="/" className="navbar-brand">
          <div className="navbar-logo">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <defs>
                <linearGradient id="logoGrad" x1="0" y1="0" x2="28" y2="28">
                  <stop offset="0%" stopColor="#667eea" />
                  <stop offset="100%" stopColor="#764ba2" />
                </linearGradient>
              </defs>
              <rect width="28" height="28" rx="8" fill="url(#logoGrad)" />
              <path d="M8 11L14 7L20 11V17L14 21L8 17V11Z" stroke="white" strokeWidth="1.5" fill="none" />
              <circle cx="14" cy="14" r="2.5" fill="white" />
            </svg>
          </div>
          <span className="navbar-title">
            Meet AI <span className="navbar-title-accent">Scribe</span>
          </span>
        </Link>

        <div className="navbar-actions">
          {user ? (
            <>
              <div className="navbar-user">
                <div className="navbar-avatar">
                  {(user.name || user.email).charAt(0).toUpperCase()}
                </div>
                <span className="navbar-username">{user.name || user.email}</span>
              </div>
              <button className="btn btn-outline btn-sm" onClick={onLogout}>
                Logout
              </button>
            </>
          ) : (
            <Link to="/login" className="btn btn-primary btn-sm">
              Get Started
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}

export default Navbar;
