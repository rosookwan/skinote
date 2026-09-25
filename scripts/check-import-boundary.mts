// 가져오기 경계(ui 7절): 화면 묶음은 옛 업무 규칙(@skinote/core)과 Node 내장 모듈을 가져오지 않는다.
//   apps/pos/src   → @skinote/contract · @skinote/ui · @skinote/layout만(그 밖의 @skinote/* 금지), node: · Node 내장 금지.
//                    @skinote/domain은 체험 자료(apps/pos/src/fixture/)만 가져온다(메모리 어댑터, work/impl-server/plan.md §3-1).
//   apps/pos/src/{screens,components,app} → 체험 자료의 규칙(../fixture/)을 모른다(읽기 모델만 받는다). 체험 자료는 main.tsx만 만든다.
//   packages/domain/src → 업무 규칙(순수 함수, 서버와 체험판이 같은 코드): @skinote/contract만. React · ui · layout · 옛 규칙 · Node 내장 금지
//   packages/store/src  → 서버 저장소(SQL의 집): @skinote/contract · domain · schema와 node:crypto · node:fs만. node:sqlite 금지(연결은
//                         schema의 openDatabase(), D10), 견본 자료(@skinote/domain/sample) · React · ui · layout · 옛 규칙 금지
//   packages/server/{src,bin} → 서버: @skinote/contract · domain · store · schema와 Node 내장 모듈. node:sqlite(연결은 저장소 · schema) ·
//                         React · ui · layout · 옛 규칙 금지
//   packages/ui/src → @skinote/core 금지, node: · Node 내장 금지
//   packages/layout/src → 순수 함수(서버와 같은 코드): React · DOM 부품(@skinote/ui) · 옛 규칙 · Node 내장 금지, @skinote/contract만
//   packages/contract/src → 화면과 서버가 함께 쓰는 형식: React · @skinote/ui · @skinote/layout · 옛 규칙 · Node 내장 금지
// 실행: node scripts/check-import-boundary.mts (어긋나면 한 줄씩 적고 exit 1). 시험(apps/pos/test)도 같은 함수를 부른다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';

export interface BoundaryRule {
  /** 저장소 뿌리에서의 폴더. */
  dir: string;
  /** 가져오면 안 되는 이름인지와 그 까닭(file은 저장소 뿌리에서의 파일 경로). */
  forbid: (specifier: string, file?: string) => string | null;
}

export interface Violation {
  file: string;
  line: number;
  specifier: string;
  reason: string;
}

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'crypto', 'dgram', 'dns', 'events', 'fs', 'fs/promises', 'http', 'http2',
  'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'readline', 'sqlite', 'stream', 'test', 'timers', 'tls', 'tty', 'url',
  'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

function nodeModule(specifier: string): string | null {
  if (specifier.startsWith('node:')) return 'Node 내장 모듈은 화면 묶음에 넣지 않는다';
  if (NODE_BUILTINS.has(specifier)) return 'Node 내장 모듈은 화면 묶음에 넣지 않는다';
  return null;
}

function legacyCore(specifier: string): string | null {
  if (/^@skinote\/core(\/|$)/.test(specifier) || /(^|\/)packages\/core(\/|$)/.test(specifier)) return '옛 업무 규칙(@skinote/core)은 화면이 가져오지 않는다';
  return null;
}

const APP_PACKAGES = /^@skinote\/(contract|ui|layout)(\/|$)/;
const DOMAIN = /^@skinote\/domain(\/|$)/;
/** 도메인(업무 규칙)을 가져와도 되는 곳: 체험 자료(메모리 어댑터)만. 화면 · 부품 · 앱 뼈대 · 미리 보기는 읽기 모델만 받는다. */
const DOMAIN_ADAPTER = /^apps\/pos\/src\/fixture\//;

const REACT = /^(react|react-dom)(\/|$)/;
/** 저장소(packages/store/src)가 쓰는 Node 내장 모듈(plan §3-1). */
const STORE_NODE: ReadonlySet<string> = new Set(['node:crypto', 'node:fs']);

/** 화면 · 부품 · 앱 뼈대는 체험 자료의 규칙을 가져오지 않는다(체험 자료는 main.tsx가 만들어 넘긴다). */
function fixtureRules(s: string): string | null {
  return /(^|\/)fixture\//.test(s) ? '화면은 체험 자료의 규칙(fixture)을 모른다: 읽기 모델만 받는다' : null;
}

