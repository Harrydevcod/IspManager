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
    whatsappReminderTemplate: '',
    whatsappWarningTemplate: '',
    whatsappSuspensionTemplate: '',
    whatsappMaintenanceTemplate: '',
    whatsappOutageTemplate: 'Texto de avaria',
    whatsappRestoredTemplate: 'Texto de reposição',
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
  test('permite editar os textos de avaria e reposição', () => {
    const html = markup({});
    expect(html).toContain('Texto de avaria');
    expect(html).toContain('Texto de reposição');
  });
  test('com UltraMsg mostra só as credenciais do UltraMsg', () => {
    const html = markup({ whatsappProvider: 'ultramsg' });
    expect(html).toContain('UltraMsg instance ID');
    expect(html).toContain('Token UltraMsg');
    expect(html).not.toContain('Token de acesso Meta');
    expect(html).not.toContain('Consultar modelos aprovados');
  });

  test('com a Meta mostra as credenciais da Meta e um modelo por aviso', () => {
    const html = markup({ whatsappProvider: 'meta-cloud' });
    expect(html).toContain('Phone number ID');
    expect(html).toContain('Token de acesso Meta');
    expect(html.match(/class="meta-template-field"/g)).toHaveLength(8);
    // Sem ID da conta e token, a consulta dos modelos não se pode fazer.
    expect(html).toMatch(/<button[^>]*disabled[^>]*title="Guarde o ID da conta e o token primeiro"/);
    expect(html).not.toContain('UltraMsg instance ID');
  });

  test('o canal WhatsApp não se desliga quando o SMS também está desligado', () => {
    // O interruptor do canal é o primeiro da aba.
    const channel = (html: string) => html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? '';
    expect(channel(markup({ whatsappChannelEnabled: true, smsCompanionEnabled: false }))).toContain('disabled=""');
    expect(channel(markup({ whatsappChannelEnabled: true, smsCompanionEnabled: true }))).not.toContain('disabled=""');
  });
});
