import json
from datetime import datetime, timezone

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, Request

from app.auth import get_current_user
from app.config import settings
from app.database import get_db
from app.models import AutosaveRequest, PuzzleResponse, SuggestRequest, SuggestResponse
from app.ollama_client import client as ollama_client

router = APIRouter(tags=["solve"])


@router.get("/puzzle", response_model=PuzzleResponse)
async def get_puzzle(
    request: Request,
    user_email: str = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    session_id = request.session.get("session_id")
    cur = await db.execute(
        "SELECT session_id, parsed_puzzle, grid_state, elapsed_seconds, puzzle_date FROM sessions WHERE session_id = ? AND deleted = 0",
        (session_id,),
    )
    row = await cur.fetchone()

    if not row or not row["parsed_puzzle"]:
        raise HTTPException(status_code=404, detail="No puzzle loaded for this session")

    puzzle = json.loads(row["parsed_puzzle"])
    rows, cols = puzzle["rows"], puzzle["cols"]
    grid_state = (
        json.loads(row["grid_state"])
        if row["grid_state"]
        else [[None] * cols for _ in range(rows)]
    )

    return PuzzleResponse(
        session_id=row["session_id"],
        rows=rows,
        cols=cols,
        grid=puzzle["grid"],
        across=puzzle["across"],
        down=puzzle["down"],
        grid_state=grid_state,
        autosave_interval=settings.autosave_interval_seconds,
        elapsed_seconds=row["elapsed_seconds"] or 0,
        puzzle_date=row["puzzle_date"],
    )


@router.post("/puzzle/autosave", status_code=204)
async def autosave(
    request: Request,
    body: AutosaveRequest,
    user_email: str = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    session_id = request.session.get("session_id")
    now = datetime.now(timezone.utc).isoformat()
    if body.elapsed_seconds is not None:
        await db.execute(
            "UPDATE sessions SET grid_state = ?, elapsed_seconds = ?, last_accessed_at = ? WHERE session_id = ?",
            (json.dumps(body.grid_state), body.elapsed_seconds, now, session_id),
        )
    else:
        await db.execute(
            "UPDATE sessions SET grid_state = ?, last_accessed_at = ? WHERE session_id = ?",
            (json.dumps(body.grid_state), now, session_id),
        )
    await db.commit()


@router.post("/puzzle/suggest", response_model=SuggestResponse)
async def suggest(
    request: Request,
    body: SuggestRequest,
    user_email: str = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    session_id = request.session.get("session_id")
    cur = await db.execute(
        "SELECT parsed_puzzle FROM sessions WHERE session_id = ? AND deleted = 0",
        (session_id,),
    )
    row = await cur.fetchone()
    if not row or not row["parsed_puzzle"]:
        raise HTTPException(status_code=404, detail="No puzzle loaded for this session")

    puzzle = json.loads(row["parsed_puzzle"])
    clue_entry = puzzle.get(body.direction, {}).get(str(body.clue_number))
    if not clue_entry:
        raise HTTPException(status_code=422, detail="Clue not found in puzzle")

    _, clue_text, answer_length = clue_entry
    template = body.partial_answer.replace("_", "-")

    suggestions = await ollama_client.predict(clue_text, template, answer_length)
    return SuggestResponse(suggestions=suggestions)
