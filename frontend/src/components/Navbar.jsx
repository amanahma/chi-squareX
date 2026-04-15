import React from 'react';
import { Link } from 'react-router-dom';
import './Navbar.css';

function Navbar({ user, onLogout }) {
  return (
    <nav className="navbar">
      <div className="navbar-inner">
        <Link to="/" className="navbar-brand">
          <div className="navbar-logo">
            <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
              <defs>
                <linearGradient id="logoGrad" x1="0" y1="0" x2="30" y2="30">
                  <stop offset="0%" stopColor="hsl(217,100%,70%)" />
                  <stop offset="100%" stopColor="hsl(224,71%,55%)" />
                </linearGradient>
              </defs>
              <rect width="30" height="30" rx="8" fill="url(#logoGrad)" />
              {/* Chi SquareX "χ²" mark */}
              <text x="5" y="21" fontFamily="Space Grotesk,sans-serif" fontSize="16" fontWeight="700" fill="white">χ²</text>
            </svg>
          </div>
          <span className="navbar-title">
            Chi SquareX · <span className="navbar-title-accent">AI Scribe</span>
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
