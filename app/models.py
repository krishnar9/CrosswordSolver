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
    N: int | None = None   # None until a puzzle has been parsed for this session
    deleted: bool


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


class AutosaveRequest(BaseModel):
    grid_state: GridState


# ---------------------------------------------------------------------------
# Suggest
# ---------------------------------------------------------------------------

class SuggestRequest(BaseModel):
    clue_number: int
    direction: Literal["across", "down"]
    partial_answer: str   # uppercase letters + "_" for empty cells, e.g. "W__D"


class SuggestResponse(BaseModel):
    suggestions: list[str]   # up to 4 items, each padded/truncated to answer_length
