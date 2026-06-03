export function normalizePhoneKey(phone: string | null): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  // CV national numbers are 7 digits; only strip the 238 country code when extra digits remain.
  if (digits.startsWith('238') && digits.length > 7) {
    digits = digits.slice(3);
  }
  return digits.length ? digits : null;
}

export function normalizeNameKey(name: string | null): string | null {
  if (!name) return null;
  const cleaned = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!cleaned) return null;
  return cleaned.split(' ').sort().join(' ');
}

export type DqClient = {
  id: number;
  clientCode: string;
  fullName: string;
  phone: string | null;
  nif: string | null;
  address: string | null;
  island: string | null;
  zone: string | null;
  status: 'active' | 'suspended' | 'cancelled';
  hasActiveService: number;
};

export type IncompleteFlag = 'noPhone' | 'noActiveService' | 'noAddress' | 'noNif';

export function computeIncompleteFlags(client: DqClient): IncompleteFlag[] {
  const flags: IncompleteFlag[] = [];
  if (!client.phone || !client.phone.trim()) flags.push('noPhone');
  if (client.status !== 'cancelled' && !client.hasActiveService) flags.push('noActiveService');
  if (!client.address?.trim() || !client.island?.trim() || !client.zone?.trim()) flags.push('noAddress');
  if (!client.nif || !client.nif.trim()) flags.push('noNif');
  return flags;
}

export type DuplicateGroup = {
  key: string;
  reason: 'phone' | 'name';
  clients: Array<{ id: number; clientCode: string; fullName: string; phone: string | null }>;
};

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export function findDuplicateGroups(clients: DqClient[], dismissedPairs: Set<string>): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];

  const collect = (keyFn: (c: DqClient) => string | null, reason: 'phone' | 'name') => {
    const buckets = new Map<string, DqClient[]>();
    for (const c of clients) {
      const k = keyFn(c);
      if (!k) continue;
      const list = buckets.get(k);
      if (list) list.push(c);
      else buckets.set(k, [c]);
    }
    for (const [k, members] of buckets) {
      if (members.length < 2) continue;
      const kept = members.filter((m) =>
        members.some((other) => other.id !== m.id && !dismissedPairs.has(pairKey(m.id, other.id)))
      );
      if (kept.length >= 2) {
        groups.push({
          key: `${reason}:${k}`,
          reason,
          clients: kept.map((c) => ({ id: c.id, clientCode: c.clientCode, fullName: c.fullName, phone: c.phone }))
        });
      }
    }
  };

  collect((c) => normalizePhoneKey(c.phone), 'phone');
  collect((c) => normalizeNameKey(c.fullName), 'name');
  return groups;
}
