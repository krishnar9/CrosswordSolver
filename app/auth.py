import uuid
from datetime import datetime, timezone

import aiosqlite
from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse

from app.config import settings
from app.database import get_db

router = APIRouter(prefix="/auth", tags=["auth"])

oauth = OAuth()
oauth.register(
    name="google",
    client_id=settings.google_client_id,
    client_secret=settings.google_client_secret,
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)


# ---------------------------------------------------------------------------
# Dependency
# ---------------------------------------------------------------------------

async def get_current_user(
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
) -> str:
    """Resolve the authenticated user email for the current request.

    Raises 401 if the session cookie is missing or the session has expired /
    been invalidated. Updates last_accessed_at on every valid request.
    """
    session_id = request.session.get("session_id")
    if not session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    cursor = await db.execute(
        "SELECT user_email FROM sessions WHERE session_id = ? AND deleted = 0",
        (session_id,),
    )
    row = await cursor.fetchone()
    if not row:
        raise HTTPException(status_code=401, detail="Session expired or invalid")

    now = datetime.now(timezone.utc).isoformat()
    await db.execute(
        "UPDATE sessions SET last_accessed_at = ? WHERE session_id = ?",
        (now, session_id),
    )
    await db.commit()

    return row["user_email"]


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/login")
async def login(request: Request):
    """Redirect the browser to Google's OAuth consent screen."""
    redirect_uri = request.url_for("auth_callback")
    return await oauth.google.authorize_redirect(request, redirect_uri)


@router.get("/callback", name="auth_callback")
async def auth_callback(
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Handle the OAuth callback from Google."""
    try:
        token = await oauth.google.authorize_access_token(request)
    except OAuthError as exc:
        raise HTTPException(status_code=400, detail=f"OAuth error: {exc.error}")

    user_info = token.get("userinfo")
    if not user_info:
        raise HTTPException(status_code=400, detail="Failed to retrieve user info from Google")

    email = user_info.get("email", "").lower()
    allowed = [e.lower() for e in settings.allowed_emails]
    if email not in allowed:
        raise HTTPException(status_code=403, detail="Access denied: email not authorised")

    # One session per user — silently invalidate any existing active session.
    await db.execute(
        "UPDATE sessions SET deleted = 1 WHERE user_email = ? AND deleted = 0",
        (email,),
    )

    session_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    await db.execute(
        """
        INSERT INTO sessions (session_id, user_email, created_at, last_accessed_at)
        VALUES (?, ?, ?, ?)
        """,
        (session_id, email, now, now),
    )
    await db.commit()

    request.session["session_id"] = session_id
    return RedirectResponse(url=request.scope.get("root_path", "") + "/")


@router.get("/logout")
async def logout(
    request: Request,
    db: aiosqlite.Connection = Depends(get_db),
):
    """Invalidate the current session and clear the browser cookie."""
    session_id = request.session.get("session_id")
    if session_id:
        await db.execute(
            "UPDATE sessions SET deleted = 1 WHERE session_id = ?",
            (session_id,),
        )
        await db.commit()
    request.session.clear()
    return RedirectResponse(url=request.scope.get("root_path", "") + "/auth/login")


@router.get("/me")
async def me(user_email: str = Depends(get_current_user)):
    """Return the currently authenticated user's email. Useful for testing."""
    return {"email": user_email}
