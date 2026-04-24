const BASE = '';

// ── State ─────────────────────────────────────────────────────────────────
let puzzle       = null;   // {rows, cols, grid, across, down}
let gridState    = null;   // rows×cols: null | uppercase letter
let acrossMap    = {};     // "r,c" → clue number (across)
let downMap      = {};     // "r,c" → clue number (down)
let acrossNums   = [];     // sorted clue numbers for Tab
let downNums     = [];

let activeDir    = null;   // "across" | "down"
let activeNum    = null;   // clue number (int)
let cursorR      = null;
let cursorC      = null;

let autosaveTimer   = null;

const RECENT_MAX  = 30;
let recentClues   = [];   // [{dir, num, snapshot}] — most-recent first
let autoSuggest   = false;

// ── DOM ───────────────────────────────────────────────────────────────────
const gridEl        = document.getElementById('grid');
const clueTextEl    = document.getElementById('clue-text');
const suggestionsEl = document.getElementById('suggestions');
const btnSuggest    = document.getElementById('btn-suggest');
const toastEl       = document.getElementById('toast');
const btnSettings   = document.getElementById('btn-settings');
const settingsMenu  = document.getElementById('settings-menu');
const optAutosuggest = document.getElementById('opt-autosuggest');
let toastTimeout    = null;

// ── Orientation warning (JS — more reliable than CSS media query) ─────────
function updateOrientationWarning() {
    const type       = window.screen.orientation ? window.screen.orientation.type : '';
    const isLandscape = type.startsWith('landscape') || window.innerWidth > window.innerHeight;
    const isMobile   = Math.min(window.innerWidth, window.innerHeight) < 600;
    const show = isLandscape && isMobile;
    document.getElementById('landscape-msg').style.display = show ? 'flex' : 'none';
    document.querySelector('.page').style.display          = show ? 'none' : '';
    if (!show && puzzle) recalcCellSize();
}
window.addEventListener('resize', updateOrientationWarning);
window.addEventListener('orientationchange', updateOrientationWarning);
updateOrientationWarning();

// ── Cell size recalc (called on load and orientation change) ───────────────
function recalcCellSize() {
    if (!puzzle) return;
    const availPx = document.documentElement.clientWidth - 40;
    const cellPx  = Math.max(18, Math.min(36, Math.floor(availPx / puzzle.cols)));
    document.documentElement.style.setProperty('--cell', cellPx + 'px');
}

// ── Init ──────────────────────────────────────────────────────────────────
(async () => {
    let data;
    try {
        const r = await fetch(BASE + '/puzzle');
        if (r.status === 401) { location.href = BASE + '/auth/login'; return; }
        if (r.status === 404) { location.href = BASE + '/';           return; }
        if (!r.ok) throw new Error(await r.text());
        data = await r.json();
    } catch (e) {
        showToast('Failed to load puzzle: ' + e.message);
        return;
    }

    puzzle    = { rows: data.rows, cols: data.cols, grid: data.grid, across: data.across, down: data.down };
    gridState = data.grid_state;

    document.getElementById('puzzle-meta').textContent =
        `${data.rows}×${data.cols}`;

    buildLookups();
    renderGrid();
    startAutosave(data.autosave_interval);
})();

// ── Lookup maps ───────────────────────────────────────────────────────────
function buildLookups() {
    for (const [numStr, [loc, , len]] of Object.entries(puzzle.across)) {
        const num = +numStr;
        const [r, c] = loc;
        for (let i = 0; i < len; i++) acrossMap[`${r},${c+i}`] = num;
    }
    for (const [numStr, [loc, , len]] of Object.entries(puzzle.down)) {
        const num = +numStr;
        const [r, c] = loc;
        for (let i = 0; i < len; i++) downMap[`${r+i},${c}`] = num;
    }
    acrossNums = Object.keys(puzzle.across).map(Number).sort((a,b)=>a-b);
    downNums   = Object.keys(puzzle.down  ).map(Number).sort((a,b)=>a-b);
}

