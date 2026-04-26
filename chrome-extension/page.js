let parsedGrid = null;

document.getElementById('fileInput').addEventListener('change', handleFileSelect);
document.getElementById('fillBtn').addEventListener('click', handleFill);
document.getElementById('diagBtn').addEventListener('click', handleDiagnose);

function handleFileSelect(event) {
  const file = event.target.files[0];
  const gridInfo = document.getElementById('gridInfo');
  const fillBtn = document.getElementById('fillBtn');

  parsedGrid = null;
  fillBtn.disabled = true;
  gridInfo.textContent = '';
  clearStatus();

  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      parsedGrid = parseGrid(e.target.result);
      const rows = parsedGrid.length;
      const cols = parsedGrid[0]?.length ?? 0;
      const letters = parsedGrid.flat().filter(c => c !== null && c !== '').length;
      gridInfo.textContent = `${rows}×${cols} grid · ${letters} filled letters`;
      fillBtn.disabled = false;
    } catch (err) {
      showStatus(`Parse error: ${err.message}`, 'error');
    }
  };
  reader.onerror = () => showStatus('Could not read file.', 'error');
  reader.readAsText(file);
}

function parseGrid(text) {
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  if (lines.length === 0) throw new Error('File is empty');

  const grid = lines.map((line, idx) => {
    const row = [];
    for (const ch of line) {
      if (ch === '█') {
        row.push(null);        // black cell
      } else if (ch === '·') {
        row.push('');          // empty white cell
      } else if (/^[A-Z]$/.test(ch)) {
        row.push(ch);          // filled cell
      }
      // ignore CR and other noise
    }
    if (row.length === 0) throw new Error(`Row ${idx + 1} has no recognizable cells`);
    return row;
  });

  const colCount = grid[0].length;
  for (let i = 1; i < grid.length; i++) {
    if (grid[i].length !== colCount) {
      throw new Error(`Inconsistent row lengths (row ${i + 1} has ${grid[i].length}, expected ${colCount})`);
    }
  }

  return grid;
}

async function handleFill() {
  if (!parsedGrid) return;

  const nytTabs = await chrome.tabs.query({ url: 'https://www.nytimes.com/crosswords/game/*' });
  if (nytTabs.length === 0) {
    showStatus('No NYT crossword tab found. Open the NYT crossword puzzle in another tab first.', 'error');
    return;
  }

  const tab = nytTabs.length === 1
    ? nytTabs[0]
    : nytTabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];

  showStatus('Filling crossword…', 'info');
  document.getElementById('fillBtn').disabled = true;

  try {
    // Bring the crossword tab to the foreground before filling.
    // Events dispatched in a background tab don't move document.activeElement,
    // so the InputEvent that commits letters to React state would fire on body.
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await new Promise(r => setTimeout(r, 400));

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: fillCrosswordInPage,
      args: [parsedGrid],
    });

    if (result.success) {
      const msg = `Filled ${result.filled} cell${result.filled !== 1 ? 's' : ''} successfully.`;
      const warn = result.warning ? ` (${result.warning})` : '';
      showStatus(msg + warn, result.warning ? 'warning' : 'success');
    } else {
      showStatus(result.error, 'error');
    }
  } catch (err) {
    showStatus(`Error: ${err.message}`, 'error');
  } finally {
    document.getElementById('fillBtn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Runs in the MAIN world of the NYT crossword tab — fully self-contained.
// ---------------------------------------------------------------------------
async function fillCrosswordInPage(grid) {
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // NYT crossword cells have IDs like "cell-id-0", "cell-id-1", ...
  // indexed left-to-right, top-to-bottom across the full grid (including
  // black-cell positions, which simply have no element).
  if (!document.getElementById('cell-id-0')) {
    // Return diagnostic info so we can identify the right selector.
    const cellLike = Array.from(document.querySelectorAll('[id]'))
      .map(el => el.id).filter(id => /cell|square|box|letter/i.test(id)).slice(0, 8);
    const anySample = Array.from(document.querySelectorAll('[id]'))
      .map(el => el.id).filter(Boolean).slice(0, 10);
    return {
      success: false,
      error: `Puzzle not loaded (no element with id="cell-id-0"). ` +
             `Cell-like IDs found: [${cellLike.join(', ') || 'none'}]. ` +
             `Other IDs: [${anySample.join(', ')}]`,
    };
  }

  // Flatten grid row-by-row — this matches the cell-id-N numbering.
  const flat = grid.flat();

  let filled = 0;

  for (let i = 0; i < flat.length; i++) {
    const letter = flat[i];
    if (!letter || !/^[A-Z]$/.test(letter)) continue;

    const cell = document.getElementById(`cell-id-${i}`);
    if (!cell) continue; // black-cell position — no element exists

    // 1. Full click sequence so React moves its hidden input to this cell.
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    cell.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
    cell.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }));
    await sleep(20);

    const keyOpts = {
      key: letter, code: `Key${letter}`,
      keyCode: letter.charCodeAt(0), which: letter.charCodeAt(0),
      bubbles: true, cancelable: true, view: window,
    };

    // 2. Standard key lifecycle on document (for any non-React listeners).
    document.dispatchEvent(new KeyboardEvent('keydown',  keyOpts));
    document.dispatchEvent(new KeyboardEvent('keypress', keyOpts));

    // 3. Fire an InputEvent on the active element.
    //    React's hidden <input> picks this up and commits the letter to state.
    if (document.activeElement) {
      document.activeElement.dispatchEvent(new InputEvent('input', {
        data: letter, inputType: 'insertText',
        bubbles: true, cancelable: true,
      }));
    }

    document.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
    await sleep(30);
    filled++;
  }

  return { success: true, filled };
}

