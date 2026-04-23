# CrosswordSolver

A browser-based crossword puzzle solver. Upload a PDF of a crossword puzzle, fill in the grid interactively, and get LLM-backed suggestions for individual clues.

See [SPEC.md](SPEC.md) for the full application specification.

---

## Environment Setup

### Prerequisites

- [Miniconda or Anaconda](https://docs.anaconda.com/miniconda/) installed
- Python 3.11 (managed via conda)
- [Ollama](https://ollama.com/) running locally with your chosen model

### 1. Create the conda environment

```bash
conda create -n crossword python=3.11 -y
conda activate crossword
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

This installs:

| Package | Purpose |
|---|---|
| `fastapi` + `uvicorn[standard]` | Web framework and ASGI server |
| `python-multipart` | PDF file upload support for FastAPI |
| `python-dotenv` | Loading environment variables from `.env` |
| `aiosqlite` | Async access to the SQLite3 session database |
| `authlib` + `httpx` + `itsdangerous` | Google OAuth 2.0 and session signing |
| `pdfplumber` + `pypdf` | PDF parsing and layout extraction |
| `pillow` + `numpy` | Image and grid analysis for crossword detection |

`httpx` also serves as the HTTP client for Ollama API calls.

### 3. Configure environment variables

Copy the example below into a `.env` file at the project root and fill in the required values:

```env
ALLOWED_EMAILS=you@gmail.com,other@gmail.com
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
OLLAMA_MODEL=your-model-name

# Optional overrides (defaults shown)
SESSION_RETENTION_DAYS=30
AUTOSAVE_INTERVAL_SECONDS=120
OLLAMA_ENDPOINT=http://localhost:11434
UPLOAD_DIR=./uploads
DATABASE_PATH=./data/puzzle.db
```

Google OAuth credentials are obtained from the [Google Cloud Console](https://console.cloud.google.com/) by creating an OAuth 2.0 Client ID for a Web Application.

### 4. Verify the setup

```bash
conda activate crossword
python -c "import fastapi, uvicorn, aiosqlite, authlib, pdfplumber, httpx; print('All dependencies OK')"
```

---

## Running the App

```bash
conda activate crossword
uvicorn app.main:app --reload
```

The API will be available at `http://localhost:8000`. In production, Nginx sits in front and serves the static frontend while proxying API requests to Uvicorn.
