// 저장소의 경계(plan §3-1 · D10): 가져오기 경계 검사가 저장소에서 node:sqlite · 화면 패키지 · 견본 자료 · 다른 Node 모듈을 잡는다. 저장소
// 코드는 마이그레이션 검사(lint --code)도 통과한다: 장부 표에 OR REPLACE · OR IGNORE가 없고 연결을 직접 열지 않는다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers.ts';

const temp = tempDir('skinote-boundary-');
after(() => temp.cleanup());
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const CHECKER = REPO + 'scripts/check-import-boundary.mts';
const LINT = REPO + 'packages/schema/tools/lint.js';

const node = (args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { encoding: 'utf8', timeout: 60_000 });

test('the import boundary catches node:sqlite, UI packages, sample data and other Node modules in packages/store/src', () => {
  const root = temp.dir + '/repo/';
  mkdirSync(root + 'packages/store/src', { recursive: true });
  writeFileSync(root + 'packages/store/src/bad.ts', [
    "import { DatabaseSync } from 'node:sqlite';",
    "import { Button } from '@skinote/ui';",
    "import { sampleSpec } from '@skinote/domain/sample';",
    "import { spawn } from 'node:child_process';",
    "import { x } from '../../../packages/domain/src/index.ts';",
    "import { legacy } from '@skinote/core';",
  ].join('\n') + '\n');
  writeFileSync(root + 'packages/store/src/good.ts', [
    "import { execute } from '@skinote/domain';",
    "import type { CommandOutcome } from '@skinote/contract';",
    "import { openDatabase } from '@skinote/schema';",
    "import { createHash } from 'node:crypto';",
    "import { mkdirSync } from 'node:fs';",
  ].join('\n') + '\n');
  const script = `import { findBoundaryViolations } from ${JSON.stringify(CHECKER)};
    const found = findBoundaryViolations(new URL(${JSON.stringify('file://' + root)}));
    process.stdout.write(JSON.stringify(found.map((v) => [v.file, v.specifier])));`;
  const out = node(['--input-type=module', '-e', script]);
  assert.equal(out.status, 0, out.stderr);
  const found = JSON.parse(out.stdout) as [string, string][];
  assert.deepEqual(found.map(([, s]) => s).sort(), ['../../../packages/domain/src/index.ts', '@skinote/core', '@skinote/domain/sample', '@skinote/ui', 'node:child_process', 'node:sqlite'].sort());
  assert.ok(found.every(([file]) => file === 'packages/store/src/bad.ts'), 'good.ts passes');
});

test('the real repository has no boundary violation, and the store source passes the migration code lint', () => {
  const boundary = node([CHECKER]);
  assert.equal(boundary.status, 0, boundary.stdout);
  const lint = node([LINT, '--code', REPO + 'packages/store/src']);
  assert.equal(lint.status, 0, lint.stdout);
  assert.match(lint.stdout, /코드 포함/);
});
