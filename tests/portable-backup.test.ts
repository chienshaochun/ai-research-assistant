import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPortableBackup,
  readPortableBackup,
} from '../electron/research/portable-backup.js';
import { ResearchStore } from '../electron/research/research-store.js';

const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ai-research-backup-test-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('portable research data backup', () => {
  it('round-trips a consistent SQLite snapshot and metadata', () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'research.sqlite');
    const snapshotPath = join(directory, 'snapshot.sqlite');
    const store = new ResearchStore(databasePath);
    try {
      store.replacePreferences({ topic: 'AI Agent' });
      store.createSnapshot(snapshotPath);
    } finally {
      store.close();
    }

    const archive = createPortableBackup(readFileSync(snapshotPath), {
      createdAt: '2026-10-06T01:00:00.000Z',
      appVersion: '0.1.0',
      schemaVersion: 10,
    });
    const restored = readPortableBackup(archive);
    expect(restored.metadata).toEqual({
      createdAt: '2026-10-06T01:00:00.000Z',
      appVersion: '0.1.0',
      schemaVersion: 10,
      databaseBytes: expect.any(Number),
    });

    const restoredPath = join(directory, 'restored.sqlite');
    writeFileSync(restoredPath, restored.database);
    const restoredStore = new ResearchStore(restoredPath);
    restoredStore.checkIntegrity();
    expect(restoredStore.getPreferences()).toMatchObject({ topic: 'AI Agent' });
    restoredStore.close();
  });

  it('rejects an invalid archive and a modified payload', () => {
    expect(() => readPortableBackup(Buffer.from('not a backup'))).toThrow('not a valid');

    const sqlite = Buffer.concat([
      Buffer.from('SQLite format 3\0', 'ascii'),
      Buffer.alloc(128),
    ]);
    const archive = createPortableBackup(sqlite, {
      createdAt: '2026-10-06T01:00:00.000Z',
      appVersion: '0.1.0',
      schemaVersion: 10,
    });
    archive[archive.length - 1] ^= 0xff;
    expect(() => readPortableBackup(archive)).toThrow();
  });
});
