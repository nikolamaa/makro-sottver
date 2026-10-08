import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBackup, readBackup, type BackupContainer } from './backup.js';
import { generateRecoveryKey, wrapMasterKey, type WrappedKey } from './recovery.js';

const SECRET_TEXT = 'Hi {{user}}, your withdrawal of 0.5 BTC is pending review by our security team.';
const payload = {
  library: {
    macros: [{ id: 'm1', title: 'Withdrawal pending', body: SECRET_TEXT, tags: ['withdrawal', 'crypto'] }],
    categories: [{ id: 'c1', name: 'Payments' }],
  },
};

const masterKey = randomBytes(32);
const recoveryKey = generateRecoveryKey();
const wrappedKey: WrappedKey = wrapMasterKey(masterKey, recoveryKey);
const backup = createBackup(payload, masterKey, wrappedKey);

function container(): BackupContainer {
  return JSON.parse(backup.toString('utf8')) as BackupContainer;
}

function withChanges(patch: Record<string, unknown>): string {
  return JSON.stringify({ ...container(), ...patch });
}

describe('createBackup', () => {
  it('writes the documented container as UTF-8 JSON', () => {
    const c = container();
    expect(Object.keys(c).sort()).toEqual(['createdAt', 'format', 'payload', 'v', 'wrappedKey']);
    expect(c.format).toBe('macropilot-backup');
    expect(c.v).toBe(1);
    expect(new Date(c.createdAt).toISOString()).toBe(c.createdAt);
    expect(c.wrappedKey).toEqual(wrappedKey);
    expect(c.payload).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('never contains plaintext or the master key', () => {
    const text = backup.toString('utf8');
    expect(text).not.toContain('withdrawal');
    expect(text).not.toContain('Payments');
    expect(text).not.toContain(masterKey.toString('base64'));
    expect(Buffer.from(container().payload, 'base64').toString('latin1')).not.toContain('withdrawal');
  });

  it('produces a different ciphertext every time', () => {
    expect(createBackup(payload, masterKey, wrappedKey).equals(backup)).toBe(false);
  });

  it('rejects an undefined payload, a malformed wrapped key and a wrong-length master key', () => {
    expect(() => createBackup(undefined, masterKey, wrappedKey)).toThrow('Backup payload must be a JSON value');
    expect(() => createBackup(payload, masterKey, { ...wrappedKey, salt: 'x' })).toThrow('Invalid wrapped key');
    expect(() => createBackup(payload, randomBytes(16), wrappedKey)).toThrow('Master key must be 32 bytes');
  });
});

describe('readBackup', () => {
  it('round-trips the payload and returns the master key', () => {
    const res = readBackup<typeof payload>(backup, recoveryKey);
    expect(res.payload).toEqual(payload);
    expect(res.masterKey.equals(masterKey)).toBe(true);
    expect(res.createdAt).toBe(container().createdAt);
  });

  it('accepts a string, a UTF-8 BOM and a sloppily typed recovery key', () => {
    const sloppy = recoveryKey.replace('MPRK-', '').replaceAll('-', ' ').toLowerCase();
    expect(readBackup(`﻿${backup.toString('utf8')}`, sloppy).payload).toEqual(payload);
  });

  it('round-trips other JSON values', () => {
    for (const value of [null, 0, 'text', [1, 2, 3], { nested: { deep: true } }]) {
      expect(readBackup(createBackup(value, masterKey, wrappedKey), recoveryKey).payload).toEqual(value);
    }
  });

  it('rejects a wrong recovery key', () => {
    expect(() => readBackup(backup, generateRecoveryKey())).toThrow(new Error('Invalid recovery key'));
  });

  it('rejects a malformed recovery key', () => {
    expect(() => readBackup(backup, 'definitely not a key')).toThrow(new Error('Invalid recovery key format'));
  });

  it('detects a tampered payload', () => {
    const blob = Buffer.from(container().payload, 'base64');
    const i = Math.floor(blob.length / 2);
    blob[i] = (blob[i] ?? 0) ^ 0x01;
    expect(() => readBackup(withChanges({ payload: blob.toString('base64') }), recoveryKey)).toThrow(
      new Error('Backup file is corrupted'),
    );
  });

  it('detects a truncated payload', () => {
    const truncated = container().payload.slice(0, 40);
    expect(() => readBackup(withChanges({ payload: truncated }), recoveryKey)).toThrow(new Error('Backup file is corrupted'));
  });

  it('detects a payload taken from a backup made with another master key', () => {
    const otherKey = randomBytes(32);
    const other = createBackup(payload, otherKey, wrapMasterKey(otherKey, recoveryKey));
    const foreignPayload = (JSON.parse(other.toString('utf8')) as BackupContainer).payload;
    expect(() => readBackup(withChanges({ payload: foreignPayload }), recoveryKey)).toThrow(
      new Error('Backup file is corrupted'),
    );
  });

  it.each<[string, string | Buffer]>([
    ['not JSON', 'this is not json'],
    ['truncated JSON', backup.subarray(0, 100)],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
  ])('reports %s as corrupted', (_label, file) => {
    expect(() => readBackup(file, recoveryKey)).toThrow(new Error('Backup file is corrupted'));
  });

  it.each<[string, Record<string, unknown>]>([
    ['a missing wrapped key', { wrappedKey: undefined }],
    ['a malformed wrapped key', { wrappedKey: { v: 1, kdf: 'scrypt' } }],
    ['hostile scrypt parameters', { wrappedKey: { ...container().wrappedKey, N: 2 ** 30 } }],
    ['a missing payload', { payload: undefined }],
    ['a non-base64 payload', { payload: '%%% not base64 %%%' }],
    ['a missing createdAt', { createdAt: undefined }],
  ])('reports %s as corrupted', (_label, patch) => {
    expect(() => readBackup(withChanges(patch), recoveryKey)).toThrow(new Error('Backup file is corrupted'));
  });

  it('rejects other file types and newer versions', () => {
    expect(() => readBackup(JSON.stringify({ hello: 'world' }), recoveryKey)).toThrow('Not a MacroPilot backup file');
    expect(() => readBackup(withChanges({ format: 'other-app' }), recoveryKey)).toThrow('Not a MacroPilot backup file');
    expect(() => readBackup(withChanges({ v: 2 }), recoveryKey)).toThrow(/Unsupported backup version/);
  });

  it('error messages never echo file content', () => {
    try {
      readBackup(`{"format":"macropilot-backup","v":1,"payload":"${SECRET_TEXT}"}`, recoveryKey);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('withdrawal');
    }
  });
});
