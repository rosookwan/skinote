// 시험과 저장소 도구(scripts/check-import-boundary.mts)가 쓰는 Node 내장 모듈의 최소 형식(@types/node를 들이지 않으려고 둔다).
declare module 'node:fs' {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
  }
  export function existsSync(path: string | URL): boolean;
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function readdirSync(path: string | URL, options: { withFileTypes: true }): Dirent[];
}
