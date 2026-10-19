import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

const BACKUP_MAGIC = 'AI_RESEARCH_ASSISTANT_BACKUP';
const BACKUP_FORMAT_VERSION = 1;
const MAX_ARCHIVE_BYTES = 150_000_000;
const MAX_DECOMPRESSED_BYTES = 300_000_000;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'ascii');

interface PortableBackupEnvelope {
  magic: typeof BACKUP_MAGIC;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  databaseSha256: string;
  databaseBase64: string;
}

export interface PortableBackupMetadata {
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  databaseBytes: number;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(new Date(value).valueOf());
}

function isSqlite(value: Uint8Array): boolean {
  return value.byteLength >= SQLITE_HEADER.byteLength &&
    Buffer.from(value.subarray(0, SQLITE_HEADER.byteLength)).equals(SQLITE_HEADER);
}

export function createPortableBackup(
  database: Uint8Array,
  metadata: { createdAt: string; appVersion: string; schemaVersion: number },
): Uint8Array {
  if (!isSqlite(database)) throw new Error('Backup source is not a SQLite database.');
  if (!validTimestamp(metadata.createdAt)) throw new Error('Backup timestamp is invalid.');
  if (!metadata.appVersion.trim() || metadata.appVersion.length > 100) {
    throw new Error('Backup app version is invalid.');
  }
  if (!Number.isInteger(metadata.schemaVersion) || metadata.schemaVersion < 1) {
    throw new Error('Backup schema version is invalid.');
  }
  const envelope: PortableBackupEnvelope = {
    magic: BACKUP_MAGIC,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: new Date(metadata.createdAt).toISOString(),
    appVersion: metadata.appVersion,
    schemaVersion: metadata.schemaVersion,
    databaseSha256: sha256(database),
    databaseBase64: Buffer.from(database).toString('base64'),
  };
  return gzipSync(Buffer.from(JSON.stringify(envelope), 'utf8'), { level: 9 });
}

export function readPortableBackup(archive: Uint8Array): {
  database: Uint8Array;
  metadata: PortableBackupMetadata;
} {
  if (archive.byteLength < 1 || archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Backup file size is outside the supported range.');
  }
  let parsed: unknown;
  try {
    const json = gunzipSync(archive, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Backup file is not a valid AI Research Assistant archive.');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Backup envelope is invalid.');
  const value = parsed as Partial<PortableBackupEnvelope>;
  if (value.magic !== BACKUP_MAGIC || value.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error('Backup format is not supported.');
  }
  if (!validTimestamp(value.createdAt) || typeof value.appVersion !== 'string' ||
      !Number.isInteger(value.schemaVersion) || typeof value.databaseSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.databaseSha256) ||
      typeof value.databaseBase64 !== 'string') {
    throw new Error('Backup metadata is invalid.');
  }
  const database = Buffer.from(value.databaseBase64, 'base64');
  if (!isSqlite(database) || sha256(database) !== value.databaseSha256) {
    throw new Error('Backup database failed its integrity hash check.');
  }
  return {
    database,
    metadata: {
      createdAt: new Date(value.createdAt).toISOString(),
      appVersion: value.appVersion,
      schemaVersion: value.schemaVersion as number,
      databaseBytes: database.byteLength,
    },
  };
}
