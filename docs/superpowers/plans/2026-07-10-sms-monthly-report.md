# SMS monthly report implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace lifetime SMS status totals with a Cape Verde-aware monthly
delivery report selected from **Configurações > SMS**.

**Architecture:** A shared pure utility owns month validation and UTC boundary
conversion. A dedicated admin-only report endpoint queries a date-indexed
`sms_outbox` cohort, while `SmsStatus` remains connectivity-only. The renderer
keeps report state separate from pairing state and ignores stale requests.

**Tech stack:** TypeScript, Fastify, SQLite, React 19, CSS, and Vitest.

## Global constraints

- Assign an SMS to the month of `sms_outbox.created_at`.
- Interpret calendar months in `Atlantic/Cape_Verde` (UTC-01:00).
- Default the selector to the current Cape Verde month.
- Keep the five existing card states, labels, colors, and order unchanged.
- Show five zero counters for an empty month.
- Do not add exports, charts, comparisons, custom ranges, or dependencies.
- Do not stage functional files automatically: this checkout already contains
  preexisting uncommitted SMS work in the same files.

---

### Task 1: Cape Verde month boundaries

**Files:**

- Create: `src/shared/sms-report.ts`
- Create: `src/shared/sms-report.test.ts`

**Interfaces:**

- Produces: `SMS_REPORT_TIMEZONE`, `smsReportMonthUtcRange(month)`, and
  `currentSmsReportMonth(now?)`.
- Consumed by: the report route and `SettingsModule`.

- [ ] **Step 1: Write failing utility tests**

Create `src/shared/sms-report.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { currentSmsReportMonth, smsReportMonthUtcRange } from './sms-report';

describe('smsReportMonthUtcRange', () => {
  test('converts a Cape Verde month to UTC boundaries', () => {
    expect(smsReportMonthUtcRange('2026-07')).toEqual({
      startUtc: '2026-07-01 01:00:00',
      endUtc: '2026-08-01 01:00:00'
    });
  });

  test('rolls December into the next year', () => {
    expect(smsReportMonthUtcRange('2026-12')).toEqual({
      startUtc: '2026-12-01 01:00:00',
      endUtc: '2027-01-01 01:00:00'
    });
  });

  test.each(['', '2026-00', '2026-13', '26-07', '2026-7'])(
    'rejects invalid month %j',
    (month) => expect(smsReportMonthUtcRange(month)).toBeNull()
  );
});

describe('currentSmsReportMonth', () => {
  test('uses the Cape Verde month at a UTC month boundary', () => {
    expect(currentSmsReportMonth(new Date('2026-07-01T00:30:00Z'))).toBe(
      '2026-06'
    );
  });
});
```

- [ ] **Step 2: Run the tests and verify the missing module fails**

Run:

```powershell
npx.cmd vitest run src/shared/sms-report.test.ts
```

Expected: FAIL because `./sms-report` does not exist.

- [ ] **Step 3: Implement the pure month utility**

Create `src/shared/sms-report.ts`:

```ts
export const SMS_REPORT_TIMEZONE = 'Atlantic/Cape_Verde';

export type SmsReportMonthRange = {
  startUtc: string;
  endUtc: string;
};

function formatSqliteUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function capeVerdeMonthBoundary(year: number, monthIndex: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, 1);
  date.setUTCHours(1, 0, 0, 0);
  return date;
}

export function smsReportMonthUtcRange(
  month: string
): SmsReportMonthRange | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return {
    startUtc: formatSqliteUtc(capeVerdeMonthBoundary(year, monthIndex)),
    endUtc: formatSqliteUtc(capeVerdeMonthBoundary(year, monthIndex + 1))
  };
}

export function currentSmsReportMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SMS_REPORT_TIMEZONE,
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('Cape Verde month is unavailable');
  return `${year}-${month}`;
}
```

- [ ] **Step 4: Run the utility tests**

Run:

```powershell
npx.cmd vitest run src/shared/sms-report.test.ts
```

Expected: 8 tests pass.

---

### Task 2: Indexed monthly report endpoint

**Files:**

- Create: `src/backend/db/migrations/0028_sms_outbox_created_status_index.ts`
- Modify: `src/backend/db/migrations/index.ts`
- Modify: `src/backend/db/migrate.test.ts`
- Modify: `src/backend/routes/sms.ts`
- Modify: `src/backend/routes/sms.test.ts`

**Interfaces:**

