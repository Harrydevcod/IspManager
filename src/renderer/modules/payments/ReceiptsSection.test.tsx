import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import type { PaymentReceipt } from '../../types';
import { ReceiptsSection } from './ReceiptsSection';

const receipt: PaymentReceipt = {
  id: 1, paymentId: 2, amountCve: 2500, paymentDate: '2026-10-13',
  paymentMethod: 'outro', source: 'cash', receiptNumber: 'RC-2026-00001',
  receiptDate: '2026-10-13', voidedAt: null, voidReason: null,
  notes: null, accountId: null, accountName: null
};
const noop = () => {};
const props = {
  receipts: [receipt], clientCreditCve: 0, balanceCve: 0, submitting: false,
  onPrintReceipt: noop, onVoidReceipt: noop, onApplyCredit: noop
};

describe('ações dos recibos Stripe', () => {
  test('o administrador recebe apenas a ação de reembolso', () => {
    const html = renderToStaticMarkup(<ReceiptsSection {...props} stripeReceiptIds={[1]} refundableReceiptIds={[1]} onRefundReceipt={noop} />);
    expect(html).toContain('Reembolsar');
    expect(html).not.toContain('Anular');
    expect(html).toContain('Recibo');
  });

  test('sem permissão de reembolso não oferece anulação local', () => {
    const html = renderToStaticMarkup(<ReceiptsSection {...props} stripeReceiptIds={[1]} refundableReceiptIds={[1]} />);
    expect(html).not.toContain('Anular');
    expect(html).not.toContain('Reembolsar');
  });

  test('um reembolso pendente ou em revisão não libera anulação', () => {
    const html = renderToStaticMarkup(<ReceiptsSection {...props} stripeReceiptIds={[1]} refundableReceiptIds={[]} onRefundReceipt={noop} />);
    expect(html).not.toContain('Anular');
    expect(html).not.toContain('Reembolsar');
  });

  test('recebimentos locais continuam a poder ser anulados', () => {
    const html = renderToStaticMarkup(<ReceiptsSection {...props} />);
    expect(html).toContain('Anular');
    expect(html).not.toContain('Reembolsar');
  });
});
