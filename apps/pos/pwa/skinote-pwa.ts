// 스키노트 PWA 빌드 플러그인(설치할 수 있는 앱). vite-plugin-pwa는 Vite 8을 적어 두었지만 workbox-build를 통해 서비스 워커를
// 따로 묶는 rollup · babel · terser를 한 벌 더 들여오므로(Vite 8은 rolldown), 작은 플러그인과 손으로 쓴 서비스 워커(sw.js)를 쓴다.
//   ① manifest.webmanifest: 이름 · 짧은 이름 스키노트, 언어 ko, standalone, 색은 디자인 토큰(packages/ui tokens.css)의
//      --sn-desk(바탕 · 제목 표시줄), public/icons의 아이콘(마스크 아이콘 포함). 모든 주소는 상대 주소라 GitHub Pages의
//      하위 경로(/skinote/)나 매장 PC 어디에 올려도 그 폴더가 범위(scope)가 된다.
//   ② index.html에 manifest 링크와 theme-color를 넣는다.
//   ③ 빌드가 끝나면 dist의 모든 파일(앱 뼈대 · 스크립트 · 스타일 · 묶은 글꼴 · 아이콘)을 미리 받을 목록으로 sw.js를 쓴다.
//      판 번호는 파일들과 서비스 워커 원본 내용의 해시라 바뀐 것이 있을 때만 새 서비스 워커가 된다.
// 등록은 앱이 운영 빌드에서만 한다(src/app/pwa.ts). 개발 서버(vite)에는 이 플러그인이 돌지 않는다.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

export interface SkinotePwaOptions {
  /** 디자인 토큰 파일(색을 읽는다). */
  tokensCss: string;
  /** 서비스 워커 원본(목록 · 판 번호 자리를 채운다). */
  serviceWorker: string;
}

/** tokens.css에서 색 토큰 하나('--sn-desk: #E9E3D6;')를 읽는다. 없으면 빌드를 멈춘다(색이 코드에 따로 적히지 않게). */
function tokenColor(css: string, name: string): string {
  const match = new RegExp('--' + name + ':\\s*(#[0-9A-Fa-f]{3,8})\\s*;').exec(css);
  if (!match?.[1]) throw new Error('디자인 토큰에 색이 없다: --' + name);
  return match[1];
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
  });
}

/** 미리 받지 않는 것: 서비스 워커 자신, 소스 맵, 운영체제가 만든 파일. */
const SKIP = [/(^|\/)sw\.js$/, /\.map$/, /(^|\/)\.DS_Store$/];

export function skinotePwa(options: SkinotePwaOptions): Plugin {
  let config: ResolvedConfig;
  let theme = '';
  let background = '';
  return {
    name: 'skinote-pwa',
    apply: 'build',
    enforce: 'post',
    configResolved(resolved) {
      config = resolved;
      const css = readFileSync(options.tokensCss, 'utf8');
      theme = tokenColor(css, 'sn-desk');
      background = tokenColor(css, 'sn-desk');
    },
    transformIndexHtml() {
      return [
        { tag: 'link', attrs: { rel: 'manifest', href: './manifest.webmanifest' }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'theme-color', content: theme }, injectTo: 'head' },
      ];
    },
    generateBundle() {
      // id는 적지 않는다: 적으면 start_url이 아니라 사이트 뿌리(origin)에 대해 풀려(GitHub Pages면 https://rosookwan.github.io/)
      // 같은 사이트의 다른 앱과 겹친다. 없으면 브라우저가 start_url(그 폴더, /skinote/)을 앱의 id로 쓴다. 설치한 뒤에는 바꾸지 않는다.
      const manifest = {
        name: '스키노트',
        short_name: '스키노트',
        description: '스키 렌탈샵 대여 장부 · 접수증 · 야간 수거 목록',
        lang: 'ko',
        dir: 'ltr',
        start_url: './',
        scope: './',
        display: 'standalone',
        theme_color: theme,
        background_color: background,
        icons: [
          { src: 'icons/app-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/app-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/app-mark.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      };
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: JSON.stringify(manifest, null, 2) + '\n' });
    },
    closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const files = listFiles(outDir)
        .map((file) => relative(outDir, file).split(sep).join('/'))
        .filter((file) => !SKIP.some((pattern) => pattern.test(file)))
        .sort();
      // 판 번호: 미리 받을 파일들과 서비스 워커 원본의 내용 해시(어느 하나가 바뀌면 새 판).
      const template = readFileSync(options.serviceWorker, 'utf8');
      const hash = createHash('sha256').update(template);
      for (const file of files) hash.update(file + '\0').update(readFileSync(join(outDir, file)));
      const version = hash.digest('hex').slice(0, 12);
      const source = template
        .replace("'__SKINOTE_VERSION__'", JSON.stringify(version))
        .replace('__SKINOTE_FILES__', JSON.stringify(files, null, 2));
      if (source.includes('__SKINOTE_')) throw new Error('서비스 워커 원본의 자리를 채우지 못했다');
      writeFileSync(join(outDir, 'sw.js'), source);
      config.logger.info('스키노트 서비스 워커: 파일 ' + files.length + '개 미리 받기 · 판 ' + version);
    },
  };
}