- Consumes: `smsReportMonthUtcRange()` and `SMS_REPORT_TIMEZONE` from Task 1.
- Produces: `GET /api/sms/report?month=YYYY-MM`.

- [ ] **Step 1: Add failing endpoint and index tests**

In `src/backend/routes/sms.test.ts`, add a helper that inserts a report row:

```ts
function seedSmsReportRow(status: string, createdAt: string) {
  db.prepare(`
    INSERT INTO sms_outbox
      (event_type, to_phone, body, status, created_at, updated_at)
    VALUES ('test', '+2389912233', 'teste', ?, ?, ?)
  `).run(status, createdAt, createdAt);
}
```

Add these tests inside `describe('SMS routes', ...)`:

```ts
test.each(['/api/sms/report', '/api/sms/report?month=2026-13'])(
  'GET %s rejects an invalid month',
  async (url) => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
  }
);

test('GET /api/sms/report returns zero counts for an empty month', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/sms/report?month=2026-07'
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    month: '2026-07',
    timezone: 'Atlantic/Cape_Verde',
    counts: {
      pendingDispatch: 0,
      pendingApproval: 0,
      sent: 0,
      failed: 0,
      rejected: 0
    }
  });
});

test('GET /api/sms/report uses Cape Verde creation-month boundaries', async () => {
  seedSmsReportRow('pending_dispatch', '2026-07-01 00:59:59');
  seedSmsReportRow('pending_approval', '2026-07-01 01:00:00');
  seedSmsReportRow('sent', '2026-07-15 12:00:00');
  seedSmsReportRow('failed', '2026-08-01 00:30:00');
  seedSmsReportRow('rejected', '2026-08-01 01:00:00');

  const response = await app.inject({
    method: 'GET',
    url: '/api/sms/report?month=2026-07'
  });

  expect(response.json().counts).toEqual({
    pendingDispatch: 0,
    pendingApproval: 1,
    sent: 1,
    failed: 1,
    rejected: 0
  });
});
```

In `src/backend/db/migrate.test.ts`, add:

```ts
test('creates the SMS monthly report index', () => {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const indexes = db.prepare(`PRAGMA index_list('sms_outbox')`).all() as Array<{
    name: string;
  }>;
  expect(indexes.map((index) => index.name)).toContain(
    'idx_sms_outbox_created_status'
  );
  db.close();
});
```

- [ ] **Step 2: Run the focused tests and verify the missing behavior fails**

Run:

```powershell
npx.cmd vitest run src/backend/routes/sms.test.ts src/backend/db/migrate.test.ts
```

Expected: report route tests return 404, and the index test fails.

- [ ] **Step 3: Add migration 0028 and register it**

Create `src/backend/db/migrations/0028_sms_outbox_created_status_index.ts`:

```ts
import type { Migration } from './types';

const migration: Migration = {
  version: 28,
  name: 'sms_outbox_created_status_index',
  sql: `
    CREATE INDEX IF NOT EXISTS idx_sms_outbox_created_status
      ON sms_outbox(created_at, status);
  `
};

export default migration;
```

Import `m0028` in `src/backend/db/migrations/index.ts` and append it to the
`migrations` array after `m0027`.

- [ ] **Step 4: Implement the monthly report route**

In `src/backend/routes/sms.ts`, import the Task 1 utilities and define:

```ts
const reportQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
});

type SmsReportCounts = {
  pendingDispatch: number | null;
  pendingApproval: number | null;
  sent: number | null;
  failed: number | null;
  rejected: number | null;
};
```

Remove the lifetime aggregate and `counts` property from `/api/sms/status`.
Then add this route after `/api/sms/status`:

```ts
app.get('/api/sms/report', adminOnly, async (request, reply) => {
  const parsed = reportQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Mes do relatorio SMS invalido' });
  }
  const range = smsReportMonthUtcRange(parsed.data.month);
  if (!range) {
    return reply.status(400).send({ error: 'Mes do relatorio SMS invalido' });
  }
  const counts = getSqliteDatabase().prepare(`
    SELECT
      SUM(CASE WHEN status='pending_dispatch' THEN 1 ELSE 0 END) AS pendingDispatch,
      SUM(CASE WHEN status='pending_approval' THEN 1 ELSE 0 END) AS pendingApproval,
      SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected
    FROM sms_outbox
    WHERE created_at >= ? AND created_at < ?
  `).get(range.startUtc, range.endUtc) as SmsReportCounts;
  return {
    month: parsed.data.month,
    timezone: SMS_REPORT_TIMEZONE,
    counts: {
      pendingDispatch: counts.pendingDispatch ?? 0,
      pendingApproval: counts.pendingApproval ?? 0,
      sent: counts.sent ?? 0,
      failed: counts.failed ?? 0,
      rejected: counts.rejected ?? 0
    }
  };
});
```

