import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import { authFetch } from '../lib/auth';
import { fallbackWhatsappTemplate } from '../lib/whatsapp';
import { BackupsPanel } from './BackupsPanel';

type SettingsFormState = {
  companyName: string;
  nif: string;
  phone: string;
  email: string;
  address: string;
  island: string;
  defaultDueDay: string;
  currencyCode: string;
  invoicePrefix: string;
  receiptPrefix: string;
  ivaRate: string;
  fiscalRegime: 'normal' | 'rempe';
  showIva: boolean;
  printQrCode: boolean;
  legalNotes: string;
  whatsappTemplate: string;
  ultraMsgInstanceId: string;
  ultraMsgToken: string;
};

export function SettingsModule() {
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState<SettingsFormState>({
    companyName: 'ISPM',
    nif: '',
    phone: '',
    email: '',
    address: '',
    island: '',
    defaultDueDay: '1',
    currencyCode: 'CVE',
    invoicePrefix: 'FT',
    receiptPrefix: 'RC',
    ivaRate: '15',
    fiscalRegime: 'normal',
    showIva: false,
    printQrCode: false,
    legalNotes: '',
    whatsappTemplate: fallbackWhatsappTemplate,
    ultraMsgInstanceId: '',
    ultraMsgToken: ''
  });

  useEffect(() => {
    authFetch('http://127.0.0.1:3001/api/settings')
      .then((response) => {
        if (!response.ok) {
          throw new Error('Nao foi possivel carregar configuracoes');
        }
        return response.json() as Promise<Omit<SettingsFormState, 'defaultDueDay' | 'ivaRate'> & { defaultDueDay: number; ivaRate: number }>;
      })
      .then((settings) => {
        setForm({
          ...settings,
          defaultDueDay: String(settings.defaultDueDay),
          ivaRate: String(settings.ivaRate)
        });
        setMessage(null);
      })
      .catch((err: unknown) => {
        setMessage(err instanceof Error ? err.message : 'Erro ao carregar configuracoes');
      });
  }, []);

  function updateForm(field: keyof SettingsFormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await authFetch('http://127.0.0.1:3001/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        defaultDueDay: Number(form.defaultDueDay),
        ivaRate: Number(form.ivaRate)
      })
    });

    if (!response.ok) {
      setMessage('Nao foi possivel gravar configuracoes.');
      return;
    }

    setMessage('Configuracoes atualizadas.');
  }

  return (
    <section className="module-panel">
      <div className="module-header">
        <div>
          <p className="eyebrow">Sistema</p>
          <h2>Configuracoes</h2>
        </div>
      </div>

      {message && <p className="module-message">{message}</p>}

      <form className="client-form" onSubmit={saveSettings}>
        <label>
          Nome da empresa
          <input required value={form.companyName} onChange={(event) => updateForm('companyName', event.target.value)} />
        </label>
        <label>
          NIF
          <input value={form.nif} onChange={(event) => updateForm('nif', event.target.value)} />
        </label>
        <label>
          Telefone
          <input value={form.phone} onChange={(event) => updateForm('phone', event.target.value)} />
        </label>
        <label>
          Email
          <input type="email" value={form.email} onChange={(event) => updateForm('email', event.target.value)} />
        </label>
        <label>
          Ilha
          <input value={form.island} onChange={(event) => updateForm('island', event.target.value)} />
        </label>
        <label>
          Dia padrao de vencimento
          <input required type="number" min="1" max="31" value={form.defaultDueDay} onChange={(event) => updateForm('defaultDueDay', event.target.value)} />
        </label>
        <label>
          Moeda
          <input required value={form.currencyCode} onChange={(event) => updateForm('currencyCode', event.target.value)} />
        </label>
        <label>
          Prefixo fatura
          <input required value={form.invoicePrefix} onChange={(event) => updateForm('invoicePrefix', event.target.value)} />
        </label>
        <label>
          Prefixo recibo
          <input required value={form.receiptPrefix} onChange={(event) => updateForm('receiptPrefix', event.target.value)} />
        </label>
        <label>
          Regime fiscal
          <select value={form.fiscalRegime} onChange={(event) => updateForm('fiscalRegime', event.target.value as 'normal' | 'rempe')}>
            <option value="normal">Regime Normal (com IVA)</option>
            <option value="rempe">REMPE (isento IVA)</option>
          </select>
        </label>
        <label>
          Taxa de IVA (%)
          <input required type="number" min="0" max="100" step="0.5" value={form.ivaRate} onChange={(event) => updateForm('ivaRate', event.target.value)} />
        </label>
        <label className="wide-field">
          Morada
          <input value={form.address} onChange={(event) => updateForm('address', event.target.value)} />
        </label>
        <label className="wide-field">
          Observacoes no documento
          <textarea rows={3} value={form.legalNotes} onChange={(event) => updateForm('legalNotes', event.target.value)} placeholder="Texto opcional que aparece no rodape de cada fatura/recibo (ex: termos, IBAN, agradecimento)" />
        </label>
        <label className="wide-field settings-toggle">
          <input
            type="checkbox"
            checked={form.showIva}
            onChange={(event) => setForm((current) => ({ ...current, showIva: event.target.checked }))}
          />
          <span>
            <strong>Mostrar linha de IVA nos documentos</strong>
            <small>Quando desligado, fatura/recibo mostram apenas o total (servico informal). Liga quando estiveres com contabilidade organizada.</small>
          </span>
        </label>
        <label className="wide-field settings-toggle">
          <input
            type="checkbox"
            checked={form.printQrCode}
            onChange={(event) => setForm((current) => ({ ...current, printQrCode: event.target.checked }))}
          />
          <span>
            <strong>Imprimir QR Code fiscal nos documentos</strong>
            <small>QR no formato Portaria 47/2021 (preparatorio para e-Fatura). Liga quando estiveres preparado para credenciacao na DNRE.</small>
          </span>
        </label>
        <label className="wide-field">
          Mensagem WhatsApp
          <textarea
            rows={4}
            value={form.whatsappTemplate}
            onChange={(event) => updateForm('whatsappTemplate', event.target.value)}
          />
        </label>
        <label>
          UltraMsg instance ID
          <input value={form.ultraMsgInstanceId} onChange={(event) => updateForm('ultraMsgInstanceId', event.target.value)} placeholder="instance00000" />
        </label>
        <label>
          UltraMsg token
          <input type="password" value={form.ultraMsgToken} onChange={(event) => updateForm('ultraMsgToken', event.target.value)} />
        </label>
        <div className="form-actions">
          <button type="submit">Gravar configuracoes</button>
        </div>
      </form>

      <BackupsPanel />
    </section>
  );
}
