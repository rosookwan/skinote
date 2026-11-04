// @ts-check
// 기사 기기의 연결 셈(work/impl-offline/plan.md O11): 서버 메모리에 기기마다 마지막 연결 · 마지막 알림(DeviceReport) · 세션이 열렸는지를 두고, 카운터가
// 보는 차량의 연결(VehicleLink)을 센다. 표에는 드물게(기기마다 1분, 대기 수가 0을 넘나들 때) devices.last_seen_at · device_sync_cursors로 적는다
// (장부가 아니다). 다시 띄우면 그 표와 열린 세션으로 다시 세운다.
//   - online: 연결이 offlineAfterMs 안이고 막힌 것이 없음. 끊겼다 돌아오면 recoverMs 동안 이어진 연결이나 대기 0 알림 뒤에야 online(깜빡임 없게).
//   - stuck: 연결은 있으나 대기 기록이 심장 박동 두 번보다 오래 남음(약한 신호: 작은 박동은 지나고 묶음은 못 감) 또는 혼자도 못 보내는 항목(stuckSeq).
//   - asleep: 조용하고 마지막 알림이 hidden · 대기 0 · 확인 중 0(주머니 속 휴대폰): 표시 없음, 마감을 막지 않음.
//   - offline: 조용함(보이는 채 조용하거나 마지막 알림에 대기 · 확인 중이 있음).
//   - idle: 열린 세션이 없고 마지막 알림의 대기가 0(로그아웃 · 깨끗이 끝남). 세션이 없어도 대기가 남았다고 알렸으면 offline.
// 차량은 기기 가운데 가장 나쁜 것(offline > stuck > asleep > online > idle): 매장에 둔 태블릿이 산속 휴대폰의 대기 12건을 가리지 않게. 차량 셈이 바뀌면 매장의
// linkRev를 올리고(알림 연결의 머리에 싣는다) onChange를 부른다.

import { DEVICE_LINK } from '@skinote/contract';

/**
 * @typedef {import('@skinote/contract').DeviceReport} DeviceReport
 * @typedef {import('@skinote/contract').VehicleLink} VehicleLink
 * @typedef {import('@skinote/contract').VehicleLinkFact} VehicleLinkFact
 * @typedef {import('@skinote/contract').VehicleLinkState} VehicleLinkState
 * @typedef {{ id: string, kind: string, vehicleId?: string, label: string, staffName?: string }} LinkDevice
 * @typedef {{
 *   deviceId: string, vehicleId?: string, kind: 'driver_phone' | 'driver_tablet', label: string, staffName?: string,
 *   lastContactAt?: number, runStart?: number, report?: DeviceReport, reportAt?: number, sessionOpen: boolean, revoked: boolean,
 *   state: VehicleLinkState, lastPersistAt?: number, persistedPending?: number,
 * }} Entry
 */

const WORST = /** @type {const} */ (['offline', 'stuck', 'asleep', 'online', 'idle']);
const rank = /** @param {VehicleLinkState} s */ s => WORST.indexOf(s);
const iso = /** @param {number} ms */ ms => new Date(ms).toISOString();

/**
 * @param {{
 *   nowMs: () => number,
 *   offlineAfterMs?: number,
 *   recoverMs?: number,
 *   heartbeatMs?: number,
 *   persistEveryMs?: number,
 *   persist?: (shopId: string, deviceId: string, report: DeviceReport, now: number) => void,
 *   onChange?: (shopId: string) => void,
 *   log?: (line: string) => void,
 * }} options
 */