- [ ] **Step 5: Run the backend tests**

Run:

```powershell
npx.cmd vitest run src/shared/sms-report.test.ts src/backend/routes/sms.test.ts src/backend/db/migrate.test.ts
```

Expected: all focused utility, route, and migration tests pass.

---

### Task 3: Monthly report component

**Files:**

- Modify: `src/renderer/types.ts`
- Modify: `src/renderer/modules/settings/SmsTab.tsx`
- Modify: `src/renderer/modules/settings/SmsTab.test.tsx`
- Modify: `src/renderer/styles.css`

**Interfaces:**

- Produces: `SmsMonthlyReport` and four `SmsTab` report props:
  `smsReportMonth`, `smsReport`, `smsReportLoading`, and
  `onSmsReportMonthChange`.
- Consumed by: `SettingsModule` in Task 4.

- [ ] **Step 1: Rewrite renderer tests for monthly report behavior**

Update the test fixture to remove `counts` from `smsStatus` and add:

```ts
const smsReport: SmsMonthlyReport = {
  month: '2026-07',
  timezone: 'Atlantic/Cape_Verde',
  counts: {
    pendingDispatch: 1,
    pendingApproval: 2,
    sent: 3,
    failed: 4,
    rejected: 5
  }
};
```

Pass the four new report props from `renderSmsTab`. Assert that:

```ts
expect(html).toContain('type="month"');
expect(html).toContain('value="2026-07"');
expect(html).toContain('>Mês</span>');
expect(html).toContain('sms-queue-stat-value">3</span>');
```

Add tests that `smsReportLoading={true}` and a report whose `month` differs
from `smsReportMonth` do not render `aria-label="Fila SMS"`. Only the loading
case renders `A carregar relatório…`. Add an all-zero report fixture and assert
that all five zero values render. Keep the existing semantic heading assertions.

Test the change callback without a DOM dependency by calling `SmsTab` as a pure
component, recursively finding the `Field` element whose `type` prop is
`"month"`, invoking its `onChange` prop with `{ target: { value: '2026-08' } }`,
and asserting that `onSmsReportMonthChange` receives `"2026-08"`.

- [ ] **Step 2: Run the renderer test and verify the new props fail**

Run:

```powershell
npx.cmd vitest run src/renderer/modules/settings/SmsTab.test.tsx
```

Expected: FAIL because `SmsMonthlyReport` and the report props do not exist.

- [ ] **Step 3: Separate connectivity and report types**

Remove `counts` from `SmsStatus` in `src/renderer/types.ts`, then add:

```ts
export type SmsMonthlyReport = {
  month: string;
  timezone: 'Atlantic/Cape_Verde';
  counts: {
    pendingDispatch: number;
    pendingApproval: number;
    sent: number;
    failed: number;
    rejected: number;
  };
};
```

- [ ] **Step 4: Implement the month selector and report states**

Add the four report props to `SmsTabProps`, destructure them, and replace the
current report section with:

```tsx
<section className="sms-delivery-report" aria-labelledby="sms-delivery-report-title">
  <div className="sms-delivery-report-head">
    <h3 id="sms-delivery-report-title">Relatório de entrega de SMS</h3>
    <Field
      className="sms-report-month"
      label="Mês"
      type="month"
      value={smsReportMonth}
      onChange={(event) => {
        if (event.target.value) onSmsReportMonthChange(event.target.value);
      }}
    />
  </div>
  {smsReportLoading ? (
    <span className="sms-report-loading" role="status">
      A carregar relatório…
    </span>
  ) : smsReport?.month === smsReportMonth ? (
    <div className="sms-queue" role="group" aria-label="Fila SMS">
      {([
        { key: 'pendingDispatch', label: 'por entregar', tone: 'warn' },
        { key: 'pendingApproval', label: 'por aprovar', tone: 'neutral' },
        { key: 'sent', label: 'enviados', tone: 'success' },
        { key: 'failed', label: 'falhados', tone: 'danger' },
        { key: 'rejected', label: 'rejeitados', tone: 'danger' }
      ] as const).map(({ key, label, tone }) => (
        <div key={key} className="sms-queue-stat" data-tone={tone}>
          <span className="sms-queue-stat-value">{smsReport.counts[key]}</span>
          <span className="sms-queue-stat-label">{label}</span>
        </div>
      ))}
    </div>
  ) : null}
</section>
```

