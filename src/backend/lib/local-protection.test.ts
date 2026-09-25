import { expect, test } from 'vitest';
import { createLocalProtection } from './local-protection';

test('sem fornecedor seguro recusa gravar e abrir', () => {
  const local = createLocalProtection(null);
  expect(local.available()).toBe(false);
  expect(() => local.seal('segredo')).toThrow();
  expect(() => local.open('enc:v1:abc')).toThrow();
});

test('Linux basic_text e falha do fornecedor nunca devolvem plaintext', () => {
  const backend = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'basic_text',
    encryptString: () => { throw new Error('secret accidentally echoed'); },
    decryptString: () => { throw new Error('secret accidentally echoed'); }
  };
  const local = createLocalProtection(backend);
  expect(local.available()).toBe(false);
  expect(() => local.seal('segredo')).toThrow('LOCAL_PROTECTION_UNAVAILABLE');
  const failing = createLocalProtection({ ...backend, getSelectedStorageBackend: () => 'gnome_libsecret' });
  expect(() => failing.seal('segredo')).toThrow('LOCAL_PROTECTION_FAILED');
});