async function handleDiagnose() {
  const nytTabs = await chrome.tabs.query({ url: 'https://www.nytimes.com/crosswords/game/*' });
  if (!nytTabs.length) { showStatus('No NYT crossword tab found.', 'error'); return; }

  const tab = nytTabs[0];
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await new Promise(r => setTimeout(r, 400));

  const diagOut = document.getElementById('diagOut');
  diagOut.textContent = 'Running…';
  diagOut.style.display = 'block';

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: diagnosePage,
    });
    diagOut.textContent = JSON.stringify(result, null, 2);
  } catch (err) {
    diagOut.textContent = 'Error: ' + err.message;
  }
}

// Runs in MAIN world — self-contained.
async function diagnosePage() {
  const cell0 = document.getElementById('cell-id-0');
  if (!cell0) {
    const allIds = Array.from(document.querySelectorAll('[id]')).map(e => e.id).filter(Boolean).slice(0, 20);
    return { error: 'cell-id-0 not found', sampleIds: allIds };
  }

  // Walk the React fiber tree upward from cell-id-0 collecting event handler names.
  const fiberKey = Object.keys(cell0).find(k =>
    k.startsWith('__reactFiber') || k.startsWith('__reactInternals')
  );
  const fiberHandlers = [];
  if (fiberKey) {
    let fiber = cell0[fiberKey];
    let depth = 0;
    while (fiber && depth < 50) {
      const props = fiber.memoizedProps;
      const typeName = typeof fiber.type === 'string' ? fiber.type
        : fiber.type?.displayName || fiber.type?.name || null;
      const handlers = props ? Object.keys(props).filter(k => /^on[A-Z]/.test(k)) : [];
      if (handlers.length || typeName) fiberHandlers.push({ depth, type: typeName, handlers });
      fiber = fiber.return;
      depth++;
    }
  }

  // Click cell-id-0 and observe what gets focused.
  cell0.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
  cell0.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window }));
  cell0.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window }));
  await new Promise(r => setTimeout(r, 150));

  const active = document.activeElement;

  // All inputs/textareas on the page.
  const inputs = Array.from(document.querySelectorAll('input, textarea')).map(el => ({
    tag: el.tagName, id: el.id, type: el.type,
    class: el.className?.toString?.().slice(0, 60),
    tabIndex: el.tabIndex,
    ariaHidden: el.getAttribute('aria-hidden'),
    isFocused: el === document.activeElement,
  }));

  // Any Redux-like store on window.
  const reduxKeys = Object.keys(window).filter(k => {
    try { const v = window[k]; return v && typeof v.dispatch === 'function' && typeof v.getState === 'function'; }
    catch { return false; }
  });

  // cell-id-0 element attributes.
  const cell0info = {
    tag: cell0.tagName,
    attrs: Object.fromEntries(cell0.getAttributeNames().map(a => [a, cell0.getAttribute(a)])),
    childTags: Array.from(cell0.children).map(c => c.tagName),
  };

  return {
    cell0: cell0info,
    fiberKeyFound: !!fiberKey,
    fiberHandlers,
    activeAfterClick: {
      tag: active?.tagName, id: active?.id,
      class: active?.className?.toString?.().slice(0, 60),
      type: active?.type, tabIndex: active?.tabIndex,
    },
    inputs,
    reduxKeys,
  };
}

function showStatus(message, type) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.className = `status ${type}`;
}

function clearStatus() {
  const el = document.getElementById('status');
  el.textContent = '';
  el.className = 'status';
}
