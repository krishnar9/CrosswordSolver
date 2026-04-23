import json
import os
import uuid
from datetime import datetime, timezone

import aiosqlite
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile

from app.auth import get_current_user
from app.config import settings
from app.database import get_db
from app.models import SessionListResponse, SessionSummary, UploadResponse
from app.services.parser import parse_puzzle

router = APIRouter(tags=["upload"])

MAX_PDF_BYTES = 1 * 1024 * 1024  # 1 MB


@router.post("/upload", response_model=UploadResponse)
async def upload_pdf(
    request: Request,
    file: UploadFile = File(...),
    user_email: str = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    if file.content_type not in ("application/pdf", "application/octet-stream"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    data = await file.read()
    if len(data) > MAX_PDF_BYTES:
        raise HTTPException(status_code=400, detail="File exceeds the 1 MB limit")

    # Persist the upload
    filename = f"{uuid.uuid4()}.pdf"
    file_path = os.path.join(settings.upload_dir, filename)
    with open(file_path, "wb") as fh:
        fh.write(data)

    # Parse
    result = parse_puzzle(file_path)
    if result is None:
        os.remove(file_path)
        raise HTTPException(
            status_code=422,
            detail="Could not parse a crossword puzzle from this PDF. "
                   "Please check the guidelines for the expected format.",
        )

    grid_sz, grid, across, down = result
    rows, cols = grid_sz

    puzzle_blob = json.dumps({
        "rows": rows,
        "cols": cols,
        "grid": grid,
        # Keys are str in JSON; values stay as lists (tuples serialise identically)
        "across": {str(k): v for k, v in across.items()},
        "down":   {str(k): v for k, v in down.items()},
    })

    # Empty grid state: None = unfilled white cell (black cells handled client-side)
    grid_state = json.dumps([[None] * cols for _ in range(rows)])

    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    await db.execute(
        """
        INSERT INTO sessions
            (session_id, user_email, created_at, last_accessed_at,
             pdf_path, parsed_puzzle, grid_state)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (session_id, user_email, now, now, file_path, puzzle_blob, grid_state),
    )
    await db.commit()

    # Point the browser session at the new puzzle session
    request.session["session_id"] = session_id

    return UploadResponse(session_id=session_id, rows=rows, cols=cols)


@router.get("/sessions", response_model=SessionListResponse)
async def list_sessions(
    user_email: str = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
    offset: int = Query(0, ge=0),
    limit: int = Query(10, ge=1, le=50),
):
    """Return the user's past puzzle sessions, newest first."""
    count_cur = await db.execute(
        "SELECT COUNT(*) FROM sessions WHERE user_email = ? AND deleted = 0 AND parsed_puzzle IS NOT NULL",
        (user_email,),
    )
    total = (await count_cur.fetchone())[0]

    cur = await db.execute(
        """
        SELECT session_id, created_at, last_accessed_at, parsed_puzzle
        FROM sessions
        WHERE user_email = ? AND deleted = 0 AND parsed_puzzle IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
        """,
        (user_email, limit, offset),
    )
    rows = await cur.fetchall()

    sessions = []
    for row in rows:
        puzzle = json.loads(row["parsed_puzzle"])
        sessions.append(SessionSummary(
            session_id=row["session_id"],
            created_at=row["created_at"],
            last_accessed_at=row["last_accessed_at"],
            N=puzzle.get("rows"),
            deleted=False,
        ))

    return SessionListResponse(sessions=sessions, total=total)


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(
    session_id: str,
    user_email: str = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Soft-delete a puzzle session."""
    cur = await db.execute(
        "SELECT session_id FROM sessions WHERE session_id = ? AND user_email = ? AND deleted = 0",
        (session_id, user_email),
    )
    if not await cur.fetchone():
        raise HTTPException(status_code=404, detail="Session not found")

    await db.execute(
        "UPDATE sessions SET deleted = 1 WHERE session_id = ?",
        (session_id,),
    )
    await db.commit()


@router.post("/sessions/{session_id}/resume", status_code=200)
async def resume_session(
    session_id: str,
    request: Request,
    user_email: str = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    """Switch the active session cookie to a previously saved puzzle."""
    cur = await db.execute(
        "SELECT session_id FROM sessions WHERE session_id = ? AND user_email = ? AND deleted = 0",
        (session_id, user_email),
    )
    if not await cur.fetchone():
        raise HTTPException(status_code=404, detail="Session not found")

    request.session["session_id"] = session_id
    return {"session_id": session_id}
