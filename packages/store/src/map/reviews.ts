// 저장된 확인 필요(ShopState.reviews) ↔ review_items(features-1 §3-2 · §9-2, E18).
//   - 새 행: 종류 · 출처(sync = 보냄 대기로 온 명령, import = 견본 자료) · 그린 문장(message)과 인자(message_params_json) · 접수 · 업무(있는 업무 행,
//     처음이면 만든다) · 보낸 기기(있는 기기만, 견본 · 메모리 어댑터는 NULL) · 만든 요청번호 · rev.
//   - 끝냄(`확인`): status_key resolved · 방법 · 누가(행위자 key) · 때 · updated_rev · version + 1. 끝낸 것은 다시 열리지 않는다.
//   - 그 밖의 바뀜(사라짐 · 문장 · 종류가 바뀜)은 UNMAPPED_CHANGE.
// 되읽기: 열린 것 + 최근(36시간 안에) 끝낸 것(처리 완료 탭은 오늘 영업일에 끝낸 것만 보인다). 누가의 이름은 끝낸 rev의 작업 기록(events.actor_name).
import type { FxReview } from '@skinote/domain';
import { canonicalJson, isoOf, msOf } from '../ids.ts';
import { all, insert, num, run, str, text, type Db } from '../db.ts';
import { unmapped, type WriteContext } from './common.ts';
import { ensureTask } from './dispatch.ts';

/** 되읽기에 끝낸 확인 필요를 남기는 기간(처리 완료 탭 = 오늘 영업일, 영업일은 24시간이라 넉넉히). */
const RESOLVED_WINDOW_MS = 36 * 3_600_000;

/** 만든 뒤 바뀌지 않는 칸(끝냄 빼고 모두). */
const fixed = (r: FxReview) => canonicalJson([r.kindKey, r.params, r.message, r.orderId ?? null, r.taskId ?? null, r.targetDeviceId ?? null, r.source, r.createdAt]);

export function writeReviews(ctx: WriteContext): void {
  const before = new Map((ctx.before.reviews ?? []).map((r) => [r.id, r]));
  const after = ctx.after.reviews ?? [];
  const afterIds = new Set(after.map((r) => r.id));
  for (const r of ctx.before.reviews ?? []) if (!afterIds.has(r.id)) unmapped('확인 필요가 사라졌다: ' + r.id);
  for (const r of after) {
    const prev = before.get(r.id);
    if (!prev) {
      insertReview(ctx, r);
      continue;
    }
    if (fixed(prev) !== fixed(r)) unmapped('확인 필요의 칸이 바뀌었다: ' + r.id);
    if (prev.status === r.status && canonicalJson(prev.resolution ?? null) === canonicalJson(r.resolution ?? null)) continue;
    if (prev.status === 'resolved' || r.status !== 'resolved' || !r.resolution) unmapped('끝낸 확인 필요가 바뀌었다: ' + r.id);
    run(ctx.db, `UPDATE review_items SET status_key = 'resolved', resolution_key = ?, resolved_by = ?, resolved_at = ?, updated_rev = ?, version = version + 1
      WHERE shop_id = ? AND id = ? AND status_key = 'open'`, r.resolution.key, ctx.actor.key, isoOf(r.resolution.at), ctx.rev, ctx.shopId, r.id);
    ctx.touched.push({ scope: 'store', entityType: 'review_items', entityId: r.id });
  }
}

function insertReview(ctx: WriteContext, r: FxReview): void {
  if (r.status !== 'open') unmapped('끝낸 채로 만든 확인 필요: ' + r.id);
  if (r.taskId !== undefined) ensureTask(ctx, r.taskId);
  insert(ctx.db, 'review_items', {
    shop_id: ctx.shopId, id: r.id, kind_key: r.kindKey, source_key: r.source, request_id: ctx.requestId, device_id: r.targetDeviceId,
    command_type: ctx.envelope?.type, order_id: r.orderId, task_id: r.taskId, message: r.message, message_params_json: canonicalJson(r.params),
    target_device_id: r.targetDeviceId, detail_json: canonicalJson({ source: r.source }), status_key: 'open', created_at: isoOf(r.createdAt), created_rev: ctx.rev,
    updated_rev: ctx.rev,
  });
  ctx.touched.push({ scope: 'store', entityType: 'review_items', entityId: r.id });
}

/** 되읽기: 열린 것 + 최근에 끝낸 것(만든 차례). */
export function loadReviews(db: Db, shopId: string, now: number): FxReview[] {
  const rows = all(db, `SELECT r.id, r.kind_key, r.source_key, r.order_id, r.task_id, r.target_device_id, r.message, r.message_params_json, r.status_key,
      r.resolution_key, r.resolved_at, r.created_at, ev.actor_name
    FROM review_items r LEFT JOIN events ev ON ev.shop_id = r.shop_id AND ev.rev = r.updated_rev AND ev.command_type = 'review.resolve'
    WHERE r.shop_id = ? AND (r.status_key = 'open' OR (r.status_key = 'resolved' AND r.resolved_at >= ?)) ORDER BY r.created_rev, r.rowid`,
  shopId, isoOf(now - RESOLVED_WINDOW_MS));
  return rows.map((r): FxReview => {
    const source = str(r.source_key);
    const resolved = str(r.status_key) === 'resolved';
    return {
      id: str(r.id), kindKey: str(r.kind_key), params: JSON.parse(str(r.message_params_json)) as Record<string, string | number>, message: str(r.message),
      ...(text(r.order_id) !== undefined ? { orderId: str(r.order_id) } : {}),
      ...(text(r.task_id) !== undefined ? { taskId: str(r.task_id) } : {}),
      ...(text(r.target_device_id) !== undefined ? { targetDeviceId: str(r.target_device_id) } : {}),
      source: source === 'import' ? 'import' : 'sync',
      createdAt: msOf(str(r.created_at)),
      status: resolved ? 'resolved' : 'open',
      ...(resolved ? {
        resolution: {
          key: text(r.resolution_key) ?? 'acknowledged', at: msOf(str(r.resolved_at)), ...(text(r.actor_name) !== undefined ? { byName: str(r.actor_name) } : {}),
        },
      } : {}),
    };
  });
}

/** 열린 확인 필요의 수(시험 · 상태 점검). */
export const openReviewCount = (db: Db, shopId: string): number =>
  num(all(db, "SELECT count(*) AS n FROM review_items WHERE shop_id = ? AND status_key = 'open'", shopId)[0]?.n);
