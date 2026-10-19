import type { CredentialEncryption } from '@siwc/local';
import type { SafeStorage } from 'electron';

type StorageAPI = Pick<
  SafeStorage,
  'isEncryptionAvailable' | 'encryptString' | 'decryptString' | 'getSelectedStorageBackend'
>;

/**
 * Electron safeStorage adapter based on OpenAI's Paste Perfect example.
 * Keep this in the main process; keys and plaintext never cross IPC.
 */
export function createElectronCredentialEncryption(
  storage: StorageAPI,
  isReady: () => boolean,
  platform: NodeJS.Platform = process.platform,
): CredentialEncryption {
  const isAvailable = () => {
    if (!isReady() || !storage.isEncryptionAvailable()) return false;
    if (platform !== 'linux') return true;
    return ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
      storage.getSelectedStorageBackend(),
    );
  };

  const requireAvailable = () => {
    if (!isAvailable()) throw new Error('OS credential encryption is unavailable.');
  };

  return {
    id: 'electron-safe-storage-v1',
    isAvailable,
    encrypt(plaintext) {
      requireAvailable();
      return storage.encryptString(plaintext);
    },
    decrypt(ciphertext) {
      requireAvailable();
      return storage.decryptString(Buffer.from(ciphertext));
    },
  };
}

