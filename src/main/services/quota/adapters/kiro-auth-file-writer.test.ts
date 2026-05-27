// Atomic read-merge-write tests for `kiro-auth-token.json`.
//
// We use real filesystem writes against `os.tmpdir()` so the
// rename-atomicity / fsync code paths are exercised exactly as
// they would be in production. Each test cleans up its own files.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProviderAdapterError } from './common';
import {
  readKiroAuthFile,
  writeKiroAuthFile,
  tempPathFor,
} from './kiro-auth-file-writer';

let testDir: string;
let filePath: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiro-auth-test-'));
  filePath = path.join(testDir, 'kiro-auth-token.json');
});

afterEach(async () => {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {
    // ignore — leftover temp dirs are not fatal
  }
});

describe('readKiroAuthFile', () => {
  it('returns null when the file does not exist', async () => {
    const result = await readKiroAuthFile(filePath);
    expect(result).toBeNull();
  });

  it('parses the canonical IDE format with ISO expiresAt', async () => {
    const fixture = {
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: '2026-05-27T14:40:43.287Z',
      profileArn: 'arn:aws:codewhisperer:us-east-1:111:profile/AAA',
      authMethod: 'social',
    };
    await fs.writeFile(filePath, JSON.stringify(fixture, null, 2), 'utf-8');

    const result = await readKiroAuthFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe('at-1');
    expect(result!.refreshToken).toBe('rt-1');
    expect(result!.expiresAt).toBe(Date.parse('2026-05-27T14:40:43.287Z'));
    expect(result!.raw).toMatchObject(fixture);
  });

  it('throws parse_error for malformed JSON', async () => {
    await fs.writeFile(filePath, 'not json', 'utf-8');
    await expect(readKiroAuthFile(filePath)).rejects.toThrowError(
      ProviderAdapterError,
    );
    await expect(readKiroAuthFile(filePath)).rejects.toMatchObject({
      code: 'parse_error',
    });
  });

  it('throws parse_error for a non-object root', async () => {
    await fs.writeFile(filePath, '"a string"', 'utf-8');
    await expect(readKiroAuthFile(filePath)).rejects.toMatchObject({
      code: 'parse_error',
    });
  });

  it('returns null fields when keys are missing', async () => {
    await fs.writeFile(filePath, JSON.stringify({}), 'utf-8');
    const result = await readKiroAuthFile(filePath);
    expect(result!.accessToken).toBeNull();
    expect(result!.refreshToken).toBeNull();
    expect(result!.expiresAt).toBeNull();
  });
});

describe('writeKiroAuthFile', () => {
  it('atomically updates token fields while preserving every other key', async () => {
    const original = {
      accessToken: 'at-old',
      refreshToken: 'rt-old',
      expiresAt: '2026-05-27T14:40:43.287Z',
      profileArn: 'arn:aws:codewhisperer:us-east-1:111:profile/AAA',
      authMethod: 'social',
      provider: 'Google',
      // Unknown future key — must round-trip.
      futureField: { nested: ['a', 'b'] },
    };
    await fs.writeFile(filePath, JSON.stringify(original, null, 2), 'utf-8');

    const newExpiresAt = Date.parse('2026-06-01T00:00:00.000Z');
    await writeKiroAuthFile(filePath, {
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      expiresAt: newExpiresAt,
      profileArn: null, // null → keep existing profileArn
    });

    const written = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(written['accessToken']).toBe('at-new');
    expect(written['refreshToken']).toBe('rt-new');
    expect(written['expiresAt']).toBe('2026-06-01T00:00:00.000Z');
    expect(written['profileArn']).toBe(
      'arn:aws:codewhisperer:us-east-1:111:profile/AAA',
    );
    expect(written['authMethod']).toBe('social');
    expect(written['provider']).toBe('Google');
    expect(written['futureField']).toEqual({ nested: ['a', 'b'] });
  });

  it('updates profileArn when the snapshot supplies a non-null value', async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: '2026-05-27T14:40:43.287Z',
        profileArn: 'arn:aws:codewhisperer:us-east-1:111:profile/OLD',
      }),
      'utf-8',
    );

    await writeKiroAuthFile(filePath, {
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: Date.parse('2026-06-01T00:00:00.000Z'),
      profileArn: 'arn:aws:codewhisperer:us-east-1:111:profile/NEW',
    });

    const written = JSON.parse(await fs.readFile(filePath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(written['profileArn']).toBe(
      'arn:aws:codewhisperer:us-east-1:111:profile/NEW',
    );
  });

  it('throws parse_error when the source file is missing', async () => {
    await expect(
      writeKiroAuthFile(filePath, {
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: Date.now(),
        profileArn: null,
      }),
    ).rejects.toMatchObject({ code: 'parse_error' });
  });

  it('does not leave a .tmp file behind on success', async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: '2026-05-27T14:40:43.287Z',
      }),
      'utf-8',
    );

    await writeKiroAuthFile(filePath, {
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      expiresAt: Date.now(),
      profileArn: null,
    });

    const tmp = tempPathFor(filePath);
    await expect(fs.access(tmp)).rejects.toThrow();
  });
});
