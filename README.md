# UKG Timesheet Buddy

A small Chrome extension that fills the UKG Pro Workforce Management Classic
timesheet (`wfm-time-web2.ultipro.com/#/timesheet`) for you. You give it a
**start time** and a **lunch start time**; it fills every **weekday** currently
shown on the page with the same schedule.

It **only fills** — it never clicks Save, Submit, or Approve. You always review
and save the timesheet yourself.

## The schedule it fills

Every weekday gets three entries totalling **7.5 h of work + a 30 min lunch**:

| Code | From | To |
| --- | --- | --- |
| `WRK` | start | lunch |
| `MEAL` | lunch | lunch + 30 min |
| `WRK` | lunch + 30 min | start + 8 h |

Example with start `8:30a` and lunch `11:30a`:

```
WRK   8:30a – 11:30a
MEAL 11:30a – 12:00p
WRK  12:00p –  4:30p   (7.5h work + 30min lunch)
```

The end time is always `start + 8h`, so the total is always 7.5 h worked
regardless of when you take lunch.

## Install (unpacked)

1. Unzip / copy this folder somewhere stable.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and pick this folder.

## Use

1. Open the timesheet page in Chrome and let it fully load.
2. Make sure you're in **Day Details** view (so individual entry rows are visible).
3. Navigate to the pay period / week you want to fill.
4. Click the extension icon, set your **Start time** and **Lunch start**.
5. Check the preview, click **Fill weekdays**, watch the log, then **review and Save manually**.

## What it does, briefly

- Reads the day rows the page is currently showing
  (`td[data-automation="dayCell"]`), e.g. "Mon 22", "Fri 26".
- For each row:
  - **Weekends** (Sat/Sun) are skipped.
  - Rows that already have any entry are skipped.
  - Otherwise it clicks **Add Time** enough times to get three editable rows,
    then for each row opens the Time Code dropdown, picks the code, and sets the
    Start/End time inputs (firing `input` + `blur` so Angular's `wsk-time-input`
    accepts the value).
- Reports a summary. **Does not save.**

## Limitations

- Only covers what's currently rendered. If you want to fill another week / pay
  period, navigate to it and run the extension again.
- The page must be in Day Details view (or another view that shows individual
  start/end rows). The "Hide Details" view doesn't expose the inputs.
- Weekday vs. weekend is detected from the day label (e.g. "Fri 26"). Rows where
  the weekday can't be read are skipped and noted in the log.

## Troubleshooting

- **"No timesheet day rows found"** — the page hadn't finished loading, or
  you're on a non-timesheet page, or you're in a view that hides per-day rows.
- **"Time code 'X' not found in dropdown"** — this employee/policy doesn't have
  `WRK` or `MEAL` available under those exact names. Check the dropdown manually.
- **Time looks wrong after fill** — UKG parses the time on blur. If you see raw
  text, click into the field and tab out; the page will reformat. Re-run if needed.
- **Validation error in the preview** — lunch must start after the work start
  time, and there must be work left after lunch (so at most 7.5 h before lunch).
