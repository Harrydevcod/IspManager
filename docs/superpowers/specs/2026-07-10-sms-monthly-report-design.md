# SMS monthly report design

**Date:** July 10, 2026

## Goal

Change the SMS delivery report in **Configurações > SMS** from lifetime totals
to totals for one selected calendar month.

## Product decisions

- Assign each SMS to the month in which it was created in `sms_outbox`.
- Use the `Atlantic/Cape_Verde` business timezone, which is UTC-01:00 and has
  no daylight-saving transitions.
- Open the report on the current Cape Verde month.
- Let the administrator choose another month with a native month selector.
- Show all five existing cards with zero values when a month has no SMS.
- Keep the existing card order, labels, colors, and delivery states.

The report does not add a message list, export, custom date range, chart, or
comparison with another month.

## Architecture

Keep companion connectivity and reporting separate. The existing
`GET /api/sms/status` endpoint continues to return pairing and connectivity
state, but stops querying or returning lifetime counters. A new admin-only
endpoint returns monthly report data:

```http
GET /api/sms/report?month=2026-07
```

The response is:

```json
{
  "month": "2026-07",
  "timezone": "Atlantic/Cape_Verde",
  "counts": {
    "pendingDispatch": 0,
    "pendingApproval": 0,
    "sent": 0,
    "failed": 0,
    "rejected": 0
  }
}
```

The endpoint validates `month` as `YYYY-MM`, including a month from `01` to
`12`. Invalid or missing values return HTTP 400 and do not run a report query.

## Month boundaries and query

Convert the selected Cape Verde month to an inclusive UTC start and exclusive
UTC end before querying SQLite. For July 2026, the range is:

```text
start: 2026-07-01 01:00:00 UTC
end:   2026-08-01 01:00:00 UTC
```

Query `sms_outbox.created_at >= start AND sms_outbox.created_at < end`. Do not
apply a SQLite date function to `created_at`; keeping the indexed column bare
allows range scans. Count the current status of every message in that creation
cohort with the existing conditional aggregates.

Add a versioned migration with an index on `(created_at, status)`. The migration
must follow the repository's checksum-verified TypeScript migration system.

## Interface

The **Relatório de entrega de SMS** section contains a field labeled **Mês**
above the status cards. Use a native `input[type="month"]` and initialize it to
the current month in `Atlantic/Cape_Verde`.

Changing **Mês** requests only the monthly report endpoint. It must not repeat
the Android connectivity check. During a month change, hide stale totals and
show a compact loading state until the response for the selected month arrives.
The cards then render the returned values, including an all-zero response.

Keep the heading as a semantic `h3`. Associate the report section with the
heading and keep the existing `aria-label="Fila SMS"` on the card group.

## State and data flow

1. `SettingsModule` initializes the selected month with a Cape Verde-aware
   helper.
2. Opening the SMS tab loads connectivity through `/api/sms/status` and report
   data through `/api/sms/report?month=YYYY-MM`.
3. Changing the selector updates the selected month and reloads only the report.
4. `SmsTab` receives the selected month, report data, loading state, and change
   callback as props.
5. `SmsTab` renders cards only when the response belongs to the selected month.

Define a separate `SmsMonthlyReport` renderer type. Do not keep report counts
inside `SmsStatus`; connectivity state and monthly aggregates have different
lifecycles.

## Error handling

- Return HTTP 400 for a missing or invalid month.
- Return the standard authenticated error response to unauthorized callers.
- On a report network or server error, stop the loading state, keep stale totals
  hidden, and show the existing top-level settings error message.
- Ignore an older response if the administrator changes months before it
  finishes, so a slow request cannot overwrite the latest selection.

## Testing

Backend tests cover:

- Missing and invalid month values.
- Empty months returning five zero counters.
- Inclusion at the Cape Verde month start.
- Exclusion at the exclusive next-month boundary.
- A late local-month message whose UTC timestamp falls in the next UTC month.
- Counting each existing SMS status within the selected creation cohort.

Renderer tests cover:

- The selector and exact **Mês** label.
- The selected month value and change callback.
- Monthly counts rendering under the existing heading.
- Zero-count cards.
- Loading state hiding stale totals.
- A report response for a different month not rendering as current data.

Run the repository validation baseline after implementation:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npx.cmd tsc -p tsconfig.main.json
```