// ── Grid rendering ────────────────────────────────────────────────────────
function renderGrid() {
    const { rows, cols, grid } = puzzle;

    recalcCellSize();

    gridEl.style.gridTemplateColumns = `repeat(${cols}, var(--cell))`;
    gridEl.style.gridTemplateRows    = `repeat(${rows}, var(--cell))`;
    gridEl.innerHTML = '';

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const val  = grid[r][c];
            const cell = document.createElement('div');
            cell.dataset.r = r;
            cell.dataset.c = c;

            if (val === -1) {
                cell.className = 'cell black';
            } else {
                cell.className = 'cell white';

                if (val > 0) {
                    const num = document.createElement('span');
                    num.className = 'cell-num';
                    num.textContent = val;
                    cell.appendChild(num);
                }

                const letter = document.createElement('span');
                letter.className = 'cell-letter';
                letter.textContent = gridState[r][c] || '';
                cell.appendChild(letter);

                cell.addEventListener('click', () => onCellClick(r, c));
                cell.addEventListener('contextmenu', e => { e.preventDefault(); onCellRightClick(r, c); });

                // Mobile: tap toggles between across and down; no long-press needed
                let tapMoved = false;
                cell.addEventListener('touchstart', () => { tapMoved = false; }, { passive: true });
                cell.addEventListener('touchmove',  () => { tapMoved = true;  }, { passive: true });
                cell.addEventListener('touchend', e => {
                    if (!tapMoved) { e.preventDefault(); onCellTap(r, c); }
                });
            }

            gridEl.appendChild(cell);
        }
    }
}

function cellEl(r, c) {
    return gridEl.querySelector(`[data-r="${r}"][data-c="${c}"]`);
}

function updateCellLetter(r, c) {
    const el = cellEl(r, c);
    if (!el) return;
    const span = el.querySelector('.cell-letter');
    if (span) span.textContent = gridState[r][c] || '';
}

// ── Highlight ─────────────────────────────────────────────────────────────
function applyHighlights() {
    // Clear
    gridEl.querySelectorAll('.cell').forEach(el => el.classList.remove('run', 'cursor'));

    if (activeNum === null) return;

    const cells = runCells(activeDir, activeNum);
    cells.forEach(([r, c]) => {
        const el = cellEl(r, c);
        if (el) el.classList.add('run');
    });
    const curEl = cellEl(cursorR, cursorC);
    if (curEl) { curEl.classList.remove('run'); curEl.classList.add('cursor'); }

    // Clue text
    const [, text, len] = puzzle[activeDir][activeNum];
    clueTextEl.innerHTML = `<strong>${activeNum} ${activeDir.charAt(0).toUpperCase()+activeDir.slice(1)}</strong>&nbsp;&nbsp;${text}&nbsp;<span style="color:#888">(${len})</span>`;

    btnSuggest.disabled = false;
}

function clearActive() {
    activeDir = activeNum = cursorR = cursorC = null;
    gridEl.querySelectorAll('.cell').forEach(el => el.classList.remove('run', 'cursor'));
    clueTextEl.innerHTML = '';
    btnSuggest.disabled = true;
    clearSuggestions();
}

// ── Clue run helpers ──────────────────────────────────────────────────────
function runCells(dir, num) {
    const [loc, , len] = puzzle[dir][num];
    const [sr, sc] = loc;
    const cells = [];
    for (let i = 0; i < len; i++) {
        cells.push(dir === 'across' ? [sr, sc+i] : [sr+i, sc]);
    }
    return cells;
}

function cursorIndexInRun() {
    return runCells(activeDir, activeNum).findIndex(([r, c]) => r === cursorR && c === cursorC);
}

// ── Visit history ─────────────────────────────────────────────────────────
function clueSnapshot(dir, num) {
    return runCells(dir, num).map(([r, c]) => gridState[r][c] || '_').join('');
}

function recordVisit(dir, num) {
    recentClues = recentClues.filter(e => !(e.dir === dir && e.num === num));
    recentClues.unshift({ dir, num, snapshot: clueSnapshot(dir, num) });
    if (recentClues.length > RECENT_MAX) recentClues.length = RECENT_MAX;
}

function wasRecentlyVisitedUnchanged(dir, num) {
    const entry = recentClues.find(e => e.dir === dir && e.num === num);
    return entry != null && clueSnapshot(dir, num) === entry.snapshot;
}

// ── Active clue activation ────────────────────────────────────────────────
function setActiveClue(dir, num, r, c) {
    const changing = dir !== activeDir || num !== activeNum;
    activeDir = dir; activeNum = num; cursorR = r; cursorC = c;
    if (changing) {
        recordVisit(dir, num);
        clearSuggestions();
        applyHighlights();
        if (autoSuggest) doSuggest();
    } else {
        applyHighlights();
    }
}

