from datetime import datetime
from typing import Literal
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Puzzle types
# ---------------------------------------------------------------------------

# A clue value as stored/returned: ((row, col), clue_text, answer_length)
# JSON serialises tuples as arrays, so we use list throughout.
GridLocation = tuple[int, int]
ClueValue = tuple[GridLocation, str, int]

# Clue dicts use string keys because JSON object keys are always strings.
ClueDict = dict[str, ClueValue]


class ParsedPuzzle(BaseModel):
    rows: int
    cols: int
    grid: list[list[int]]   # -1=black, 0=white, >0=clue-number start
    across: ClueDict
    down: ClueDict


# ---------------------------------------------------------------------------
# Session types
# ---------------------------------------------------------------------------

class SessionSummary(BaseModel):
    session_id: str
    created_at: datetime
    last_accessed_at: datetime
    N: int | None = None
    deleted: bool
    answered_clues: int = 0
    total_clues: int = 0
    puzzle_date: str | None = None
    title: str | None = None
    elapsed_seconds: int = 0


class SessionListResponse(BaseModel):
    sessions: list[SessionSummary]
    total: int


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------

class UploadResponse(BaseModel):
    session_id: str
    rows: int
    cols: int


# ---------------------------------------------------------------------------
# Solve / grid state
# ---------------------------------------------------------------------------

# Each cell is an uppercase letter, or None for an empty white cell.
# Black cells are not stored — they are derived from the clue data.
GridState = list[list[str | None]]


class PuzzleResponse(BaseModel):
    session_id: str
    rows: int
    cols: int
    grid: list[list[int]]
    across: ClueDict
    down: ClueDict
    grid_state: GridState
    autosave_interval: int
    elapsed_seconds: int = 0
    puzzle_date: str | None = None


class AutosaveRequest(BaseModel):
    grid_state: GridState
    elapsed_seconds: int | None = None


# ---------------------------------------------------------------------------
# Suggest
# ---------------------------------------------------------------------------

class SuggestRequest(BaseModel):
    clue_number: int
    direction: Literal["across", "down"]
    partial_answer: str   # uppercase letters + "_" for empty cells, e.g. "W__D"


class SuggestResponse(BaseModel):
    suggestions: list[str]   # up to 4 items, each padded/truncated to answer_length


# ---------------------------------------------------------------------------
# NYT fetch
# ---------------------------------------------------------------------------

class FetchNYTRequest(BaseModel):
    nyt_cookie: str
    date: str | None = None  # "YYYY-MM-DD", defaults to today if omitted
