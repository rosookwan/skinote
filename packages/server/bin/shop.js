#!/usr/bin/env node
// @ts-check
// 매장 명령줄(plan §5-5). 서버와 같은 환경 변수(/etc/skinote/skinote.env · secrets.env)를 읽는다. SQL은 없다(@skinote/store).
// 비밀(비밀번호 · 등록 번호)은 표준 출력에 한 번만 찍고 표준 오류 · 파일 · 기록에는 적지 않는다.
//
//   node bin/shop.js provision     --shop <id> --code <code> --name <이름> (--sample | --spec 파일.json) [--staff "<이름>:<역할>[:<차량>]" …]
//                                  [--test] [--pin-digits 4]                        → 직원 · 역할 · 비밀번호 표(한 번)          [혼자]
//   node bin/shop.js load-sample   --shop <id> --date today|YYYY-MM-DD   (시험 매장만)                                              [혼자]
//   node bin/shop.js reset-test-shop --shop <id> [--sample | --spec 파일.json]  (시험 매장만, 없으면 --sample)                          [혼자]
//                                  → 옛 파일의 사본을 backups/resets/에 받고 지금 견본(명세)으로 매장 파일을 다시 만든다. 직원 계정 ·
//                                    비밀번호 · 등록한 기기 · 로그인은 그대로(새 명세에 차량이 없는 기사 기기만 끊음), 새 epoch
//   node bin/shop.js device-code   --shop <id> --kind pos|driver_tablet|driver_phone --label <이름> [--vehicle <차량>] [--minutes 60]
//                                  → 등록 번호 1234-5678-9012(한 번)                                                              [온라인 가능]
//   node bin/shop.js rotate-pin    --shop <id> --staff <이름|id> [--pin-digits 4] → 새 비밀번호(한 번), 잠금 풀기                     [온라인 가능]
//   node bin/shop.js revoke-device --shop <id> --device <기기 이름|id> → 기기 끊기(세션 · 알림 연결이 끝남)                           [온라인 가능]
//   node bin/shop.js revoke-device --shop <id> --open-all → 열린 등록으로 스스로 붙은 기기(`시험 기기 N`)를 모두 끊기                [온라인 가능]
//   node bin/shop.js status        --shop <id> → rev · 영업일 · 접수 수 · 기기 · 직원 수(이름 없음), 스스로 붙은 기기마다 한 줄          [온라인 가능]
//   node bin/shop.js --stdin       표준 입력의 { "op": "…", "args": { … } } 한 JSON(deploy.sh --shop-cli). args.spec은 명세 객체여도 된다.
//
// [혼자] 명령은 매장의 쓰는 사람 잠금을 스스로 잡는다: 서버가 돌고 있으면 거절한다(서버를 멈추거나 deploy.sh --shop-cli).
// [온라인 가능] 명령은 잠금이 비어 있으면 파일을 직접 열고, 서버가 쥐고 있으면 관리 소켓(SKINOTE_ADMIN_SOCKET)으로 서버에 보낸다.
// 파일은 서버가 시작할 때 마이그레이션한 것이어야 한다(명령줄은 마이그레이션하지 않는다).
//
// 끝 코드: 0 성공, 64 쓰는 법이 틀림, 65 자료(명세 · 인자)가 틀림, 69 지금 할 수 없음(서버가 돎 · 파일 없음 · 아직 없는 기능),
// 70 처리 오류, 78 설정 오류.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { businessDateOf, freeNumbers, prepareImport, sampleDay, sampleSpec } from '@skinote/domain';
import { applyPending, inspectFile, openDatabase } from '@skinote/schema';
import { acquireWriterLock, openControlStore, openShopStore } from '@skinote/store';
import { sendAdminRequest } from '../src/admin-socket.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { generatePin, hashPin } from '../src/pin.js';
import { loadSecrets } from '../src/secrets.js';
import { ONLINE_OPS, OpError } from '../src/shop-ops.js';
import { ResetError, resetTestShop } from '../src/shop-reset.js';
import { openShopPort } from '../src/shops.js';

export const EXIT = Object.freeze({ ok: 0, usage: 64, data: 65, unavailable: 69, software: 70, config: 78 });

/**
 * @typedef {{
 *   env: Record<string, string | undefined>,
 *   out: (text: string) => void,
 *   err: (text: string) => void,
 *   readStdin: () => Promise<string>,
 *   now: () => number,
 * }} CliIo
 * @typedef {Record<string, unknown> & { staff?: string[] }} CliArgs
 */

