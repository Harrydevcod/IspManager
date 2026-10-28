import type Database from 'better-sqlite3';
import { labelForOperationMode } from '../../shared/operation';
import { formatDate, loadCompany, PALETTE } from './documents';
import { ANTENNA_TYPES, NAT_MODES } from './iptv-source';
import { readPppoeSecret } from './secrets';

const PDFDocument = require('pdfkit');

/** `pending`: com utilizador PPPoE e nunca visto online por PPPoE. `all`: todos os activos com PPPoE. */
export type MigrationScope = 'pending' | 'all';

export type MigrationDevice = { type: string; name: string; mac: string | null; ip: string | null; mode: string | null };
export type MigrationCard = {
  serviceId: number; clientCode: string | null; clientName: string; phone: string | null; zone: string | null; address: string | null;
  plan: string | null; username: string; password: string; target: string; devices: MigrationDevice[];
};

const kind = (type: string | null) => (type ?? '').trim().toLowerCase();
const mode = (value: string | null) => (value ?? '').trim().toLowerCase();

/**
 * Onde se escreve o PPPoE: no equipamento que faz NAT, porque é o que o gateway vê
 * (a mesma regra da origem do IPTV, ADR 0021). Com tudo em camada 2, ou com o modo
 * por classificar, nunca se adivinha: o técnico confirma no local.
 */
export function pppoeTarget(devices: MigrationDevice[]): string {
  const antenna = devices.find((d) => ANTENNA_TYPES.has(kind(d.type)));
  const router = devices.find((d) => kind(d.type) === 'router');
  if (antenna && NAT_MODES.has(mode(antenna.mode))) return `Na WAN da antena (${antenna.name})`;
  if (router && NAT_MODES.has(mode(router.mode))) return `Na WAN do router do cliente (${router.name})`;
  if (antenna && !mode(antenna.mode)) return 'Confirmar no local: modo da antena por classificar';
  if (router && !mode(router.mode)) return 'Confirmar no local: modo do router por classificar';
  return 'Confirmar no local: nenhum equipamento registado faz NAT';
}

/** As fichas, e os serviços que não as levam por não terem senha legível. Ordenadas por zona e cliente. */
export function loadMigrationCards(db: Database.Database, scope: MigrationScope): { cards: MigrationCard[]; withoutPassword: number[] } {
  const services = db.prepare(`
    SELECT s.id, s.pppoe_username AS username, c.client_code AS clientCode, c.full_name AS clientName, c.phone, c.zone, c.address, p.name AS plan
    FROM services s
    JOIN clients c ON c.id = s.client_id
    LEFT JOIN internet_plans p ON p.id = s.plan_id
    LEFT JOIN service_network_state n ON n.service_id = s.id
    WHERE s.status = 'active' AND s.pppoe_username IS NOT NULL AND TRIM(s.pppoe_username) <> ''
      ${scope === 'pending' ? 'AND n.last_online_at IS NULL' : ''}
    ORDER BY COALESCE(c.zone, '') COLLATE NOCASE, c.full_name COLLATE NOCASE, s.id
  `).all() as Array<Omit<MigrationCard, 'serviceId' | 'password' | 'target' | 'devices'> & { id: number }>;
  // Equipamento próprio ou partilhado (antena partilhada), como a origem do IPTV o lê.
  const devices = db.prepare(`
    SELECT e.type, TRIM(COALESCE(e.brand, '') || ' ' || COALESCE(e.model, e.description, '')) AS name,
           a.mac_address AS mac, a.ip_address AS ip, a.operation_mode AS mode
    FROM assignment_services x
    JOIN service_device_assignments a ON a.id = x.assignment_id AND a.end_date IS NULL
    JOIN equipment_catalog e ON e.id = a.catalog_id
    WHERE x.service_id = ? ORDER BY a.id
  `);
  const cards: MigrationCard[] = [];
  const withoutPassword: number[] = [];
  for (const { id, ...service } of services) {
    const password = readPppoeSecret(db, id);
    if (!password) { withoutPassword.push(id); continue; }
    const list = (devices.all(id) as MigrationDevice[]).map((d) => ({ ...d, name: d.name || d.type }));
    cards.push({ serviceId: id, ...service, password, target: pppoeTarget(list), devices: list });
  }
  return { cards, withoutPassword };
}

const CARD_CHECKLIST = [
  'Pôr a WAN do equipamento indicado em PPPoE',
  'Escrever o utilizador e a senha exactamente como estão',
  'Confirmar que a ligação PPPoE fica activa',
  'Confirmar a navegação (e o IPTV, se o cliente tiver)'
];

