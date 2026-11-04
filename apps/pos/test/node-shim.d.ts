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

// 기사 기기의 서명 시험(sign.test.ts): 서버와 같은 검사(node:crypto verify, IEEE P1363)로 기기가 만든 서명을 본다.
declare module 'node:crypto' {
  export function verify(
    algorithm: string,
    data: Uint8Array,
    key: { key: JsonWebKey; format: 'jwk'; dsaEncoding?: 'ieee-p1363' | 'der' },
    signature: Uint8Array,
  ): boolean;
}
