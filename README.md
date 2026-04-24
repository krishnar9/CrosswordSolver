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

### Architecture

```
Browser ──HTTPS──▶ Cloudflare edge (TLS termination, DDoS protection)
                        │
                   A record: crossword.notnoise.us → Hetzner CX22, Nuremberg
                        │ (HTTPS on port 443, Cloudflare origin cert)
                   nginx on Hetzner VM
                        │ (HTTP to 127.0.0.1:8000)
                   Docker container (uvicorn)
                        │ (OLLAMA_ENDPOINT + CF Access headers)
                   Cloudflare Tunnel ──▶ Ollama on developer's machine (GPU)
```

### Runtime dependencies

All five components must be running for the app to be fully functional:

| Component | Location | Kept alive by |
|---|---|---|
| Hetzner VM (nginx + Docker app) | Hetzner cloud | `restart: unless-stopped`, nginx systemd |
| Cloudflare | Cloudflare edge | Managed service |
| Google OAuth | Google Cloud | Managed service |
| Ollama | Developer's machine | `ollama` systemd service |
| cloudflared tunnel | Developer's machine | `cloudflared` systemd service |

If the developer's machine is off, suggestions are unavailable but the rest of the app (login, upload, solve, autosave) continues working.

---

### Phase 1 — Cloudflare Tunnel for Ollama (developer's machine)

This exposes the local Ollama instance to the Hetzner app without opening any ports on the router.

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
cloudflared tunnel login           # opens browser, authorises with Cloudflare
cloudflared tunnel create ollama   # saves credentials to ~/.cloudflared/<tunnel-id>.json
```

**Create the tunnel config** at `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: ollama.notnoise.us
    service: http://localhost:11434
    originRequest:
      httpHostHeader: "localhost"   # required: Ollama rejects non-localhost Host headers (DNS rebinding protection)
  - service: http_status:404
```

**Add a DNS record:**

```bash
cloudflared tunnel route dns ollama ollama.notnoise.us
```

**Test before daemonising:**

```bash
cloudflared tunnel run ollama
# in another terminal:
curl -s https://ollama.notnoise.us/api/tags   # should return model list
```

**Install as a systemd service:**

`cloudflared service install` runs as root and expects config in `/etc/cloudflared/`, not `~/.cloudflared/`. Copy the files there first:

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/config.yml /etc/cloudflared/config.yml
sudo cp ~/.cloudflared/<tunnel-id>.json /etc/cloudflared/
sudo sed -i 's|/home/<user>/.cloudflared/|/etc/cloudflared/|g' /etc/cloudflared/config.yml
cat /etc/cloudflared/config.yml   # verify credentials-file path is correct
```

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
systemctl status cloudflared   # should show active (running)
```

The shell-based `cloudflared tunnel run` used for testing can now be stopped — the systemd service takes over.

**Lock it down with Cloudflare Access:**

1. Cloudflare dashboard → **Zero Trust → Access → Applications → Add an application → Self-hosted**
   - Application domain: `ollama.notnoise.us`
2. Policy: action = **Service Auth**, rule type = **Service Token**
3. **Zero Trust → Access → Service Auth → Service Tokens → Create service token**
   - Name it `hetzner-crossword`
   - Copy the **Client ID** and **Client Secret** (secret shown once only)

Verify the lock is working:

```bash
# Should now return 403
curl -s -o /dev/null -w "%{http_code}" https://ollama.notnoise.us/api/tags

# Should return the model list
curl -s \
  -H "CF-Access-Client-Id: <client-id>" \
  -H "CF-Access-Client-Secret: <client-secret>" \
  https://ollama.notnoise.us/api/tags
```

---

### Phase 2 — Hetzner VM

Provision a **CX22** instance (2 vCPU, 4 GB RAM, ~€3.29/mo) in **Nuremberg** running **Ubuntu 24.04**.

Hetzner bills by the hour. To "pause" the VM: snapshot (~€0.48/mo for a 40 GB disk) then delete the server. Restore by creating a new server from the snapshot.

**SSH key:** add your public key in Hetzner Console → Security → SSH Keys before creating the server.

**Hetzner cloud firewall** (create and apply to the server):

| Direction | Protocol | Port | Source |
|---|---|---|---|
| Inbound | TCP | 22 | Your home IP only |
| Inbound | TCP | 80 | Cloudflare IPv4 ranges |
| Inbound | TCP | 443 | Cloudflare IPv4 ranges |

Cloudflare's current IPv4 ranges: https://www.cloudflare.com/ips-v4

**Install Docker and nginx on the VM:**

```bash
curl -fsSL https://get.docker.com | sh
apt-get install -y nginx
systemctl enable nginx docker
```

---

### Phase 3 — Cloudflare DNS and TLS

1. Cloudflare dashboard for `notnoise.us` → **DNS → Add record**:
   - Type: `A`, Name: `crossword`, IPv4: Hetzner VM IP, Proxy: **Proxied** (orange cloud on)

2. **SSL/TLS → Overview** → set mode to **Full (strict)**
   - Cloudflare connects to the origin on port 443 and validates the certificate

3. Generate a **Cloudflare origin certificate** (15-year, free):
   - **SSL/TLS → Origin Server → Create Certificate**
   - Install on the VM:
     ```bash
     mkdir -p /etc/ssl/cloudflare
     nano /etc/ssl/cloudflare/crossword.pem   # paste certificate
     nano /etc/ssl/cloudflare/crossword.key   # paste private key
     chmod 600 /etc/ssl/cloudflare/crossword.key
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
ln -sf /etc/nginx/sites-available/crossword /etc/nginx/sites-enabled/crossword
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

