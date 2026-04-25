# Crossword Puzzle Solver — Application Specification

## Overview

A browser-based crossword puzzle solver. The user uploads a PDF of a crossword puzzle, the backend parses it, and the user fills in the grid interactively. Progress is periodically auto-saved. An LLM-backed suggestion feature helps with individual clues.

---

## Technical Stack

- **Frontend**: Static HTML/CSS/JavaScript
- **Backend**: Python, FastAPI, Uvicorn
- **Container**: Docker (single container, bind-mounted volumes for database and uploads)
- **Reverse proxy**: Nginx on the Hetzner VM, proxying to the Docker container on `127.0.0.1:8000`
- **Edge**: Cloudflare (DNS proxy, TLS termination, DDoS protection)
- **Database**: SQLite3 (single file, persisted via Docker bind mount at `./data/puzzle.db`)
- **LLM**: Fine-tuned Qwen 3 4B model running on the developer's machine via Ollama, exposed to the production app through a Cloudflare Tunnel protected by Cloudflare Access

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `ALLOWED_EMAILS` | Comma-separated list of Google email addresses permitted to log in | (required) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | (required) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | (required) |
| `SECRET_KEY` | Secret used to sign browser session cookies | (required) |
| `HTTPS_ONLY` | Set `true` in production to add the `Secure` flag to the session cookie | `false` |
| `SESSION_RETENTION_DAYS` | Number of days to retain session log data | `30` |
| `AUTOSAVE_INTERVAL_SECONDS` | How often (in seconds) the solve page auto-saves grid state | `120` |
| `OLLAMA_ENDPOINT` | Base URL of the Ollama API | `http://localhost:11434` |
| `OLLAMA_MODEL` | Name of the Ollama model to use for suggestions | (required) |
| `OLLAMA_CF_CLIENT_ID` | Cloudflare Access service token client ID (production only) | `""` |
| `OLLAMA_CF_CLIENT_SECRET` | Cloudflare Access service token secret (production only) | `""` |
| `OLLAMA_TEMPERATURE` | Base sampling temperature for the Ollama model | `0.3` |
| `OLLAMA_NUM_PREDICT` | Max tokens the model generates per request | `12` |
| `OLLAMA_TOP_K` | Top-K sampling parameter | `40` |
| `OLLAMA_TOP_P` | Nucleus sampling parameter | `0.95` |
| `OLLAMA_REPEAT_PENALTY` | Repetition penalty | `1.1` |
| `UPLOAD_DIR` | Server filesystem path where uploaded PDFs are stored | `./uploads` |
| `DATABASE_PATH` | Path to the SQLite3 database file | `./data/puzzle.db` |

---

## Authentication

Entry to the application is protected by Google OAuth 2.0. On successful login, the authenticated user's email is checked against the `ALLOWED_EMAILS` list. If the email is not on the list, access is denied with an appropriate error message.

**One active session per user.** If the user logs in from a new device, all existing sessions for that account are marked `auth_invalidated = 1`. The new session is the only one accepted for API calls. Invalidated sessions remain visible in puzzle history — their grid state and puzzle data are intact and resumable. Resuming a historical session re-activates it and invalidates the currently active one.

### Session Table (SQLite3)

Each session is a row in the `sessions` table with the following fields:

| Field | Description |
|---|---|
| `session_id` | Unique session identifier |
| `user_email` | Google email address |
| `created_at` | Timestamp when the session was created |
| `last_accessed_at` | Timestamp of the last request in this session |
| `pdf_path` | Path on the server filesystem to the uploaded PDF |
| `parsed_puzzle` | JSON blob of the parsed puzzle data — `{rows, cols, grid, across, down}` |
| `grid_state` | JSON 2-D array (rows × cols) representing the partially filled grid — `null` for empty, uppercase letter for filled |
| `deleted` | `1` when the user explicitly deleted the session from the history list |
| `auth_invalidated` | `1` when the session was superseded by a new login from another device |

