export interface LocalProtection {
  available(): boolean;
  seal(value: string): string;
  open(stored: string): string;
}

export interface StorageBackend {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

/** No plaintext fallback, including Electron's Linux basic_text backend. */
export function createLocalProtection(storage: StorageBackend | null): LocalProtection {
  const available = () => {
    try {
      return !!storage?.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  };
  return {
    available,
    seal(value) {
      if (!storage || !available()) throw new Error('LOCAL_PROTECTION_UNAVAILABLE');
      try { return 'enc:v1:' + storage.encryptString(value).toString('base64'); }
      catch { throw new Error('LOCAL_PROTECTION_FAILED'); }
    },
    open(stored) {
      if (!storage || !available()) throw new Error('LOCAL_PROTECTION_UNAVAILABLE');
      if (!stored.startsWith('enc:v1:')) throw new Error('INVALID_LOCAL_ENVELOPE');
      try { return storage.decryptString(Buffer.from(stored.slice(7), 'base64')); }
      catch { throw new Error('LOCAL_PROTECTION_FAILED'); }
    }
  };
}

export function electronProtection(): LocalProtection {
  if (!process.versions.electron) return createLocalProtection(null);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return createLocalProtection((require('electron') as { safeStorage: StorageBackend }).safeStorage);
}