// ── Click handlers ────────────────────────────────────────────────────────
function onCellClick(r, c) {
    const num = acrossMap[`${r},${c}`];
    if (num === undefined) return;
    if (activeDir === 'across' && activeNum === num) {
        cursorR = r; cursorC = c;
        applyHighlights();
    } else {
        setActiveClue('across', num, r, c);
    }
}

function onCellRightClick(r, c) {
    const num = downMap[`${r},${c}`];
    if (num === undefined) return;
    if (activeDir === 'down' && activeNum === num) {
        cursorR = r; cursorC = c;
        applyHighlights();
    } else {
        setActiveClue('down', num, r, c);
    }
}

function onCellTap(r, c) {
    const acrossNum = acrossMap[`${r},${c}`];
    const downNum   = downMap[`${r},${c}`];
    if (activeDir === 'across' && activeNum === acrossNum && acrossNum !== undefined) {
        // Already on this across — switch to down if available, else move cursor
        if (downNum !== undefined) setActiveClue('down', downNum, r, c);
        else { cursorR = r; cursorC = c; applyHighlights(); }
    } else if (activeDir === 'down' && activeNum === downNum && downNum !== undefined) {
        // Already on this down — switch back to across if available, else move cursor
        if (acrossNum !== undefined) setActiveClue('across', acrossNum, r, c);
        else { cursorR = r; cursorC = c; applyHighlights(); }
    } else if (acrossNum !== undefined) {
        setActiveClue('across', acrossNum, r, c);
    } else if (downNum !== undefined) {
        setActiveClue('down', downNum, r, c);
    }
}

// ── Keyboard ──────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
    if (activeNum === null) return;

    if (/^[a-zA-Z]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        gridState[cursorR][cursorC] = e.key.toUpperCase();
        updateCellLetter(cursorR, cursorC);
        advanceCursor();
        return;
    }

    switch (e.key) {
        case 'Backspace':
            e.preventDefault();
            gridState[cursorR][cursorC] = null;
            updateCellLetter(cursorR, cursorC);
            retreatCursor();
            break;

        case 'ArrowRight':
            if (activeDir === 'across') { e.preventDefault(); moveCursor(1); }
            break;
        case 'ArrowLeft':
            if (activeDir === 'across') { e.preventDefault(); moveCursor(-1); }
            break;
        case 'ArrowDown':
            if (activeDir === 'down') { e.preventDefault(); moveCursor(1); }
            break;
        case 'ArrowUp':
            if (activeDir === 'down') { e.preventDefault(); moveCursor(-1); }
            break;

        case 'Tab':
            e.preventDefault();
            navigateClue(e.shiftKey ? -1 : 1);
            break;
    }
});

function advanceCursor() {
    const cells = runCells(activeDir, activeNum);
    const idx   = cursorIndexInRun();
    if (idx < cells.length - 1) {
        [cursorR, cursorC] = cells[idx + 1];
        applyHighlights();
    }
}

function retreatCursor() {
    const cells = runCells(activeDir, activeNum);
    const idx   = cursorIndexInRun();
    if (idx > 0) {
        [cursorR, cursorC] = cells[idx - 1];
        applyHighlights();
    }
}

function moveCursor(delta) {
    const cells = runCells(activeDir, activeNum);
    const idx   = cursorIndexInRun();
    const next  = idx + delta;
    if (next >= 0 && next < cells.length) {
        [cursorR, cursorC] = cells[next];
        applyHighlights();
    }
}

function cluePriority() {
    // Unfilled clues only, excluding recently visited ones with no answer change.
    // Sorted: fewest unfilled → most filled → longest → random.
    const all = [];
    for (const dir of ['across', 'down']) {
        for (const [numStr] of Object.entries(puzzle[dir])) {
            const num   = +numStr;
            const cells = runCells(dir, num);
            const unfilled = cells.filter(([r, c]) => !gridState[r][c]).length;
            if (unfilled === 0) continue;
            if (wasRecentlyVisitedUnchanged(dir, num)) continue;
            all.push({ dir, num, unfilled, filled: cells.length - unfilled, length: cells.length });
        }
    }
    all.sort((a, b) =>
        a.unfilled !== b.unfilled ? a.unfilled - b.unfilled :
        a.filled   !== b.filled   ? b.filled   - a.filled   :
        a.length   !== b.length   ? b.length   - a.length   :
        Math.random() - 0.5
    );
    return all;
}