class CliError extends Error {
  /** @param {number} exit @param {string} message */
  constructor(exit, message) {
    super(message);
    this.exit = exit;
  }
}

/** 깃발 이름 → 인자 이름과 모양(참거짓 · 값 · 여러 번). */
const FLAGS = /** @type {Record<string, { key: string, kind: 'bool' | 'value' | 'many' }>} */ ({
  '--shop': { key: 'shop', kind: 'value' },
  '--code': { key: 'code', kind: 'value' },
  '--name': { key: 'name', kind: 'value' },
  '--sample': { key: 'sample', kind: 'bool' },
  '--spec': { key: 'spec', kind: 'value' },
  '--staff': { key: 'staff', kind: 'many' },
  '--test': { key: 'test', kind: 'bool' },
  '--pin-digits': { key: 'pinDigits', kind: 'value' },
  '--date': { key: 'date', kind: 'value' },
  '--kind': { key: 'kind', kind: 'value' },
  '--label': { key: 'label', kind: 'value' },
  '--vehicle': { key: 'vehicle', kind: 'value' },
  '--minutes': { key: 'minutes', kind: 'value' },
  '--device': { key: 'device', kind: 'value' },
  '--open-all': { key: 'openAll', kind: 'bool' },
});

const OPS = ['provision', 'load-sample', 'reset-test-shop', 'device-code', 'rotate-pin', 'revoke-device', 'status'];
/** 매장 파일을 혼자 써야 하는 명령(서버가 돌면 거절, deploy/shop-cli.sh는 서버를 잠깐 멈춘다). */
export const EXCLUSIVE_OPS = Object.freeze(['provision', 'load-sample', 'reset-test-shop']);
const USAGE = '쓰는 법: node bin/shop.js <provision|load-sample|reset-test-shop|device-code|rotate-pin|revoke-device|status> --shop <매장 id> …  (또는 --stdin)';

/** @param {string[]} argv @returns {{ op: string, args: CliArgs, stdin: boolean }} */
export function parseArgs(argv) {
  if (argv[0] === '--stdin' && argv.length === 1) return { op: '', args: {}, stdin: true };
  const [op = '', ...rest] = argv;
  if (!OPS.includes(op)) throw new CliError(EXIT.usage, USAGE);
  /** @type {CliArgs} */
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = FLAGS[/** @type {string} */ (rest[i])];
    if (!flag) throw new CliError(EXIT.usage, `모르는 깃발 ${JSON.stringify(rest[i])}\n${USAGE}`);
    if (flag.kind === 'bool') {
      args[flag.key] = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new CliError(EXIT.usage, `${rest[i]} 뒤에 값이 없습니다`);
    i += 1;
    if (flag.kind === 'many') args.staff = [...(args.staff ?? []), value];
    else args[flag.key] = value;
  }
  return { op, args, stdin: false };
}

/** '<이름>:<역할>[:<차량>]' → 직원 명세. @param {string} text */
function parseStaff(text) {
  const [name = '', role = '', vehicleKey, extra] = text.split(':').map(p => p.trim());
  if (extra !== undefined || !/^[^\p{Cc}<>:]{1,20}$/u.test(name)) throw new CliError(EXIT.data, '--staff는 "<이름>:<역할>[:<차량>]"(이름 1~20자)');
  if (role !== 'manager' && role !== 'counter' && role !== 'driver') throw new CliError(EXIT.data, '직원 역할은 manager · counter · driver');
  return { name, role: /** @type {'manager' | 'counter' | 'driver'} */ (role), ...(vehicleKey ? { vehicleKey } : {}) };
}

/** 서버가 마이그레이션한 파일인지 보고 쓰기 연결로 연다. @param {import('../src/config.js').ServerConfig} config @param {string} shopId */
function openFiles(config, shopId) {
  const files = /** @type {const} */ ([['control', join(config.dbDir, 'control.sqlite')], ['shop', join(config.shopDbDir, shopId + '.sqlite')]]);
  for (const [kind, file] of files) {
    const state = inspectFile(file, kind);
    if (!state.exists) throw new CliError(EXIT.unavailable, `${kind} 파일이 없습니다: 서버를 이 설정으로 한 번 시작해 파일을 만든 뒤 다시 합니다`);
    if (state.problems.length || state.pending.length) {
      throw new CliError(EXIT.unavailable, `${kind} 파일이 이 판으로 마이그레이션되지 않았습니다: 서버를 이 판으로 한 번 시작한 뒤 다시 합니다`);
    }
  }
  const controlDb = openDatabase(files[0][1]);
  const shopDb = openDatabase(files[1][1]);
  let shopOpen = true;
  const closeShop = () => {
    if (!shopOpen) return;
    shopOpen = false;
    shopDb.close();
  };
  return { controlDb, shopDb, closeShop, close: () => { closeShop(); controlDb.close(); } };
}

