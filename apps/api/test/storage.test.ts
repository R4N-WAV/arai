import { CHUNK_OVERHEAD, CHUNK_SIZE } from '@arai/shared';
import { describe, expect, it } from 'vitest';
import { chunkRange, remoteUrl, validRemoteRef } from '../src/lib/remote';
import { blob, newProject, pid, registered } from './helpers';

const FULL = CHUNK_SIZE + CHUNK_OVERHEAD;

describe('bring-your-own storage', () => {
  it('only accepts real Dropbox share links and Drive ids, and rebuilds URLs on fixed hosts', () => {
    expect(validRemoteRef('dropbox', 'https://www.dropbox.com/scl/fi/abc123def456/x.arai?rlkey=abcdef123456')).toBe(true);
    expect(validRemoteRef('dropbox', 'https://evil.example/s/abc/x')).toBe(false);
    expect(validRemoteRef('dropbox', 'https://www.dropbox.com.evil.example/s/abcdefgh/x')).toBe(false);
    expect(validRemoteRef('gdrive', '1AbCdEfGhIjKlMnOp_-')).toBe(true);
    expect(validRemoteRef('gdrive', '../../etc/passwd')).toBe(false);
    expect(remoteUrl({} as never, 'dropbox', 'https://www.dropbox.com/scl/fi/abc123def456/x.arai?rlkey=abcdef123456')).toBe('https://dl.dropboxusercontent.com/scl/fi/abc123def456/x.arai?rlkey=abcdef123456');
    expect(remoteUrl({} as never, 'gdrive', '1AbCdEfGhIjKlMnOp_-')).toBeNull(); // no API key configured
  });

  it('maps chunk indexes to byte ranges of the single remote file', () => {
    const size = 2 * FULL + 500;
    expect(chunkRange(size, 0)).toEqual({ start: 0, end: FULL - 1 });
    expect(chunkRange(size, 2)).toEqual({ start: 2 * FULL, end: size - 1 });
  });

  it('needs a connected account, a valid reference and a readable remote file; such files skip the quota', async () => {
    const { c } = await registered('st_byo');
    const p = await newProject(c);
    const body = (over: Record<string, unknown>) => ({ id: pid(), kind: 'audio', encSize: 540, chunkCount: 1, encFileKey: blob(), keyVersion: 1, ...over });
    const ref = 'https://www.dropbox.com/scl/fi/abc123def456/x.arai?rlkey=abcdef123456';
    // Not connected yet.
    expect((await c.call('POST', `/projects/${p}/files`, body({ storage: 'dropbox', remoteRef: ref }))).status).toBe(400);
    expect((await c.call('PUT', '/account/storage-accounts/dropbox', { encToken: blob() })).status).toBe(200);
    expect((await c.call('GET', '/account/storage-accounts')).json.accounts).toHaveLength(1);
    expect((await c.call('POST', `/projects/${p}/files`, body({ storage: 'dropbox', remoteRef: 'https://evil.example/x' }))).status).toBe(400);
    expect((await c.call('POST', `/projects/${p}/files`, body({ storage: 'dropbox' }))).status).toBe(400);
    // The test runner cannot reach Dropbox, so the size check refuses it (as it would a missing file).
    expect((await c.call('POST', `/projects/${p}/files`, body({ storage: 'dropbox', remoteRef: ref }))).json.error).toBe('remote_unreadable');
    expect((await c.call('DELETE', '/account/storage-accounts/dropbox')).status).toBe(200);
  });
});
