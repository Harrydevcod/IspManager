# SMS delivery report heading implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the exact heading “Relatório de entrega de SMS” above the SMS
status cards in **Configurações > SMS**.

**Architecture:** Keep the change local to `SmsTab`. Render the existing status
cards and the new semantic heading inside a dedicated report section, and add
one focused CSS rule for hierarchy and spacing. Verify the rendered markup with
React's server renderer so the test requires no browser or new dependency.

**Tech stack:** React 19, TypeScript, CSS, Vitest, and `react-dom/server`.

## Global constraints

- The heading text must be exactly `Relatório de entrega de SMS`.
- Render the heading only when the SMS status cards are present.
- Keep every existing card, counter, label, color, state, and order unchanged.
- Do not add a subtitle, banner, date range, filter, dependency, or delivery
  state.
- Keep the existing `aria-label="Fila SMS"` on the status card group.

---

### Task 1: Label the SMS delivery report

**Files:**

- Create: `src/renderer/modules/settings/SmsTab.test.tsx`
- Modify: `src/renderer/modules/settings/SmsTab.tsx`
- Modify: `src/renderer/styles.css`

**Interfaces:**

- Consumes: the existing `SmsTab` props and `SmsStatus` shape.
- Produces: a semantic `h3` with ID `sms-delivery-report-title` and a report
  section linked to it through `aria-labelledby`.

- [ ] **Step 1: Write the failing renderer test**

Create `src/renderer/modules/settings/SmsTab.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { SmsStatus } from '../../types';
import { SmsTab } from './SmsTab';
import type { SettingsFormState } from './settingsForm';

const form = {
  smsCompanionEnabled: true,
  smsDispatchIntervalSeconds: '60',
  smsRetryGraceMinutes: '5',
  smsInvoiceIssuedTemplate: '',
  smsReceiptConfirmedTemplate: '',
  smsPaymentOverdueTemplate: '',
  smsSuspensionNoticeTemplate: ''
} as SettingsFormState;

const smsStatus: SmsStatus = {
  configured: true,
  paired: true,
  reachable: true,
  active: true,
  baseUrl: 'http://192.168.1.50:8765',
  deviceName: 'Telemóvel da loja',
  counts: {
    pendingDispatch: 1,
    pendingApproval: 2,
    sent: 3,
    failed: 4,
    rejected: 5
  }
};

function renderSmsTab(status: SmsStatus | null) {
  return renderToStaticMarkup(
    <SmsTab
      form={form}
      onUpdate={vi.fn()}
      onToggle={vi.fn()}
      smsStatus={status}
      smsPairing={{ baseUrl: '', deviceName: '' }}
      onPairingChange={vi.fn()}
      smsVerifying={false}
      smsPairingBusy={false}
      smsDetecting={false}
      smsQrDataUrl=""
      onDetectPhone={vi.fn()}
      onCreatePairing={vi.fn()}
      onRevokePairing={vi.fn()}
    />
  );
}

describe('SmsTab delivery report', () => {
  test('labels the SMS status cards with a semantic heading', () => {
    const html = renderSmsTab(smsStatus);

    expect(html).toContain(
      '<section class="sms-delivery-report" aria-labelledby="sms-delivery-report-title">'
    );
    expect(html).toContain(
      '<h3 id="sms-delivery-report-title">Relatório de entrega de SMS</h3>'
    );
    expect(html.indexOf('Relatório de entrega de SMS')).toBeLessThan(
      html.indexOf('aria-label="Fila SMS"')
    );
  });

  test('does not render the report heading without status cards', () => {
    expect(renderSmsTab(null)).not.toContain('Relatório de entrega de SMS');
  });
});
```

- [ ] **Step 2: Run the test and verify the missing heading fails**

Run:

```powershell
npx.cmd vitest run src/renderer/modules/settings/SmsTab.test.tsx
```

Expected: the first test fails because the rendered markup does not contain
`sms-delivery-report-title`; the second test passes.

- [ ] **Step 3: Add the semantic report section and heading**

In `src/renderer/modules/settings/SmsTab.tsx`, replace the existing
`{smsStatus && (...)}` card block with:

```tsx
{smsStatus && (
  <section
    className="sms-delivery-report"
    aria-labelledby="sms-delivery-report-title"
  >
    <h3 id="sms-delivery-report-title">Relatório de entrega de SMS</h3>
    <div className="sms-queue" role="group" aria-label="Fila SMS">
      {([
        { key: 'pendingDispatch', label: 'por entregar', tone: 'warn' },
        { key: 'pendingApproval', label: 'por aprovar', tone: 'neutral' },
        { key: 'sent', label: 'enviados', tone: 'success' },
        { key: 'failed', label: 'falhados', tone: 'danger' },
        { key: 'rejected', label: 'rejeitados', tone: 'danger' }
      ] as const).map(({ key, label, tone }) => (
        <div key={key} className="sms-queue-stat" data-tone={tone}>
          <span className="sms-queue-stat-value">
            {smsStatus.counts[key] ?? 0}
          </span>
          <span className="sms-queue-stat-label">{label}</span>
        </div>
      ))}
    </div>
  </section>
)}
```

- [ ] **Step 4: Add focused hierarchy and spacing styles**

In `src/renderer/styles.css`, immediately before `.sms-queue`, add:

```css
.sms-delivery-report {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-3) 0 var(--space-1);
}

.sms-delivery-report h3 {
  margin: 0;
  color: var(--text-1);
  font-size: var(--fs-sm);
  font-weight: 700;
  line-height: 1.25;
}
```

Update `.sms-queue` from
`margin: var(--space-2) 0 var(--space-1);` to `margin: 0;` so the report section
owns the spacing and the heading remains directly associated with the cards.

- [ ] **Step 5: Run the focused test and renderer validation**

Run:

```powershell
npx.cmd vitest run src/renderer/modules/settings/SmsTab.test.tsx
npm.cmd run typecheck
npm.cmd run lint
```

Expected: both `SmsTab` tests pass, TypeScript reports no errors, and ESLint
reports no errors.

- [ ] **Step 6: Review the final diff and commit only the feature files**

Run:

```powershell
git diff --check -- src/renderer/modules/settings/SmsTab.tsx src/renderer/modules/settings/SmsTab.test.tsx src/renderer/styles.css
git diff -- src/renderer/modules/settings/SmsTab.tsx src/renderer/modules/settings/SmsTab.test.tsx src/renderer/styles.css
git add src/renderer/modules/settings/SmsTab.tsx src/renderer/modules/settings/SmsTab.test.tsx src/renderer/styles.css
git commit -m "feat(sms): label delivery report cards"
```

Expected: the diff contains only the heading section, its focused styles, and
the renderer test. The commit succeeds without staging unrelated local changes.
