// 개인정보 열람 기록(pii_access_log, deployment 10-4 · 10-5, features-1 E16 · E17): 누가 온전한 전화번호를 봤는지(phone_reveal), 누가 수거 목록을
// 인쇄했는지(list_print). 읽기라 작업 기록(events)이 아니라 이 표에 한 줄씩 남긴다(목록 인쇄는 한 줄에 줄 수). 번호 · 이름은 적지 않는다(무엇을
// 봤는지는 접수 id 또는 `list`). 보관 기간은 매장 설정 retention.pii_access_days(기본 365일)이고 지난 줄은 보관 정리가 지운다.
import { addDays, isoOf, ulid } from './ids.ts';
import { insert, type Db } from './db.ts';
import { currentSetting } from './registry-read.ts';

/** 보관 기간의 기본(sys_setting_definitions retention.pii_access_days). */
export const PII_ACCESS_DAYS = 365;

export interface PiiAccess {
  /** 행위자(`staff:<직원 id>`). */
  actorKey: string;
  /** 본 기기(devices.id). 없으면 NULL. */
  deviceId?: string;
  action: 'phone_reveal' | 'list_print';
  /** 무엇을: 접수(order) · 목록(list). */
  subjectType: 'order' | 'list';
  subjectId?: string;
  /** 목록이면 줄 수(1 이상). */
  itemCount?: number;
  now: number;
}

/** 열람 한 번을 적는다. 돌려주는 것: 새 줄의 id. */
export function logPiiAccess(db: Db, shopId: string, entry: PiiAccess): string {
  const days = currentSetting<{ pii_access_days?: number }>(db, shopId, 'retention')?.pii_access_days;
  const keep = typeof days === 'number' && Number.isInteger(days) && days > 0 ? days : PII_ACCESS_DAYS;
  const at = isoOf(entry.now);
  const id = ulid(entry.now);
  insert(db, 'pii_access_log', {
    shop_id: shopId, id, actor_key: entry.actorKey, device_id: entry.deviceId, action_key: entry.action, subject_type: entry.subjectType,
    subject_id: entry.subjectId, item_count: Math.max(1, Math.floor(entry.itemCount ?? 1)), at, purge_after: addDays(at.slice(0, 10), keep) + at.slice(10),
  });
  return id;
}
