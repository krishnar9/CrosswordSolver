# CrosswordSolver

A browser-based crossword puzzle solver. Upload a PDF of a crossword puzzle, fill in the grid interactively, and get LLM-backed suggestions for individual clues.

See [SPEC.md](SPEC.md) for the full application specification.

---

## Local Development

### Prerequisites

- Python 3.11 (via conda or any environment manager)
- [Ollama](https://ollama.com/) running locally with your fine-tuned model registered
- **poppler** system package (required by `pdf2image`)

```bash
# Arch / Manjaro
sudo pacman -S poppler

# Ubuntu / Debian
sudo apt install poppler-utils
```

### Setup

```bash
conda create -n crossword python=3.11 -y
conda activate crossword
pip install -r requirements.txt
```

Register the fine-tuned model in Ollama (once):

```bash
ollama create <your-model-name> -f Modelfile
ollama list   # verify it appears
```

Create `.env` at the project root:

```env
ALLOWED_EMAILS=you@gmail.com
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
SECRET_KEY=a-long-random-secret-string
OLLAMA_MODEL=your-model-name
```

In Google Cloud Console → **APIs & Services → Credentials**, add
`http://127.0.0.1:8002/auth/callback` as an authorized redirect URI.

### Run

```bash
conda activate crossword
uvicorn app.main:app --reload --port 8002
```

App is available at `http://127.0.0.1:8002`.

---

## Production Deployment

### Architecture overview

```
Browser ──HTTPS──▶ Cloudflare edge
                        │ (proxied A record: crossword.notnoise.us → Hetzner VM IP)
                   nginx on Hetzner VM (port 80, Cloudflare origin cert)
                        │
                   Docker container (uvicorn on 127.0.0.1:8000)
                        │ (OLLAMA_ENDPOINT env var)
                   Cloudflare Tunnel ──▶ Ollama on dev machine
```

---

### Phase 1 — Cloudflare Tunnel for Ollama (dev machine)

This exposes your local Ollama instance to the Hetzner app without opening any ports on your router.

**Install cloudflared:**

```bash
# Arch / Manjaro
sudo pacman -S cloudflared

# Ubuntu / Debian
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
```

**Authenticate and create the tunnel:**

```bash
cloudflared tunnel login                     # opens browser, authorises with Cloudflare
cloudflared tunnel create ollama             # creates tunnel, saves credentials to ~/.cloudflared/
```

**Create the tunnel config** at `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: ollama.notnoise.us
    service: http://localhost:11434
    originRequest:
      httpHostHeader: "localhost"   # Ollama rejects non-localhost Host headers (DNS rebinding protection)
  - service: http_status:404
```

**Add a DNS record** in Cloudflare (this command does it automatically):

```bash
cloudflared tunnel route dns ollama ollama.notnoise.us
```

**Install as a systemd service** so it survives reboots:

`cloudflared service install` runs as root and expects config in `/etc/cloudflared/`, not `~/.cloudflared/`. Copy the files there first:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/config.yml /etc/cloudflared/config.yml
sudo cp ~/.cloudflared/<tunnel-id>.json /etc/cloudflared/
sudo sed -i 's|/home/<user>/.cloudflared/|/etc/cloudflared/|g' /etc/cloudflared/config.yml
cat /etc/cloudflared/config.yml   # verify credentials-file path is correct
```

Then install and enable:

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
systemctl status cloudflared   # should show active (running)
```

**Lock it down with Cloudflare Access:**

1. In the Cloudflare dashboard → **Zero Trust → Access → Applications**, create a new application for `ollama.notnoise.us`.
2. Set the policy to **Service Auth** only (no user login).
3. Under **Service Auth**, generate a service token. Copy the **Client ID** and **Client Secret** — these go into the Hetzner app's `.env` as `OLLAMA_CF_CLIENT_ID` and `OLLAMA_CF_CLIENT_SECRET`.

---

### Phase 2 — Hetzner VM

Provision a **CX22** instance (2 vCPU, 4 GB RAM) running Ubuntu 24.04.

**Install Docker and nginx:**

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out and back in

# nginx
sudo apt install nginx
```

**Configure the Hetzner cloud firewall** to allow inbound traffic on ports 80 and 443 from Cloudflare's IP ranges only. Cloudflare publishes these at https://www.cloudflare.com/ips/. Block all other inbound traffic on those ports.

---

### Phase 3 — Cloudflare DNS and TLS

1. In the Cloudflare dashboard for `notnoise.us`, add an **A record**:
   - Name: `crossword`
   - IPv4: Hetzner VM IP
   - Proxy status: **Proxied** (orange cloud on)

2. Set **SSL/TLS mode** to **Full (strict)**.

3. Generate a **Cloudflare origin certificate** (15-year, free):
   - Cloudflare dashboard → **SSL/TLS → Origin Server → Create Certificate**
   - Install on the VM:
     ```bash
     sudo mkdir -p /etc/ssl/cloudflare
     # paste the cert and key into:
     sudo nano /etc/ssl/cloudflare/crossword.pem   # certificate
     sudo nano /etc/ssl/cloudflare/crossword.key   # private key
     sudo chmod 600 /etc/ssl/cloudflare/crossword.key
     ```

**nginx config** at `/etc/nginx/sites-available/crossword`:

```nginx
server {
    listen 443 ssl;
    server_name crossword.notnoise.us;

    ssl_certificate     /etc/ssl/cloudflare/crossword.pem;
    ssl_certificate_key /etc/ssl/cloudflare/crossword.key;

    client_max_body_size 10M;

    location / {
        proxy_pass         http://127.0.0.1:8000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/crossword /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

### Phase 4 — Deploy the app

**On the Hetzner VM:**

```bash
git clone <repo-url> /opt/crossword
cd /opt/crossword
cp .env.example .env
nano .env   # fill in all required values
```

Key values for production `.env`:

```env
HTTPS_ONLY=true
OLLAMA_ENDPOINT=https://ollama.notnoise.us
OLLAMA_CF_CLIENT_ID=<from Cloudflare Access service token>
OLLAMA_CF_CLIENT_SECRET=<from Cloudflare Access service token>
```

Generate a strong `SECRET_KEY`:

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

**Start the app:**

```bash
docker compose up -d --build
docker compose logs -f   # verify startup, check for missing env vars
```

---

### Phase 5 — Google OAuth

In Google Cloud Console → **APIs & Services → Credentials**, add
`https://crossword.notnoise.us/auth/callback` as an authorized redirect URI on the existing OAuth client.

---

## Operations

### Start / stop / restart

```bash
# From /opt/crossword on the Hetzner VM
docker compose up -d          # start (or restart if already running)
docker compose down           # stop and remove container (data volumes untouched)
docker compose restart        # restart container without rebuilding
docker compose logs -f        # tail logs
```

### Update the app

```bash
cd /opt/crossword
git pull
docker compose up -d --build   # rebuilds image, restarts container, zero data loss
```

The `./data` and `./uploads` directories on the host are bind-mounted into the container and are never touched by a build or restart.

### Schema changes

The database schema is initialised in `app/database.py`. Additive changes (new tables, new nullable columns via `ALTER TABLE`) are safe to deploy with a normal update — `init_db()` runs on every startup. Destructive changes require a manual migration step before starting the new container.

---

## Backup and Restore

All persistent state lives in two host directories:

| Directory | Contents | Priority |
|---|---|---|
| `./data/` | SQLite database (`puzzle.db`) | Critical |
| `./uploads/` | Uploaded PDF files | Lower (puzzle data is already parsed into the DB) |

### Backup

```bash
# From /opt/crossword on the Hetzner VM
tar -czf crossword-backup-$(date +%Y%m%d).tar.gz data/ uploads/
```

Copy off the VM:

```bash
# From your local machine
scp user@<hetzner-ip>:/opt/crossword/crossword-backup-*.tar.gz ./backups/
```

### Restore

```bash
# On the Hetzner VM
cd /opt/crossword
docker compose down
tar -xzf crossword-backup-YYYYMMDD.tar.gz   # overwrites data/ and uploads/
docker compose up -d
```

---

## Project Structure

```
app/
  main.py           — FastAPI app, lifespan, middleware
  auth.py           — Google OAuth routes and session dependency
  config.py         — Environment variable settings
  database.py       — SQLite3 init, schema, and cleanup loop
  ollama_client.py  — Async Ollama suggestion client (supports CF Access headers)
  models.py         — Pydantic request/response models
  routes/
    upload.py       — PDF upload, session list, resume, delete
    solve.py        — Puzzle fetch, autosave, suggest
  services/
    parser.py       — PDF → grid + clues parse routine
Dockerfile
docker-compose.yml
.env.example
nginx/
  crossword.conf    — LAN nginx config (reference only; superseded by production setup)
static/
  index.html        — Upload / session list page
  solve.html        — Interactive solver page
  css/style.css
  js/upload.js
  js/solve.js
  help/pdf-format.html
```