/** 비밀값(없으면 needPepper일 때 설정 오류, 아니면 이번 실행만의 값: 명령을 적용하지 않는 운영 명령). @param {CliIo} io @param {boolean} needPepper */
function secretsFor(io, needPepper) {
  try {
    return loadSecrets(io.env);
  } catch (error) {
    if (needPepper) throw error;
    const key = () => new Uint8Array(randomBytes(32));
    return { pinPepper: key(), sessionKey: key(), fingerprintKey: key(), ipKey: key() };
  }
}

/**
 * 명세 읽기: --spec(파일 경로 또는 --stdin의 명세 객체) 또는 --sample(견본). 둘 다 없으면 sampleByDefault일 때 견본.
 * @param {CliArgs} args @param {{ sampleByDefault?: boolean }} [options] @returns {import('@skinote/domain').ShopSpec}
 */
function readSpec(args, { sampleByDefault = false } = {}) {
  if (args.spec !== undefined && args.sample) throw new CliError(EXIT.usage, '--sample과 --spec 가운데 하나만');
  if (args.spec && typeof args.spec === 'object') return structuredClone(/** @type {any} */ (args.spec));
  if (typeof args.spec === 'string') {
    try {
      return JSON.parse(readFileSync(args.spec, 'utf8'));
    } catch {
      throw new CliError(EXIT.data, '--spec 파일을 JSON으로 읽지 못했습니다');
    }
  }
  if (args.sample || sampleByDefault) return sampleSpec();
  throw new CliError(EXIT.usage, 'provision에는 --sample 또는 --spec이 있어야 합니다');
}

/** @param {CliArgs} args @returns {import('@skinote/domain').ShopSpec} */
function specOf(args) {
  const spec = readSpec(args);
  if (typeof args.code !== 'string' || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(args.code)) throw new CliError(EXIT.usage, '--code는 영문 소문자 · 숫자 · -(2~32자)');
  if (typeof args.name !== 'string' || !/^[^\p{Cc}<>]{1,40}$/u.test(args.name)) throw new CliError(EXIT.usage, '--name은 1~40자');
  spec.shop = { ...spec.shop, code: args.code, name: args.name };
  spec.registry = { ...spec.registry, shopName: args.name };
  if (args.staff?.length) spec.staff = args.staff.map(parseStaff);
  if (!Array.isArray(spec.staff) || spec.staff.length === 0) throw new CliError(EXIT.data, '직원이 한 명도 없습니다(--staff)');
  return spec;
}

/** 저장소 · 명세 오류를 끝 코드로. @param {unknown} error */
function storeProblem(error) {
  const code = /** @type {{ code?: unknown }} */ (error ?? {}).code;
  if (code === 'ALREADY_PROVISIONED') return new CliError(EXIT.data, '이미 만든 매장입니다(장부는 지우지 않으니 새로 시작하려면 새 매장 id)');
  if (code === 'BAD_SPEC' || code === 'TIMEZONE_UNSUPPORTED') return new CliError(EXIT.data, `명세가 틀렸습니다(${String(code)}): ${/** @type {Error} */ (error).message}`);
  return null;
}

/**
 * 매장 만들기(혼자): 명세를 메모리 파일에 먼저 만들어 보고(틀린 명세가 control에 반쯤 남지 않게), control 계정 → 매장 파일 → control의
 * epoch 기록(tenant_epochs). 두 파일은 한 트랜잭션이 아니므로, control에는 매장이 있는데 매장 파일이 비어 있으면(그 사이에 멈춤 · 디스크
 * 오류) 이어서 한다: 있는 계정을 그대로 쓰고 새 비밀번호를 준다.
 * @param {import('../src/config.js').ServerConfig} config @param {string} shopId @param {CliArgs} args @param {CliIo} io
 */
