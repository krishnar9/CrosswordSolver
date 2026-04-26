import json
import os
import re
import uuid
from datetime import datetime, timezone

import aiosqlite
import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile

from app.auth import get_current_user
from app.config import settings
from app.database import get_db
from app.models import FetchNYTRequest, SessionListResponse, SessionSummary, UploadResponse
from app.services.parser import parse_puzzle

router = APIRouter(tags=["upload"])

MAX_PDF_BYTES = 1 * 1024 * 1024  # 1 MB


def _compute_progress(puzzle: dict, grid_state: list) -> tuple[int, int]:
    """Return (answered_clues, total_clues). A clue is answered when every cell is filled."""
    total = len(puzzle.get("across", {})) + len(puzzle.get("down", {}))
    answered = 0
    for clue_val in puzzle.get("across", {}).values():
        r, c, length = clue_val[0][0], clue_val[0][1], clue_val[2]
        if all(grid_state[r][c + i] is not None for i in range(length)):
            answered += 1
    for clue_val in puzzle.get("down", {}).values():
        r, c, length = clue_val[0][0], clue_val[0][1], clue_val[2]
        if all(grid_state[r + i][c] is not None for i in range(length)):
            answered += 1
    return answered, total


async def _process_pdf_bytes(
    data: bytes,
    file_path: str,
    user_email: str,
    request: Request,
    db: aiosqlite.Connection,
    puzzle_date: str | None = None,
) -> UploadResponse:
    """Save PDF bytes, parse, create session. Cleans up file on parse failure."""
    with open(file_path, "wb") as fh:
        fh.write(data)

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
        "across": {str(k): v for k, v in across.items()},
        "down":   {str(k): v for k, v in down.items()},
    })

    grid_state = json.dumps([[None] * cols for _ in range(rows)])

    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()

    await db.execute(
        """
        INSERT INTO sessions
            (session_id, user_email, created_at, last_accessed_at,
             pdf_path, parsed_puzzle, grid_state, puzzle_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (session_id, user_email, now, now, file_path, puzzle_blob, grid_state, puzzle_date),
    )
    await db.commit()

    request.session["session_id"] = session_id
    return UploadResponse(session_id=session_id, rows=rows, cols=cols)


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

    filename = f"{uuid.uuid4()}.pdf"
    file_path = os.path.join(settings.upload_dir, filename)
    return await _process_pdf_bytes(data, file_path, user_email, request, db)


_NYT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, */*",
}


@router.post("/fetch-nyt", response_model=UploadResponse)
async def fetch_nyt(
    body: FetchNYTRequest,
    request: Request,
    user_email: str = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    date_str = body.date
    if date_str is not None:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_str):
            raise HTTPException(status_code=400, detail="Date must be in YYYY-MM-DD format.")
        meta_url = "https://www.nytimes.com/svc/crosswords/v6/puzzle/daily/{}.json".format(
            date_str
        )
    else:
        meta_url = "https://www.nytimes.com/svc/crosswords/v6/puzzle/daily.json"

    headers = {**_NYT_HEADERS, "Cookie": f"NYT-S={body.nyt_cookie}"}

    async with httpx.AsyncClient() as client:
        try:
            meta_resp = await client.get(
                meta_url, headers=headers, follow_redirects=True, timeout=15.0
            )
        except httpx.RequestError:
            raise HTTPException(status_code=502, detail="Could not reach NYT.")

        if meta_resp.status_code in (401, 403):
            raise HTTPException(status_code=401, detail="NYT cookie is invalid or expired.")
        if meta_resp.status_code == 404:
            raise HTTPException(status_code=404, detail="No puzzle found for that date.")
        if not meta_resp.is_success:
            raise HTTPException(status_code=502, detail="Failed to fetch puzzle info from NYT.")

        try:
            meta = meta_resp.json()
        except Exception:
            raise HTTPException(status_code=502, detail="Unexpected response from NYT.")

        if not meta.get("body"):
            raise HTTPException(status_code=404, detail="No puzzle found for that date.")

        puzzle_id = meta.get("id")
        if not puzzle_id:
            raise HTTPException(status_code=502, detail="Could not determine puzzle ID from NYT response.")

        pdf_url = f"https://www.nytimes.com/svc/crosswords/v2/puzzle/{puzzle_id}.pdf"
        try:
            pdf_resp = await client.get(
                pdf_url, headers=headers, follow_redirects=True, timeout=30.0
            )
        except httpx.RequestError:
            raise HTTPException(status_code=502, detail="Could not download PDF from NYT.")

        if not pdf_resp.is_success:
            raise HTTPException(status_code=502, detail="Failed to download PDF from NYT.")

        data = pdf_resp.content
        puzzle_date = meta.get("publicationDate")

    if len(data) > MAX_PDF_BYTES:
        raise HTTPException(status_code=400, detail="PDF from NYT exceeds the 1 MB limit.")

    filename = f"{uuid.uuid4()}.pdf"
    file_path = os.path.join(settings.upload_dir, filename)
    return await _process_pdf_bytes(data, file_path, user_email, request, db, puzzle_date=puzzle_date)


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
    session_count = (await count_cur.fetchone())[0]

    cur = await db.execute(
        """
        SELECT session_id, created_at, last_accessed_at, parsed_puzzle, grid_state,
               puzzle_date, title, elapsed_seconds
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
        grid_state = json.loads(row["grid_state"]) if row["grid_state"] else []
        answered, total_clues = _compute_progress(puzzle, grid_state)
        sessions.append(SessionSummary(
            session_id=row["session_id"],
            created_at=row["created_at"],
            last_accessed_at=row["last_accessed_at"],
            N=puzzle.get("rows"),
            deleted=False,
            answered_clues=answered,
            total_clues=total_clues,
            puzzle_date=row["puzzle_date"],
            title=row["title"],
            elapsed_seconds=row["elapsed_seconds"] or 0,
        ))

    return SessionListResponse(sessions=sessions, total=session_count)


@router.patch("/sessions/{session_id}/title", status_code=204)
async def update_session_title(
    session_id: str,
    body: dict,
    user_email: str = Depends(get_current_user),
    db: aiosqlite.Connection = Depends(get_db),
):
    title = body.get("title", "").strip() or None
    await db.execute(
        "UPDATE sessions SET title = ? WHERE session_id = ? AND user_email = ? AND deleted = 0",
        (title, session_id, user_email),
    )
    await db.commit()


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

    # Invalidate all other sessions, then re-activate this one.
    await db.execute(
        "UPDATE sessions SET auth_invalidated = 1 WHERE user_email = ? AND deleted = 0 AND auth_invalidated = 0",
        (user_email,),
    )
    await db.execute(
        "UPDATE sessions SET auth_invalidated = 0 WHERE session_id = ?",
        (session_id,),
    )
    await db.commit()

    request.session["session_id"] = session_id
    return {"session_id": session_id}
