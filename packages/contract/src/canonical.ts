// 정규 JSON(work/impl-offline/plan.md O5): 지문 · 해시 · 명령 서명이 같은 글을 만들도록 값 하나를 한 가지 글로 쓴다. 기기(브라우저)와 서버
// (저장소 · 서버)가 같은 함수를 쓴다(저장소 ids.ts는 이것을 다시 내보낸다).
//   - 객체의 열쇠는 UTF-16 코드 단위 차례로 늘어놓는다(자바스크립트 글 비교 그대로).
//   - 빈칸 · 줄바꿈이 없다.
//   - 객체의 undefined 칸은 빠진다. 목록의 undefined는 null이다(JSON과 같다).
//   - 유한하지 않은 수(NaN · Infinity)는 던진다(서명한 값과 받은 값이 조용히 달라지지 않게). -0은 0이다.
//   - 글은 JSON.stringify 그대로다(한글은 그대로, 제어 문자는 \u 표기).
//   - 맨 위의 undefined는 'null'이다(옛 저장소 함수와 같게). 함수 · symbol · bigint는 던진다.

/** 값 하나를 정규 JSON 글로. */
export function canonicalJson(value: unknown): string {
  return write(value);
}

function write(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined':
      return 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('정규 JSON: 유한하지 않은 수');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map((v) => write(v)).join(',') + ']';
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + write(v)).join(',') + '}';
    }
    default:
      throw new TypeError('정규 JSON: 쓸 수 없는 값(' + typeof value + ')');
  }
}
