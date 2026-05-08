// popup.js — runs in the extension popup.
// Parses the CSV, then injects the page-level filler with the parsed rows.

const $ = (id) => document.getElementById(id);
const logEl = $('log');
let parsedRows = null;

function log(msg, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
  logEl.innerHTML = '';
  logEl.classList.remove('muted');
}

// Minimal CSV parser. Handles quoted fields and commas-in-quotes; not a full RFC parser
// but enough for the timesheet CSV described in the README.
function parseCSV(text) {
  const lines = [];
  let cur = [];
  let field = '';
  let inQuote = false;

  const pushField = () => { cur.push(field); field = ''; };
  const pushLine = () => { lines.push(cur); cur = []; };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuote = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') pushField();
      else if (c === '\r') { /* ignore */ }
      else if (c === '\n') { pushField(); pushLine(); }
      else field += c;
    }
  }
  // last field/line
  if (field.length > 0 || cur.length > 0) { pushField(); pushLine(); }

  // strip empty trailing lines
  while (lines.length && lines[lines.length - 1].every(f => f.trim() === '')) lines.pop();

  if (lines.length === 0) throw new Error('CSV is empty.');

  const header = lines[0].map(h => h.trim().toLowerCase());
  const required = ['date', 'time_code', 'start', 'end'];
  for (const r of required) {
    if (!header.includes(r)) throw new Error(`CSV is missing required column: ${r}`);
  }
  const idx = Object.fromEntries(required.map(r => [r, header.indexOf(r)]));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (row.every(f => f.trim() === '')) continue;
    const obj = {
      date:      (row[idx.date]      || '').trim(),
      time_code: (row[idx.time_code] || '').trim(),
      start:     (row[idx.start]     || '').trim(),
      end:       (row[idx.end]       || '').trim(),
    };
    if (!obj.date || !obj.time_code || !obj.start || !obj.end) {
      throw new Error(`Row ${i + 1} is missing a value: ${JSON.stringify(obj)}`);
    }
    // Validate date-ish (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(obj.date)) {
      throw new Error(`Row ${i + 1}: date must be YYYY-MM-DD, got "${obj.date}"`);
    }
    // Validate HH:MM (24h)
    for (const k of ['start', 'end']) {
      if (!/^\d{1,2}:\d{2}$/.test(obj[k])) {
        throw new Error(`Row ${i + 1}: ${k} must be HH:MM, got "${obj[k]}"`);
      }
    }
    rows.push(obj);
  }
  if (rows.length === 0) throw new Error('CSV has a header but no data rows.');
  return rows;
}

// Group rows by date (YYYY-MM-DD -> [{time_code,start,end}, ...])
function groupByDate(rows) {
  const byDate = {};
  for (const r of rows) {
    const day = parseInt(r.date.slice(8, 10), 10); // day-of-month
    const key = r.date;
    if (!byDate[key]) byDate[key] = { day, entries: [] };
    byDate[key].entries.push({ time_code: r.time_code, start: r.start, end: r.end });
  }
  return byDate;
}

$('csv').addEventListener('change', async (e) => {
  clearLog();
  parsedRows = null;
  $('fill').disabled = true;
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const rows = parseCSV(text);
    parsedRows = rows;
    log(`Loaded ${rows.length} entries from ${file.name}`, 'ok');
    const grouped = groupByDate(rows);
    const dates = Object.keys(grouped).sort();
    log(`Spans ${dates.length} day(s): ${dates[0]} … ${dates[dates.length - 1]}`);
    $('fill').disabled = false;
  } catch (err) {
    log(`CSV error: ${err.message}`, 'err');
  }
});

$('clearLog').addEventListener('click', clearLog);

$('fill').addEventListener('click', async () => {
  if (!parsedRows) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    log('No active tab.', 'err');
    return;
  }
  if (!/ultipro\.com/.test(tab.url)) {
    log('Active tab is not an UKG/UltiPro page. Open the timesheet first.', 'err');
    return;
  }

  log(`Filling on tab: ${tab.url}`);
  $('fill').disabled = true;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN', // run in page world so we share Angular's DOM access
      func: pageFill,
      args: [parsedRows]
    });
    const result = results && results[0] && results[0].result;
    if (!result) {
      log('No result returned from page.', 'warn');
    } else {
      const { logs, summary, error } = result;
      for (const entry of logs || []) log(entry.msg, entry.cls || '');
      if (error) log(`Error: ${error}`, 'err');
      if (summary) log(summary, 'ok');
    }
  } catch (err) {
    log(`Injection failed: ${err.message}`, 'err');
  } finally {
    $('fill').disabled = false;
  }
});