export function createDeviceLinks({
  nowMs, offlineAfterMs = DEVICE_LINK.offlineAfterMs, recoverMs = DEVICE_LINK.recoverMs, heartbeatMs = DEVICE_LINK.heartbeatMs,
  persistEveryMs = DEVICE_LINK.persistEveryMs, persist, onChange, log = () => {},
}) {
  /** @type {Map<string, { linkRev: number, signature: string, devices: Map<string, Entry> }>} */
  const shops = new Map();

  /** @param {string} shopId */
  const shopOf = shopId => {
    let shop = shops.get(shopId);
    if (!shop) {
      shop = { linkRev: 0, signature: '', devices: new Map() };
      shops.set(shopId, shop);
    }
    return shop;
  };

  /** @param {string} shopId @param {LinkDevice} device */
  const entryOf = (shopId, device) => {
    const shop = shopOf(shopId);
    let entry = shop.devices.get(device.id);
    if (!entry) {
      entry = {
        deviceId: device.id, kind: device.kind === 'driver_tablet' ? 'driver_tablet' : 'driver_phone', label: device.label, sessionOpen: false, revoked: false, state: 'idle',
        ...(device.vehicleId ? { vehicleId: device.vehicleId } : {}),
      };
      shop.devices.set(device.id, entry);
    }
    if (device.vehicleId) entry.vehicleId = device.vehicleId;
    entry.label = device.label;
    // 마지막으로 로그인한 직원(세션이 있는 연결만 안다, 메모리만): 같은 차량의 다른 기사에게 어느 기기인지 알릴 때(§17 R3-28).
    if (device.staffName) entry.staffName = device.staffName;
    return entry;
  };

  /** 기기에 남은 기록 수. pendingCount가 이미 결과 확인 중(unconfirmedCount)을 담는다(DeviceReport, §18 R4-7: 두 번 세지 않는다). @param {Entry} e */
  const pendingOf = e => (e.report ? e.report.pendingCount : 0);

  /** 기기 하나의 지금 상태. @param {Entry} e @param {number} now @returns {VehicleLinkState} */
  function stateOf(e, now) {
    const silent = e.lastContactAt === undefined || now - e.lastContactAt > offlineAfterMs;
    const pending = pendingOf(e);
    if (e.revoked) return pending > 0 ? 'offline' : 'idle';
    if (!e.sessionOpen) return pending > 0 && silent ? 'offline' : pending > 0 ? stuckOrOnline(e, now) : 'idle';
    if (silent) return e.report?.visibility === 'hidden' && pending === 0 ? 'asleep' : 'offline';
    // 끊겼다 돌아온 뒤: 이어진 연결이 recoverMs가 되거나 대기 0 알림이 올 때까지 끊김으로 둔다(깜빡임 없게).
    if (e.state === 'offline' && pending > 0 && e.runStart !== undefined && now - e.runStart < recoverMs) return 'offline';
    return stuckOrOnline(e, now);
  }

  /** @param {Entry} e @param {number} now @returns {VehicleLinkState} */
  function stuckOrOnline(e, now) {
    const r = e.report;
    if (!r) return 'online';
    if (r.stuckSeq !== undefined) return 'stuck';
    const oldest = r.oldestPendingAt !== undefined ? Date.parse(r.oldestPendingAt) : Number.NaN;
    if (r.pendingCount > 0 && Number.isFinite(oldest) && now - oldest > 2 * heartbeatMs) return 'stuck';
    return 'online';
  }

  /** 상태의 '…부터'(가장 오래된 대기 항목, 없으면 마지막 연결). @param {Entry} e */
  function sinceOf(e) {
    const r = e.report;
    const oldest = r && pendingOf(e) > 0 && r.oldestPendingAt !== undefined ? Date.parse(r.oldestPendingAt) : Number.NaN;
    if (Number.isFinite(oldest)) return oldest;
    return e.lastContactAt;
  }

  /** 매장의 차량 연결(차량마다 가장 나쁜 기기). @param {string} shopId @param {number} now @returns {VehicleLink[]} */
  function vehicleLinks(shopId, now = nowMs()) {
    const shop = shops.get(shopId);
    if (!shop) return [];
    /** @type {Map<string, { link: VehicleLink, rank: number }>} */
    const byVan = new Map();
    for (const e of shop.devices.values()) {
      if (!e.vehicleId) continue;
      const state = stateOf(e, now);
      e.state = state;
      const since = sinceOf(e);
      /** @type {VehicleLink} */
      const link = {
        vehicleId: e.vehicleId, state, ...(since !== undefined ? { since: iso(since) } : {}), ...(e.lastContactAt !== undefined ? { lastContactAt: iso(e.lastContactAt) } : {}),
        reportedPending: e.report ? pendingOf(e) : null, deviceKind: e.kind,
      };
      const prev = byVan.get(e.vehicleId);
      if (!prev || rank(state) < prev.rank) byVan.set(e.vehicleId, { link, rank: rank(state) });
    }
    return [...byVan.values()].map(x => x.link).sort((a, b) => a.vehicleId.localeCompare(b.vehicleId));
  }

  /** 차량 셈이 바뀌었으면 linkRev를 올리고 알린다. @param {string} shopId @param {number} now */
  function settle(shopId, now) {
    const shop = shopOf(shopId);
    const signature = JSON.stringify(vehicleLinks(shopId, now).map(l => [l.vehicleId, l.state, l.reportedPending, l.state === 'online' || l.state === 'idle' ? null : l.since ?? null]));
    if (signature === shop.signature) return;
    shop.signature = signature;
    shop.linkRev += 1;
    try {
      onChange?.(shopId);
    } catch (error) {
      log(`연결 알림 실패 ${error instanceof Error ? error.name : 'Error'}`);
    }
  }

  /** 드물게 표에 적는다(기기마다 persistEveryMs, 대기가 0을 넘나들면 곧바로). @param {string} shopId @param {Entry} e @param {number} now */
  function maybePersist(shopId, e, now) {
    if (!persist || !e.report) return;
    const pending = pendingOf(e);
    const crossed = e.persistedPending !== undefined && (e.persistedPending === 0) !== (pending === 0);
    if (!crossed && e.lastPersistAt !== undefined && now - e.lastPersistAt < persistEveryMs) return;
    try {
      persist(shopId, e.deviceId, e.report, now);
      e.lastPersistAt = now;
      e.persistedPending = pending;
    } catch (error) {
      log(`연결 적기 실패 ${error instanceof Error ? error.name : 'Error'}`);
    }
  }

  /** 연결 한 번(기사 기기의 세션이 있는 요청마다). @param {string} shopId @param {LinkDevice} device @param {number} [now] */
  function touch(shopId, device, now = nowMs()) {
    const e = entryOf(shopId, device);
    if (e.lastContactAt === undefined || now - e.lastContactAt > offlineAfterMs) e.runStart = now;
    e.lastContactAt = now;
    e.sessionOpen = true;
    settle(shopId, now);
    return e;
  }

  return {
    touch,
    /**
     * 기기의 알림(심장 박동 · 사본 · 묶음 · 전달). session false = 세션 없는 전달.
     * @param {string} shopId @param {LinkDevice} device @param {DeviceReport} report @param {{ session?: boolean, now?: number }} [options]
     */
    report(shopId, device, report, { session = true, now = nowMs() } = {}) {
      const e = session ? touch(shopId, device, now) : entryOf(shopId, device);
      if (!session) e.lastContactAt = now;
      e.report = report;
      e.reportAt = now;
      maybePersist(shopId, e, now);
      settle(shopId, now);
    },
    /** 세션이 끝남(로그아웃 · 만료 · 끊기). @param {string} shopId @param {string} deviceId */
    sessionEnded(shopId, deviceId) {
      const e = shops.get(shopId)?.devices.get(deviceId);
      if (!e) return;
      e.sessionOpen = false;
      settle(shopId, nowMs());
    },
    /** 기기 끊기. @param {string} shopId @param {string} deviceId */
    revoked(shopId, deviceId) {
      const e = shops.get(shopId)?.devices.get(deviceId);
      if (!e) return;
      e.revoked = true;
      e.sessionOpen = false;
      settle(shopId, nowMs());
    },
    /** 살피기(서버가 sweepMs마다): 조용해진 기기의 상태를 바꾼다. @param {number} [now] */
    sweep(now = nowMs()) {
      for (const shopId of shops.keys()) settle(shopId, now);
    },
    vehicleLinks,
    /** 마감 명령에 적을 차량 연결 사실(O12). @param {string} shopId @param {number} [now] @returns {VehicleLinkFact[]} */
    facts(shopId, now = nowMs()) {
      return vehicleLinks(shopId, now).map(l => ({
        vehicleId: l.vehicleId, state: l.state, reportedPending: l.reportedPending, ...(l.since ? { since: l.since } : {}), ...(l.state === 'stuck' ? { stuck: true } : {}),
      }));
    },
    /** 매장의 연결 판(알림 연결의 머리). @param {string} shopId */
    linkRev: shopId => shops.get(shopId)?.linkRev ?? 0,
    /** 기기의 마지막 알림과 연결(번호 빈 곳의 위 번호 · 오래 조용함). @param {string} shopId @param {string} deviceId */
    lastReport(shopId, deviceId) {
      const e = shops.get(shopId)?.devices.get(deviceId);
      return e ? { report: e.report, lastContactAt: e.lastContactAt, revoked: e.revoked } : undefined;
    },
    /** 기기 하나의 지금 상태(시험 · 명령줄). @param {string} shopId @param {string} deviceId */
    deviceState(shopId, deviceId) {
      const e = shops.get(shopId)?.devices.get(deviceId);
      return e ? { state: stateOf(e, nowMs()), pending: e.report ? pendingOf(e) : null, sessionOpen: e.sessionOpen, lastContactAt: e.lastContactAt } : undefined;
    },
    /**
     * 같은 차량의 다른 기기가 보낼 기록을 알렸거나 수를 모른 채 끊겼는지(로그인 때 한 번, sync 6). 그 기기의 등록 이름과 마지막 로그인 직원도 준다(한
     * 차량에 개인 휴대폰이 둘이면 어느 기기인지, §17 R3-28).
     * @param {string} shopId @param {string | undefined} vehicleId @param {string} deviceId
     * @returns {{ deviceKind: 'driver_phone' | 'driver_tablet', pending: number | null, label: string, staffName?: string } | undefined}
     */
    vanPendingElsewhere(shopId, vehicleId, deviceId) {
      if (!vehicleId) return undefined;
      const now = nowMs();
      for (const e of shops.get(shopId)?.devices.values() ?? []) {
        if (e.deviceId === deviceId || e.vehicleId !== vehicleId || e.revoked) continue;
        const state = stateOf(e, now);
        const pending = e.report ? pendingOf(e) : null;
        if ((pending !== null && pending > 0) || (state === 'offline' && pending === null)) {
          return { deviceKind: e.kind, pending, label: e.label, ...(e.staffName ? { staffName: e.staffName } : {}) };
        }
      }
      return undefined;
    },
    /**
     * 다시 띄운 뒤: 표의 연결 사실과 열린 세션으로 다시 세운다. 대기가 남았다고 적힌 기기는 알림(대기 수)을, 보이는지 모르는 기기는 조용한 것(hidden)으로 본다.
     * @param {string} shopId
     * @param {{ deviceId: string, kind: string, vehicleId?: string, label: string, status: string, lastSeenAt?: number, queueDepth?: number, lastSeq: number }[]} rows
     * @param {ReadonlySet<string>} openSessions
     */
    restore(shopId, rows, openSessions) {
      for (const r of rows) {
        if (r.kind !== 'driver_phone' && r.kind !== 'driver_tablet') continue;
        const e = entryOf(shopId, { id: r.deviceId, kind: r.kind, label: r.label, ...(r.vehicleId ? { vehicleId: r.vehicleId } : {}) });
        if (r.lastSeenAt !== undefined) e.lastContactAt = r.lastSeenAt;
        e.sessionOpen = openSessions.has(r.deviceId);
        e.revoked = r.status === 'revoked';
        if (r.queueDepth !== undefined) {
          e.report = {
            pendingCount: r.queueDepth, unconfirmedCount: 0, lastSeq: r.lastSeq, clockOffsetMs: 0, appVersion: '', offlineCapable: false, localFirst: true, visibility: 'hidden', unreadable: 0,
          };
          e.persistedPending = r.queueDepth;
        }
      }
      settle(shopId, nowMs());
    },
  };
}

/** @typedef {ReturnType<typeof createDeviceLinks>} DeviceLinks */
