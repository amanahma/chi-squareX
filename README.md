# Google Meet AI Scribe

> AI-powered meeting transcription and summarization for Google Meet — built for the Chi SquareX Summer Internship Task.

---

## Features

| Feature | Status | Details |
|---------|--------|---------|
| **Meet Integration** | ✅ | Bot launches Chrome, navigates to Meet, attempts join, captures captions |
| **Dual Transcript Pipeline** | ✅ | Primary DOM captions + optional audio recording/STT fallback with merged transcript |
| **AI Summarization** | ✅ | Gemini 2.0 Flash processes transcripts into structured summaries |
| **Manual Transcript** | ✅ | Paste a transcript directly for instant AI summarization |
| **Responsive UI** | ✅ | React + Vite premium dark-themed dashboard with real-time polling |
| **Authentication** | ✅ | JWT-based signup/login with bcrypt password hashing |
| **Persistent Storage** | ✅ | SQLite database for users, meetings, transcripts, and summaries |
| **Real-time Status** | ✅ | Honest pipeline: pending → joining → transcribing → summarizing → completed/failed |
| **Retry Support** | ✅ | Retry failed meetings with optional transcript paste |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, Vite 6, React Router 7 |
| **Backend** | Node.js, Express 4, SQLite (better-sqlite3) |
| **AI** | Google Gemini 2.0 Flash API |
| **Bot** | puppeteer-core (uses system Chrome) |
| **Auth** | JWT + bcrypt |
| **Hosting** | Netlify (frontend) + Render (backend) |

---

## Local Development Setup

### Prerequisites

- **Node.js** v18+
- **Google Chrome** installed
- **Gemini API Key** from [Google AI Studio](https://aistudio.google.com/apikey)

### 1. Install Dependencies

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 2. Configure Environment

Create `backend/.env`:
```env
PORT=5001
SECRET_KEY=meet-**-scribe-***-secret-2026
GEMINI_API_KEY=AIzaSyDA-4FOqD774rJc45CV7886nFJ3QauDw6w
```

### 3. Start Development Servers

```bash
# Terminal 1 — Backend
cd backend
npm run dev

# Terminal 2 — Frontend
cd frontend
npm run dev
```

Open **http://localhost:5173**

## How It Works

### Bot Pipeline
```
Submit Meet Link
     ↓
[pending] → Bot starting
     ↓
[joining] → Chrome launches, navigates to Meet
     ↓
[transcribing] → Capturing live captions from DOM
     ↓
[recording_audio] → Recording meeting audio for fallback
     ↓
[transcribing_audio] → Speech-to-text fallback (if configured)
     ↓
[merging_transcript] → Caption + audio transcript merge
     ↓
[summarizing] → Sending transcript to Gemini API
     ↓
[completed] → Structured summary saved
     or
[failed] → Honest error message displayed
```

### Manual Transcript Flow
```
Paste Meet Link + Transcript → [summarizing] → [completed]
```

### Summary Output Structure
```json
{
  "title": "Meeting title",
  "overview": "2-3 sentence overview",
  "participants": ["Name1", "Name2"],
  "topics": [{"name": "Topic", "summary": "Details"}],
  "decisions": ["Decision 1", "Decision 2"],
  "action_items": [{"assignee": "Person", "task": "Task", "deadline": "Date"}],
  "key_takeaways": ["Takeaway 1", "Takeaway 2"]
}
```

---

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/health` | No | Health + config status |
| `GET` | `/api/config` | No | System capabilities |
| `POST` | `/api/auth/signup` | No | Create account |
| `POST` | `/api/auth/login` | No | Login |
| `GET` | `/api/meetings` | Yes | List user meetings |
| `POST` | `/api/meetings` | Yes | Create + start bot |
| `POST` | `/api/meetings/:id/retry` | Yes | Retry failed meeting |
| `DELETE` | `/api/meetings/:id` | Yes | Delete meeting |

---

## GenAI Usage in Development

This project uses **Google's Gemini 2.0 Flash** API as the core AI component:
- **Meeting Summarization**: Transcripts are sent to Gemini with a structured prompt that requests JSON output containing title, overview, participants, topics, decisions, action items, and key takeaways
- **Structured Output**: Uses `responseMimeType: 'application/json'` to ensure reliable JSON parsing
- The AI integration is the primary value proposition — converting unstructured meeting text into actionable, organized summaries

---

## Known Limitations

1. **Google Meet Auth**: Bot needs a signed-in Chrome profile to join meetings. Without it, Google's login wall blocks entry. Set `CHROME_USER_DATA_DIR` to a dedicated bot profile (see Setup Step 3).
2. **Profile Lock**: If Chrome is running with the same profile, the bot can't launch. Use a dedicated bot profile (`C:\MeetBot`) to avoid conflicts.
3. **Host Approval**: Some meetings require the host to admit participants — the bot will wait up to 60 seconds, then report the timeout.
4. **Audio Fallback Provider**: Audio STT fallback requires `OPENAI_API_KEY`. Without it, the system runs caption-only mode and logs STT as skipped.
5. **Caption Capture**: Captions are still primary and depend on Meet DOM behavior. Audio fallback reduces, but does not eliminate, risk of missing text.
6. **Workaround**: Manual transcript paste always works reliably for AI summarization — paste on submit or via Retry.

---

## Project Structure

```
Chi SquareX/
├── backend/
│   ├── src/index.js           # API server + bot worker + Gemini integration
│   ├── .env.example           # Environment template
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx            # Main app (routing, polling, auth state)
│   │   └── components/        # Dashboard, SummaryCard, SummaryView, Login, Navbar
│   ├── vite.config.js         # Vite config with dynamic API proxy
│   └── index.html             # Entry point with SEO meta tags
├── netlify.toml               # Frontend deployment config
├── render.yaml                # Backend deployment config
├── .env.example               # Root environment reference
└── README.md
```

