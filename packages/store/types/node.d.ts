// 저장소 코드와 시험이 쓰는 Node 내장 모듈의 최소 형식(@types/node를 들이지 않으려고 둔다. domain · contract의 node-shim과 같은 방식).
// 실행은 Node 22.18 이상이 .ts를 그대로 읽는다(형식만 지움, plan D10).

interface NodeBuffer extends Uint8Array {
  toString(encoding?: 'hex' | 'base64' | 'base64url' | 'utf8'): string;
}

declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array, encoding?: 'utf8'): Hash;
    digest(): NodeBuffer;
    digest(encoding: 'hex' | 'base64' | 'base64url'): string;
  }
  export function createHash(algorithm: 'sha256'): Hash;
  export function createHmac(algorithm: 'sha256', key: string | Uint8Array): Hash;
  export function randomBytes(size: number): NodeBuffer;
  export function hkdfSync(digest: 'sha256', ikm: Uint8Array | string, salt: Uint8Array | string, info: Uint8Array | string, keylen: number): ArrayBuffer;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): string | undefined;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function readdirSync(path: string): string[];
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:child_process' {
  interface Readable {
    on(event: 'data', listener: (chunk: NodeBuffer) => void): void;
  }
  export interface ChildProcess {
    readonly pid?: number;
    readonly stdout: Readable | null;
    readonly stderr: Readable | null;
    kill(signal?: 'SIGKILL' | 'SIGTERM'): boolean;
    on(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  }
  export function spawn(command: string, args: readonly string[], options?: { stdio?: ('pipe' | 'ignore' | 'inherit')[] }): ChildProcess;
  export function spawnSync(command: string, args: readonly string[], options?: { encoding?: 'utf8'; timeout?: number }): { status: number | null; stdout: string; stderr: string };
}

declare module 'node:test' {
  type Fn = () => void | Promise<void>;
  export function test(name: string, fn: Fn): Promise<void>;
  export function test(name: string, options: { timeout?: number; skip?: boolean | string }, fn: Fn): Promise<void>;
  export function describe(name: string, fn: () => void): void;
  export function before(fn: Fn): void;
  export function after(fn: Fn): void;
  export function beforeEach(fn: Fn): void;
  export function afterEach(fn: Fn): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
    doesNotMatch(value: string, pattern: RegExp, message?: string): void;
    throws(fn: () => unknown, expected?: RegExp | ((error: unknown) => boolean) | object, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
    rejects(promise: Promise<unknown> | (() => Promise<unknown>), expected?: RegExp | ((error: unknown) => boolean) | object, message?: string): Promise<void>;
    fail(message?: string): never;
  }
  const assert: Assert;
  export default assert;
}

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  execPath: string;
  pid: number;
  exitCode?: number;
  stdout: { write(text: string): boolean };
  on(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  exit(code?: number): never;
};