async function provision(config, shopId, args, io) {
  const spec = specOf(args);
  const isTest = args.test === true;
  const digits = args.pinDigits === undefined ? 4 : Number(args.pinDigits);
  if (!Number.isInteger(digits) || digits < 4 || digits > 6) throw new CliError(EXIT.usage, '--pin-digits는 4~6');
  const secrets = secretsFor(io, true);
  const now = io.now();
  const options = { secrets: { fingerprintKey: secrets.fingerprintKey } };
  const dry = openDatabase(':memory:');
  try {
    applyPending(dry, 'shop');
    openShopStore(/** @type {any} */ (dry), shopId, options).provision(spec, now, { isTest });
  } catch (error) {
    throw storeProblem(error) ?? error;
  } finally {
    dry.close();
  }
  const files = openFiles(config, shopId);
  try {
    const control = openControlStore(/** @type {any} */ (files.controlDb));
    const store = openShopStore(/** @type {any} */ (files.shopDb), shopId, options);
    const already = new CliError(EXIT.data, '이미 만든 매장입니다(장부는 지우지 않으니 새로 시작하려면 새 매장 id)');
    let shopMade = true;
    try {
      store.head(now);
    } catch (error) {
      if (/** @type {{ code?: unknown }} */ (error).code !== 'SHOP_NOT_PROVISIONED') throw error;
      shopMade = false;
    }
    const tenant = control.tenant(shopId);
    if (tenant && shopMade) {
      // 둘 다 있다: epoch 기록만 빠졌으면 채운다(예전 판이 만든 매장).
      recordEpoch(control, store, shopId, now);
      throw already;
    }
    if (!tenant && shopMade) throw new CliError(EXIT.data, '매장 파일에는 매장이 있는데 control에 없습니다: 사람이 확인해야 합니다');
    if (!tenant && control.tenantByCode(spec.shop.code)) throw new CliError(EXIT.data, '같은 --code의 매장이 이미 있습니다');
    const pins = spec.staff.map(() => generatePin(digits));
    const hashes = await Promise.all(pins.map(pin => hashPin(secrets.pinPepper, pin)));
    /** @type {string[]} */
    let accountIds;
    if (tenant) {
      // 이어서 하기: 지난 실행이 만든 계정(같은 차례 · 같은 이름)에 새 비밀번호.
      const accounts = control.accountsOf(shopId);
      if (accounts.length !== spec.staff.length || accounts.some((a, i) => a.displayName !== spec.staff[i]?.name)) {
        throw new CliError(EXIT.data, '지난 실행과 직원 명세가 다릅니다: 같은 --staff로 다시 합니다');
      }
      if (tenant.isTest !== isTest) throw new CliError(EXIT.data, '지난 실행과 --test가 다릅니다');
      accounts.forEach((a, i) => control.setPinHash(a.id, /** @type {string} */ (hashes[i]), now));
      accountIds = accounts.map(a => a.id);
      io.err('지난 실행이 control에만 매장을 만들고 멈췄습니다: 이어서 매장 파일을 만듭니다(새 비밀번호)\n');
    } else {
      ({ accountIds } = control.provisionTenant({
        shopId, code: spec.shop.code, name: spec.shop.name, isTest, staff: spec.staff.map((s, i) => ({ displayName: s.name, pinHash: /** @type {string} */ (hashes[i]) })),
      }, now));
    }
    try {
      store.provision(spec, now, { isTest, accountIds });
    } catch (error) {
      throw storeProblem(error) ?? error;
    }
    recordEpoch(control, store, shopId, now);
    io.out(['직원\t역할\t비밀번호', ...spec.staff.map((s, i) => `${s.name}\t${s.role}\t${pins[i]}`)].join('\n') + '\n');
    io.err(`매장 ${shopId}(${spec.shop.code}) 만듦 · 직원 ${spec.staff.length}명${isTest ? ' · 시험 매장' : ''}: 비밀번호는 위 표에만 있습니다(다시 보려면 rotate-pin)\n`);
  } finally {
    files.close();
  }
}

/** 매장 파일의 epoch(1번)를 control tenant_epochs에 적는다(없으면). */
function recordEpoch(control, store, shopId, now) {
  if (control.currentEpoch(shopId)) return;
  control.recordEpoch({ tenantId: shopId, epochNo: 1, epochId: store.head(now).epoch, now });
}