> **Why port 443 and not 80?** With Cloudflare SSL/TLS in Full (strict) mode, Cloudflare connects to the origin on port 443. nginx must listen there and present a valid certificate (the Cloudflare origin cert).

---

### Phase 4 — Deploy the app

```bash
git clone https://github.com/krishnar9/CrosswordSolver.git /opt/crossword
cd /opt/crossword
```

**Create persistent data directories with correct ownership before starting the container.** The app runs as uid 1000 inside the container; Docker auto-creates bind-mount directories as root, which the app cannot write to.

```bash
mkdir -p /opt/crossword/data /opt/crossword/uploads
chown -R 1000:1000 /opt/crossword/data /opt/crossword/uploads
```

**Create the `.env` file:**

```bash
cp .env.example .env
nano .env
```

Required values:

```env
HTTPS_ONLY=true
ALLOWED_EMAILS=user@gmail.com,other@gmail.com
GOOGLE_CLIENT_ID=<from Google Cloud Console>
GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
SECRET_KEY=<generate with: python3 -c "import secrets; print(secrets.token_hex(32))">
OLLAMA_ENDPOINT=https://ollama.notnoise.us
OLLAMA_MODEL=cross_qwen3_4b:latest
OLLAMA_CF_CLIENT_ID=<from Cloudflare Access service token>
OLLAMA_CF_CLIENT_SECRET=<from Cloudflare Access service token>
```

**Start the app:**

```bash
docker compose up -d --build
docker compose logs -f   # verify: DB initialised, Ollama model loaded, startup complete
```

> **Why `--forwarded-allow-ips *` in the Dockerfile?** Uvicorn must trust `X-Forwarded-Proto: https` from nginx to build correct OAuth redirect URIs. Docker proxies host requests through the bridge gateway (`172.17.0.1`), not `127.0.0.1`, so trusting only `127.0.0.1` silently discards the header and OAuth URLs are built as `http://`. The wildcard is safe because port 8000 is bound to `127.0.0.1` on the host and unreachable externally.

---

### Phase 5 — Google OAuth

1. Google Cloud Console → **APIs & Services → Credentials → your OAuth client → Authorized redirect URIs**
   - Add: `https://crossword.notnoise.us/auth/callback`

2. **APIs & Services → OAuth consent screen → Test users**
   - Add every email address in `ALLOWED_EMAILS`
   - While the app is in **Testing** status, Google restricts OAuth to listed test users only. The app can remain in Testing status indefinitely — Google's app verification process is not required for a private allowlisted app.

---

## Operations

### Start / stop / restart

```bash
# From /opt/crossword on the Hetzner VM
docker compose up -d          # start (or restart if already running)
docker compose down           # stop and remove container (data volumes untouched)
docker compose restart        # restart without rebuilding
docker compose logs -f        # tail logs
```

### Update the app

```bash
cd /opt/crossword
git pull
docker compose up -d --build   # rebuilds image, restarts container, zero data loss
```

`./data` and `./uploads` are bind-mounted host directories — never touched by a build or restart.

### Schema changes

The schema is initialised in `app/database.py` via `init_db()` on every startup. Additive changes (new tables, new nullable columns via `ALTER TABLE`) deploy safely with a normal update. Destructive schema changes require a manual migration step before starting the new container.

---

## Backup and Restore

All persistent state lives in two host directories on the Hetzner VM:

| Directory | Contents | Priority |
|---|---|---|
| `./data/` | SQLite database (`puzzle.db`) | Critical |
| `./uploads/` | Uploaded PDF files | Lower (puzzle data is already parsed into the DB) |

### Backup

```bash
# On the Hetzner VM, from /opt/crossword
tar -czf crossword-backup-$(date +%Y%m%d).tar.gz data/ uploads/

# Copy to local machine
scp root@178.104.156.246:/opt/crossword/crossword-backup-*.tar.gz ./backups/
```

### Restore

```bash
# On the Hetzner VM
cd /opt/crossword
docker compose down
tar -xzf crossword-backup-YYYYMMDD.tar.gz
chown -R 1000:1000 data/ uploads/
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
