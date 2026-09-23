// 체험판 빌드 확인(브라우저 없이, GitHub Pages에 올리기 전). npm run build 뒤 npm run check:dist
// 공개 체험판은 https://rosookwan.github.io/skinote/ 처럼 하위 경로에서 열리므로 빌드한 apps/pos/dist가
//   ① 어디에 올려도 되는지: index.html · 스타일 · 스크립트의 주소가 모두 상대 주소(./)이고, 절대 주소(/assets/…)가 없다.
//   ② 설치한 앱(PWA)이 그 폴더를 범위로 쓰는지: manifest의 id · start_url · scope가 './'이고 아이콘 파일이 있으며,
//      서비스 워커가 './sw.js'(범위 './')로 등록되고 sw.js가 미리 받을 파일이 모두 dist에 있다.
//   ③ 체험판에 넣으면 안 되는 것이 없는지: 관리자 콘솔(파일 이름 · #/admin 경로), 비밀 키 · 토큰 모양의 글, .env 파일,
//      가짜 번호(010-0000-xxxx)가 아닌 휴대폰 번호.
// 브라우저에서 하위 경로로 띄워 서비스 워커 범위 · 오프라인까지 보는 것은 npm run test:pwa(scripts/check-pwa.mjs)다.
// 이 검사는 Pages 배포(.github/workflows/pages.yml)와 CI가 빌드 바로 뒤에 돈다.
//   환경 변수: SKINOTE_DIST(다른 빌드 폴더를 볼 때, 기본 apps/pos/dist)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = process.env.SKINOTE_DIST ? resolve(process.env.SKINOTE_DIST) : fileURLToPath(new URL('../apps/pos/dist/', import.meta.url));
const TEXT_EXTENSIONS = ['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.txt'];

const problems = [];
const passed = [];
const check = (name, ok, detail = '') => {
  if (ok) passed.push(name);
  else problems.push(name + (detail ? ' — ' + detail : ''));
};

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

/** 상대 주소인지: '/'나 '//'로 시작하지 않고, 'https:' · 'data:' 같은 주소 방식이 앞에 없다. */
function isRelative(url) {
  return !url.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(url);
}