Render the report section independently of `smsStatus`; pairing connectivity
must not control report visibility.

- [ ] **Step 5: Add responsive report-header styles**

Add to `src/renderer/styles.css` beside `.sms-delivery-report`:

```css
.sms-delivery-report-head {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
}

.sms-report-month {
  width: min(12rem, 100%);
}

.sms-report-loading {
  min-height: var(--space-5);
  color: var(--text-3);
  font-size: var(--fs-sm);
}
```

- [ ] **Step 6: Run the renderer tests**

Run:

```powershell
npx.cmd vitest run src/renderer/modules/settings/SmsTab.test.tsx
```

Expected: all monthly report renderer tests pass.

---

### Task 4: Settings data flow and final verification

**Files:**

- Modify: `src/renderer/modules/SettingsModule.tsx`

**Interfaces:**

- Consumes: `currentSmsReportMonth()` and `SmsMonthlyReport`.
- Supplies: all Task 3 report props to `SmsTab`.

- [ ] **Step 1: Add separate monthly report state**

Import `currentSmsReportMonth`, import `SmsMonthlyReport`, and add:

```ts
const [smsReportMonth, setSmsReportMonth] = useState(currentSmsReportMonth);
const [smsReport, setSmsReport] = useState<SmsMonthlyReport | null>(null);
const [smsReportLoading, setSmsReportLoading] = useState(false);
const smsReportRequestRef = useRef(0);
```

- [ ] **Step 2: Implement stale-safe report loading**

Add this function beside `loadSmsStatus`:

```ts
async function loadSmsReport(month: string) {
  const requestId = ++smsReportRequestRef.current;
  setSmsReportLoading(true);
  setSmsReport(null);
  try {
    const response = await authFetch(
      `http://127.0.0.1:3001/api/sms/report?month=${encodeURIComponent(month)}`
    );
    const data = (await response.json().catch(() => ({}))) as
      | SmsMonthlyReport
      | { error?: string };
    if (requestId !== smsReportRequestRef.current) return;
    if (!response.ok || !('counts' in data)) {
      throw new Error(
        'error' in data && data.error
          ? data.error
          : 'Não foi possível carregar o relatório SMS.'
      );
    }
    setSmsReport(data);
  } catch (error) {
    if (requestId !== smsReportRequestRef.current) return;
    setSmsReport(null);
    setMessage({
      tone: 'error',
      text:
        error instanceof Error
          ? error.message
          : 'Não foi possível carregar o relatório SMS.',
      placement: 'top'
    });
  } finally {
    if (requestId === smsReportRequestRef.current) {
      setSmsReportLoading(false);
    }
  }
}
```

- [ ] **Step 3: Load reports only for the active SMS tab**

Replace the SMS-tab refresh effect with:

```ts
useEffect(() => {
  if (activeTab !== 'sms') return;
  void loadSmsStatus();
  void loadSmsReport(smsReportMonth);
}, [activeTab, smsReportMonth]);
```

The existing initial settings load may continue loading connectivity, but it
must not request a report until the SMS tab opens.

- [ ] **Step 4: Wire the monthly props into `SmsTab`**

Add these props to the existing `SmsTab` call:

```tsx
smsReportMonth={smsReportMonth}
smsReport={smsReport}
smsReportLoading={smsReportLoading}
onSmsReportMonthChange={setSmsReportMonth}
```

- [ ] **Step 5: Run all verification commands**

Run:

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd test
npx.cmd tsc -p tsconfig.main.json
git diff --check
```

Expected: typecheck, lint, main compilation, and all tests pass; Git reports no
whitespace errors.

- [ ] **Step 6: Review without staging overlapping user work**

Run:

```powershell
git status --short
git diff -- src/shared/sms-report.ts src/shared/sms-report.test.ts src/backend/db/migrations/0028_sms_outbox_created_status_index.ts src/backend/db/migrations/index.ts src/backend/db/migrate.test.ts src/backend/routes/sms.ts src/backend/routes/sms.test.ts src/renderer/types.ts src/renderer/modules/settings/SmsTab.tsx src/renderer/modules/settings/SmsTab.test.tsx src/renderer/modules/SettingsModule.tsx src/renderer/styles.css
```

Expected: the monthly report changes are present alongside the preserved SMS
work that already existed. Do not run `git add` for these overlapping files.