**`deleted` vs `auth_invalidated`**: `deleted` is a user-initiated action and hides the entry from the history list immediately. `auth_invalidated` is set server-side when the user logs in from a new device; the session can no longer be used for API calls but its puzzle data remains visible in history. This preserves puzzle history across multi-device logins.

A background cleanup job removes rows older than `SESSION_RETENTION_DAYS` days. Both `deleted` and `auth_invalidated` rows are subject to the same cleanup window.

---

## File Upload Page

The first screen the user sees after login. It contains two sections:

### Upload Section

The upload controls are stacked vertically in this order:
1. File picker (accepts PDF files only, 1 MB size limit)
2. Guidelines hint line with a link to the PDF format page
3. Upload button

On upload, the file is sent to the backend, saved to `UPLOAD_DIR` on the server filesystem, and the backend attempts to parse it (see Parse Routine below).
- **On parse failure**: display an appropriate error message and keep the user on this page.
- **On parse success**: a new session row is created with the file path and parsed data, the browser session cookie is updated to point to it, and the user is redirected to the Solve page.

### Previously Processed Puzzles Card

Displays up to 10 of the user's past puzzle sessions in reverse-chronological order (newest first). Each entry shows: puzzle dimensions, upload date/time, and solve progress as `answered/total clues` (a clue counts as answered only when every cell in its run is filled).

A **More** button below the list loads the next 10 sessions. The button is hidden when all sessions fit on the first page and only appears when there are more sessions to load.

Each entry has two actions:
- **Resume**: navigates to the Solve page, restoring the saved grid state for that session.
- **Delete**: sets `deleted = true` on the row. The entry disappears from the list immediately. The row is retained in the database until the retention window expires.

---

## Parse Routine

A Python function (`parse_puzzle`) that takes the path to an uploaded PDF and returns either a tuple `(grid_sz, grid, across, down)` on success or `None` on failure.

Uses `pdf2image` + OpenCV to detect the grid via Hough line transforms, and PyMuPDF (`fitz`) to extract clue text. Requires `poppler` as a system dependency.

### Outputs

| Output | Type | Description |
|---|---|---|
| `grid_sz` | `(int, int)` | `(rows, cols)` dimensions of the grid (may be non-square) |
| `grid` | `list[list[int]]` | `rows × cols` classification: `-1` = black, `0` = white, `>0` = white cell where that clue number starts |
| `across` | `dict` | Clues for across answers |
| `down` | `dict` | Clues for down answers |

### Clue Dictionary Format

Keys are clue numbers (integers). Values are 3-tuples:

```
(grid_location, clue_text, answer_length)
```

- `grid_location`: `(row, col)` tuple (0-indexed). `(0, 0)` is top-left.
- `clue_text`: string of English words.
- `answer_length`: positive integer ≥ 2. Number of consecutive grid cells the answer occupies.

For an Across clue, cells run left-to-right from `grid_location`. For a Down clue, cells run top-to-bottom. Clue numbers are unique within each dictionary but the same number may appear in both `Across` and `Down`.

**Example**: `across[16] = ((4, 5), "Clue Text", 6)` — a 6-letter across answer starting at row 4, column 5, occupying cells `(4,5)` through `(4,10)`.

### Grid Cell Classification

White cells (data-entry cells) are the union of all cells covered by any clue. All remaining cells are black.

---

## Solve Page

### Grid Rendering

The grid is rendered in black and white with a minimalist style.

- **Black cells**: not covered by any clue. Non-interactive.
- **White cells**: covered by at least one clue. Hold a single uppercase ASCII letter or are empty.
- **Clue number label**: cells that are the starting location of any clue display that clue number in the top-left corner (non-editable, small font).

### Cell Interaction

**Left-click** (desktop) / **tap** (mobile): if the clicked cell is covered by an across clue, highlight all cells of that across run in light grey/blue and display the across clue text below the grid. If no across clue covers this cell, do nothing.

**Right-click** (desktop): if the clicked cell is covered by a down clue, highlight all cells of that down run and display the down clue text below the grid.

**Second tap on the same cell** (mobile): toggles between the across and down clue covering that cell. First tap activates the across clue (if available); tapping the same cell again switches to the down clue; tapping again switches back to across. If only one direction covers the cell, repeated taps move the cursor within the run.