export const BOUNDARY_RULES: readonly BoundaryRule[] = [
  {
    dir: 'apps/pos/src',
    forbid: (s, file) => legacyCore(s) ?? nodeModule(s)
      ?? (DOMAIN.test(s) && !DOMAIN_ADAPTER.test(file ?? '') ? '업무 규칙(@skinote/domain)은 체험 자료(fixture/)만 가져온다: 화면은 읽기 모델만 받는다' : null)
      ?? (s.startsWith('@skinote/') && !APP_PACKAGES.test(s) && !DOMAIN.test(s) ? 'apps/pos는 @skinote/contract · ui · layout만 가져온다' : null)
      ?? (/(^|\/)packages\//.test(s) ? '패키지는 이름(@skinote/…)으로 가져온다' : null),
  },
  {
    dir: 'packages/ui/src',
    forbid: (s) => legacyCore(s) ?? nodeModule(s),
  },
  { dir: 'apps/pos/src/screens', forbid: fixtureRules },
  { dir: 'apps/pos/src/components', forbid: fixtureRules },
  { dir: 'apps/pos/src/app', forbid: fixtureRules },
  {
    dir: 'packages/layout/src',
    forbid: (s) => legacyCore(s) ?? nodeModule(s)
      ?? (REACT.test(s) ? 'layout은 순수 함수다(React 없이 서버에서도 돈다)' : null)
      ?? (s.startsWith('@skinote/') && !/^@skinote\/contract(\/|$)/.test(s) ? 'layout은 @skinote/contract만 가져온다(ui → layout → ui 고리 금지)' : null),
  },
  {
    dir: 'packages/domain/src',
    forbid: (s) => legacyCore(s) ?? nodeModule(s)
      ?? (REACT.test(s) ? 'domain은 순수 함수다(React 없이 서버에서도 돈다)' : null)
      ?? (s.startsWith('@skinote/') && !/^@skinote\/contract(\/|$)/.test(s) ? 'domain은 @skinote/contract만 가져온다' : null)
      ?? (/(^|\/)(apps|packages)\//.test(s) ? '패키지는 이름(@skinote/…)으로 가져온다' : null),
  },
  {
    dir: 'packages/store/src',
    forbid: (s) => legacyCore(s)
      ?? (s === 'node:sqlite' || s === 'sqlite' ? '저장소는 node:sqlite를 가져오지 않는다: 연결은 @skinote/schema의 openDatabase()로 연다(D10)' : null)
      ?? (nodeModule(s) && !STORE_NODE.has(s) ? '저장소가 쓰는 Node 내장 모듈은 node:crypto · node:fs뿐이다' : null)
      ?? (REACT.test(s) ? '저장소는 화면 부품을 모른다(React 금지)' : null)
      ?? (/^@skinote\/domain\/sample(\/|$)/.test(s) ? '운영 저장소는 견본 자료(@skinote/domain/sample)를 가져오지 않는다' : null)
      ?? (s.startsWith('@skinote/') && !/^@skinote\/(contract|domain|schema)(\/|$)/.test(s) ? '저장소는 @skinote/contract · domain · schema만 가져온다' : null)
      ?? (/(^|\/)(apps|packages)\//.test(s) ? '패키지는 이름(@skinote/…)으로 가져온다' : null),
  },
  ...['packages/server/src', 'packages/server/bin'].map((dir): BoundaryRule => ({
    dir,
    forbid: (s) => legacyCore(s)
      ?? (s === 'node:sqlite' || s === 'sqlite' ? '서버는 node:sqlite를 가져오지 않는다: 장부 SQL은 @skinote/store, 연결은 @skinote/schema(D10)' : null)
      ?? (REACT.test(s) ? '서버는 화면 부품을 모른다(React 금지)' : null)
      ?? (s.startsWith('@skinote/') && !/^@skinote\/(contract|domain|store|schema)(\/|$)/.test(s) ? '서버는 @skinote/contract · domain · store · schema만 가져온다' : null)
      ?? (/(^|\/)(apps|packages)\//.test(s) ? '패키지는 이름(@skinote/…)으로 가져온다' : null),
  })),
  {
    dir: 'packages/contract/src',
    forbid: (s) => legacyCore(s) ?? nodeModule(s)
      ?? (REACT.test(s) ? 'contract는 화면 부품을 모른다(React 금지)' : null)
      ?? (s.startsWith('@skinote/') ? 'contract는 다른 @skinote 패키지를 가져오지 않는다' : null),
  },
];

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs|css)$/;
const SPECIFIERS = [
  /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g,
];

function files(root: URL, dir: string): string[] {
  const base = new URL(dir.endsWith('/') ? dir : dir + '/', root);
  if (!existsSync(base)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const rel = dir.replace(/\/$/, '') + '/' + entry.name;
    if (entry.isDirectory()) out.push(...files(root, rel));
    else if (SOURCE.test(entry.name)) out.push(rel);
  }
  return out;
}

/** 주석 안의 가져오기 글은 세지 않는다(줄 번호는 지킨다). */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"])\/\/[^\n]*/g, (_, lead: string) => lead);
}

export function findBoundaryViolations(root: URL, rules: readonly BoundaryRule[] = BOUNDARY_RULES): Violation[] {
  const out: Violation[] = [];
  for (const rule of rules) {
    for (const file of files(root, rule.dir)) {
      const text = stripComments(readFileSync(new URL(file, root), 'utf8'));
      for (const pattern of SPECIFIERS) {
        for (const match of text.matchAll(pattern)) {
          const specifier = match[1] ?? '';
          const reason = rule.forbid(specifier, file);
          if (!reason) continue;
          const line = text.slice(0, match.index ?? 0).split('\n').length;
          out.push({ file, line, specifier, reason });
        }
      }
    }
  }
  return out;
}

const repoRoot = new URL('../', import.meta.url);
const entry = (globalThis as { process?: { argv: string[]; exitCode?: number } }).process;
if (entry && entry.argv[1] && new URL(import.meta.url).pathname === entry.argv[1]) {
  const found = findBoundaryViolations(repoRoot);
  for (const v of found) console.log(v.file + ':' + v.line + '  ' + v.specifier + '  — ' + v.reason);
  console.log(found.length ? '가져오기 경계 어긋남 ' + found.length + '건' : '가져오기 경계 확인: 어긋남 없음');
  entry.exitCode = found.length ? 1 : 0;
}