/** A4, duas fichas por página com linha de corte. Utilizador e senha em letra de largura fixa: 0 e O não se confundem. */
export function renderMigrationCardsPdf(cards: MigrationCard[]): Promise<Buffer> {
  const company = loadCompany();
  const doc = new PDFDocument({ size: 'A4', margin: 0, info: { Title: 'Fichas de migração PPPoE', Author: company.companyName, Subject: 'Confidencial' } });
  const W = 595.28; const H = 841.89; const M = 36; const cw = W - 2 * M;
  const half = (H - 2 * M) / 2;
  const pages = Math.max(1, Math.ceil(cards.length / 2));
  const today = formatDate(new Date().toISOString().slice(0, 10));
  const line = (value: string, x: number, y: number, width: number, size: number, font = 'Helvetica', color: string = PALETTE.ink, align: 'left' | 'right' = 'left') =>
    doc.font(font).fontSize(size).fillColor(color).text(value, x, y, { width, align, lineBreak: false, ellipsis: true });

  const card = (c: MigrationCard, top: number) => {
    let y = top + 6;
    line('FICHA DE MIGRAÇÃO PPPoE', M, y, cw / 2, 8, 'Helvetica-Bold', PALETTE.accent);
    line(`Serviço #${c.serviceId}${c.clientCode ? ` · ${c.clientCode}` : ''}`, M + cw / 2, y, cw / 2, 8, 'Helvetica', PALETTE.muted, 'right');
    y += 14;
    line(c.clientName, M, y, cw, 15, 'Helvetica-Bold');
    y += 20;
    line([c.zone, c.address].filter(Boolean).join(' · ') || 'Sem morada registada', M, y, cw, 9, 'Helvetica', PALETTE.inkSoft);
    y += 12;
    line([c.phone ? `Tel. ${c.phone}` : null, c.plan ? `Plano ${c.plan}` : null].filter(Boolean).join(' · ') || '—', M, y, cw, 9, 'Helvetica', PALETTE.inkSoft);
    y += 18;

    doc.roundedRect(M, y, cw, 54, 4).fillAndStroke(PALETTE.paperTint, PALETTE.hairline);
    line('UTILIZADOR', M + 12, y + 9, cw / 2 - 24, 7, 'Helvetica-Bold', PALETTE.muted);
    line('SENHA', M + cw / 2 + 12, y + 9, cw / 2 - 24, 7, 'Helvetica-Bold', PALETTE.muted);
    line(c.username, M + 12, y + 24, cw / 2 - 24, 15, 'Courier-Bold');
    line(c.password, M + cw / 2 + 12, y + 24, cw / 2 - 24, 15, 'Courier-Bold');
    y += 66;

    line('ONDE CONFIGURAR', M, y, cw, 7, 'Helvetica-Bold', PALETTE.muted);
    y += 11;
    line(c.target, M, y, cw, 10, 'Helvetica-Bold');
    y += 15;
    for (const d of c.devices.slice(0, 3)) {
      const parts = [d.name, d.mode ? labelForOperationMode(d.mode) : 'modo por classificar', d.mac ? `MAC ${d.mac}` : null, d.ip ? `IP ${d.ip}` : null];
      line(`• ${parts.filter(Boolean).join(' · ')}`, M + 4, y, cw - 4, 8.5, 'Helvetica', PALETTE.inkSoft);
      y += 11;
    }
    if (c.devices.length === 0) { line('• Nenhum equipamento registado no serviço', M + 4, y, cw - 4, 8.5, 'Helvetica', PALETTE.danger); y += 11; }
    y += 6;

    for (const step of CARD_CHECKLIST) {
      doc.rect(M, y, 8, 8).lineWidth(0.7).strokeColor(PALETTE.ink).stroke();
      line(step, M + 14, y, cw - 14, 9);
      y += 14;
    }

    const bottom = top + half - 30;
    // O espaço que sobra é do técnico: o que encontrou no local.
    y += 6;
    line('OBSERVAÇÕES', M, y, cw, 7, 'Helvetica-Bold', PALETTE.muted);
    doc.lineWidth(0.5).strokeColor(PALETTE.hairline);
    for (let ruled = y + 26; ruled < bottom - 28; ruled += 22) doc.moveTo(M, ruled).lineTo(W - M, ruled).stroke();
    doc.lineWidth(0.5).strokeColor(PALETTE.light);
    const fields = ['Data', 'Hora', 'Técnico', 'Assinatura'];
    const fw = cw / fields.length;
    fields.forEach((label, i) => {
      doc.moveTo(M + i * fw, bottom).lineTo(M + (i + 1) * fw - 12, bottom).stroke();
      line(label, M + i * fw, bottom + 4, fw - 12, 7, 'Helvetica', PALETTE.muted);
    });
  };

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      for (let page = 0; page < pages; page += 1) {
        if (page > 0) doc.addPage();
        const pair = cards.slice(page * 2, page * 2 + 2);
        if (pair.length === 0) line('Nenhum serviço por migrar.', M, M, cw, 11, 'Helvetica', PALETTE.muted);
        pair.forEach((c, i) => card(c, M + i * half));
        if (pair.length === 2) {
          doc.lineWidth(0.5).strokeColor(PALETTE.light).dash(4, { space: 3 }).moveTo(M / 2, M + half).lineTo(W - M / 2, M + half).stroke().undash();
        }
        line(`${company.companyName || 'ISPM'} · Confidencial: destruir depois da migração · ${today} · ${page + 1}/${pages}`,
          M, H - M + 12, cw, 7, 'Helvetica', PALETTE.muted);
      }
      doc.end();
    } catch (error) { doc.destroy(error instanceof Error ? error : new Error(String(error))); reject(error); }
  });
}