**Clicking / tapping a black cell**: do nothing.

**Landscape orientation** (mobile): if the device is in landscape orientation and is a mobile-sized screen, a full-screen message prompts the user to rotate to portrait. The solver UI is hidden until the device returns to portrait.

When a clue run is highlighted (active), a cursor indicates the current data-entry cell within the run.

**Before any clue is selected**, the clue text area below the grid is blank.

Switching to a different clue (by click, right-click, or Tab) clears any currently displayed suggestions.

### Keyboard Behaviour (when a clue is active)

| Key | Behaviour |
|---|---|
| Letter (A–Z, a–z) | Write the letter (uppercased) into the current cell, overwriting any existing entry. Advance cursor to the next cell in the run. If already at the last cell, the keystroke is accepted but the cursor stays on the last cell. |
| Arrow keys | Move cursor within the run in the appropriate direction. Moving in a direction not applicable to the active run (e.g., Up/Down in an Across clue) does nothing. Attempting to move past the start or end of the run does nothing. |
| Backspace | Clear the current cell. Move cursor to the previous cell in the run. If already at the first cell, clear and stay. |
| Tab | Advance to the next clue in a priority-sorted list. Only clues with **at least one unfilled cell** are eligible. Clues visited in the last 30 Tab navigations are skipped unless their answer has changed since they were last visited. Sort order: ① fewest unfilled cells (ascending) ② most filled cells (descending) ③ longest answer (descending) ④ random. The cursor is placed on the first cell of the selected clue. Wraps from last back to first. If all eligible clues are exhausted, Tab does nothing. |
| Shift+Tab | Move backwards through the same priority-sorted list. |

Data is not case-sensitive; all input is stored and displayed as uppercase. Rebus (multi-letter) entries are not supported — each cell holds exactly one letter.

---

## Solve Page — Action Buttons

Controls displayed below the clue text area: **Save**, **Suggest**, **Exit**, **Next** (mobile only), **Settings** (⚙), and **Keyboard** ⌨ (mobile only).

### Save

Downloads the current grid state as a plain text file. The filename format is `CWPuz_YYYYMMDD_HHMMSS.txt`.

The file begins with a two-line header followed by a separator:
```
Crossword Solver — {rows}×{cols}
{Month Day, Year}  {HH:MM:SS}
──────────────────
```
Then the grid: `█` for black cells, `·` for unfilled white cells, uppercase letter for filled white cells.

If the download fails, display an error message to the user.

### Suggest

Active only when a clue is selected. Greyed out otherwise.

Clicking Suggest calls the backend, which queries the Ollama model with three inputs:
1. The answer length for the active clue.
2. The clue text.
3. The current partial answer string: a sequence of uppercase letters and `-` characters (one `-` per unfilled cell) passed as the template to the model.

The backend fires 4 concurrent Ollama requests with slightly staggered temperatures (base + 0.1 × i) to produce diverse answers. Responses are deduplicated and filtered — results that are entirely unknown characters are discarded. Up to 4 unique valid answers are returned, each padded to exactly `answer_length` with `_` if the model returns a shorter string. If fewer than 4 usable answers are produced, the remaining slots are shown greyed out.

**Clicking a suggestion** places it into the grid at the active clue's starting location, overwriting all cells in the run. A `_` character in the suggestion clears the corresponding cell (removes any prior entry). Non-underscore characters overwrite the cell with that letter. The suggestion display is cleared after placement.

If the Ollama model fails to respond within **10 seconds**, display a non-blocking error notification. The user may continue solving without suggestions.

### Next (mobile only)

Advances to the next unfilled clue using the same priority sort as Tab, and scrolls the clue text into view. Equivalent to Tab on desktop. Only rendered on screens narrower than 600 px.

### Exit

Autosaves the current grid state to the database, then navigates to the File Upload page. No confirmation dialog is shown — the puzzle can always be resumed later from the Previously Processed Puzzles list.

### Settings (⚙)

