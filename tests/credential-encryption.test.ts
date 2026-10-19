import { describe, expect, it, vi } from 'vitest';
import { createElectronCredentialEncryption } from '../electron/credential-encryption.js';

type StorageBackend =
  | 'basic_text'
  | 'gnome_libsecret'
  | 'kwallet'
  | 'kwallet5'
  | 'kwallet6'
  | 'unknown';

function storage(available = true, backend: StorageBackend = 'unknown') {
  return {
    isEncryptionAvailable: vi.fn(() => available),
    getSelectedStorageBackend: vi.fn(() => backend),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().replace('encrypted:', '')),
  };
}

describe('Electron credential encryption adapter', () => {
  it('uses safeStorage without exposing a plaintext fallback', async () => {
    const api = storage();
    const encryption = createElectronCredentialEncryption(api, () => true, 'win32');
    const encrypted = await encryption.encrypt('secret');
    expect(Buffer.from(encrypted).toString()).toBe('encrypted:secret');
    expect(await encryption.decrypt(encrypted)).toBe('secret');
  });

  it('fails closed before Electron is ready', async () => {
    const encryption = createElectronCredentialEncryption(storage(), () => false, 'win32');
    expect(await encryption.isAvailable()).toBe(false);
    expect(() => encryption.encrypt('secret')).toThrow('OS credential encryption is unavailable');
  });

  it('rejects Linux basic_text storage', async () => {
    const encryption = createElectronCredentialEncryption(storage(true, 'basic_text'), () => true, 'linux');
    expect(await encryption.isAvailable()).toBe(false);
  });
});
