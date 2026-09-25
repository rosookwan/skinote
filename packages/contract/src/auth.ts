// 기기 등록 · 직원 로그인 · 세션의 형식(work/impl-server/plan.md D6 · §5-1 · §5-3). 서버(packages/server의 auth.js)와 앱(HttpClient ·
// 등록 · 로그인 화면)이 함께 쓴다. 비밀값(비밀번호 · 등록 번호 · 세션 토큰)은 모양만 여기 있고 값은 어디에도 적지 않는다.
//
// 흐름: 등록 번호 12자리(명령줄이 한 번 보여 줌) + 기기 열쇠(WebCrypto P-256, 꺼낼 수 없음)로 기기 등록 → 로그인 때마다 서버의 한 번
// 쓰는 값(nonce)에 기기 열쇠로 서명 → 직원 타일 → 비밀번호(숫자 4~6자리) → 세션 쿠키. 쿠키 뒤의 POST는 CSRF 머리를 함께 보낸다.

/** 매장 기기 종류(devices.kind_key, sys_device_kinds의 매장 기기). */
export const DEVICE_KINDS = ['pos', 'driver_tablet', 'driver_phone'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** 기사 기기인지(기사 세션: 자기 차량의 일만, plan §5-4). */
export const isDriverDevice = (kind: DeviceKind): boolean => kind === 'driver_tablet' || kind === 'driver_phone';

/** 서명 문장의 앞마디(D6). 같은 기기 열쇠가 나중에 보냄 대기 명령에 서명해도 로그인 서명과 헷갈리지 않게 한다. */
export const LOGIN_CONTEXT = 'skinote-login-v1';

/** 로그인 서명 문장: `skinote-login-v1|<origin>|<deviceId>|<nonce>`(UTF-8). origin은 앱 주소(https://…, 끝 빗금 없음). */
export function loginMessage(origin: string, deviceId: string, nonce: string): string {
  return LOGIN_CONTEXT + '|' + origin + '|' + deviceId + '|' + nonce;
}

/** 등록 번호는 숫자 12자리다(화면에 영어 글자가 없어서 숫자판으로 넣는다, D6). */
export const ENROLL_CODE_DIGITS = 12;
/** 직원 비밀번호(숫자판): 4~6자리. */
export const PIN_MIN_DIGITS = 4;
export const PIN_MAX_DIGITS = 6;

export const isEnrollCode = (value: string): boolean => /^\d{12}$/.test(value);
export const isPin = (value: string): boolean => /^\d{4,6}$/.test(value);

/** 등록 번호의 숫자만('1234-5678-9012' · '1234 5678 9012' → '123456789012'). */
export const enrollCodeDigits = (value: string): string => value.replace(/[\s-]/g, '');

/** 등록 번호 보이기: 넷씩 끊어 '1234-5678-9012'. 12자리가 아니면 받은 그대로. */
export function formatEnrollCode(code: string): string {
  const digits = enrollCodeDigits(code);
  return isEnrollCode(digits) ? digits.slice(0, 4) + '-' + digits.slice(4, 8) + '-' + digits.slice(8) : code;
}

/** 세션 쿠키 이름(__Host-: Secure · Path=/ · Domain 없음이 강제된다). */
export const SESSION_COOKIE = '__Host-sn_session';
/** 쿠키 뒤의 POST가 함께 보내는 CSRF 머리(값은 SessionInfo.csrf, 기기는 메모리에만 둔다). */
export const CSRF_HEADER = 'x-skinote-csrf';

/** 앱이 부르는 길(앞 빗금 없음: 앱은 new URL(path, document.baseURI)로 푼다). */
export const API_V2 = /* @__PURE__ */ Object.freeze({
  session: 'api/v2/session',
  enroll: 'api/v2/device/enroll',
  challenge: 'api/v2/device/challenge',
  staff: 'api/v2/login/staff',
  login: 'api/v2/login',
  logout: 'api/v2/logout',
  head: 'api/v2/head',
  query: 'api/v2/query',
  command: 'api/v2/command',
  stream: 'api/v2/stream',
});

/** 기기 공개 열쇠(WebCrypto exportKey('jwk')의 P-256 공개 열쇠). 비밀 열쇠(d)는 기기 밖으로 나오지 않는다. */
export interface DevicePublicKey {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  ext?: boolean;
  key_ops?: string[];
}

export interface EnrollRequest {
  /** 숫자 12자리(끊는 표시 없이). */
  code: string;
  publicKey: DevicePublicKey;
  /** 기기가 말한 모양('Windows · Chrome', 80자까지). 승인 기록에만 쓴다. */
  agent: string;
}

/** 등록된 기기(기기가 IndexedDB에 둔다). */
export interface EnrolledDevice {
  deviceId: string;
  kind: DeviceKind;
  label: string;
  vehicleId?: string;
}

export interface ChallengeRequest {
  deviceId: string;
}

/** 로그인 서명에 쓸 한 번 값(60초, 한 번만). */
export interface Challenge {
  nonce: string;
  expiresAt: string;
}

export interface StaffListRequest {
  deviceId: string;
  nonce: string;
  /** loginMessage(origin, deviceId, nonce)의 ECDSA P-256 SHA-256 서명(r ‖ s 64바이트, base64url). */
  signature: string;
}

/** 로그인 화면의 직원 타일. */
export interface StaffTile {
  id: string;
  name: string;
}

/** 서명이 맞으면: 이 기기에서 5분 쓰는 표(ticket)와 직원 타일(기사 기기는 기사가 먼저). */
export interface StaffList {
  ticket: string;
  shopName: string;
  staff: StaffTile[];
}

export interface LoginRequest {
  ticket: string;
  staffId: string;
  /** 숫자 4~6자리. */
  pin: string;
}

/** 로그인한 세션(쿠키는 HttpOnly라 화면이 읽지 못한다: 이것으로 누가 · 어느 기기인지 안다). */
export interface SessionInfo {
  shop: { name: string };
  staff: { id: string; name: string; roleKey: string };
  device: { id: string; kind: DeviceKind; label: string; vehicleId?: string };
  /** POST마다 CSRF_HEADER로 보낸다(메모리에만). */
  csrf: string;
  /** 쓰지 않고 이만큼 지나면 로그인이 끝난다(초). */
  idleTimeoutS: number;
  serverTime: string;
}

/** 지금 머리(GET api/v2/head): 영업일과 서버 시각. */
export interface HeadInfo {
  epoch: string;
  rev: number;
  configRev: number;
  serverTime: string;
  currentBusinessDate: string;
}

/** 서버가 돌려주는 실패 코드(화면 글이 아니다: 화면은 코드로 가르고 문구 표의 말을 쓴다). */
export type ApiErrorCode =
  | 'UNSUPPORTED_MEDIA_TYPE' // Content-Type이 application/json이 아니다(415)
  | 'TOO_LARGE' // 본문이 길다(413)
  | 'BAD_ORIGIN' // 다른 주소에서 온 요청(403)
  | 'RATE_LIMITED' // 너무 잦다(429)
  | 'SIGNED_OUT' // 로그인하지 않았다(401)
  | 'SESSION_EXPIRED' // 로그인이 끝났다(401)
  | 'DEVICE_REVOKED' // 끊은 기기(401)
  | 'BAD_CSRF' // CSRF 머리가 없거나 틀렸다(403)
  | 'BAD_JSON' // JSON이 아니거나 너무 깊다(400)
  | 'BAD_INPUT' // 모양이 틀렸다(400)
  | 'QUEUE_NOT_SUPPORTED' // 보냄 대기 명령의 칸(deviceSeq …): 서버 모드는 온라인만(400)
  | 'UNKNOWN_COMMAND' // 모르는 명령(400)
  | 'UNKNOWN_QUERY' // 모르는 조회(400)
  | 'UNKNOWN_VIEW' // 모르는 화면(400)
  | 'NOT_FOUND' // 없는 접수 · 업무(404)
  | 'FORBIDDEN' // 이 세션이 읽을 수 없는 것(403)
  | 'BAD_CODE' // 등록 번호 불일치(400)
  | 'CODE_USED' // 쓴 · 지난 등록 번호(410)
  | 'DEVICE_UNKNOWN' // 이 서버에 없는 기기(404): 기기는 열쇠를 지우고 다시 등록
  | 'BAD_SIGNATURE' // 기기 서명 · 한 번 값이 틀렸다(401)
  | 'BAD_TICKET' // 로그인 표가 없거나 지났다(401)
  | 'UNKNOWN_STAFF' // 없는 직원(400)
  | 'BAD_PIN' // 비밀번호 불일치(401)
  | 'LOCKED' // 이 기기에서 이 사람의 로그인 잠김(423, lockedUntil)
  | 'SHOP_UNAVAILABLE' // 매장 파일을 쓸 수 없다(503)
  | 'TOO_MANY_STREAMS' // 알림 연결이 많다(429)
  | 'INTERNAL'; // 처리 오류(500)

/** 실패 본문. 로그인 잠김이면 lockedUntil, 모양 오류면 어디가 틀렸는지(값은 싣지 않는다). */
export interface ApiError {
  ok: false;
  service: 'skinote';
  code: ApiErrorCode;
  lockedUntil?: string;
  problems?: string[];
  /** GET api/v2/session의 401. */
  state?: 'signed_out';
}
