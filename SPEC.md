# Crossword Puzzle Solver — Application Specification

## Overview

A browser-based crossword puzzle solver. The user uploads a PDF of a crossword puzzle, the backend parses it, and the user fills in the grid interactively. Progress is periodically auto-saved. An LLM-backed suggestion feature helps with individual clues.

---

## Technical Stack

- **Frontend**: Static HTML/CSS/JavaScript
- **Backend**: Python, FastAPI, Uvicorn
- **Reverse proxy**: Nginx (serves static files, proxies API requests to FastAPI)
- **Database**: SQLite3 (single file, accessed by the backend)
- **LLM**: Locally-running Ollama instance hosting a fine-tuned Qwen model

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `ALLOWED_EMAILS` | Comma-separated list of Google email addresses permitted to log in | (required) |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | (required) |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | (required) |
| `SESSION_RETENTION_DAYS` | Number of days to retain session log data | `30` |
| `AUTOSAVE_INTERVAL_SECONDS` | How often (in seconds) the solve page auto-saves grid state | `120` |
| `OLLAMA_ENDPOINT` | Base URL of the Ollama API | `http://localhost:11434` |
| `OLLAMA_MODEL` | Name of the Ollama model to use for suggestions | (required) |
| `UPLOAD_DIR` | Server filesystem path where uploaded PDFs are stored | `./uploads` |
| `DATABASE_PATH` | Path to the SQLite3 database file | `./data/puzzle.db` |

---

## Authentication

Entry to the application is protected by Google OAuth 2.0. On successful login, the authenticated user's email is checked against the `ALLOWED_EMAILS` list. If the email is not on the list, access is denied with an appropriate error message.

**One session per user.** If the user logs in while another session for the same account is still active, the old session is invalidated silently server-side and the new session proceeds without warning.

### Session Table (SQLite3)

Each session is a row in the `sessions` table with the following fields:

| Field | Description |
|---|---|
| `session_id` | Unique session identifier |
| `user_email` | Google email address |
| `created_at` | Timestamp when the session was created |
| `last_accessed_at` | Timestamp of the last request in this session |
| `pdf_path` | Path on the server filesystem to the uploaded PDF |
| `parsed_puzzle` | JSON blob of the parsed puzzle data (N, Across, Down) |
| `grid_state` | JSON array representing the partially filled grid |
| `deleted` | Boolean soft-delete flag (see File Upload Page) |

A background cleanup job removes rows older than `SESSION_RETENTION_DAYS` days. Rows with `deleted = true` are subject to the same cleanup window — they are not kept permanently.

---

## File Upload Page

The first screen the user sees after login. It contains two sections:

### Upload Section

- A file picker that accepts PDF files only, with a 1 MB size limit.
- A link to a static HTML guidelines page explaining the expected PDF format (NYT-style printed crossword puzzle).
- On upload, the file is sent to the backend, saved to `UPLOAD_DIR` on the server filesystem, and the backend attempts to parse it (see Parse Routine below).
  - **On parse failure**: display an appropriate error message and keep the user on this page.
  - **On parse success**: store the file path and parsed data in the session record, then redirect the user to the Solve page.

### Previously Processed Puzzles Card

Displays up to 10 of the user's past puzzle sessions in reverse-chronological order (newest first). Each entry shows identifying information (e.g., upload date/time, puzzle dimensions). A "Load more" control fetches the next batch of 10.

Each entry has two actions:
- **Resume**: navigates to the Solve page, restoring the saved grid state for that session.
- **Delete**: sets `deleted = true` on the row. The entry disappears from the list immediately. The row is retained in the database until the retention window expires.

---

## Parse Routine

A Python function that takes the path to an uploaded PDF and returns either a tuple `(N, Across, Down)` on success or `None` on failure.

### Outputs

| Output | Type | Description |
|---|---|---|
| `N` | `int` | Side length of the (square) crossword grid |
| `Across` | `dict` | Clues for across answers |
| `Down` | `dict` | Clues for down answers |

### Clue Dictionary Format

Keys are clue numbers (integers). Values are 3-tuples:

```
(grid_location, clue_text, answer_length)
```

- `grid_location`: `(row, col)` tuple (0-indexed). `(0, 0)` is top-left, `(N-1, N-1)` is bottom-right.
- `clue_text`: string of English words.
- `answer_length`: positive integer ≥ 2. Number of consecutive grid cells the answer occupies.

For an Across clue, cells run left-to-right from `grid_location`. For a Down clue, cells run top-to-bottom. Clue numbers are unique within each dictionary but the same number may appear in both `Across` and `Down`.

