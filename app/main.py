import asyncio
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from app.config import settings
from app.database import init_db, run_cleanup_loop
from app.auth import router as auth_router
from app.ollama_client import client as ollama_client
from app.routes.upload import router as upload_router
from app.routes.solve import router as solve_router

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

    try:
        ollama_client.load_model()
        logger.info("Ollama model loaded: %s", settings.ollama_model)
    except RuntimeError as e:
        logger.warning("Ollama unavailable — suggestions disabled: %s", e)

    cleanup_task = asyncio.create_task(run_cleanup_loop())
    yield
    cleanup_task.cancel()


app = FastAPI(title="CrosswordSolver", lifespan=lifespan)

app.add_middleware(
    SessionMiddleware,
    secret_key=settings.secret_key or "dev-only-insecure-key",
    session_cookie="cw_session",
    max_age=86400 * settings.session_retention_days,
    https_only=False,
    same_site="lax",
)

app.include_router(auth_router)
app.include_router(upload_router)
app.include_router(solve_router)

# HTML page routes — JS handles auth redirects client-side
@app.get("/")
async def index_page():
    return FileResponse("static/index.html")

@app.get("/solve")
async def solve_page():
    return FileResponse("static/solve.html")

@app.get("/help/pdf-format")
async def pdf_format_page():
    return FileResponse("static/help/pdf-format.html")

app.mount("/static", StaticFiles(directory="static"), name="static")
