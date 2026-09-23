// 빌드 도구(pwa/skinote-pwa.ts · vite.config.ts)가 쓰는 Node 내장 모듈의 최소 형식. @types/node를 들이지 않으려고 둔다
// (vite의 형식 파일이 `types="node"`를 부르므로 이 폴더를 typeRoots로 준다). 필요한 것만 적는다.
declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: 'sha256'): Hash;
}

declare module 'node:fs' {
  interface Dirent {
    name: string;
    isDirectory(): boolean;
  }
  export function readFileSync(path: string): Uint8Array;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function writeFileSync(path: string, data: string): void;
}

declare module 'node:path' {
  export const sep: string;
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...parts: string[]): string;
}
