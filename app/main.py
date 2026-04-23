import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app.config import settings
from app.database import init_db, run_cleanup_loop
from app.auth import router as auth_router
from app.routes.upload import router as upload_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    missing = settings.validate()
    if missing:
        logger.warning("Missing required env vars: %s", ", ".join(missing))

    os.makedirs(settings.upload_dir, exist_ok=True)
    await init_db()
    logger.info("Database initialised at %s", settings.database_path)

    cleanup_task = asyncio.create_task(run_cleanup_loop())
    yield
    cleanup_task.cancel()


app = FastAPI(title="CrosswordSolver", lifespan=lifespan)

app.add_middleware(
    SessionMiddleware,
    secret_key=settings.secret_key or "dev-only-insecure-key",
    session_cookie="cw_session",
    max_age=86400 * settings.session_retention_days,
    https_only=False,   # set True behind Nginx with TLS
    same_site="lax",
)

app.include_router(auth_router)
app.include_router(upload_router)

app.mount("/static", StaticFiles(directory="static"), name="static")
