const BASE = '';

const fileInput        = document.getElementById('file-input');
const btnUpload        = document.getElementById('btn-upload');
const errorEl          = document.getElementById('upload-error');
const nytCookieInput   = document.getElementById('nyt-cookie-input');
const nytCookieSaved   = document.getElementById('nyt-cookie-saved');
const nytCookieRow     = document.getElementById('nyt-cookie-row');
const btnChangeCookie  = document.getElementById('btn-change-cookie');
const nytDateInput     = document.getElementById('nyt-date-input');
const btnFetchNYT      = document.getElementById('btn-fetch-nyt');
const nytErrorEl       = document.getElementById('nyt-error');
const tabUpload        = document.getElementById('tab-upload');
const tabNYT           = document.getElementById('tab-nyt');
const panelUpload      = document.getElementById('panel-upload');
const panelNYT         = document.getElementById('panel-nyt');
const listEl           = document.getElementById('session-list');
const noSessions       = document.getElementById('no-sessions');
const loadMore         = document.getElementById('load-more');
const toastEl          = document.getElementById('toast');

let offset = 0;
const LIMIT = 10;
let toastTimeout = null;

// ── Auth check + init ─────────────────────────────────────────────────────
(async () => {
    const r = await fetch(BASE + '/auth/me');
    if (r.status === 401) { location.href = BASE + '/auth/login'; return; }

    selectTab('upload');
    updateCookieUI();

    await loadSessions();
})();

// ── Tab switching ─────────────────────────────────────────────────────────
function selectTab(which) {
    const isNYT = which === 'nyt';
    tabUpload.classList.toggle('active', !isNYT);
    tabNYT.classList.toggle('active', isNYT);
    panelUpload.style.display = isNYT ? 'none' : 'block';
    panelNYT.style.display   = isNYT ? 'block' : 'none';
}

tabUpload.addEventListener('click', () => selectTab('upload'));
tabNYT.addEventListener('click',    () => selectTab('nyt'));

// ── Cookie UI state ───────────────────────────────────────────────────────
function updateCookieUI() {
    const hasCookie = !!localStorage.getItem('nyt_cookie');
    nytCookieRow.style.display   = hasCookie ? 'none'  : 'block';
    nytCookieSaved.style.display = hasCookie ? 'block' : 'none';
}

btnChangeCookie.addEventListener('click', (e) => {
    e.preventDefault();
    localStorage.removeItem('nyt_cookie');
    nytCookieInput.value = '';
    updateCookieUI();
});

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

// ── Fetch from NYT ────────────────────────────────────────────────────────
btnFetchNYT.addEventListener('click', async () => {
    nytErrorEl.style.display = 'none';

    const cookie = localStorage.getItem('nyt_cookie') || nytCookieInput.value.trim();
    if (!cookie) { showNYTError('Please enter your NYT-S cookie value.'); return; }

    btnFetchNYT.disabled = true;
    btnFetchNYT.textContent = 'Fetching…';

    const body = { nyt_cookie: cookie };
    if (nytDateInput.value) body.date = nytDateInput.value;

    try {
        const resp = await fetch(BASE + '/fetch-nyt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!resp.ok) {
            if (resp.status === 401) {
                localStorage.removeItem('nyt_cookie');
                updateCookieUI();
                showNYTError('Cookie is invalid or expired. Please enter a new one.');
            } else {
                showNYTError(data.detail || 'Fetch failed.');
            }
        } else {
            localStorage.setItem('nyt_cookie', cookie);
            updateCookieUI();
            location.href = BASE + '/solve';
        }
    } catch {
        showNYTError('Fetch failed. Please try again.');
    } finally {
        btnFetchNYT.disabled = false;
        btnFetchNYT.textContent = 'Fetch';
    }
});

function showNYTError(msg) {
    nytErrorEl.textContent = msg;
    nytErrorEl.style.display = 'block';
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

function formatElapsed(secs) {
    if (!secs) return null;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

function formatPuzzleLabel(s) {
    if (s.puzzle_date) {
        const d = new Date(s.puzzle_date + 'T12:00:00');
        return 'NYT ' + d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    }
    return s.title || new Date(s.created_at).toLocaleString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function sessionItem(s) {
    const li = document.createElement('li');
    li.className = 'session-item';
    li.dataset.id = s.session_id;

    const progress = s.total_clues > 0
        ? `${s.answered_clues}/${s.total_clues}`
        : '—';

    const isNYT = !!s.puzzle_date;
    const labelText = formatPuzzleLabel(s);

    const meta = document.createElement('span');
    meta.className = 'session-meta';

    const sizeSpan = document.createElement('strong');
    sizeSpan.textContent = s.N ? `${s.N}×${s.N}` : '?';

    const sep1 = document.createTextNode(' · ');
    const sep2 = document.createTextNode(' · ');

    const progressSpan = document.createElement('span');
    progressSpan.style.color = '#555';
    progressSpan.textContent = `${progress} clues`;

    if (isNYT) {
        const labelSpan = document.createElement('span');
        labelSpan.textContent = labelText;
        meta.append(sizeSpan, sep1, labelSpan, sep2, progressSpan);
    } else {
        const labelSpan = document.createElement('span');
        labelSpan.className = 'session-label editable';
        labelSpan.textContent = labelText;
        labelSpan.title = 'Click to edit title';
        labelSpan.addEventListener('click', () => startEditTitle(s.session_id, labelSpan, s));
        meta.append(sizeSpan, sep1, labelSpan, sep2, progressSpan);
    }

    const timeStr = formatElapsed(s.elapsed_seconds);
    if (timeStr) {
        const sep3 = document.createTextNode(' · ');
        const timeSpan = document.createElement('span');
        timeSpan.className = 'session-time';
        timeSpan.textContent = '⏱ ' + timeStr;
        meta.append(sep3, timeSpan);
    }

    const actions = document.createElement('span');
    actions.className = 'session-actions';
    actions.innerHTML = `
      <button class="link-btn" data-action="resume">Resume</button>
      <button class="link-btn danger" data-action="delete">Delete</button>`;

    li.append(meta, actions);

    li.querySelector('[data-action=resume]').addEventListener('click', () => resumeSession(s.session_id));
    li.querySelector('[data-action=delete]').addEventListener('click', () => deleteSession(s.session_id, li));
    return li;
}

function startEditTitle(sessionId, labelSpan, s) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'title-input';
    input.value = s.title || '';
    input.placeholder = 'Add a title…';
    input.maxLength = 100;
    labelSpan.replaceWith(input);
    input.focus();
    input.select();

    async function save() {
        const newTitle = input.value.trim();
        s.title = newTitle || null;
        const newLabel = document.createElement('span');
        newLabel.className = 'session-label editable';
        newLabel.textContent = formatPuzzleLabel(s);
        newLabel.title = 'Click to edit title';
        newLabel.addEventListener('click', () => startEditTitle(sessionId, newLabel, s));
        input.replaceWith(newLabel);
        await fetch(BASE + `/sessions/${sessionId}/title`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTitle }),
        });
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = s.title || ''; input.blur(); }
    });
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
