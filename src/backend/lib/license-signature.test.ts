import { sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { licenseClaimSchema, type LicenseClaim } from '../../shared/license';
import { generateLicenseKeyPair, signLicense, verifyLicenseToken } from './license-signature';

const keys = generateLicenseKeyPair();
const otherKeys = generateLicenseKeyPair();

function claim(overrides: Partial<LicenseClaim> = {}): LicenseClaim {
  return licenseClaimSchema.parse({
    v: 1,
    id: 'LIC-2026-0007',
    customer: 'Nova Tech, Lda',
    kind: 'subscricao',
    bind: 'none',
    issuedAt: '2026-08-02',
    expiresAt: '2027-08-02',
    ...overrides
  });
}

describe('signLicense', () => {
  test('produz um token em duas partes base64url', () => {
    const token = signLicense(claim(), keys.privateKey);
    expect(token.split('.')).toHaveLength(2);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  test('recusa assinar um claim malformado', () => {
    // Uma perpétua com validade nunca deve chegar às mãos do cliente.
    const broken = { ...claim(), kind: 'perpetua' } as LicenseClaim;
    expect(() => signLicense(broken, keys.privateKey)).toThrow();
  });
});

describe('verifyLicenseToken', () => {
  test('aceita um token válido e devolve o claim', () => {
    const result = verifyLicenseToken(signLicense(claim(), keys.privateKey), keys.publicKey);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claim.id).toBe('LIC-2026-0007');
      expect(result.claim.customer).toBe('Nova Tech, Lda');
      expect(result.claim.graceDays).toBe(14);
    }
  });

  test('tolera quebras de linha e espaços do copiar-colar', () => {
    const token = signLicense(claim(), keys.privateKey);
    const wrapped = `${token.slice(0, 40)}\n  ${token.slice(40)}\n`;
    expect(verifyLicenseToken(wrapped, keys.publicKey).ok).toBe(true);
  });

  test('rejeita um token assinado por outra chave', () => {
    const token = signLicense(claim(), otherKeys.privateKey);
    const result = verifyLicenseToken(token, keys.publicKey);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('não confere');
  });

  test('rejeita um payload adulterado', () => {
    // Estender a validade reescrevendo o JSON tem de invalidar a assinatura.
    const token = signLicense(claim(), keys.privateKey);
    const [, signature] = token.split('.');
    const forged = JSON.stringify({ ...claim(), expiresAt: '2099-01-01' });
    const tampered = `${Buffer.from(forged, 'utf8').toString('base64url')}.${signature}`;
    expect(verifyLicenseToken(tampered, keys.publicKey).ok).toBe(false);
  });

  test('rejeita uma assinatura adulterada', () => {
    const token = signLicense(claim(), keys.privateKey);
    const [payload, signature] = token.split('.');
    const flipped = signature[0] === 'A' ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    expect(verifyLicenseToken(`${payload}.${flipped}`, keys.publicKey).ok).toBe(false);
  });

  test('rejeita um claim que a assinatura cobre mas o schema recusa', () => {
    const rogue = Buffer.from(JSON.stringify({ v: 99, id: 'X' }), 'utf8');
    const signature = sign(null, rogue, keys.privateKey);
    const token = `${rogue.toString('base64url')}.${signature.toString('base64url')}`;
    const result = verifyLicenseToken(token, keys.publicKey);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('não reconhecida');
  });

  test.each([
    ['', 'vazia'],
    ['   ', 'vazia'],
    ['sem-ponto', 'inválido'],
    ['.assinatura', 'inválido'],
    ['payload.', 'inválido']
  ])('rejeita o token %j', (token, expected) => {
    const result = verifyLicenseToken(token, keys.publicKey);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.toLowerCase()).toContain(expected);
  });

  test('não rebenta com uma chave pública inválida', () => {
    const token = signLicense(claim(), keys.privateKey);
    const result = verifyLicenseToken(token, 'não é uma chave PEM');
    expect(result.ok).toBe(false);
  });
});
