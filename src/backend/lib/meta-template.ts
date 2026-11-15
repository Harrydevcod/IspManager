import { numberMetaVariables, renderWhatsappTemplate, type WhatsappTemplateData } from '../../shared/whatsapp';
import type { WhatsappTemplate } from './whatsapp-provider';

type ApprovedTemplate = { name: string; language: string; body: string };

/** Builds a snapshot for the outbox; a mismatch must never fall back to a different message. */
export function prepareMetaTemplate(
  approved: ApprovedTemplate, source: string, data: WhatsappTemplateData, companyName: string
): { ok: true; template: WhatsappTemplate } | { ok: false; reason: string } {
  const fields = Array.from(source.matchAll(/\{([a-z_]+)\}/gi), (match) => match[0]);
  const slots = Array.from(approved.body.matchAll(/\{\{([^{}]+)\}\}/g), (match) => match[1]);
  if (fields.length !== slots.length || slots.some((slot, index) => slot !== String(index + 1))) {
    return { ok: false, reason: 'Os campos do modelo da Meta nao correspondem ao texto do ISPM' };
  }
  if (numberMetaVariables(source) !== approved.body.replace(/\r\n/g, '\n').trim()) {
    return { ok: false, reason: 'O texto aprovado da Meta difere do texto do ISPM' };
  }
  const params = fields.map((field) => renderWhatsappTemplate(field, data, companyName).trim());
  if (params.some((value, index) => !value || value === fields[index])) {
    return { ok: false, reason: 'Um campo do modelo nao tem valor valido' };
  }
  return { ok: true, template: { name: approved.name, language: approved.language, params } };
}
