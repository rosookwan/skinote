// @ts-check
// 쓰기를 열기 전의 확인: 권한이 없어 SQLite가 말없이 읽기 전용으로 연 파일은 쓰기 막음(READ_ONLY_FILE, 503),
// 그 판의 post_migration 사본이 잘렸거나(도중에 죽은 VACUUM INTO) 끝나지 않은 -journal이 있으면 치우고 다시 받음,
// 다시 받지 못하면 쓰기 막음(POST_MIGRATION_BACKUP_MISSING).

import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { checkBackupFile, isVerified } from '../src/backup-files.js';
import { closeDatabases, openDatabases } from '../src/databases.js';
import { startServer } from '../src/server.js';
import { collectLog, request, tempDir, testConfig } from './helpers.js';

const temp = tempDir();
after(() => temp.cleanup());
const quiet = { log: () => {} };
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** @param {string} name @param {string} shops */
function prepared(name, shops) {
  const config = testConfig(join(temp.dir, name), { SKINOTE_SHOP_IDS: shops });
  closeDatabases(openDatabases(config, quiet));
  return config;
}

/** 그 파일의 post_migration 사본 이름(오래된 것 먼저). @param {string} dir @param {string} base */
function postCopies(dir, base) {
  return readdirSync(dir).filter(n => n.startsWith(`${base}.post_migration.v0001.`) && n.endsWith('.sqlite')).sort();
}

test('a shop file the service user cannot write is reported as READ_ONLY_FILE and health is 503', { skip: isRoot && 'root ignores file modes' }, async () => {
  for (const variant of ['file', 'folder']) {
    const config = prepared(`read-only-${variant}`, 'shop-a');
    const file = join(config.shopDbDir, 'shop-a.sqlite');
    const target = variant === 'file' ? file : config.shopDbDir;
    chmodSync(target, variant === 'file' ? 0o444 : 0o555);
    const { lines, log } = collectLog();
    const app = await startServer(config, { log });
    try {
      const res = await request(app.port, '/api/health');
      assert.equal(res.status, 503, variant);
      const shop = (await res.json()).databases[1];
      assert.equal(shop.writable, false, variant);
      if (variant === 'file') {
        // 실행기는 up_to_date · read_write라고 돌려주지만 SQLite가 말없이 읽기 전용으로 열었다.
        assert.equal(shop.status, 'up_to_date');
        assert.deepEqual(shop.warnings, ['READ_ONLY_FILE']);
        assert.ok(lines.some(l => l.includes('파일에 쓸 수 없음(SQLITE_READONLY)')), lines.join('\n'));
      } else {
        // -wal · -shm을 만들 수 없는 폴더: 쓰기 연결을 열지 못하고 까닭이 코드로 보인다.
        assert.equal(shop.status, 'failed');
        assert.equal(shop.reason, 'SQLITE_READONLY');
      }
    } finally {
      await app.close();
      chmodSync(target, variant === 'file' ? 0o644 : 0o755);
    }
  }
});

test('a truncated post_migration copy (no marker) is set aside and taken again before writes', async () => {
  const config = prepared('truncated', 'shop-a');
  const [copy] = postCopies(config.migrationBackupDir, 'shop-a');
  const path = join(config.migrationBackupDir, copy);
  assert.ok(isVerified(path), 'the first start marked the runner-checked copy');
  // VACUUM INTO가 도중에 죽은 모습: 앞 절반만 있고 확인 표시는 없다.
  const bytes = readFileSync(path);
  writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
  rmSync(`${path}.verified`);

  const { lines, log } = collectLog();
  const app = await startServer(config, { log });
  try {
    const shop = (await (await request(app.port, '/api/health')).json()).databases[1];
    assert.equal(shop.writable, true);
    assert.deepEqual(shop.warnings, ['POST_MIGRATION_BACKUP_RETAKEN']);
    assert.ok(lines.some(l => l.includes(`${copy}이(가) 망가짐(TRUNCATED)`)), lines.join('\n'));
  } finally {
    await app.close();
  }
  assert.ok(existsSync(`${path}.broken`), 'the truncated copy is kept aside for inspection');
  const now = postCopies(config.migrationBackupDir, 'shop-a');
  assert.equal(now.length, 1);
  assert.notEqual(now[0], copy);
  const fresh = join(config.migrationBackupDir, now[0]);
  assert.deepEqual(checkBackupFile(fresh), { ok: true });
  assert.ok(isVerified(fresh));
});

test('a copy changed after it was marked, or with a leftover -journal, is not trusted', async () => {
  const config = prepared('stale-marker', 'shop-a,shop-b');
  const dir = config.migrationBackupDir;
  // shop-a: 표시는 있지만 파일이 그 뒤에 잘렸다(크기 · 시각이 표시와 다름).
  const a = join(dir, postCopies(dir, 'shop-a')[0]);
  writeFileSync(a, readFileSync(a).subarray(0, 4096 * 3));
  // shop-b: 파일은 온전하지만 옆에 끝나지 않은 -journal이 있다.
  const b = join(dir, postCopies(dir, 'shop-b')[0]);
  writeFileSync(`${b}-journal`, 'hot journal');

  const { lines, log } = collectLog();
  const app = await startServer(config, { log });
  try {
    const body = await (await request(app.port, '/api/health')).json();
    assert.equal(body.ok, true);
    for (const shop of body.databases.slice(1)) assert.deepEqual(shop.warnings, ['POST_MIGRATION_BACKUP_RETAKEN'], shop.file);
    assert.ok(lines.some(l => l.includes('망가짐(TRUNCATED)')), lines.join('\n'));
    assert.ok(lines.some(l => l.includes('망가짐(HOT_JOURNAL)')), lines.join('\n'));
  } finally {
    await app.close();
  }
  assert.ok(existsSync(`${b}-journal.broken`) && !existsSync(`${b}-journal`));

  // 다시 시작하면 새 사본의 표시를 믿고 아무것도 다시 받지 않는다.
  const again = await startServer(config, quiet);
  try {
    const body = await (await request(again.port, '/api/health')).json();
    for (const db of body.databases) assert.deepEqual(db.warnings, [], db.file);
  } finally {
    await again.close();
  }
});

test('when the copy is broken and cannot be taken again, writes stay blocked', { skip: isRoot && 'root ignores file modes' }, async () => {
  const config = prepared('cannot-retake', 'shop-a');
  const dir = config.migrationBackupDir;
  const a = join(dir, postCopies(dir, 'shop-a')[0]);
  writeFileSync(a, readFileSync(a).subarray(0, 4096 * 3));
  chmodSync(dir, 0o555);
  const app = await startServer(config, quiet);
  try {
    const res = await request(app.port, '/api/health');
    assert.equal(res.status, 503);
    const shop = (await res.json()).databases[1];
    assert.equal(shop.writable, false);
    assert.deepEqual(shop.warnings, ['POST_MIGRATION_BACKUP_MISSING']);
  } finally {
    await app.close();
    chmodSync(dir, 0o755);
  }
});
