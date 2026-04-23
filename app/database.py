import asyncio
import os
from datetime import datetime, timedelta, timezone
from typing import AsyncGenerator

import aiosqlite

from app.config import settings

CREATE_SESSIONS_TABLE = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id       TEXT PRIMARY KEY,
    user_email       TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL,
    pdf_path         TEXT,
    parsed_puzzle    TEXT,
    grid_state       TEXT,
    deleted          INTEGER NOT NULL DEFAULT 0
)
"""


async def init_db() -> None:
    os.makedirs(os.path.dirname(settings.database_path), exist_ok=True)
    async with aiosqlite.connect(settings.database_path) as db:
        await db.execute(CREATE_SESSIONS_TABLE)
        await db.commit()


async def get_db() -> AsyncGenerator[aiosqlite.Connection, None]:
    """FastAPI dependency — yields one connection per request."""
    async with aiosqlite.connect(settings.database_path) as db:
        db.row_factory = aiosqlite.Row
        yield db


async def _delete_expired_sessions() -> None:
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=settings.session_retention_days)
    ).isoformat()
    async with aiosqlite.connect(settings.database_path) as db:
        await db.execute("DELETE FROM sessions WHERE created_at < ?", (cutoff,))
        await db.commit()


async def run_cleanup_loop() -> None:
    """Background task: purge sessions older than SESSION_RETENTION_DAYS, hourly."""
    while True:
        await _delete_expired_sessions()
        await asyncio.sleep(3600)
