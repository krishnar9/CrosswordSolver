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
  if (!nytTabs.length) return;
  const tab = nytTabs[0];

  try {
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    
    // 1. Map the grid coordinates ONCE
    const [{ result: gridMap }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const mapping = {};
        document.querySelectorAll('[id^="cell-id-"]').forEach(el => {
          const rect = el.getBoundingClientRect();
          mapping[el.id.replace('cell-id-', '')] = {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
          };
        });
        return mapping;
      }
    });

    const rows = parsedGrid.length;
    const cols = parsedGrid[0].length;

for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const index = r * cols + c;
    const letter = parsedGrid[r][c];
    const coords = gridMap[index];

    if (letter && /^[A-Z]$/.test(letter) && coords) {
      
      // 1. CLICK: Explicitly move the focus. 
      // We MUST await these to ensure the focus 'lands' before we type.
      await sendClick(tab.id, coords.x, coords.y);
      
      // 2. DELAY: Tiny gap for the focus state to update (React needs this)
      await new Promise(r => setTimeout(r, 15));

      // 3. KEY SEQUENCE: Send Down, then Up. 
      // Splitting these is more 'human' and prevents key-jamming.
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        text: letter,
        unmodifiedText: letter,
        key: letter,
        code: `Key${letter}`,
        windowsVirtualKeyCode: letter.charCodeAt(0)
      });

      // The 'char' event is what actually puts the text in the box
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'char',
        text: letter,
      });

      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: letter,
        code: `Key${letter}`
      });

      // 4. VERIFICATION DELAY:
      // This is the 'Speed/Stability' sweet spot. 
      // Start at 25ms. If it still skips, move to 35ms.
      await new Promise(r => setTimeout(r, 25));
    }
  }
}
    showStatus('Grid filled at warp speed!', 'success');
  } finally {
    chrome.debugger.detach({ tabId: tab.id });
  }
}

async function sendClick(tabId, x, y) {
  const p = { x, y, button: 'left', clickCount: 1 };
  // We await the click because focus movement is slow, but we only do this 
  // once per "word," not once per "letter."
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...p });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...p });
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
