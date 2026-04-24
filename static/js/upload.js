const BASE = '';

const fileInput  = document.getElementById('file-input');
const btnUpload  = document.getElementById('btn-upload');
const errorEl    = document.getElementById('upload-error');
const listEl     = document.getElementById('session-list');
const noSessions = document.getElementById('no-sessions');
const loadMore   = document.getElementById('load-more');
const toastEl    = document.getElementById('toast');

let offset = 0;
const LIMIT = 10;
let toastTimeout = null;

// ── Auth check + init ─────────────────────────────────────────────────────
(async () => {
    const r = await fetch(BASE + '/auth/me');
    if (r.status === 401) { location.href = BASE + '/auth/login'; return; }
    await loadSessions();
})();

// ── Upload ────────────────────────────────────────────────────────────────
btnUpload.addEventListener('click', async () => {
    errorEl.style.display = 'none';
    const file = fileInput.files[0];
    if (!file) { showError('Please select a PDF file.'); return; }
    if (file.type !== 'application/pdf') { showError('Only PDF files are accepted.'); return; }
    if (file.size > 1024 * 1024) { showError('File exceeds the 1 MB limit.'); return; }

    btnUpload.disabled = true;
    btnUpload.textContent = 'Uploading…';

    const form = new FormData();
    form.append('file', file);

    try {
        const resp = await fetch(BASE + '/upload', { method: 'POST', body: form });
        const data = await resp.json();
        if (!resp.ok) {
            showError(data.detail || 'Upload failed.');
        } else {
            location.href = BASE + '/solve';
        }
    } catch {
        showError('Upload failed. Please try again.');
    } finally {
        btnUpload.disabled = false;
        btnUpload.textContent = 'Upload';
    }
});

function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
}

// ── Session list ──────────────────────────────────────────────────────────
async function loadSessions(reset = false) {
    if (reset) { offset = 0; listEl.innerHTML = ''; }

    const resp = await fetch(BASE + `/sessions?offset=${offset}&limit=${LIMIT}`);
    if (!resp.ok) return;
    const data = await resp.json();

    if (data.total === 0 && offset === 0) {
        noSessions.style.display = 'block';
        loadMore.style.display = 'none';
        return;
    }
    noSessions.style.display = 'none';

    data.sessions.forEach(s => listEl.appendChild(sessionItem(s)));

    offset += data.sessions.length;
    loadMore.style.display = offset < data.total ? 'block' : 'none';
}

function sessionItem(s) {
    const li = document.createElement('li');
    li.className = 'session-item';
    li.dataset.id = s.session_id;

    const date = new Date(s.created_at).toLocaleString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });

    const progress = s.total_clues > 0
        ? `${s.answered_clues}/${s.total_clues}`
        : '—';

    li.innerHTML = `
      <span class="session-meta">
        <strong>${s.N ? s.N+'×'+s.N : '?'}</strong>
        &nbsp;·&nbsp;${date}
        &nbsp;·&nbsp;<span style="color:#555">${progress} clues</span>
      </span>
      <span class="session-actions">
        <button class="link-btn" data-action="resume">Resume</button>
        <button class="link-btn danger" data-action="delete">Delete</button>
      </span>`;

    li.querySelector('[data-action=resume]').addEventListener('click', () => resumeSession(s.session_id));
    li.querySelector('[data-action=delete]').addEventListener('click', () => deleteSession(s.session_id, li));
    return li;
}

async function resumeSession(id) {
    const r = await fetch(BASE + `/sessions/${id}/resume`, { method: 'POST' });
    if (r.ok) location.href = BASE + '/solve';
    else showToast('Could not resume session.');
}

async function deleteSession(id, li) {
    const r = await fetch(BASE + `/sessions/${id}`, { method: 'DELETE' });
    if (r.ok) {
        li.remove();
        if (!listEl.children.length) noSessions.style.display = 'block';
    } else {
        showToast('Could not delete session.');
    }
}

loadMore.addEventListener('click', () => loadSessions());

// ── Toast ─────────────────────────────────────────────────────────────────
function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toastEl.classList.remove('show'), 3500);
}
