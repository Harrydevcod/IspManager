import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { WhatsappTab } from './WhatsappTab';
import type { SettingsFormState } from './settingsForm';

function markup(overrides: Partial<SettingsFormState>) {
  const form = {
    whatsappProvider: 'ultramsg',
    ultraMsgInstanceId: 'instance9',
    metaPhoneNumberId: '1055',
    whatsappChannelEnabled: true,
    smsCompanionEnabled: true,
    noticeCooldownDays: '7',
    autoNoticesEnabled: false,
    whatsappTestTemplate: '',
    whatsappTemplate: '',
    whatsappInvoiceReadyTemplate: '',
    whatsappReceiptTemplate: '',
    whatsappOverdueTemplate: '',
    whatsappSuspensionTemplate: '',
    ...overrides
  } as SettingsFormState;
  return renderToStaticMarkup(
    <WhatsappTab
      form={form}
      onUpdate={() => undefined}
      onToggle={() => undefined}
      testPhone=""
      onTestPhoneChange={() => undefined}
      testMessage={null}
      testSending={false}
      onSendTest={() => undefined}
    />
  );
}

describe('WhatsappTab', () => {
  test('com UltraMsg mostra só as credenciais do UltraMsg', () => {
    const html = markup({ whatsappProvider: 'ultramsg' });
    expect(html).toContain('UltraMsg instance ID');
    expect(html).toContain('Token UltraMsg');
    expect(html).not.toContain('Token de acesso Meta');
    expect(html).not.toContain('24 horas');
  });

  test('com a Meta mostra as credenciais da Meta e avisa da janela de 24 horas', () => {
    const html = markup({ whatsappProvider: 'meta-cloud' });
    expect(html).toContain('Phone number ID');
    expect(html).toContain('Token de acesso Meta');
    expect(html).toContain('24 horas');
    expect(html).not.toContain('UltraMsg instance ID');
  });

  test('o canal WhatsApp não se desliga quando o SMS também está desligado', () => {
    // O interruptor do canal é o primeiro da aba.
    const channel = (html: string) => html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? '';
    expect(channel(markup({ whatsappChannelEnabled: true, smsCompanionEnabled: false }))).toContain('disabled=""');
    expect(channel(markup({ whatsappChannelEnabled: true, smsCompanionEnabled: true }))).not.toContain('disabled=""');
  });
});