// ---------------------------------------------------------------------------
// pageFill — runs in the PAGE's world, so it has direct DOM/AngularJS access.
// Returns { logs: [{msg, cls}], summary, error } back to the popup.
// CRITICAL: This function must NOT click Save / Submit / Approve. Fill only.
// ---------------------------------------------------------------------------
async function pageFill(rows) {
  const logs = [];
  const log = (msg, cls) => logs.push({ msg, cls });

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Wait for a condition with a timeout. Returns the truthy result, or null.
  async function waitFor(fn, { timeout = 4000, interval = 50 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  // Trigger the events Angular needs. For wsk-time-input, the input value is
  // bound via ng-model with parsing on blur, so we set the value, fire input,
  // then blur — that's what makes Angular accept it.
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  function setInputValue(input, value) {
    nativeInputValueSetter.call(input, value);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function fireBlur(input) {
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  // Group CSV rows by date (YYYY-MM-DD)
  const byDate = {};
  for (const r of rows) {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  }
  const dates = Object.keys(byDate).sort();

  // Find all day rows currently rendered. Each day's first <td> has
  // data-automation="dayCell" and contains text like "Fri 1" or "Mon 12".
  function collectDayCells() {
    const cells = Array.from(document.querySelectorAll('td[data-automation="dayCell"]'));
    return cells.map(td => {
      const text = (td.textContent || '').trim();
      // Match "Mon 4", "Tue 12", "Fri 1" — pull the trailing day number
      const m = text.match(/(\d{1,2})\b\s*$/m);
      const dayNum = m ? parseInt(m[1], 10) : null;
      return { td, text, dayNum };
    });
  }

  // For a given dayCell, walk up to the row's <tr> ancestor whose colspan-4
  // <td> wraps the timesheet-entry-detail block; we need the surrounding
  // entry-detail container so we can find inputs/dropdowns just for THIS day.
  function entryDetailForDayCell(dayCellTd) {
    // The structure is: <tr> dayCell <td>(addEditButton)</td> <td>schedule</td>
    //                   <td colspan="4"><timesheet-entry-detail>...</></td>
    // The dayCell is in the first <tr> of a day; for "Day Details" view, all of
    // a day's detail rows live inside that single <timesheet-entry-detail>.
    const tr = dayCellTd.closest('tr');
    if (!tr) return null;
    const detail = tr.querySelector('timesheet-entry-detail');
    return detail || null;
  }

  // Within an entry-detail node, find the rows that represent existing edits.
  // Each edit row has a Start/End time pair (via wsk-time-input + timeInput)
  // and a time-code ui-select dropdown.
  function findEditRows(entryDetail) {
    if (!entryDetail) return [];
    // Look for wsk-time-input with name="startTime" — each edit row has exactly one.
    const startInputs = Array.from(entryDetail.querySelectorAll('wsk-time-input[name="startTime"]'));
    return startInputs.map(start => {
      // Find nearest containing row element. Use the closest <tr>.
      const tr = start.closest('tr');
      if (!tr) return null;
      const startInput = tr.querySelector('wsk-time-input[name="startTime"] input[data-automation="timeInput"]');
      const endInput   = tr.querySelector('wsk-time-input[name="time"]      input[data-automation="timeInput"]');
      const tcDropdown = tr.querySelector('[data-automation="laborMetricTIME_CODEDropdown"]');
      return { tr, startInput, endInput, tcDropdown };
    }).filter(Boolean);
  }

  // Decide if a row is "non-empty" — i.e., already has data we shouldn't touch.
  // The page pre-fills the Time Code dropdown (e.g. "WRK") on empty rows, so
  // the dropdown alone is NOT a signal of real data. Only the time inputs
  // count: if both Start and End are blank, the row is empty.
  function rowHasData(row) {
    const sv = row.startInput ? (row.startInput.value || '').trim() : '';
    const ev = row.endInput   ? (row.endInput.value   || '').trim() : '';
    return Boolean(sv || ev);
  }

  function dayHasAnyData(rows_) {
    return rows_.some(rowHasData);
  }

  // Click the "Add Time" plus button next to the day, to spawn a new edit row.
  async function clickAddEditFor(dayCellTd) {
    const tr = dayCellTd.closest('tr');
    if (!tr) return false;
    const btn = tr.querySelector('a[data-automation="addEditButton"]');
    if (!btn) return false;
    btn.click();
    await sleep(120);
    return true;
  }

  // Pick a time code from the angular-ui-select dropdown by visible text.
  async function selectTimeCode(tcDropdown, code) {
    if (!tcDropdown) throw new Error('No time-code dropdown for row');
    // If already selected with the right code, do nothing.
    const display = tcDropdown.querySelector('.ui-select-match-text [ng-bind]') ||
                    tcDropdown.querySelector('.ui-select-match-text');
    const current = display ? (display.textContent || '').trim() : '';
    if (current && current.toLowerCase() === code.toLowerCase()) return true;

    // Open the dropdown.
    const toggle = tcDropdown.querySelector('.ui-select-toggle');
    if (!toggle) throw new Error('No toggle on time-code dropdown');
    toggle.click();

    // The choices appear in a <ul> within the dropdown. Wait for them.
    const choice = await waitFor(() => {
      const items = tcDropdown.querySelectorAll('.ui-select-choices li, .ui-select-choices-row, [role="option"]');
      for (const it of items) {
        const txt = (it.textContent || '').trim();
        if (txt && txt.toLowerCase() === code.toLowerCase()) return it;
      }
      // Fallback: anything containing the code as a whole word
      for (const it of items) {
        const txt = (it.textContent || '').trim();
        if (new RegExp('\\b' + code.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '\\b', 'i').test(txt)) return it;
      }
      return null;
    }, { timeout: 2500 });

    if (!choice) {
      // Close the dropdown so we don't leave the UI in a weird state
      try { toggle.click(); } catch (_) {}
      throw new Error(`Time code "${code}" not found in dropdown`);
    }

    // The clickable element is usually the inner span/div, but clicking the li works too.
    const clickTarget = choice.querySelector('.ui-select-choices-row-inner') ||
                        choice.querySelector('a, span, div') ||
                        choice;
    clickTarget.click();
    await sleep(80);
    return true;
  }

  async function fillRow(row, entry) {
    // 1) time code
    await selectTimeCode(row.tcDropdown, entry.time_code);

    // 2) start time
    if (!row.startInput) throw new Error('No start-time input');
    row.startInput.focus();
    setInputValue(row.startInput, entry.start);
    fireBlur(row.startInput);
    await sleep(60);

    // 3) end time
    if (!row.endInput) throw new Error('No end-time input');
    row.endInput.focus();
    setInputValue(row.endInput, entry.end);
    fireBlur(row.endInput);
    await sleep(60);
  }

  // -------- main --------
  let cells;
  try {
    cells = collectDayCells();
  } catch (e) {
    return { logs, error: `Could not read timesheet rows: ${e.message}` };
  }

  if (cells.length === 0) {
    return {
      logs,
      error: 'No timesheet day rows found on this page. Make sure the timesheet is fully loaded and that "Day Details" view is selected so individual entry rows are visible.'
    };
  }

  log(`Found ${cells.length} day row(s) on the page.`);

  let filledDays = 0;
  let skippedExisting = 0;
  let missingDays = 0;
  let totalEntries = 0;
  let errors = 0;

  for (const date of dates) {
    const entries = byDate[date];
    const dayNum = parseInt(date.slice(8, 10), 10);
    const cell = cells.find(c => c.dayNum === dayNum);
    if (!cell) {
      missingDays++;
      log(`· ${date}: no row on this page (day ${dayNum} not visible) — skipped.`, 'warn');
      continue;
    }

    const detail = entryDetailForDayCell(cell.td);
    let existingRows = findEditRows(detail);

    if (existingRows.length && dayHasAnyData(existingRows)) {
      skippedExisting++;
      log(`· ${date}: already has entries — skipped.`, 'warn');
      continue;
    }

    // We need exactly entries.length editable rows. The page usually starts
    // with one empty row already; click "Add Time" to make the rest.
    let needed = entries.length;
    let available = existingRows.length || 0;

    // Edge case: an entry-detail with zero start-time inputs. Click Add to spawn one.
    while (available < 1) {
      const ok = await clickAddEditFor(cell.td);
      if (!ok) break;
      existingRows = findEditRows(detail);
      available = existingRows.length;
      if (available >= 1) break;
    }

    while (available < needed) {
      const ok = await clickAddEditFor(cell.td);
      if (!ok) {
        log(`  · ${date}: couldn't find "Add Time" button to add row ${available + 1}.`, 'err');
        errors++;
        break;
      }
      // Wait for the new row to appear.
      const before = available;
      await waitFor(() => {
        existingRows = findEditRows(detail);
        return existingRows.length > before;
      }, { timeout: 1500 });
      available = existingRows.length;
      if (available === before) {
        log(`  · ${date}: row didn't appear after clicking Add Time.`, 'err');
        errors++;
        break;
      }
    }

    if (available < needed) {
      log(`· ${date}: only ${available}/${needed} rows available — partial fill.`, 'warn');
    }

    // Fill in order. existingRows order matches DOM order.
    const fillCount = Math.min(available, needed);
    let dayOk = true;
    for (let i = 0; i < fillCount; i++) {
      try {
        await fillRow(existingRows[i], entries[i]);
        totalEntries++;
      } catch (e) {
        dayOk = false;
        errors++;
        log(`  · ${date} entry ${i + 1} (${entries[i].time_code} ${entries[i].start}-${entries[i].end}): ${e.message}`, 'err');
      }
    }

    if (dayOk && fillCount === needed) {
      filledDays++;
      log(`✓ ${date}: filled ${fillCount} entr${fillCount === 1 ? 'y' : 'ies'}.`, 'ok');
    } else if (fillCount > 0) {
      filledDays++;
      log(`~ ${date}: filled ${fillCount}/${needed} entr${needed === 1 ? 'y' : 'ies'}.`, 'warn');
    }
  }

  const summaryParts = [
    `Filled ${filledDays} day(s), ${totalEntries} total entr${totalEntries === 1 ? 'y' : 'ies'}.`
  ];
  if (skippedExisting) summaryParts.push(`${skippedExisting} skipped (already had data).`);
  if (missingDays)     summaryParts.push(`${missingDays} day(s) not on this page.`);
  if (errors)          summaryParts.push(`${errors} error(s) — see log.`);
  summaryParts.push('Nothing was submitted; review and Save manually.');

  return { logs, summary: summaryParts.join(' ') };
}