/**
 * 견본 하루 불러오기(혼자, 시험 매장만): 견본 18팀을 그 날짜의 다음 빈 접수 번호 · 빈 번호 실물 · 날짜가 든 id로 바꿔 넣는다. 같은 날짜를
 * 두 번 하면 두 번째는 아무것도 적지 않는다(요청번호 import:sample:<날짜>).
 * @param {import('../src/config.js').ServerConfig} config @param {string} shopId @param {CliArgs} args @param {CliIo} io
 */
function loadSample(config, shopId, args, io) {
  const files = openFiles(config, shopId);
  try {
    const control = openControlStore(/** @type {any} */ (files.controlDb));
    const tenant = control.tenant(shopId);
    if (!tenant) throw new CliError(EXIT.unavailable, '아직 만들지 않은 매장입니다(provision 먼저)');
    if (!tenant.isTest) throw new CliError(EXIT.data, '견본 자료는 시험 매장(provision --test)에만 넣습니다');
    const secrets = secretsFor(io, false);
    const store = openShopStore(/** @type {any} */ (files.shopDb), shopId, { secrets: { fingerprintKey: secrets.fingerprintKey } });
    const now = io.now();
    const state = store.state(now);
    const today = businessDateOf(now, state.settings.businessDayCutoff);
    const date = args.date === 'today' || args.date === undefined ? today : String(args.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) throw new CliError(EXIT.usage, '--date는 today 또는 YYYY-MM-DD');
    const prefix = date.slice(2).replace(/-/g, '') + '-';
    const used = state.orders.filter(o => o.receiptNo.startsWith(prefix)).map(o => Number(o.receiptNo.slice(prefix.length)) || 0);
    // 견본 모양은 이 매장의 목록에서 고른다: 장비 · 리프트권을 번호로 세면 번호 매장 모양, 아니면 첫 매장 모양(2026-09-26). 견본 하루의 상품 ·
    // 재고 방식이 목록과 다르면(옛 견본으로 만든 시험 매장 · 다른 명세) 처리 오류 대신 한 줄로 거절한다.
    const shape = Object.values(state.registry.products).some(p => p.tracking === 'unit') ? 'numbered' : 'first';
    const sample = sampleDay({ date, epoch: state.epoch, ids: 'demo', shop: shape });
    const mismatch = sample.orders.flatMap(o => o.lines).find(l => state.registry.products[l.kind]?.tracking !== l.tracking);
    if (mismatch) throw new CliError(EXIT.data, '견본 모양이 다릅니다 · reset-test-shop 먼저(' + mismatch.kind + ')');
    let day;
    try {
      day = prepareImport(sample, { date, startSeq: Math.max(0, ...used) + 1, free: kind => freeNumbers(state, kind) });
    } catch (error) {
      throw new CliError(EXIT.data, '견본 하루를 넣을 빈 번호가 모자랍니다: ' + /** @type {Error} */ (error).message);
    }
    let result;
    try {
      result = store.importDay({ date, orders: day.orders, pins: day.pins, deposits: day.deposits, paymentGroups: day.paymentGroups }, 'import:sample:' + date, now,
        { key: 'system:cli', name: 'system:cli' });
    } catch (error) {
      if (/** @type {{ code?: unknown }} */ (error).code === 'NOT_TEST_SHOP') throw new CliError(EXIT.data, '견본 자료는 시험 매장에만 넣습니다');
      throw error;
    }
    io.out(`견본 하루\t${date}\n접수\t${result.orders}팀${result.replay ? '(이미 넣음: 그대로)' : ''}\nrev\t${result.rev}\n`);
  } finally {
    files.close();
  }
}

/**
 * 시험 매장 새로 만들기(혼자, 시험 매장만): 옛 파일의 사본을 받고 지금 견본(또는 --spec)으로 매장 파일을 다시 만든다. 이 매장의 코드 ·
 * 이름 · 직원은 control과 옛 파일의 것을 그대로 쓴다(--code · --name · --staff는 받지 않는다). 비밀번호는 control에 그대로라 찍지 않는다.
 * @param {import('../src/config.js').ServerConfig} config @param {string} shopId @param {CliArgs} args @param {CliIo} io
 */
