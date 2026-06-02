export function normalizePhoneKey(phone: string | null): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('238') && digits.length > 7) {
    digits = digits.slice(3);
  }
  return digits.length ? digits : null;
}

export function normalizeNameKey(name: string | null): string | null {
  if (!name) return null;
  const cleaned = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!cleaned) return null;
  return cleaned.split(' ').sort().join(' ');
}