**Example**: `Across[16] = ((4, 5), "Clue Text", 6)` — a 6-letter across answer starting at row 4, column 5, occupying cells `(4,5)` through `(4,10)`.

### Grid Cell Classification

White cells (data-entry cells) are the union of all cells covered by any clue. All remaining cells in the N×N grid are black.

---

## Solve Page

### Grid Rendering

The grid is rendered in black and white with a minimalist style.

- **Black cells**: not covered by any clue. Non-interactive.
- **White cells**: covered by at least one clue. Hold a single uppercase ASCII letter or are empty.
- **Clue number label**: cells that are the starting location of any clue display that clue number in the top-left corner (non-editable, small font).

### Cell Interaction

**Left-click** (desktop) / **tap** (mobile): if the clicked cell is covered by an across clue, highlight all cells of that across run in light grey/blue and display the across clue text below the grid. If no across clue covers this cell, do nothing.

**Right-click** (desktop) / **long-press** (mobile): if the clicked cell is covered by a down clue, highlight all cells of that down run and display the down clue text below the grid. If no down clue covers this cell, do nothing.

**Clicking a black cell**: do nothing.

When a clue run is highlighted (active), a cursor indicates the current data-entry cell within the run.

**Before any clue is selected**, the clue text area below the grid is blank.

### Keyboard Behaviour (when a clue is active)

| Key | Behaviour |
|---|---|
| Letter (A–Z, a–z) | Write the letter (uppercased) into the current cell, overwriting any existing entry. Advance cursor to the next cell in the run. If already at the last cell, the keystroke is accepted but the cursor stays on the last cell. |
| Arrow keys | Move cursor within the run in the appropriate direction. Moving in a direction not applicable to the active run (e.g., Up/Down in an Across clue) does nothing. Attempting to move past the start or end of the run does nothing. |
| Backspace | Clear the current cell. Move cursor to the previous cell in the run. If already at the first cell, clear and stay. |
| Tab | Advance to the clue with the next higher number in the same group (Across or Down). Wraps from the last clue back to the first. |
| Shift+Tab | Move to the clue with the next lower number in the same group. Wraps from the first clue back to the last. |

Data is not case-sensitive; all input is stored and displayed as uppercase. Rebus (multi-letter) entries are not supported — each cell holds exactly one letter.

---

## Solve Page — Action Buttons

Three buttons are displayed below the clue text area: **Save**, **Suggest**, **Finish**.

### Save

Downloads the current grid state as a plain text file with a minimalist ASCII representation of the grid. The filename format is `CWPuz_YYYYMMDD_HHMMSS.txt`.

If the download fails, display an error message to the user.

If the user attempts to refresh or navigate away from the Solve page (browser `beforeunload`), prompt: "Would you like to save your progress before leaving?" with Save and Discard options.

### Suggest

Active only when a clue is selected. Greyed out otherwise.

Clicking Suggest calls the backend, which queries the Ollama model with three inputs:
1. The answer length for the active clue.
2. The clue text.
3. The current partial answer string: a sequence of uppercase letters and `_` characters (one `_` per unfilled cell), e.g., `W__D` for a 4-letter answer with only the first and last letters filled.

The backend returns up to 4 suggested answers, each padded or truncated server-side to exactly match the answer length. Padding uses blank/unfilled slots (represented as `_`). The 4 slots are arranged in a 2×2 grid below the buttons. If the LLM returns fewer than 4 usable answers, the unfilled slots are shown greyed out.

**Clicking a suggestion** places it into the grid at the active clue's starting location, overwriting all cells in the run. A `_` character in the suggestion clears the corresponding cell (removes any prior entry). Non-underscore characters overwrite the cell with that letter. The suggestion display is cleared after placement.

If the Ollama model fails to respond within **10 seconds**, display a non-blocking error notification. The user may continue solving without suggestions.

### Finish

Prompts the user with three options:
- **Save and exit**: downloads the save file, then navigates to the File Upload page.
- **Exit without saving**: navigates to the File Upload page immediately.
- **Cancel**: dismisses the dialog and returns to the Solve page.

Navigating back to the File Upload page clears all current session puzzle state.

---

## Auto-Save

The Solve page automatically syncs the current grid state to the session record in the database every `AUTOSAVE_INTERVAL_SECONDS` seconds. A sync also occurs immediately when the user initiates a Save, triggers a Finish, or navigates away.

---

## Static Pages

- **`/help/pdf-format`**: placeholder HTML page explaining the expected PDF format. Content to be filled in later.