A gear icon button at the end of the action bar. Clicking it opens a small dropdown menu with solver preferences:

- **Auto-suggest** (default: off): when enabled, switching to a new clue automatically triggers the Suggest flow. A checkmark is shown next to the option when it is active.
- **Auto-edit** (default: off, mobile only): when enabled, the soft keyboard opens automatically whenever a clue is selected. Only shown on screens narrower than 600 px.

### Keyboard ⌨ (mobile only)

Opens the soft keyboard for the currently active clue. If no clue is selected, a toast prompts the user to tap a clue first. Useful when Auto-edit is off and the user wants to type without re-tapping a cell. Only rendered on screens narrower than 600 px.

Input from the soft keyboard is routed through a hidden `<input>` element that receives focus. Letters are uppercased and written to the active cell; Backspace clears the current cell and retreats the cursor.

---

## Auto-Save

The Solve page automatically syncs the current grid state to the session record in the database every `AUTOSAVE_INTERVAL_SECONDS` seconds. A sync also occurs immediately when the user clicks Exit or navigates away (via the browser `beforeunload` event — no browser prompt is shown; the save is silent).

---

## Deployment

### Production architecture

```
Browser ──HTTPS──▶ Cloudflare edge (TLS termination, DDoS protection)
                        │
                   A record: crossword.notnoise.us → Hetzner CX22, Nuremberg
                        │ (HTTPS on port 443, Cloudflare origin cert)
                   nginx on Hetzner VM
                        │ (HTTP to 127.0.0.1:8000)
                   Docker container (uvicorn)
                        │ (OLLAMA_ENDPOINT + CF Access headers)
                   Cloudflare Tunnel ──▶ Ollama on developer's machine (GPU)
```

**Five components must be running** for the app to be fully functional:

| Component | Location | Kept alive by |
|---|---|---|
| Hetzner VM (nginx + Docker app) | Hetzner cloud | `restart: unless-stopped` + nginx systemd |
| Cloudflare | Cloudflare edge | Managed service |
| Google OAuth | Google Cloud | Managed service |
| Ollama | Developer's machine | `ollama` systemd service |
| cloudflared tunnel | Developer's machine | `cloudflared` systemd service |

If the developer's machine is off, suggestions are unavailable but the rest of the app (login, upload, solve, autosave) continues working.

**Ollama** runs on the developer's GPU machine and is exposed via a Cloudflare Tunnel (`ollama.notnoise.us`). The tunnel is protected by a Cloudflare Access service token (Service Auth policy); the app sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers with every Ollama request. The cloudflared config rewrites the `Host` header to `localhost` before forwarding to Ollama — required because Ollama's DNS rebinding protection rejects requests with non-localhost `Host` headers.

The app runs at the root of `crossword.notnoise.us` with no path prefix. Uvicorn is started with `--proxy-headers --forwarded-allow-ips *` so that OAuth redirect URIs are built as `https://` from the `X-Forwarded-Proto` header set by nginx. The wildcard is safe because port 8000 is bound to `127.0.0.1` on the host — only nginx can reach it. Note: `127.0.0.1` alone is insufficient because Docker proxies requests through the bridge gateway (`172.17.0.1`), not localhost.

Nginx listens on **port 443** with a Cloudflare origin certificate. Cloudflare SSL/TLS mode is set to **Full (strict)**, which means Cloudflare connects to the origin on port 443 and validates the certificate.

The Google OAuth app remains in **Testing** status in Google Cloud Console. All permitted users must be added as test users there in addition to appearing in `ALLOWED_EMAILS`. This is sufficient for a private allowlisted app — Google's app verification process is not required.

The Google OAuth authorized redirect URI is `https://crossword.notnoise.us/auth/callback`.

### Local development

Uvicorn is run directly on `localhost` without a proxy. The app is available at `http://127.0.0.1:<port>`. The Google OAuth authorized redirect URI for local development is `http://127.0.0.1:<port>/auth/callback`.

---

## Static Pages

- **`/help/pdf-format`**: placeholder HTML page explaining the expected PDF format. Content to be filled in later.