function resetShop(config, shopId, args, io) {
  for (const [key, flag] of /** @type {const} */ ([['code', '--code'], ['name', '--name'], ['staff', '--staff'], ['test', '--test'], ['pinDigits', '--pin-digits']])) {
    if (args[key] !== undefined) throw new CliError(EXIT.usage, `reset-test-shop은 지금 매장의 코드 · 이름 · 직원 · 비밀번호를 그대로 씁니다(${flag} 없이)`);
  }
  const baseSpec = readSpec(args, { sampleByDefault: true });
  if (!baseSpec || typeof baseSpec !== 'object' || !baseSpec.registry || !baseSpec.shop) throw new CliError(EXIT.data, '명세가 틀렸습니다: shop · registry가 없습니다');
  const secrets = secretsFor(io, false);
  const files = openFiles(config, shopId);
  try {
    let summary;
    try {
      summary = resetTestShop(config, shopId, {
        controlDb: files.controlDb, shopDb: files.shopDb, closeShop: files.closeShop, baseSpec, now: io.now(), fingerprintKey: secrets.fingerprintKey,
      });
    } catch (error) {
      if (!(error instanceof ResetError)) throw error;
      const exit = error.code === 'NOT_TEST_SHOP' || error.code === 'BAD_SPEC' ? EXIT.data : error.code === 'SWAP_FAILED' ? EXIT.software : EXIT.unavailable;
      throw new CliError(exit, error.message);
    }
    io.out([
      `시험 매장 새로 만듦\t${summary.shopId}`,
      `직원\t${summary.staff}명(계정 · 비밀번호 그대로)`,
      `기기\t${summary.devices.kept}대 그대로 · ${summary.devices.dropped}대 끊음`,
      `세션\t${summary.sessions.kept}개 그대로 · ${summary.sessions.ended}개 끝냄`,
      `epoch\t${summary.epoch.no} (rev ${summary.epoch.revFloor + 1}부터, 옛 rev ${summary.oldRev})`,
      `백업\t${summary.backup.path}`,
      `sha256\t${summary.backup.sha256}`,
    ].join('\n') + '\n');
    if (summary.movedDrivers) io.err(`기사 ${summary.movedDrivers}명의 차량이 새 명세에 없어 첫 차량으로 옮겼습니다\n`);
    if (summary.devices.dropped) io.err(`새 명세에 차량이 없는 기사 기기 ${summary.devices.dropped}대를 끊었습니다: device-code로 다시 등록합니다\n`);
    for (const line of summary.warnings) io.err(line + '\n');
    io.err('옛 장부(접수 · 돈 · 재고)는 위 백업에만 있습니다. 견본 하루: load-sample --date today\n');
  } finally {
    files.close();
  }
}

/** 운영 명령의 결과를 사람이 읽는 줄로. @param {string} op @param {any} result */
function describe(op, result) {
  switch (op) {
    case 'device-code':
      return `등록 번호\t${result.formatted}\n기기\t${result.label} (${result.kind}${result.vehicleId ? ' · ' + result.vehicleId : ''})\n유효\t${result.expiresAt}까지\n`;
    case 'rotate-pin':
      return `직원\t역할\t비밀번호\n${result.staff}\t${result.role}\t${result.pin}\n`;
    case 'revoke-device':
      if (result.openAll) return `스스로 붙은 시험 기기 ${result.revoked}대 끊음 · 끝낸 세션 ${result.sessions}개 · 닫은 알림 연결 ${result.streams}개\n`;
      return `기기 ${result.label} ${result.revoked ? '끊음' : '이미 끊겨 있음'} · 끝낸 세션 ${result.sessions}개 · 닫은 알림 연결 ${result.streams}개\n`;
    default:
      return JSON.stringify(result) + '\n';
  }
}

/**
 * 명령줄 하나를 돌린다(시험은 같은 프로세스에서 부른다). 끝 코드를 돌려준다.
 * @param {string[]} argv @param {CliIo} io
 */
