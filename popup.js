// popup.js — runs in the extension popup.
// Takes a start time + lunch start time, derives a fixed 7.5h-work + 30min-lunch
// schedule, and fills every weekday on the visible timesheet with it.

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const previewEl = $('preview');

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

// --- time helpers -----------------------------------------------------------

const WORK_MINUTES = 7.5 * 60;   // 450
const LUNCH_MINUTES = 30;
const DAY_MINUTES = WORK_MINUTES + LUNCH_MINUTES; // start -> end span = 8h

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function addMinutes(hhmm, mins) {
  let total = toMinutes(hhmm) + mins;
  total = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 24h "HH:MM" -> 12h "h:mma" / "h:mmp" to match the UKG cell format (e.g. 8:30a, 12:00p).
function to12h(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h < 12 ? 'a' : 'p';
  let hr = h % 12;
  if (hr === 0) hr = 12;
  return `${hr}:${String(m).padStart(2, '0')}${period}`;
}

// Build the three entries from start + lunch. Returns { entries, error }.
function buildEntries(start, lunch) {
  if (!start || !lunch) return { error: 'Enter both a start time and a lunch start time.' };

  const startMin = toMinutes(start);
  const lunchMin = toMinutes(lunch);
  const morning = lunchMin - startMin;        // first WRK block
  const afternoon = WORK_MINUTES - morning;   // second WRK block

  if (morning <= 0) return { error: 'Lunch must start after the work start time.' };
  if (afternoon <= 0) return { error: 'Lunch is too late — there must be work left after lunch (max 7.5h before lunch).' };
  if (startMin + DAY_MINUTES > 1440) return { error: 'Start time is too late — the day would run past midnight.' };

  const mealEnd = addMinutes(lunch, LUNCH_MINUTES);
  const workEnd = addMinutes(start, DAY_MINUTES);

  const entries = [
    { time_code: 'WRK',  start: to12h(start),   end: to12h(lunch) },
    { time_code: 'MEAL', start: to12h(lunch),   end: to12h(mealEnd) },
    { time_code: 'WRK',  start: to12h(mealEnd), end: to12h(workEnd) },
  ];
  return { entries };
}

function renderPreview() {
  const { entries, error } = buildEntries($('start').value, $('lunch').value);
  if (error) {
    previewEl.classList.add('bad');
    previewEl.textContent = error;
    $('fill').disabled = true;
    return;
  }
  previewEl.classList.remove('bad');
  previewEl.textContent = entries
    .map(e => `${e.time_code.padEnd(4)} ${e.start.padStart(6)} – ${e.end}`)
    .join('\n') + '\n(7.5h work + 30min lunch)';
  $('fill').disabled = false;
}

$('start').addEventListener('input', renderPreview);
$('lunch').addEventListener('input', renderPreview);
$('clearLog').addEventListener('click', clearLog);
renderPreview();

// --- fill action ------------------------------------------------------------

$('fill').addEventListener('click', async () => {
  const { entries, error } = buildEntries($('start').value, $('lunch').value);
  if (error) { log(error, 'err'); return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) { log('No active tab.', 'err'); return; }
  if (!/ultipro\.com/.test(tab.url)) {
    log('Active tab is not an UKG/UltiPro page. Open the timesheet first.', 'err');
    return;
  }

  clearLog();
  log(`Filling weekdays on: ${tab.url}`);
  $('fill').disabled = true;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN', // run in page world so we share Angular's DOM access
      func: pageFill,
      args: [entries]
    });
    const result = results && results[0] && results[0].result;
    if (!result) {
      log('No result returned from page.', 'warn');
    } else {
      const { logs, summary, error: pageErr } = result;
      for (const entry of logs || []) log(entry.msg, entry.cls || '');
      if (pageErr) log(`Error: ${pageErr}`, 'err');
      if (summary) log(summary, 'ok');
    }
  } catch (err) {
    log(`Injection failed: ${err.message}`, 'err');
  } finally {
    renderPreview();
  }
});

