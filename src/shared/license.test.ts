import { describe, expect, test } from 'vitest';
import {
  DEFAULT_GRACE_DAYS,
  TRIAL_DAYS,
  licenseClaimSchema,
  licenseStatus,
  type LicenseClaim
} from './license';

const NOW = new Date(2026, 7, 2); // 02-08-2026, meia-noite local

function subscription(overrides: Partial<LicenseClaim> = {}): LicenseClaim {
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

function perpetual(overrides: Partial<LicenseClaim> = {}): LicenseClaim {
  return licenseClaimSchema.parse({
    v: 1,
    id: 'LIC-2026-0008',
    customer: 'Ilha Net, Lda',
    kind: 'perpetua',
    bind: 'none',
    issuedAt: '2026-08-02',
    maintenanceUntil: '2027-08-02',
    ...overrides
  });
}

describe('licenseClaimSchema', () => {
  test('aplica os valores por omissão', () => {
    const claim = subscription();
    expect(claim.graceDays).toBe(DEFAULT_GRACE_DAYS);
    expect(claim.entitlements).toEqual([]);
  });

  test('exige fingerprint quando a licença é ligada à máquina', () => {
    expect(licenseClaimSchema.safeParse({
      v: 1, id: 'L', customer: 'C', kind: 'subscricao', bind: 'machine',
      issuedAt: '2026-08-02', expiresAt: '2027-08-02'
    }).success).toBe(false);

    expect(licenseClaimSchema.safeParse({
      v: 1, id: 'L', customer: 'C', kind: 'subscricao', bind: 'machine',
      fingerprint: 'a3f2', issuedAt: '2026-08-02', expiresAt: '2027-08-02'
    }).success).toBe(true);
  });

  test('exige validade na subscrição', () => {
    expect(licenseClaimSchema.safeParse({
      v: 1, id: 'L', customer: 'C', kind: 'subscricao', bind: 'none', issuedAt: '2026-08-02'
    }).success).toBe(false);
  });

  test('rejeita uma perpétua com data de validade', () => {
    // Um engano do emissor aqui mataria uma licença vitalícia paga.
    expect(licenseClaimSchema.safeParse({
      v: 1, id: 'L', customer: 'C', kind: 'perpetua', bind: 'none',
      issuedAt: '2026-08-02', expiresAt: '2027-08-02'
    }).success).toBe(false);
  });

  test('rejeita datas mal formadas ou inexistentes', () => {
    expect(licenseClaimSchema.safeParse({ ...subscription(), expiresAt: '02-08-2027' }).success).toBe(false);
    expect(licenseClaimSchema.safeParse({ ...subscription(), expiresAt: '2027-02-31' }).success).toBe(false);
  });

  test('rejeita uma versão de formato desconhecida', () => {
    expect(licenseClaimSchema.safeParse({ ...subscription(), v: 2 }).success).toBe(false);
  });

  test('valida o NIF cabo-verdiano quando presente', () => {
    expect(licenseClaimSchema.safeParse({ ...subscription(), nif: '212345678' }).success).toBe(true); // coletiva
    expect(licenseClaimSchema.safeParse({ ...subscription(), nif: '112345678' }).success).toBe(true); // singular
    expect(licenseClaimSchema.safeParse({ ...subscription(), nif: '312345678' }).success).toBe(false);
    expect(licenseClaimSchema.safeParse({ ...subscription(), nif: '21234567' }).success).toBe(false);
  });
});

describe('avaliação', () => {
  test('sem licença nem marca de início conta a avaliação a partir de agora', () => {
    const status = licenseStatus({}, NOW);
    expect(status.state).toBe('trial');
    expect(status.canWrite).toBe(true);
    expect(status.daysRemaining).toBe(TRIAL_DAYS);
  });

  test('desconta os dias já usados', () => {
    const status = licenseStatus({ trialStartedAt: '2026-07-23' }, NOW); // 10 dias
    expect(status.state).toBe('trial');
    expect(status.daysRemaining).toBe(20);
  });

  test('o último dia da avaliação ainda permite escrever', () => {
    const status = licenseStatus({ trialStartedAt: '2026-07-04' }, NOW); // 29 dias usados
    expect(status.state).toBe('trial');
    expect(status.daysRemaining).toBe(1);
    expect(status.canWrite).toBe(true);
  });

  test('esgotada, passa a leitura-apenas', () => {
    const status = licenseStatus({ trialStartedAt: '2026-07-03' }, NOW); // 30 dias usados
    expect(status.state).toBe('readonly');
    expect(status.canWrite).toBe(false);
    expect(status.reason).toContain('exportação');
  });
});

describe('subscrição', () => {
  test('dentro da validade está ativa', () => {
    const status = licenseStatus({ claim: subscription() }, NOW);
    expect(status.state).toBe('active');
    expect(status.canWrite).toBe(true);
    expect(status.updatesAllowed).toBe(true);
    expect(status.daysRemaining).toBe(365);
  });

  test('o próprio dia da validade ainda está ativo', () => {
    const status = licenseStatus({ claim: subscription({ expiresAt: '2026-08-02' }) }, NOW);
    expect(status.state).toBe('active');
    expect(status.daysRemaining).toBe(0);
  });

  test('expirada dentro da tolerância continua a escrever', () => {
    const status = licenseStatus({ claim: subscription({ expiresAt: '2026-07-29' }) }, NOW); // 4 dias
    expect(status.state).toBe('grace');
    expect(status.canWrite).toBe(true);
    expect(status.daysRemaining).toBe(-4);
    expect(status.reason).toContain('10 dias');
  });

  test('o último dia da tolerância ainda escreve', () => {
    const status = licenseStatus({ claim: subscription({ expiresAt: '2026-07-19' }) }, NOW); // 14 dias
    expect(status.state).toBe('grace');
    expect(status.canWrite).toBe(true);
  });

  test('passada a tolerância fica em leitura-apenas', () => {
    const status = licenseStatus({ claim: subscription({ expiresAt: '2026-07-18' }) }, NOW); // 15 dias
    expect(status.state).toBe('readonly');
    expect(status.canWrite).toBe(false);
    expect(status.updatesAllowed).toBe(false);
  });

  test('respeita uma tolerância personalizada', () => {
    const claim = subscription({ expiresAt: '2026-07-29', graceDays: 2 });
    expect(licenseStatus({ claim }, NOW).state).toBe('readonly');
  });
});

describe('perpétua', () => {
  test('está sempre ativa e pode escrever', () => {
    const status = licenseStatus({ claim: perpetual() }, NOW);
    expect(status.state).toBe('active');
    expect(status.canWrite).toBe(true);
    expect(status.daysRemaining).toBeNull();
  });

  test('manutenção terminada continua ativa mas sem atualizações', () => {
    // A promessa da compra única: anos depois, ainda funciona.
    const status = licenseStatus({ claim: perpetual({ maintenanceUntil: '2026-01-31' }) }, NOW);
    expect(status.state).toBe('active');
    expect(status.canWrite).toBe(true);
    expect(status.updatesAllowed).toBe(false);
    expect(status.reason).toContain('continua a funcionar');
  });

  test('o último dia da manutenção ainda dá direito a atualizações', () => {
    const status = licenseStatus({ claim: perpetual({ maintenanceUntil: '2026-08-02' }) }, NOW);
    expect(status.updatesAllowed).toBe(true);
  });

  test('sem manutenção definida tem atualizações para sempre', () => {
    const status = licenseStatus({ claim: perpetual({ maintenanceUntil: undefined }) }, NOW);
    expect(status.updatesAllowed).toBe(true);
  });

  test('uma perpétua de 2019 continua a funcionar em 2036', () => {
    const claim = perpetual({ issuedAt: '2019-03-01', maintenanceUntil: '2020-03-01' });
    const status = licenseStatus({ claim }, new Date(2036, 0, 1));
    expect(status.state).toBe('active');
    expect(status.canWrite).toBe(true);
  });
});

describe('ligação à máquina', () => {
  const bound = () => subscription({ bind: 'machine', fingerprint: 'a3f2' });

  test('aceita a máquina certa', () => {
    expect(licenseStatus({ claim: bound(), machineFingerprint: 'a3f2' }, NOW).state).toBe('active');
  });

  test('rejeita outra máquina', () => {
    const status = licenseStatus({ claim: bound(), machineFingerprint: 'b7c1' }, NOW);
    expect(status.state).toBe('invalid');
    expect(status.canWrite).toBe(false);
    expect(status.reason).toContain('LIC-2026-0007');
  });

  test('rejeita quando não há fingerprint da máquina', () => {
    expect(licenseStatus({ claim: bound() }, NOW).state).toBe('invalid');
  });

  test('a chave simples ignora a máquina', () => {
    const status = licenseStatus({ claim: subscription(), machineFingerprint: 'qualquer' }, NOW);
    expect(status.state).toBe('active');
  });
});

describe('assinatura inválida', () => {
  test('sobrepõe-se a tudo o resto', () => {
    const status = licenseStatus(
      { signatureError: 'A assinatura da licença não confere.', claim: subscription() },
      NOW
    );
    expect(status.state).toBe('invalid');
    expect(status.canWrite).toBe(false);
    expect(status.reason).toBe('A assinatura da licença não confere.');
  });
});
