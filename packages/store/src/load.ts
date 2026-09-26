// 표 → 도메인 상태(ShopState, plan §4-4). 머리(epoch · rev · 영업일 · 다음 접수 번호), 매장 목록 값 · 운영 규칙 · 돈통(registry-read),
// 번호 실물, 접수와 그 줄 · 약속 · 결제 약속 · 할인(map/orders), 재고 이동을 접은 수 셈 · 번호 · 준비 번호 · 일정 몫(map/stock), 돈 ·
// 보증금(map/money), 방문 · 청구 조정 · 빨리 확인 · 방문 순서(map/dispatch), 차량 현금 · 마감(map/cash).
// 지금은 매장의 모든 접수를 읽는다(열린 날 창 · 필요할 때 더 읽기는 plan §4-4의 다음 단계: 시험 매장 크기에서는 이것으로 충분하고, 캐시가
// rev마다 한 번만 읽게 한다).
import type { ShopState } from '@skinote/domain';
import { StoreError } from './errors.ts';
import { businessDateAt, openDays } from './dates.ts';
import { isoOf } from './ids.ts';
import { num, one, str, type Db } from './db.ts';
import { loadRegistry } from './registry-read.ts';
import { loadOrderShells, splitChains } from './map/orders.ts';
import { loadAssets, loadStock, loadVanSpares } from './map/stock.ts';
import { loadMoney } from './map/money.ts';
import { loadDispatch } from './map/dispatch.ts';
import { loadCash } from './map/cash.ts';

export { loadAssets } from './map/stock.ts';

/** 매장의 머리: epoch · rev · configRev · 지금 영업일. 명령 트랜잭션과 캐시 확인이 쓴다(인덱스 읽기 몇 번). */
export interface ShopHead {
  epoch: string;
  rev: number;
  configRev: number;
  businessDate: string;
}

export function readHead(db: Db, shopId: string, now: number): ShopHead {
  const row = one(db, `SELECT s.config_rev, i.epoch_id, c.value AS rev FROM shops s
    JOIN shop_instance i ON i.shop_id = s.id
    LEFT JOIN shop_counters c ON c.shop_id = s.id AND c.counter_key = 'rev' AND c.scope_key = ''
    WHERE s.id = ?`, shopId);
  if (!row) throw new StoreError('SHOP_NOT_PROVISIONED', '매장 행이 없다: ' + shopId);
  return { epoch: str(row.epoch_id), rev: num(row.rev), configRev: num(row.config_rev), businessDate: businessDateAt(db, shopId, now) };
}

/** 매장 파일의 epoch(번호 · id · rev 바닥). 백업이 control의 tenant_epochs에 본 rev를 적을 때 쓴다. 매장이 없으면 undefined. */
export function readInstance(db: Db, shopId: string): { epochId: string; epochNo: number; revFloor: number } | undefined {
  const r = one(db, 'SELECT epoch_id, epoch_no, rev_floor FROM shop_instance WHERE shop_id = ?', shopId);
  return r ? { epochId: str(r.epoch_id), epochNo: num(r.epoch_no), revFloor: num(r.rev_floor) } : undefined;
}

/** 지금 rev만(캐시 확인: 트랜잭션마다 한 번). */
export const readRev = (db: Db, shopId: string): number =>
  num(one(db, "SELECT value FROM shop_counters WHERE shop_id = ? AND counter_key = 'rev' AND scope_key = ''", shopId)?.value);

/** 그 영업일의 다음 접수 번호(shop_counters('receipt', 날짜)는 마지막으로 준 번호). */
export const nextReceiptSeq = (db: Db, shopId: string, date: string): number =>
  num(one(db, "SELECT value FROM shop_counters WHERE shop_id = ? AND counter_key = 'receipt' AND scope_key = ?", shopId, date)?.value) + 1;

/** 이 시각의 도메인 상태(판 3 모양: 메모리 어댑터 몫의 칸 outcomes · driverDevice · storyApplied는 빈 값). */
export function loadShopState(db: Db, shopId: string, now: number): ShopState {
  const head = readHead(db, shopId, now);
  const { registry, settings, drawers } = loadRegistry(db, shopId, isoOf(now));
  const { orders, byId, lineById } = loadOrderShells(db, shopId, registry);
  const vanReceipts = loadStock(db, shopId, orders, lineById, splitChains(db, shopId));
  const { paymentGroups, deposits } = loadMoney(db, shopId, byId);
  const { pins, routeRanks } = loadDispatch(db, shopId, byId);
  const { cashTransfers, closings } = loadCash(db, shopId);
  return {
    version: 3,
    epoch: head.epoch,
    rev: head.rev,
    businessDate: head.businessDate,
    registry,
    orders,
    pins,
    routeRanks,
    outcomes: {},
    driverDevice: { offline: false, queue: [] },
    settings,
    assets: loadAssets(db, shopId),
    vanSpares: loadVanSpares(db, shopId, registry),
    deposits,
    paymentGroups,
    drawers,
    cashTransfers,
    closings,
    vanReceipts,
    nextReceiptSeq: nextReceiptSeq(db, shopId, head.businessDate),
    storyApplied: [],
  };
}

/** 열린 날(오늘 영업일로 끝남). ShopState.openDays는 B2d에서 생긴다. */
export const loadOpenDays = (db: Db, shopId: string, businessDate: string): string[] => openDays(db, shopId, businessDate);