// ---------------------------------------------------------------------------
// pageFill — runs in the PAGE's world, so it has direct DOM/AngularJS access.
// Fills every visible WEEKDAY row with the same `entries`.
// Returns { logs: [{msg, cls}], summary, error } back to the popup.
// CRITICAL: This function must NOT click Save / Submit / Approve. Fill only.
// ---------------------------------------------------------------------------
async function pageFill(entries) {
  const logs = [];
  const log = (msg, cls) => logs.push({ msg, cls });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function waitFor(fn, { timeout = 4000, interval = 50 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

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

  const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
  const WEEKENDS = ['sat', 'sun'];

  // Each day's first <td> has data-automation="dayCell" with text like "Fri 26".
  function collectDayCells() {
    const cells = Array.from(document.querySelectorAll('td[data-automation="dayCell"]'));
    return cells.map(td => {
      const text = (td.textContent || '').trim();
      const dm = text.match(/(\d{1,2})\b\s*$/m);
      const dayNum = dm ? parseInt(dm[1], 10) : null;
      const wm = text.match(/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i);
      const weekday = wm ? wm[1].toLowerCase() : null;
      return { td, text, dayNum, weekday };
    });
  }

  function entryDetailForDayCell(dayCellTd) {
    const tr = dayCellTd.closest('tr');
    if (!tr) return null;
    return tr.querySelector('timesheet-entry-detail') || null;
  }

  function findEditRows(entryDetail) {
    if (!entryDetail) return [];
    const startInputs = Array.from(entryDetail.querySelectorAll('wsk-time-input[name="startTime"]'));
    return startInputs.map(start => {
      const tr = start.closest('tr');
      if (!tr) return null;
      const startInput = tr.querySelector('wsk-time-input[name="startTime"] input[data-automation="timeInput"]');
      const endInput   = tr.querySelector('wsk-time-input[name="time"]      input[data-automation="timeInput"]');
      const tcDropdown = tr.querySelector('[data-automation="laborMetricTIME_CODEDropdown"]');
      return { tr, startInput, endInput, tcDropdown };
    }).filter(Boolean);
  }

  // The page pre-fills the Time Code dropdown (e.g. "WRK") on empty rows, so the
  // dropdown alone isn't a signal of real data. Only the time inputs count.
  function rowHasData(row) {
    const sv = row.startInput ? (row.startInput.value || '').trim() : '';
    const ev = row.endInput   ? (row.endInput.value   || '').trim() : '';
    return Boolean(sv || ev);
  }
  function dayHasAnyData(rows_) {
    return rows_.some(rowHasData);
  }

  async function clickAddEditFor(dayCellTd) {
    const tr = dayCellTd.closest('tr');
    if (!tr) return false;
    const btn = tr.querySelector('a[data-automation="addEditButton"]');
    if (!btn) return false;
    btn.click();
    await sleep(120);
    return true;
  }

  async function selectTimeCode(tcDropdown, code) {
    if (!tcDropdown) throw new Error('No time-code dropdown for row');
    const display = tcDropdown.querySelector('.ui-select-match-text [ng-bind]') ||
                    tcDropdown.querySelector('.ui-select-match-text');
    const current = display ? (display.textContent || '').trim() : '';
    if (current && current.toLowerCase() === code.toLowerCase()) return true;

    const toggle = tcDropdown.querySelector('.ui-select-toggle');
    if (!toggle) throw new Error('No toggle on time-code dropdown');
    toggle.click();

    const choice = await waitFor(() => {
      const items = tcDropdown.querySelectorAll('.ui-select-choices li, .ui-select-choices-row, [role="option"]');
      for (const it of items) {
        const txt = (it.textContent || '').trim();
        if (txt && txt.toLowerCase() === code.toLowerCase()) return it;
      }
      for (const it of items) {
        const txt = (it.textContent || '').trim();
        if (new RegExp('\\b' + code.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '\\b', 'i').test(txt)) return it;
      }
      return null;
    }, { timeout: 2500 });

    if (!choice) {
      try { toggle.click(); } catch (_) {}
      throw new Error(`Time code "${code}" not found in dropdown`);
    }

    const clickTarget = choice.querySelector('.ui-select-choices-row-inner') ||
                        choice.querySelector('a, span, div') ||
                        choice;
    clickTarget.click();
    await sleep(80);
    return true;
  }

  async function fillRow(row, entry) {
    await selectTimeCode(row.tcDropdown, entry.time_code);

    if (!row.startInput) throw new Error('No start-time input');
    row.startInput.focus();
    setInputValue(row.startInput, entry.start);
    fireBlur(row.startInput);
    await sleep(60);

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
      error: 'No timesheet day rows found. Make sure the timesheet is fully loaded and "Day Details" view is selected so per-day entry rows are visible.'
    };
  }

  log(`Found ${cells.length} day row(s) on the page.`);

  let filledDays = 0;
  let skippedExisting = 0;
  let skippedWeekend = 0;
  let skippedUnknown = 0;
  let totalEntries = 0;
  let errors = 0;
  const needed = entries.length;

  for (const cell of cells) {
    const label = cell.text.replace(/\s+/g, ' ').trim() || `day ${cell.dayNum ?? '?'}`;

    if (cell.weekday && WEEKENDS.includes(cell.weekday)) {
      skippedWeekend++;
      continue;
    }
    if (!cell.weekday || !WEEKDAYS.includes(cell.weekday)) {
      skippedUnknown++;
      log(`· ${label}: couldn't tell if it's a weekday — skipped.`, 'warn');
      continue;
    }

    const detail = entryDetailForDayCell(cell.td);
    let existingRows = findEditRows(detail);

    if (existingRows.length && dayHasAnyData(existingRows)) {
      skippedExisting++;
      log(`· ${label}: already has entries — skipped.`, 'warn');
      continue;
    }

    let available = existingRows.length || 0;

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
        log(`  · ${label}: couldn't find "Add Time" button to add row ${available + 1}.`, 'err');
        errors++;
        break;
      }
      const before = available;
      await waitFor(() => {
        existingRows = findEditRows(detail);
        return existingRows.length > before;
      }, { timeout: 1500 });
      available = existingRows.length;
      if (available === before) {
        log(`  · ${label}: row didn't appear after clicking Add Time.`, 'err');
        errors++;
        break;
      }
    }

    const fillCount = Math.min(available, needed);
    let dayOk = true;
    for (let i = 0; i < fillCount; i++) {
      try {
        await fillRow(existingRows[i], entries[i]);
        totalEntries++;
      } catch (e) {
        dayOk = false;
        errors++;
        log(`  · ${label} entry ${i + 1} (${entries[i].time_code} ${entries[i].start}-${entries[i].end}): ${e.message}`, 'err');
      }
    }

    if (dayOk && fillCount === needed) {
      filledDays++;
      log(`✓ ${label}: filled ${fillCount} entries.`, 'ok');
    } else if (fillCount > 0) {
      filledDays++;
      log(`~ ${label}: filled ${fillCount}/${needed} entries.`, 'warn');
    }
  }

  const summaryParts = [
    `Filled ${filledDays} weekday(s), ${totalEntries} total entries.`
  ];
  if (skippedExisting) summaryParts.push(`${skippedExisting} skipped (already had data).`);
  if (skippedWeekend)  summaryParts.push(`${skippedWeekend} weekend day(s) skipped.`);
  if (skippedUnknown)  summaryParts.push(`${skippedUnknown} day(s) skipped (unknown weekday).`);
  if (errors)          summaryParts.push(`${errors} error(s) — see log.`);
  summaryParts.push('Nothing was submitted; review and Save manually.');

  return { logs, summary: summaryParts.join(' ') };
}