function navigateClue(delta) {
    const sorted = cluePriority();
    if (sorted.length === 0) return;
    const idx  = sorted.findIndex(c => c.dir === activeDir && c.num === activeNum);
    const next = sorted[(idx + delta + sorted.length) % sorted.length];
    const [[r, c]] = puzzle[next.dir][next.num];
    setActiveClue(next.dir, next.num, r, c);
}

// ── Save (download) ───────────────────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', doSave);

function doSave() {
    const { rows, cols, grid } = puzzle;
    const now  = new Date();
    const ts   = now.toISOString().replace(/\D/g,'').slice(0,14);
    const dateStr = now.toLocaleDateString(undefined, { year:'numeric', month:'long', day:'numeric' });
    const timeStr = now.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit', second:'2-digit' });

    const header = [
        `Crossword Solver — ${rows}×${cols}`,
        `${dateStr}  ${timeStr}`,
        '─'.repeat(cols + 2),
    ];

    const lines = [];
    for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
            line += grid[r][c] === -1 ? '█' : (gridState[r][c] || '·');
        }
        lines.push(line);
    }
    const name = `CWPuz_${ts.slice(0,8)}_${ts.slice(8,14)}.txt`;
    const blob = new Blob([[...header, ...lines].join('\n')], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ── Suggest ───────────────────────────────────────────────────────────────
document.getElementById('btn-suggest').addEventListener('click', doSuggest);

async function doSuggest() {
    if (activeNum === null) return;
    const cells   = runCells(activeDir, activeNum);
    const partial = cells.map(([r,c]) => gridState[r][c] || '_').join('');

    clearSuggestions();
    btnSuggest.disabled = true;

    let suggestions = [];
    try {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 10000);
        const resp = await fetch(BASE + '/puzzle/suggest', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ clue_number: activeNum, direction: activeDir, partial_answer: partial }),
            signal:  ctrl.signal,
        });
        clearTimeout(tid);
        if (resp.ok) suggestions = (await resp.json()).suggestions;
    } catch {
        showToast('Suggestion service unavailable.');
    } finally {
        btnSuggest.disabled = false;
    }

    renderSuggestions(suggestions);
}

function renderSuggestions(list) {
    suggestionsEl.innerHTML = '';
    for (let i = 0; i < 4; i++) {
        const s = list[i];
        const el = document.createElement('div');
        if (s) {
            el.className = 'suggestion';
            el.textContent = s;
            el.addEventListener('click', () => applySuggestion(s));
        } else {
            el.className = 'suggestion empty';
            el.textContent = '—';
        }
        suggestionsEl.appendChild(el);
    }
}

function applySuggestion(suggestion) {
    const cells = runCells(activeDir, activeNum);
    cells.forEach(([r, c], i) => {
        const ch = (suggestion[i] || '_');
        gridState[r][c] = ch === '_' ? null : ch.toUpperCase();
        updateCellLetter(r, c);
    });
    clearSuggestions();
}

function clearSuggestions() { suggestionsEl.innerHTML = ''; }

// ── Settings ──────────────────────────────────────────────────────────────
btnSettings.addEventListener('click', e => {
    e.stopPropagation();
    settingsMenu.classList.toggle('open');
});

optAutosuggest.addEventListener('click', () => {
    autoSuggest = !autoSuggest;
    optAutosuggest.classList.toggle('active', autoSuggest);
});

document.addEventListener('click', () => settingsMenu.classList.remove('open'));

// ── Exit ──────────────────────────────────────────────────────────────────
document.getElementById('btn-exit').addEventListener('click', async () => {
    await doAutosave();
    location.href = BASE + '/';
});

// ── Next (mobile tab equivalent) ──────────────────────────────────────────
document.getElementById('btn-next').addEventListener('click', () => {
    navigateClue(1);
    clueTextEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

// ── Autosave ──────────────────────────────────────────────────────────────
function startAutosave(intervalSecs) {
    autosaveTimer = setInterval(doAutosave, intervalSecs * 1000);
}

async function doAutosave() {
    if (!gridState) return;
    try {
        await fetch(BASE + '/puzzle/autosave', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ grid_state: gridState }),
        });
    } catch { /* silent */ }
}

window.addEventListener('beforeunload', () => { doAutosave(); });

// ── Toast ─────────────────────────────────────────────────────────────────
function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toastEl.classList.remove('show'), 3500);
}