function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('빌드한 앱이 없습니다: ' + DIST + '\n먼저 npm run build 를 실행하세요.');
    process.exit(1);
  }
  const files = listFiles(DIST).map((file) => relative(DIST, file).split(sep).join('/')).sort();
  const read = (file) => readFileSync(join(DIST, file), 'utf8');
  const textFiles = files.filter((file) => TEXT_EXTENSIONS.some((ext) => file.endsWith(ext)));
  const scripts = files.filter((file) => file.startsWith('assets/') && file.endsWith('.js'));
  const styles = files.filter((file) => file.startsWith('assets/') && file.endsWith('.css'));

  // ① 상대 주소
  const html = read('index.html');
  const htmlUrls = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const absoluteHtml = htmlUrls.filter((url) => !isRelative(url));
  check('index.html의 주소가 모두 상대 주소', absoluteHtml.length === 0, absoluteHtml.join(', '));
  const missingHtml = htmlUrls.filter((url) => isRelative(url) && !files.includes(url.replace(/^\.\//, '')));
  check('index.html이 가리키는 파일이 모두 있음', missingHtml.length === 0, missingHtml.join(', '));
  check('index.html이 스크립트와 스타일을 불러옴', htmlUrls.some((u) => u.endsWith('.js')) && htmlUrls.some((u) => u.endsWith('.css')));
  const absoluteCss = styles.flatMap((file) => [...read(file).matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]
    .map((m) => m[1]).filter((url) => !url.startsWith('data:') && !isRelative(url)).map((url) => file + ': ' + url));
  check('스타일의 url()이 모두 상대 주소', absoluteCss.length === 0, absoluteCss.join(', '));
  const absoluteJs = scripts.flatMap((file) => [...read(file).matchAll(/["'`]\/(?:assets|icons)\/[^"'`]*["'`]/g)].map((m) => file + ': ' + m[0]));
  check('스크립트에 절대 주소(/assets/ · /icons/)가 없음', absoluteJs.length === 0, absoluteJs.join(', '));

  // ② PWA: manifest · 서비스 워커
  let manifest = null;
  try { manifest = JSON.parse(read('manifest.webmanifest')); } catch (error) { check('manifest.webmanifest를 읽음', false, String(error)); }
  if (manifest) {
    check('manifest의 start_url · scope가 ./', manifest.start_url === './' && manifest.scope === './',
      JSON.stringify({ start_url: manifest.start_url, scope: manifest.scope }));
    // 앱의 id는 start_url의 사이트 뿌리(origin)에 대해 풀린다: 풀린 id가 범위(하위 경로) 안이어야 같은 사이트의 다른 앱과 겹치지 않는다.
    const at = new URL('https://example.test/skinote/manifest.webmanifest');
    const start = new URL(manifest.start_url, at);
    const appId = manifest.id === undefined ? start : new URL(manifest.id, start.origin + '/');
    const scope = new URL(manifest.scope, at);
    check('manifest의 앱 id가 범위(하위 경로) 안', appId.href.startsWith(scope.href), 'id ' + (manifest.id ?? '(없음 → start_url)') + ' → ' + appId.href + ' · 범위 ' + scope.href);
    const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
    const badIcons = icons.filter((icon) => !isRelative(icon.src) || !files.includes(icon.src.replace(/^\.\//, ''))).map((icon) => icon.src);
    check('manifest 아이콘이 상대 주소이고 파일이 있음', icons.length > 0 && badIcons.length === 0, badIcons.join(', '));
    check('manifest에 마스크 아이콘이 있음', icons.some((icon) => String(icon.purpose ?? '').split(/\s+/).includes('maskable')));
  }
  const registered = scripts.some((file) => /serviceWorker\.register\(\s*["'`]\.\/sw\.js["'`]\s*,\s*\{\s*scope:\s*["'`]\.\/["'`]/.test(read(file)));
  check("서비스 워커를 './sw.js'(범위 './')로 등록", registered);
  if (!files.includes('sw.js')) check('sw.js가 있음', false);
  else {
    const sw = read('sw.js');
    const list = /const FILES = (\[[\s\S]*?\]);/.exec(sw);
    let precache = [];
    try { precache = list ? JSON.parse(list[1]) : []; } catch { precache = []; }
    check('sw.js의 판 번호 · 파일 목록이 채워짐', !sw.includes('__SKINOTE_') && precache.length > 0);
    const missing = precache.filter((file) => !isRelative(file) || !files.includes(file));
    check('sw.js가 미리 받을 파일이 모두 상대 주소이고 dist에 있음', missing.length === 0, missing.join(', '));
    check('sw.js가 앱 뼈대(index.html)를 미리 받음', precache.includes('index.html'));
  }

  // ③ 체험판에 넣지 않는 것
  const adminFiles = files.filter((file) => /admin/i.test(file));
  check('관리자 콘솔 파일이 없음', adminFiles.length === 0, adminFiles.join(', '));
  const adminRoutes = scripts.filter((file) => /#\/admin\b/.test(read(file)));
  check('관리자 콘솔 경로(#/admin)가 없음', adminRoutes.length === 0, adminRoutes.join(', '));
  check('.env 파일이 없음', !files.some((file) => /(^|\/)\.env/.test(file)));
  const SECRETS = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '비밀 키'],
    [/\bghp_[A-Za-z0-9]{36}\b/, 'GitHub 토큰'],
    [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/, 'GitHub 토큰'],
    [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'API 키'],
    [/\bAKIA[0-9A-Z]{16}\b/, '클라우드 접근 키'],
  ];
  const secretHits = textFiles.flatMap((file) => {
    const text = read(file);
    return SECRETS.filter(([pattern]) => pattern.test(text)).map(([, label]) => file + ': ' + label);
  });
  check('비밀 키 · 토큰 모양의 글이 없음', secretHits.length === 0, secretHits.join(', '));
  const phones = textFiles.flatMap((file) => [...read(file).matchAll(/\b01[016789]-?(\d{3,4})-?\d{4}\b/g)]
    .filter((m) => m[1] !== '0000').map((m) => file + ': ' + m[0]));
  check('휴대폰 번호는 가짜(010-0000-xxxx)뿐', phones.length === 0, [...new Set(phones)].slice(0, 5).join(', '));

  const bytes = files.reduce((sum, file) => sum + statSync(join(DIST, file)).size, 0);
  for (const name of passed) console.log('✓ ' + name);
  for (const problem of problems) console.log('✗ ' + problem);
  console.log('\n체험판 빌드: 파일 ' + files.length + '개 · ' + (bytes / 1024 / 1024).toFixed(2) + ' MB · 확인 ' + passed.length + '개 통과 · ' + problems.length + '개 어긋남');
  process.exitCode = problems.length ? 1 : 0;
}

main();
