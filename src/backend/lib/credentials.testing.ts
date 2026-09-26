import { randomBytes } from 'node:crypto';
import { createLocalProtection, type LocalProtection } from './local-protection';
import type { Vault } from './vault';
import { decryptValue, encryptValue } from './vault-crypto';

/** DPAPI de brincar: o que uma "máquina" sela só essa máquina abre. Só para testes. */
export function fakeMachine(name: string): LocalProtection {
  return createLocalProtection({
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`${name}:${plain}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const text = buf.toString('utf8');
      if (!text.startsWith(`${name}:`)) throw new Error('outra máquina');
      return text.slice(name.length + 1);
    }
  });
}

/** Cofre pronto, só em memória — o que a app empacotada tem depois do arranque. */
export function memoryVault(): Vault {
  const key = randomBytes(32);
  const refuse = () => { throw new Error('NOT_SUPPORTED_IN_MEMORY_VAULT'); };
  return {
    status: () => 'ready',
    encrypt: (context, value) => encryptValue(key, context, value),
    decrypt: (context, stored) => decryptValue(key, context, stored),
    pendingRecoveryKey: refuse,
    confirmRecovery: refuse,
    unlock: refuse,
    dispose: () => key.fill(0)
  };
}