export async function runShopCli(argv, io) {
  /** @type {import('@skinote/store').WriterLock | null} */
  let lock = null;
  try {
    let { op, args, stdin } = parseArgs(argv);
    if (stdin) {
      let request;
      try {
        request = JSON.parse(await io.readStdin());
      } catch {
        throw new CliError(EXIT.usage, '--stdin은 { "op": …, "args": { … } } JSON 하나');
      }
      if (!request || typeof request.op !== 'string' || !OPS.includes(request.op) || (request.args !== undefined && typeof request.args !== 'object')) {
        throw new CliError(EXIT.usage, USAGE);
      }
      op = request.op;
      args = { ...(request.args ?? {}) };
      if (args.staff !== undefined && (!Array.isArray(args.staff) || !args.staff.every(s => typeof s === 'string'))) {
        if (typeof args.staff === 'string') args.staff = [args.staff];
        else throw new CliError(EXIT.usage, 'args.staff는 글 목록');
      }
    }
    const config = loadConfig(io.env);
    const shopId = typeof args.shop === 'string' ? args.shop : '';
    if (!config.shopIds.includes(shopId)) throw new CliError(EXIT.usage, '--shop이 SKINOTE_SHOP_IDS에 없습니다');

    if (EXCLUSIVE_OPS.includes(op)) {
      lock = acquireWriterLock(config.dataDir, shopId);
      if (!lock) throw new CliError(EXIT.unavailable, '서버가 이 매장 파일을 쓰는 중입니다: 서버를 멈춘 뒤 다시 하거나 deploy.sh --shop-cli를 씁니다');
      if (op === 'provision') await provision(config, shopId, args, io);
      else if (op === 'load-sample') loadSample(config, shopId, args, io);
      else resetShop(config, shopId, args, io);
      return EXIT.ok;
    }

    if (op === 'rotate-pin' && (args.staff?.length ?? 0) > 1) throw new CliError(EXIT.usage, 'rotate-pin은 --staff 하나');
    const opArgs = op === 'rotate-pin' ? { staff: args.staff?.[0], pinDigits: args.pinDigits }
      : op === 'device-code' ? { kind: args.kind, label: args.label, vehicle: args.vehicle, minutes: args.minutes }
        : op === 'revoke-device' ? { device: args.device, ...(args.openAll === true ? { openAll: true } : {}) } : {};
    lock = acquireWriterLock(config.dataDir, shopId);
    if (!lock) {
      // 서버가 돈다: 관리 소켓으로 보낸다(서버가 자기 연결로 처리한다).
      if (!config.adminSocket) throw new CliError(EXIT.unavailable, '서버가 도는데 관리 소켓이 꺼져 있습니다(SKINOTE_ADMIN_SOCKET)');
      let answer;
      try {
        answer = await sendAdminRequest(config.adminSocket, { op, shopId, args: opArgs });
      } catch (error) {
        throw new CliError(EXIT.unavailable, `관리 소켓에 붙지 못했습니다(${/** @type {{ code?: string }} */ (error).code ?? 'ERROR'})`);
      }
      if (!answer.ok) throw new CliError(answer.code === 'BAD_ARGS' || answer.code === 'NOT_FOUND' || answer.code === 'AMBIGUOUS' ? EXIT.data : EXIT.unavailable, `${answer.message}(${answer.code})`);
      io.out(describe(op, answer.result));
      return EXIT.ok;
    }
    const files = openFiles(config, shopId);
    try {
      const secrets = secretsFor(io, op === 'rotate-pin');
      const control = openControlStore(/** @type {any} */ (files.controlDb));
      const port = openShopPort({ db: /** @type {any} */ (files.shopDb), shopId }, { secrets });
      const run = ONLINE_OPS[/** @type {keyof typeof ONLINE_OPS} */ (op)];
      const result = await run({ shopId, port, control, secrets, now: io.now }, /** @type {any} */ (opArgs));
      io.out(describe(op, result));
    } finally {
      files.close();
    }
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliError) {
      io.err(error.message + '\n');
      return error.exit;
    }
    if (error instanceof ConfigError) {
      io.err(error.message + '\n');
      return EXIT.config;
    }
    if (error instanceof OpError) {
      io.err(`${error.message}(${error.code})\n`);
      return error.code === 'NOT_PROVISIONED' ? EXIT.unavailable : EXIT.data;
    }
    const e = /** @type {Error & { code?: string }} */ (error);
    io.err(`처리 오류${e.code ? `(${e.code})` : ''}: ${e.message}\n`);
    return EXIT.software;
  } finally {
    lock?.release();
  }
}

/** @returns {CliIo} */
function processIo() {
  return {
    env: process.env,
    out: text => { process.stdout.write(text); },
    err: text => { process.stderr.write(text); },
    readStdin: () => new Promise((resolve, reject) => {
      let text = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        text += chunk;
        if (text.length > 1024 * 1024) reject(new Error('표준 입력이 너무 깁니다'));
      });
      process.stdin.on('end', () => resolve(text));
      process.stdin.on('error', reject);
    }),
    now: () => Date.now(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runShopCli(process.argv.slice(2), processIo()).then(code => { process.exitCode = code; });
}
