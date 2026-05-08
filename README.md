# UKG Timesheet CSV Filler

A small Chrome extension that reads a CSV and fills it into the UKG Pro
Workforce Management Classic timesheet (`wfm-time-web2.ultipro.com/#/timesheet`).
It **only fills** — it never clicks Save, Submit, or Approve. You always
review and save the timesheet yourself.

## CSV format

Columns (header row required, exact names):

```
date,time_code,start,end
2026-05-04,WRK,07:50,12:00
2026-05-04,MEAL,12:00,12:30
2026-05-04,WRK,12:30,15:50
```

- `date` — `YYYY-MM-DD`. Only the day-of-month is matched against the page.
- `time_code` — must match a value available in the page's Time Code dropdown
  (e.g. `WRK`, `MEAL`). Case-insensitive.
- `start`, `end` — `HH:MM` in 24-hour clock.

You can have several rows for the same day; each becomes a separate entry row,
in CSV order. Days that already have any entries are skipped — fill an empty
day, save, then re-run for the next.

## Install (unpacked)

1. Unzip / copy this folder somewhere stable.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and pick this folder.

## Use

1. Open the timesheet page in Chrome and let it fully load.
2. Make sure you're in **Day Details** view (so individual entry rows are visible).
3. Navigate to the pay period you want to fill.
4. Click the extension icon, choose your CSV.
5. Click **Fill timesheet**, watch the log, then **review and Save manually**.

## What it does, briefly

- Iterates the day rows the page is currently showing
  (`td[data-automation="dayCell"]`).
- For each CSV date whose day-of-month matches a visible row:
  - If the row has any existing data, it's skipped.
  - Otherwise, clicks the **Add Time** button enough times to get one editable
    row per CSV entry, then for each row:
    - Opens the Time Code dropdown and clicks the matching choice.
    - Sets the Start/End time inputs and fires `input` + `blur` so Angular's
      `ng-model` and `wsk-time-input` accept the value.
- Reports a summary. **Does not save.**

## Limitations

- Only covers what's currently rendered. If your CSV spans multiple pay
  periods, navigate to each one and run the extension again.
- The page must be in Day Details view (or another view that shows individual
  start/end rows). The "Hide Details" view doesn't expose the inputs.
- Time Code dropdown matching is by exact visible text (case-insensitive),
  with a fallback to whole-word match if the exact label has extra description.

## Troubleshooting

- **"No timesheet day rows found"** — the page hadn't finished loading, or
  you're on a non-timesheet page, or you're in a view that hides per-day rows.
- **"Time code 'X' not found in dropdown"** — your CSV has a code that this
  employee/policy doesn't have available. Check the dropdown manually.
- **Time looks wrong after fill** — UKG parses the time on blur. If you see
  raw text like `0750` instead of `07:50`, click into the field and tab out;
  the page will reformat. Re-run if needed.
