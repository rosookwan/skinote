// 시험에서 쓰는 Node 내장 모듈의 최소 형식(@types/node를 들이지 않으려고 둔다).
declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function existsSync(path: string | URL): boolean;
}
