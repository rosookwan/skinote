// @ts-check
// 서버 판의 앱 뼈대 표시(계획 work/impl-server/plan.md D7). 배포(deploy.sh)가 릴리스에 복사한 index.html에만
// `<meta name="skinote-runtime" content="server">`를 넣는다: 앱은 이 표시가 있으면 늘 서버 모드(세션 · 등록 · 로그인)로 돌고, 없으면
// 체험판이다. 빌드 결과(apps/pos/dist)와 GitHub Pages에는 넣지 않는다(check:dist가 막는다). 로컬 시험 앞단(scripts/lib/local-proxy.mjs)은
// dist의 index.html을 보낼 때 이 함수로 그 자리에서 찍는다.

export const RUNTIME_META_NAME = 'skinote-runtime';
export const RUNTIME_META_TAG = '<meta name="skinote-runtime" content="server">';

const HAS_MARKER = /<meta\s[^>]*name\s*=\s*["']skinote-runtime["'][^>]*>/i;
const HEAD_OPEN = /<head(\s[^>]*)?>/i;

/** 표시가 이미 있는지. @param {string} html */
export function isStamped(html) {
  return HAS_MARKER.test(html);
}

/**
 * index.html에 서버 표시를 넣는다(<head> 바로 뒤, 한 번만: 이미 있으면 그대로 돌려준다). <head>가 없으면 던진다.
 * @param {string} html
 */
export function stampRuntime(html) {
  if (isStamped(html)) return html;
  const head = HEAD_OPEN.exec(html);
  if (!head) throw new Error('index.html에 <head>가 없습니다');
  const at = head.index + head[0].length;
  return html.slice(0, at) + '\n    ' + RUNTIME_META_TAG + html.slice(at);
}
