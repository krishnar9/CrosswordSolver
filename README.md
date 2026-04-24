# CrosswordSolver

A browser-based crossword puzzle solver. Upload a PDF of a crossword puzzle, fill in the grid interactively, and get LLM-backed suggestions for individual clues.

See [SPEC.md](SPEC.md) for the full application specification.

---

## Prerequisites

- [Miniconda or Anaconda](https://docs.anaconda.com/miniconda/)
- Python 3.11 (managed via conda)
- [Ollama](https://ollama.com/) running locally with your fine-tuned model registered
- **poppler** system package (required by `pdf2image` for PDF rendering)
- Nginx (for LAN deployment)

Install poppler:
```bash
# Arch / Manjaro
sudo pacman -S poppler

# Ubuntu / Debian
sudo apt install poppler-utils
```

---

## Installation

### 1. Create the conda environment

```bash
conda create -n crossword python=3.11 -y
conda activate crossword
```

### 2. Install Python dependencies

```bash
pip install -r requirements.txt
```

| Package | Purpose |
|---|---|
| `fastapi` + `uvicorn[standard]` | Web framework and ASGI server |
| `python-multipart` | PDF file upload support |
| `python-dotenv` | Load environment variables from `.env` |
| `aiosqlite` | Async SQLite3 access |
| `authlib` + `httpx` + `itsdangerous` | Google OAuth 2.0 and session signing |
| `ollama` | Python client for the local Ollama instance |
| `pymupdf` | Extract clue text from PDF (`fitz`) |
| `pdf2image` | Render PDF pages to images (requires poppler) |
| `opencv-python` | Grid detection via Hough line transforms |
| `pillow` + `numpy` | Image handling and array operations |

### 3. Register the Ollama model

The fine-tuned model must be registered in the local Ollama registry before the app starts. Run this once from the directory containing your `Modelfile`:

```bash
ollama create <your-model-name> -f Modelfile
```

Verify it appears in the registry:
```bash
ollama list
```

### 4. Configure environment variables

Create a `.env` file at the project root:

```env
# Required
ALLOWED_EMAILS=you@gmail.com,other@gmail.com
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
SECRET_KEY=a-long-random-secret-string
OLLAMA_MODEL=your-model-name

# Optional — Ollama tuning (defaults shown)
OLLAMA_ENDPOINT=http://localhost:11434
OLLAMA_TEMPERATURE=0.3
OLLAMA_NUM_PREDICT=12
OLLAMA_TOP_K=40
OLLAMA_TOP_P=0.95
OLLAMA_REPEAT_PENALTY=1.1

# Optional — application (defaults shown)
SESSION_RETENTION_DAYS=30
AUTOSAVE_INTERVAL_SECONDS=120
UPLOAD_DIR=./uploads
DATABASE_PATH=./data/puzzle.db
```

### 5. Configure Google OAuth

1. Open [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials**.
2. Create an **OAuth 2.0 Client ID** for a *Web Application*.
3. Under **Authorized redirect URIs** add:
   - `http://127.0.0.1:<port>/auth/callback` — for local development
   - `https://<your-lan-host>/crossword/auth/callback` — for LAN deployment (requires HTTPS; see Deployment below)
4. Copy the client ID and secret into `.env`.

---

## Running Locally (development)

```bash
conda activate crossword
uvicorn app.main:app --reload --port 8002
```

The app is available at `http://127.0.0.1:8002`. No `--root-path` flag is needed for local access — the frontend auto-detects the base path from the URL.

---

## LAN Deployment via Nginx

The app is served under the `/crossword/` path prefix on port 80 (alongside other apps on the same Nginx server).

### 1. Generate a self-signed TLS certificate

Google OAuth requires HTTPS for non-localhost redirect URIs.

```bash
sudo openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout /etc/ssl/private/krishna-local.key \
  -out /etc/ssl/certs/krishna-local.crt \
  -subj "/CN=krishna.local" \
  -addext "subjectAltName=IP:192.168.1.2,DNS:krishna.local"
```

### 2. Deploy the Nginx config

The [nginx/crossword.conf](nginx/crossword.conf) file contains the full server block (both `/crossplay/` and `/crossword/` locations). Copy it over the existing config:

```bash
sudo cp nginx/crossword.conf /etc/nginx/sites-available/puzzle.conf
sudo nginx -t && sudo systemctl reload nginx
```

### 3. Allow HTTPS through the firewall

```bash
sudo ufw allow from 192.168.1.0/24 to any port 443
```

### 4. Start Uvicorn

Bind to localhost only and pass `--root-path` so OAuth redirect URIs are built correctly:

```bash
conda activate crossword
uvicorn app.main:app --host 127.0.0.1 --port 8001 --root-path /crossword
```

The app is available at `https://192.168.1.2/crossword/` (or `https://krishna.local/crossword/`).

> **First visit**: browsers will show a certificate warning for the self-signed cert. Click through once, or install `krishna-local.crt` as a trusted CA on each device.

---

## Project Structure

```
app/
  main.py           — FastAPI app, lifespan, middleware
  auth.py           — Google OAuth routes and session dependency
  config.py         — Environment variable settings
  database.py       — SQLite3 init and cleanup loop
  ollama_client.py  — Async Ollama suggestion client
  models.py         — Pydantic request/response models
  routes/
    upload.py       — PDF upload, session list, resume, delete
    solve.py        — Puzzle fetch, autosave, suggest
  services/
    parser.py       — PDF → grid + clues parse routine
nginx/
  crossword.conf    — Full Nginx server config (both apps)
static/
  index.html        — Upload / session list page
  solve.html        — Interactive solver page
  css/style.css
  js/upload.js
  js/solve.js
  help/pdf-format.html
```
