// 앱 시작의 작은 입구(work/impl-offline/plan.md O15 · §7-7): main.tsx가 서버 모드(앱 뼈대의 서버 표시)일 때만 따로 받아 부른다(서비스 워커가 미리
// 받아 둔 묶음이라 산에서도 열린다). 기기 저장소(IndexedDB `skinote-local`)에서 기억한 세션 · 사본 머리 · 기기 메모만 읽고 서버에 묻지 않는다.
//   - open: 기억한 세션이 유효하다 → 서버를 기다리지 않고 목록으로(서버 묻기는 뒤에서).
//   - locked: 유효하지만 앱 잠금 때다(또는 다섯 번 틀려 잠김) → 기억한 기사의 비밀번호 판.
//   - 그 밖(없음 · 끝남 · 사본을 읽을 수 없음) → null: 평소처럼 서버에 묻는다. 보냄 대기는 그대로다.
//   - 지움 시계(§17 R3-9, deployment 10-5): 기억한 세션이 없거나 끝났는데(끝남 · 쉬는 시간 · 24시간 창 · 시계가 뒤로 감) 사본이나 세션 칸이
//     남아 있으면 지운다(사본 · 사본 열쇠 · 기억한 세션 · 확인 값, dropCopy). 보냄 대기와 그 열쇠는 남는다. DriverClient가 돌지 않아도(잃은 휴대폰 ·
//     로그인 화면에 머문 기기) 켤 때마다 지운다. 세션이 유효한데 사본 형식을 모르거나 확인 값이 없을 뿐이면 지우지 않는다(24시간 창 안, §17-2).
// 도메인(업무 규칙)을 가져오지 않는다(작게).
import type { OfflinePolicy, SessionInfo } from '@skinote/contract';
import { isVerifier } from './app-lock.ts';
import { openIdbStore } from './idb-store.ts';
import { COPY_FMT, LocalStore, STATE_VERSION } from './local-store.ts';
import { readAll, type RawStore } from './raw-store.ts';
import { isRemembered, REMEMBERED_ID, rememberedStart, VERIFIER_ID, type RememberedSession } from './remembered.ts';

/** 운영 값이 없을 때의 기본(offline_policy 시드: 휴대폰 5분 · 태블릿 30분). */
const DEFAULT_LOCK_MINUTES = { driver_phone: 5, driver_tablet: 30 } as const;

export interface BootStart {
  decision: 'open' | 'locked';
  session: SessionInfo;
  /** 틀려서 잠긴 동안이면 풀리는 때(`로그인 잠김 · {시각} 이후 가능`). */
  lockUntil?: number;
  /** 이 기기의 서버에 가지 않은 기록 수. */
  pending: number;
}

/** 지울 것(사본 · 세션 칸)이 남아 있는지. */
async function hasPersonalData(raw: RawStore): Promise<boolean> {
  const [copy, sessions] = await Promise.all([readAll(raw, 'snapshot'), readAll(raw, 'session')]);
  return copy.length > 0 || sessions.length > 0;
}

/** 기억한 세션으로 열 수 있으면 그 모양, 아니면 null(지움 시계를 돌린 뒤). 저장소를 열 수 없으면 null. open은 시험이 메모리 저장소를 넣는다. */
export async function rememberedDriverStart(now = Date.now(), open: () => Promise<RawStore> = openIdbStore): Promise<BootStart | null> {
  let raw: RawStore;
  try {
    raw = await open();
  } catch {
    return null;
  }
  try {
    // 기억한 세션을 먼저 연다(어느 기기 id인지 알아야 열쇠 모양을 맞춘다: 열쇠 자체는 id로 찾는다).
    const probe = new LocalStore({ raw, deviceId: '', channel: null });
    const record = await probe.readSessionRecord<RememberedSession>(REMEMBERED_ID);
    if (!isRemembered(record)) {
      // 기억한 세션이 없거나 열 수 없다: 남은 사본 · 확인 값을 지운다(지움 시계, §17 R3-9).
      if (await hasPersonalData(raw)) await probe.dropCopy().catch(() => undefined);
      return null;
    }
    const local = new LocalStore({ raw, deviceId: record.session.device.id, channel: null });
    const [meta, head, verifier, queue] = await Promise.all([
      local.readMeta(), local.copyHead(), local.readSessionRecord<unknown>(VERIFIER_ID), readAll(raw, 'queue'),
    ]);
    const kind = record.session.device.kind === 'driver_phone' ? 'driver_phone' : 'driver_tablet';
    const policy: Pick<OfflinePolicy, 'piiWipeHours' | 'appLockMinutes' | 'clockWarnMinutes'> = {
      piiWipeHours: head?.policy.piiWipeHours ?? record.session.policy?.piiWipeHours ?? 24,
      appLockMinutes: head?.policy.appLockMinutes ?? record.session.policy?.appLockMinutes ?? DEFAULT_LOCK_MINUTES[kind],
      clockWarnMinutes: head?.policy.clockWarnMinutes ?? record.session.policy?.clockWarnMinutes ?? 2,
    };
    const copyOk = !!head && head.fmt === COPY_FMT && head.stateVersion === STATE_VERSION && head.vehicleId === (record.session.vehicleId ?? record.session.device.vehicleId ?? head.vehicleId);
    const start = rememberedStart({ now, record, copyOk, verifier: isVerifier(verifier), meta, policy });
    if (start.decision !== 'open' && start.decision !== 'locked') {
      // 끝남 · 쉬는 시간 · 24시간 창 · 시계: 이름 · 번호가 든 사본과 세션 칸을 지운다(보냄 대기는 남는다). 세션은 아직 유효한데 이 기기에서 열 수 없을
      // 뿐이면(사본 형식을 이 빌드가 모름 · 확인 값 없음) 지우지 않고 서버에 묻는다: 새 사본이 덮거나 온라인 로그인(앱 잠금은 닫힌 쪽, §17-2 R3-7 · R3-9).
      if (start.why !== 'no_copy' && start.why !== 'no_verifier') await local.dropCopy().catch(() => undefined);
      return null;
    }
    return {
      decision: start.decision, session: record.session, ...(start.why === 'locked_out' && meta.lockUntil !== undefined ? { lockUntil: meta.lockUntil } : {}),
      pending: queue.filter((r) => r.state !== 'answered').length,
    };
  } catch {
    return null;
  } finally {
    raw.close();
  }
}
