// 서버 길(비밀번호 재발급 · 기기 막기, features-1 E15 · E13c)의 거절: 코드(ApiErrorCode 또는 NETWORK)와 잠김 끝 시각. 화면(PinDialog)과
// 서버 클라이언트(HttpClient)가 함께 쓴다. 이 파일만 따로 두어 체험판 묶음에 서버 클라이언트가 들지 않게 한다.
export class ServerRefusal extends Error {
  readonly code: string;
  readonly lockedUntil: string | undefined;
  constructor(code: string, lockedUntil?: string) {
    super(code);
    this.name = 'ServerRefusal';
    this.code = code;
    this.lockedUntil = lockedUntil;
  }
}
