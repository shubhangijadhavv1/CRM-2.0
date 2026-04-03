# Attendance Reconciliation Runbook

## Purpose

Repair historical duplicate attendance rows so the server can enforce a single canonical session per user/day.

## Preconditions

- Set `MONGO_URI` in environment.
- Stop scheduled scripts that modify attendance while reconciliation runs.
- Take a database backup/snapshot first.

## Commands

- Reconcile duplicates:
  - `npm run reconcile-attendance`
- Validate metrics consistency engine:
  - `npm run verify-attendance-consistency`

## Expected Outcome

- At most one active attendance session per `userId + date`.
- Non-canonical duplicate rows are marked `checked-out`.
- Canonical rows have merged intervals and recomputed `idleMinutes` + `totalWorkMinutes`.

## Post-run Validation

- Open staff dashboard and attendance view for the same user/day and verify:
  - login/logout
  - shift/work/idle/remaining
  - lunch/tea break durations
- Confirm desktop tray summary matches web summary for an active session.
