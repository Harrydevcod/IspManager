import {
  Children,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode
} from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';
import type { SmsMonthlyReport, SmsStatus } from '../../types';
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
  deviceName: 'Telemóvel da loja'
};

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

function smsTabProps(
  overrides: Partial<ComponentProps<typeof SmsTab>> = {}
): ComponentProps<typeof SmsTab> {
  return {
    form,
    onUpdate: vi.fn(),
    onToggle: vi.fn(),
    smsStatus,
    smsReportMonth: '2026-07',
    smsReport,
    smsReportLoading: false,
    onSmsReportMonthChange: vi.fn(),
    smsPairing: { baseUrl: '', deviceName: '' },
    onPairingChange: vi.fn(),
    smsVerifying: false,
    smsPairingBusy: false,
    smsDetecting: false,
    smsQrDataUrl: '',
    onDetectPhone: vi.fn(),
    onCreatePairing: vi.fn(),
    onRevokePairing: vi.fn(),
    ...overrides
  };
}

function renderSmsTab(overrides: Partial<ComponentProps<typeof SmsTab>> = {}) {
  return renderToStaticMarkup(<SmsTab {...smsTabProps(overrides)} />);
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean
): ReactElement | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    if (predicate(child)) return child;
    const nested = findElement(
      (child.props as { children?: ReactNode }).children,
      predicate
    );
    if (nested) return nested;
  }
  return null;
}

describe('SmsTab monthly delivery report', () => {
  test('renders the selected month and monthly status counts', () => {
    const html = renderSmsTab();

    expect(html).toContain(
      '<section class="sms-delivery-report" aria-labelledby="sms-delivery-report-title">'
    );
    expect(html).toContain(
      '<h3 id="sms-delivery-report-title">Relatório de entrega de SMS</h3>'
    );
    expect(html).toContain('>Mês</span>');
    expect(html).toContain('type="month"');
    expect(html).toContain('value="2026-07"');
    expect(html).toContain('sms-queue-stat-value">3</span>');
  });

  test('forwards month changes', () => {
    const onMonthChange = vi.fn();
    const tree = SmsTab(smsTabProps({ onSmsReportMonthChange: onMonthChange }));
    const monthField = findElement(
      tree,
      (element) => (element.props as { type?: string }).type === 'month'
    );
    expect(monthField).not.toBeNull();

    const onChange = (monthField!.props as {
      onChange: (event: { target: { value: string } }) => void;
    }).onChange;
    onChange({ target: { value: '2026-08' } });

    expect(onMonthChange).toHaveBeenCalledWith('2026-08');
  });

  test('renders five zero counters for an empty month', () => {
    const html = renderSmsTab({
      smsReport: {
        ...smsReport,
        counts: {
          pendingDispatch: 0,
          pendingApproval: 0,
          sent: 0,
          failed: 0,
          rejected: 0
        }
      }
    });

    expect(html.match(/sms-queue-stat-value">0<\/span>/g)).toHaveLength(5);
  });

  test('hides stale totals while the selected month is loading', () => {
    const html = renderSmsTab({ smsReportLoading: true });

    expect(html).toContain('A carregar relatório…');
    expect(html).not.toContain('aria-label="Fila SMS"');
  });

  test('does not render a response for a different month', () => {
    const html = renderSmsTab({ smsReportMonth: '2026-08' });

    expect(html).not.toContain('aria-label="Fila SMS"');
    expect(html).not.toContain('A carregar relatório…');
  });
});
