// V2 새 접수 ① 품목 · V3 ② 일정(spec 3-4 · 3-5, ui 6-6). 틀은 접수증형(왼쪽 종이 · 오른쪽 판)이고 두 단계가 한 화면이다: 종이 머리의
// 단계 탭 `① 품목` · `② 일정` · `③ 결제`(뒤 단계는 앞 단계가 채워져야 누를 수 있다). 초안은 이 기기에 있고(app/new-order-draft.ts),
// 누를 때마다 서버에 orderDraft를 다시 물어 타일 · 고르는 줄 · 선택 품목 · 합계 · 일정 버튼 · 접수 내용 · 바닥줄 글을 받는다. 화면은
// 계산하지 않는다: 누른 것(이름 · 연락처 숫자 · 인원 · 품목 수 · 수령 · 반납 일정)을 초안에 넣기만 한다.
// 높이 · 폭이 모자라면 쪽을 넘기거나 덜 중요한 것을 뺀다(스크롤 · 말줄임 없음): 종류 격자는 잰 높이로 한 쪽의 줄 수를 세고 바닥줄에
// `품목 종류 1 / 2쪽`, 오른쪽 판의 줄은 판 안의 쪽 넘김, 대표자 줄은 숫자판 그림 → 이름표 차례로 빼고, ② 일정의 묶음 제목 줄이 들어가지
// 않으면(1024×569 · 529) 제목을 왼쪽 이름표 칸으로 옮긴다. 작은 창: 대표자(기기 자판), 연락처 · 직접 입력 시각(숫자판), 전화 예약 ·
// 차량 배달, 반납 장소의 구역 → 장소, 다른 날, 부츠 규격. ③ 결제는 ② 위에 뜨는 V4 접수 확정 창(CheckoutDialog)이고, 확정되면 초안을
// 지우고 새 접수의 접수증으로 간다. 초안은 화면을 떠나도 남고(`새 접수`를 다시 누르면 그대로), 바닥줄 `접수 취소`(묻고)로만 버린다.
import {
  ACTION_LABELS, dayPickOf, ORDER_DRAFT_KEYS as K, type DraftLineView, type OrderDraftParams, type OrderDraftView, type PlaceArea,
} from '@skinote/contract';
import {
  ChoiceRow, DialogFrame, FooterBar, FormRow, Icon, KindTile, ListRow2, NumberPad, Pager, PlaceChooser, PrimaryButton, Tag, TextFit, formatWon, t,
  timeFromDigits, useDeviceProfile, useElementSize, useFontsVersion, useIsoLayoutEffect, useUi,
} from '@skinote/ui';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useClient } from '../app/client.tsx';
import {
  clearNewOrder, draftParams, EMPTY_NEW_ORDER, hasDraft, loadNewOrder, qtyOf, saveNewOrder, withDeliver, withName, withOpenKind, withOpenVariant, withParty, withPhone,
  withPickupNow, withQuantity, withReserve, withReturnDay, withReturnPlace, withReturnSlot, type NewOrderState,
} from '../app/new-order-draft.ts';
import { go, type NewOrderStep } from '../app/router.ts';
import { say } from '../app/strings.ts';
import { CheckoutDialog } from '../components/CheckoutDialog.tsx';
import { ChoiceSheet, NoticeDialog } from '../components/NoticeDialog.tsx';
import { usePosHeader } from '../components/PosHeader.tsx';
import { TextSheet } from '../components/TextSheet.tsx';

/** 종류 격자의 칸 수(pos 3 × 3, ui 3-10). 줄 수는 잰 높이로 센다. */
export const TILE_COLUMNS = 3;
/** 대표자 이름의 글자 수 한도. */
const NAME_MAX = 20;
/** 서버 시각이 바꾸는 것(지난 반납 타임)을 다시 읽는 간격. */
const REFRESH_MS = 60_000;

type Sheet =
  | { kind: 'name' }
  | { kind: 'phone' }
  | { kind: 'reserve' }
  | { kind: 'deliver' }
  | { kind: 'time'; back: 'reserve' | 'deliver' }
  | { kind: 'calendar'; back: 'return' | 'reserve' }
  | { kind: 'area'; area: PlaceArea }
  | { kind: 'variants' }
  | { kind: 'pay' };

// ── 쪽 · 맞춤(잰 크기로 세는 모양 계산, 업무 규칙이 아님) ─────────────────────────

/** 한 쪽의 종류 타일 수: 잰 높이에 들어가는 타일 줄 수 × 칸 수. 재기 전에는 모두. */
export function tilesPerPage(heightPx: number | undefined, tilePx: number, gapPx: number, count: number): number {
  if (!heightPx) return Math.max(1, count);
  const rows = Math.max(1, Math.floor((heightPx + gapPx) / (tilePx + gapPx)));
  return rows * TILE_COLUMNS;
}

/**
 * 판 안의 두 줄 줄 쪽 나누기: 모두 들어가면 한 쪽(extraPx = 뒤의 안내 줄이 함께 들어가면 보인다), 아니면 쪽 넘김 한 줄(rowPx)을 빼고
 * 들어가는 줄 수씩.
 */
export function rowPages(heightPx: number | undefined, rowPx: number, count: number, extraPx = 0): { perPage: number; pages: number; extra: boolean } {
  if (!heightPx || count === 0) return { perPage: Math.max(1, count), pages: 1, extra: true };
  if (count * rowPx + extraPx <= heightPx + 0.5) return { perPage: count, pages: 1, extra: true };
  if (count * rowPx <= heightPx + 0.5) return { perPage: count, pages: 1, extra: false };
  const perPage = Math.max(1, Math.floor((heightPx - rowPx) / rowPx));
  return { perPage, pages: Math.ceil(count / perPage), extra: false };
}

/** 바닥줄 글('새 접수 · 이민호 팀 · 4명')이 좁으면 뒤 조각부터 뺀 글들. */
export function footerAlts(footer: string): string[] {
  const parts = footer.split(' · ');
  return parts.map((_, i) => parts.slice(0, parts.length - i).join(' · '));
}

/** 가로로 넘치는지: 요소 자신이나 그 칸(자식) 하나라도 글이 칸보다 넓다. */
const overX = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1 || [...el.children].some((c) => c.scrollWidth > c.clientWidth + 1);
const overY = (el: HTMLElement) => el.scrollHeight > el.clientHeight + 1;

/** 그린 뒤 넘치면 한 단계씩 줄인다(0 → max). signature(크기 · 글꼴 · 글)가 바뀌면 0부터 다시 잰다. */
function useOverflowLevel(ref: RefObject<HTMLElement | null>, max: number, signature: string, over: (el: HTMLElement) => boolean): number {
  const [state, setState] = useState({ signature, level: 0 });
  const level = state.signature === signature ? state.level : 0;
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (over(el) && level < max) setState({ signature, level: level + 1 });
    else if (state.signature !== signature) setState({ signature, level });
  });
  return level;
}

/** 초안이 바뀔 때마다 서버에 다시 묻는다(답을 받기 전에는 앞의 답을 그대로 보인다). 새 rev · 1분마다도 다시 읽는다. */
function useOrderDraftView(params: OrderDraftParams): OrderDraftView | null {
  const client = useClient();
  const key = JSON.stringify(params);
  const [tick, setTick] = useState(0);
  const [view, setView] = useState<OrderDraftView | null>(null);
  const asked = useRef('');
  useEffect(() => {
    const off = client.subscribe(() => setTick((n) => n + 1));
    const timer = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => { off(); clearInterval(timer); };
  }, [client]);
  useEffect(() => {
    let alive = true;
    const ask = key + '#' + tick;
    asked.current = ask;
    client.query('orderDraft', JSON.parse(key) as OrderDraftParams).then(
      (next) => { if (alive && asked.current === ask) setView(next); },
      // 체험 자료는 실패하지 않는다. 운영에서 끊기면 앞의 답을 그대로 두고 다음 알림 · 1분 뒤에 다시 묻는다.
      () => undefined,
    );
    return () => { alive = false; };
  }, [client, key, tick]);
  return view;
}

// ── 화면 ──────────────────────────────────────────────────────────

export function NewOrderScreen({ step }: { step: NewOrderStep }) {
  const header = usePosHeader('other');
  const [order, setOrder] = useState<NewOrderState>(() => loadNewOrder());
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const view = useOrderDraftView(draftParams(order));
  // 종류 격자의 쪽: 한 쪽의 타일 수는 격자가 잰 높이로 센다(ItemsBody가 알린다), 쪽 넘김은 바닥줄.
  const [tilePage, setTilePage] = useState(0);
  const [perPage, setPerPage] = useState(9);
  const tilePages = view ? Math.max(1, Math.ceil(view.tiles.length / perPage)) : 1;
  const tiles = { page: Math.min(tilePage, tilePages - 1), pages: tilePages, perPage };
  /** 그 종류가 있는 쪽으로(선택 품목 줄을 눌러 연 종류). */
  const showKind = (kindKey: string) => {
    const index = view?.tiles.findIndex((tile) => tile.key === kindKey) ?? -1;
    if (index >= 0) setTilePage(Math.floor(index / perPage));
  };

  // 초안은 화면을 떠나도 남는다(‹ 장부 · 머리줄 장부 · 끝 4자리로 연 접수증 · 브라우저 뒤로): 손님 응대로 끊겨도 `새 접수`를 다시 누르면
  // 그대로 열린다. 지우는 것은 접수 확정(order.create)과 `접수 취소`(묻고 지움)뿐이다.
  useEffect(() => { saveNewOrder(order); }, [order]);
  const [discarding, setDiscarding] = useState(false);

  const change = (next: NewOrderState) => setOrder(next);
  const toLedger = () => go({ name: 'ledger', date: null });
  const discard = () => {
    clearNewOrder();
    setDiscarding(false);
    setOrder(EMPTY_NEW_ORDER);
    go({ name: 'ledger', date: null });
  };
  const toStep = (next: NewOrderStep) => go({ name: 'newOrder', step: next }, { replace: true });

  const ready = view?.ready ?? { items: false, schedule: false };
  const stepTab = (text: string) => {
    const [no, ...rest] = text.split(' ');
    return <><span className="pos-step-no">{no}</span> {rest.join(' ')}</>;
  };

  return (
    <div className="sn-screen">
      {header.element}
      <div className="sn-desk pos-slip-desk">
        <article className="sn-slip pos-new" aria-label={step === 'items' ? say('newOrderItemsAria') : say('newOrderScheduleAria')}>
          <header className="sn-slip-head">
            <div className="pos-new-head">
              <h1 className="sn-slip-title">{say('newOrder')}</h1>
              {view?.channelTag ? <Tag text={view.channelTag} tone="blue" /> : null}
            </div>
            <div className="sn-tabs pos-new-tabs" role="tablist" aria-label={say('newOrderSteps')}>
              <button type="button" role="tab" className="sn-tab" aria-selected={step === 'items'} onClick={() => toStep('items')}>{stepTab(say('stepItems'))}</button>
              <button type="button" role="tab" className="sn-tab" aria-selected={step === 'schedule'} disabled={step !== 'schedule' && !ready.items} onClick={() => toStep('schedule')}>{stepTab(say('stepSchedule'))}</button>
              <button type="button" role="tab" className="sn-tab" aria-selected={false} disabled={!ready.schedule} onClick={() => setSheet({ kind: 'pay' })}>{stepTab(say('stepPay'))}</button>
            </div>
          </header>
          {view && step === 'items' ? <ItemsBody view={view} order={order} change={change} setSheet={setSheet} tiles={tiles} onPerPage={setPerPage} /> : null}
          {view && step === 'schedule' ? <ScheduleBody view={view} order={order} change={change} setSheet={setSheet} /> : null}
        </article>
        {view ? (
          step === 'items'
            ? <ItemsSide view={view} order={order} change={change} onKind={showKind} onNext={() => toStep('schedule')} />
            : <ScheduleSide view={view} onNext={() => setSheet({ kind: 'pay' })} />
        ) : <aside className="pos-side" />}
      </div>
      <NewOrderFooter view={view} tiles={step === 'items' ? tiles : null} onTilePage={setTilePage} onBack={toLedger} {...(hasDraft(order) ? { onDiscard: () => setDiscarding(true) } : {})} />
      {view && sheet ? <Sheets key={sheetKey(sheet)} sheet={sheet} view={view} order={order} change={change} setSheet={setSheet} /> : null}
      {discarding ? (
        <NoticeDialog
          title={ACTION_LABELS.cancel}
          lines={view ? [view.footer] : []}
          actions={[{ label: ACTION_LABELS.cancel, onPress: discard }]}
          onClose={() => setDiscarding(false)}
        />
      ) : null}
      {header.overlays}
    </div>
  );
}

interface PartProps {
  view: OrderDraftView;
  order: NewOrderState;
  change: (next: NewOrderState) => void;
  setSheet: (sheet: Sheet | null) => void;
}

// ── ① 품목(왼쪽 종이) ───────────────────────────────────────────────

interface TilePaging {
  page: number;
  pages: number;
  perPage: number;
}

function ItemsBody({ view, order, change, setSheet, tiles, onPerPage }: PartProps & { tiles: TilePaging; onPerPage: (perPage: number) => void }) {
  const { viewport } = useUi();
  const profile = useDeviceProfile();
  const fonts = useFontsVersion();
  const bodyRef = useRef<HTMLDivElement>(null);
  const repRef = useRef<HTMLDivElement>(null);
  const body = useElementSize(bodyRef);
  // 격자에 남는 높이 = 종이 본문 − 위아래 여백 − 대표자 줄 − 고르는 줄 둘(52 + 8 + 52) − 사이 둘. 격자는 위에 붙고 남는 자리는 맨 아래(큰 화면).
  const fixed = profile.space.s * 2 + profile.minTargetPx + (profile.minTargetPx * 2 + profile.space.s) + profile.space.s * 2;
  const perPage = tilesPerPage(body ? body.height - fixed : undefined, profile.minTargetPx + profile.space.xs, profile.space.s, view.tiles.length);
  useIsoLayoutEffect(() => { if (perPage !== tiles.perPage) onPerPage(perPage); }, [perPage, tiles.perPage]);
  const name = order.draft.leader.name.trim();
  const phone = view.leader.phone;
  const party = view.leader.party;
  // 대표자 줄이 넘치면: 숫자판 그림 → 인원 이름표 → 연락처 이름표 → 대표자 이름표 차례로 뺀다(읽는 이름은 남는다).
  const drop = useOverflowLevel(repRef, 4, [viewport.width, fonts, name, phone, party.value].join('|'), overX);
  const picker = view.picker;
  const openTile = view.tiles.find((tile) => tile.open);
  const shown = view.tiles.slice(tiles.page * perPage, (tiles.page + 1) * perPage);
  // 격자의 줄 자리는 쪽마다 같다(마지막 쪽의 타일이 적어도 고르는 줄이 올라오지 않게).
  const gridRows = Math.max(1, Math.ceil(Math.min(perPage, view.tiles.length) / TILE_COLUMNS));

  const openKind = (key: string) => change(withOpenKind(order, key));
  const quantity = picker?.quantity;
  const setQty = (delta: number) => {
    if (!quantity) return;
    const next = Math.min(quantity.value.max, Math.max(quantity.value.min, qtyOf(order, quantity.target) + delta));
    change(withQuantity(order, quantity.target, next));
  };

  return (
    <div ref={bodyRef} className="pos-new-body">
      <div ref={repRef} className={'pos-new-rep' + ['drop-icon', 'drop-party', 'drop-contact', 'drop-leader'].slice(0, drop).map((c) => ' ' + c).join('')}>
        <button type="button" className={'sn-button pos-new-field is-name' + (name ? ' has-value' : '') + (view.ready.missing === 'name' ? ' is-missing' : '')} aria-label={name ? say('leaderInput', { name }) : say('leaderPad')} onClick={() => setSheet({ kind: 'name' })}>
          <small className="pos-new-label">{say('leader')}</small>
          {name ? <TextFit className="pos-new-value" input={{ mode: 'words', text: name }} /> : <span className="pos-new-value is-empty">{say('leaderEmpty')}</span>}
        </button>
        <button type="button" className={'sn-button pos-new-field is-phone' + (phone ? ' has-value' : '')} aria-label={phone ? say('contactInput', { phone }) : say('contactPad')} onClick={() => setSheet({ kind: 'phone' })}>
          <small className="pos-new-label">{say('contact')}</small>
          {phone ? <b className="pos-new-value">{phone}</b> : null}
          <span className="pos-new-icon"><Icon name="keypad" /></span>
        </button>
        <div className="pos-new-people" role="group" aria-label={say('party')}>
          <small className="pos-new-label">{say('party')}</small>
          <button type="button" className="sn-qty-button" aria-label={t('qtyMinus')} disabled={party.value <= party.min} onClick={() => change(withParty(order, party.value - 1))}>−</button>
          <output className={'sn-qty-value' + (party.value === 0 ? ' is-zero' : '')} aria-live="polite">{party.value + party.unit}</output>
          <button type="button" className="sn-qty-button" aria-label={t('qtyPlus')} disabled={party.value >= party.max} onClick={() => change(withParty(order, party.value + 1))}>+</button>
        </div>
      </div>

      <div className="pos-new-kinds" role="group" aria-label={say('kindGroup')} style={{ gridTemplateRows: 'repeat(' + gridRows + ', calc(var(--sn-target) + var(--sn-space-xs)))' }}>
        {shown.map((tile) => <KindTile key={tile.key} tile={tile} onPress={openKind} />)}
      </div>

      <div className="pos-new-open" role="group" aria-label={openTile ? say('kindPick', { kind: openTile.label }) : say('kindGroup')}>
        {picker ? (
          <>
            <div className="pos-new-pick">
              {picker.variants ? (
                <>
                  <span className="pos-new-pick-label">{picker.variants.label}</span>
                  <ChoiceRow
                    options={picker.variants.options}
                    label={picker.variants.label}
                    onPress={(key) => change(withOpenVariant(order, key))}
                    {...(picker.variants.moreLabel ? { more: { label: picker.variants.moreLabel, onPress: () => setSheet({ kind: 'variants' }) } } : {})}
                  />
                </>
              ) : null}
            </div>
            <div className="pos-new-pick">
              {quantity ? (
                <>
                  <span className="pos-new-pick-label">{quantity.label}</span>
                  <button type="button" className="sn-qty-button" aria-label={t('qtyMinus')} disabled={quantity.value.value <= quantity.value.min} onClick={() => setQty(-1)}>−</button>
                  <output className={'sn-qty-value' + (quantity.value.value === 0 ? ' is-zero' : '')} aria-live="polite">{quantity.value.value + quantity.value.unit}</output>
                  <button type="button" className="sn-qty-button" aria-label={t('qtyPlus')} disabled={quantity.value.value >= quantity.value.max} onClick={() => setQty(1)}>+</button>
                  {quantity.note ? <TextFit className="pos-new-pick-note" input={{ mode: 'words', text: quantity.note }} /> : null}
                </>
              ) : <span className="pos-new-hint">{picker.hint}</span>}
            </div>
          </>
        ) : <p className="pos-new-hint">{say('kindPickHint')}</p>}
      </div>
    </div>
  );
}

// ── ① 품목(오른쪽 판: 선택 품목 · 합계 · 다음) ─────────────────────────────

/**
 * 오른쪽 판의 두 줄 줄(잰 높이로 쪽 나누기). onShort: 줄이 다 들어가지 않을 때 한 번 알린다(선택 품목 판은 합계의 장비 · 리프트권 줄을
 * 빼 자리를 만든다 — 줄에 같은 금액이 있다).
 */
function PanelRows({ rows, extra, render, onShort }: { rows: DraftLineView[]; extra?: ReactNode; render: (row: DraftLineView) => ReactNode; onShort?: () => void }) {
  const profile = useDeviceProfile();
  const boxRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(boxRef);
  const extraPx = extra ? Math.ceil(profile.minFontPx * 1.35) + profile.space.xs + profile.space.s : 0;
  const paging = rowPages(size?.height, profile.minTargetPx, rows.length, extraPx);
  const short = size !== null && rows.length * profile.minTargetPx > size.height + 0.5;
  useIsoLayoutEffect(() => { if (short) onShort?.(); }, [short, rows.length, size?.height]);
  const [page, setPage] = useState(0);
  const current = Math.min(page, paging.pages - 1);
  const shown = rows.slice(current * paging.perPage, (current + 1) * paging.perPage);
  return (
    <div ref={boxRef} className="pos-new-rows">
      <ol className="sn-list-rows">{shown.map(render)}</ol>
      {paging.extra ? extra : null}
      {paging.pages > 1 ? <div className="pos-new-rows-pager"><Pager page={current} pageCount={paging.pages} onChange={setPage} /></div> : null}
    </div>
  );
}

function ItemsSide({ view, order, change, onKind, onNext }: Omit<PartProps, 'setSheet'> & { onKind: (kindKey: string) => void; onNext: () => void }) {
  const { viewport } = useUi();
  // 선택 품목 줄이 다 들어가지 않으면(1024×569 · 529) 합계의 장비 · 리프트권 줄을 빼고 합계 · 보증금만 둔다(창 크기 · 줄 수가 바뀌면 다시).
  const signature = [viewport.width, viewport.height, view.selected.length].join('|');
  const [compact, setCompact] = useState({ signature, on: false });
  const sumCompact = compact.signature === signature && compact.on;
  const totals = sumCompact ? view.totals.filter((line) => line.strong || line.muted) : view.totals;
  const openRow = (row: DraftLineView) => {
    if (!row.open) return;
    change(withOpenKind(order, row.open.kindKey, row.open.variantKey));
    // 그 종류가 격자의 다른 쪽에 있으면 그 쪽으로.
    onKind(row.open.kindKey);
  };
  return (
    <aside className="pos-side pos-new-side" aria-label={say('selectedItems')}>
      <h2 className="pos-new-panel-title">{say('selectedItems')}</h2>
      <PanelRows
        rows={view.selected}
        onShort={() => { if (!sumCompact) setCompact({ signature, on: true }); }}
        render={(row) => (
          <ListRow2 key={row.key} title={row.title} note={row.note} {...(row.items ? { items: row.items } : {})} {...(row.amount !== undefined ? { amount: formatWon(row.amount) } : {})} {...(row.open ? { onPress: () => openRow(row) } : {})} />
        )}
      />
      <div className={'pos-new-sum' + (sumCompact ? ' is-compact' : '')}>
        {totals.map((line) => (
          <span key={line.label} className={'pos-new-sum-line' + (line.strong ? ' is-total' : '') + (line.muted ? ' is-muted' : '')}>
            <span>{line.label}</span>
            <span>{formatWon(line.amount)}</span>
          </span>
        ))}
      </div>
      {view.ready.itemsReason ? <p className="pos-new-reason">{view.ready.itemsReason}</p> : null}
      <PrimaryButton className="pos-new-go" label={say('nextToSchedule')} disabled={!view.ready.items} onPress={onNext} />
    </aside>
  );
}

// ── ② 일정(왼쪽 종이: 수령 방법 · 반납일 · 반납 시각 · 반납 장소) ─────────────────

function Block({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <section className={'pos-new-block' + (className ? ' ' + className : '')} aria-label={label}>
      <h2 className="pos-new-block-title">{label}</h2>
      {children}
    </section>
  );
}

function ScheduleBody({ view, order, change, setSheet }: PartProps) {
  const { viewport } = useUi();
  const fonts = useFontsVersion();
  const bodyRef = useRef<HTMLDivElement>(null);
  const s = view.schedule;
  // 묶음 제목 줄이 들어가지 않으면(1024×569 · 529) 제목을 왼쪽 이름표 칸으로(줄 수는 그대로 넷).
  const compact = useOverflowLevel(bodyRef, 1, [viewport.width, viewport.height, fonts].join('|'), overY) > 0;
  const reserveOn = s.pickup.find((o) => o.key === K.reserve)?.selected === true;
  const otherOn = s.returnDays.find((o) => o.key === K.other)?.selected === true;
  // 예약 · 차량 배달은 작은 창을 열기만 한다: 창 안에서 누른 것만 초안에 넣는다(열고 `닫기`만 하면 수령 방법은 그대로, 창은 처음 값을
  // 골라 둔 모양으로 보인다).
  const onPickup = (key: string) => {
    if (key === K.now) change(withPickupNow(order));
    else if (key === K.reserve) setSheet({ kind: 'reserve' });
    else if (key === K.deliver) setSheet({ kind: 'deliver' });
  };
  return (
    <div ref={bodyRef} className={'pos-new-body pos-new-schedule' + (compact ? ' is-compact' : '')}>
      <Block label={say('pickupMethod')}>
        <ChoiceRow options={s.pickup} label={say('pickupMethod')} names={reserveOn ? {} : { reserve: say('reserveAria') }} onPress={onPickup} />
      </Block>
      <Block label={say('returnDay')}>
        <ChoiceRow
          options={s.returnDays}
          label={say('returnDay')}
          names={otherOn ? {} : { [K.other]: say('pickDay') }}
          onPress={(key) => { const day = dayPickOf(key); if (day) change(withReturnDay(order, view, day)); else setSheet({ kind: 'calendar', back: 'return' }); }}
        />
      </Block>
      <Block label={say('returnTime')}>
        <ChoiceRow options={s.returnSlots} label={say('returnTime')} onPress={(key) => change(withReturnSlot(order, view, key))} />
      </Block>
      <Block label={say('returnPlace')} className="is-place">
        <PlaceChooser
          areas={s.areas}
          place={s.returnPlace}
          label={say('returnPlace')}
          againName={(place) => say('placeAgain', { place })}
          onPick={(place) => change(withReturnPlace(order, place))}
          onArea={(area) => setSheet({ kind: 'area', area })}
        />
      </Block>
    </div>
  );
}

function ScheduleSide({ view, onNext }: { view: OrderDraftView; onNext: () => void }) {
  return (
    <aside className="pos-side pos-new-side" aria-label={say('orderSummary')}>
      <h2 className="pos-new-panel-title">{say('orderSummary')}</h2>
      <PanelRows
        rows={view.summary}
        extra={<p className="pos-new-note">{say('perItemSchedule')}</p>}
        render={(row) => <ListRow2 key={row.key} title={row.title} note={row.note} {...(row.items ? { items: row.items } : {})} />}
      />
      <PrimaryButton className="pos-new-go" label={say('nextToPay')} disabled={!view.ready.schedule} onPress={onNext} />
    </aside>
  );
}

// ── 바닥줄: ‹ 장부 · 팀 한 줄 · 종류 격자의 쪽 ────────────────────────────────

function NewOrderFooter({ view, tiles, onTilePage, onBack, onDiscard }: {
  view: OrderDraftView | null; tiles: TilePaging | null; onTilePage: (page: number) => void; onBack: () => void; onDiscard?: () => void;
}) {
  return (
    <FooterBar
      metrics={[]}
      {...(tiles && tiles.pages > 1 ? { pager: <Pager label={say('kindGroup')} page={tiles.page} pageCount={tiles.pages} onChange={onTilePage} /> } : {})}
    >
      <div className="pos-footer-back">
        <button type="button" className="sn-button" onClick={onBack}>
          <Icon name="left" />
          <span>{t('home')}</span>
        </button>
        {onDiscard ? <button type="button" className="sn-button" onClick={onDiscard}>{ACTION_LABELS.cancel}</button> : null}
        {view ? <TextFit input={{ mode: 'alts', alts: footerAlts(view.footer) }} /> : null}
      </div>
    </FooterBar>
  );
}

// ── 작은 창들 ────────────────────────────────────────────────────────

/** 창마다 따로 그린다(숫자판의 친 숫자가 다른 창으로 넘어가지 않게). */
const sheetKey = (sheet: Sheet) => sheet.kind + ('back' in sheet ? ':' + sheet.back : '') + (sheet.kind === 'area' ? ':' + sheet.area.key : '');

function Sheets({ sheet, view, order, change, setSheet }: PartProps & { sheet: Sheet }) {
  const [digits, setDigits] = useState(() => (sheet.kind === 'phone' ? order.draft.leader.phone : ''));
  const close = () => setSheet(null);
  const s = view.schedule;
  switch (sheet.kind) {
    case 'name':
      return (
        <TextSheet
          title={say('leader')}
          value={order.draft.leader.name}
          placeholder={say('leaderEmpty')}
          maxLength={NAME_MAX}
          onSubmit={(name) => { change(withName(order, name)); close(); }}
          onClose={close}
        />
      );
    case 'phone':
      return (
        <NumberPad
          mode="phone"
          title={say('contact')}
          value={digits}
          onChange={setDigits}
          onSubmit={(value) => { change(withPhone(order, value)); close(); }}
          onClose={close}
        />
      );
    case 'time':
      return (
        <NumberPad
          mode="time"
          title={sheet.back === 'reserve' ? say('pickupTime') : say('deliverTime')}
          value={digits}
          onChange={setDigits}
          onSubmit={(value) => {
            const time = timeFromDigits(value);
            if (time) change(sheet.back === 'reserve' ? withReserve(order, { time }) : withDeliver(order, { time }));
            setSheet({ kind: sheet.back });
          }}
          onClose={() => setSheet({ kind: sheet.back })}
        />
      );
    case 'reserve':
      return (
        <DialogFrame title={say('reserveTitle')} onClose={close} className="pos-new-window">
          <FormRow label={say('pickupDay')}>
            <ChoiceRow
              options={s.reserve.days ?? []}
              label={say('pickupDay')}
              names={{ [K.other]: say('pickDay') }}
              onPress={(key) => { const day = dayPickOf(key); if (day) change(withReserve(order, { day })); else setSheet({ kind: 'calendar', back: 'reserve' }); }}
            />
          </FormRow>
          <FormRow label={say('pickupTime')}>
            <ChoiceRow options={s.reserve.times} label={say('pickupTime')} onPress={(key) => (key === K.custom ? setSheet({ kind: 'time', back: 'reserve' }) : change(withReserve(order, { time: key })))} />
          </FormRow>
          <FormRow label={say('pickupPlace')}>
            <PlaceChooser areas={s.areas} place={s.reserve.place} label={say('pickupPlace')} againName={(place) => say('placeAgain', { place })} onPick={(place) => change(withReserve(order, { place }))} />
          </FormRow>
        </DialogFrame>
      );
    case 'deliver':
      return (
        <DialogFrame title={say('deliverTitle')} onClose={close} className="pos-new-window">
          <FormRow label={say('deliverTime')}>
            <ChoiceRow options={s.deliver.times} label={say('deliverTime')} onPress={(key) => (key === K.custom ? setSheet({ kind: 'time', back: 'deliver' }) : change(withDeliver(order, { time: key })))} />
          </FormRow>
          <FormRow label={say('deliverPlace')}>
            <PlaceChooser areas={s.areas} place={s.deliver.place} store={false} label={say('deliverPlace')} againName={(place) => say('placeAgain', { place })} onPick={(place) => change(withDeliver(order, { place }))} />
          </FormRow>
        </DialogFrame>
      );
    case 'calendar':
      return (
        <ChoiceSheet
          title={say('pickDay')}
          choices={s.calendar.filter((d) => sheet.back === 'reserve' || d.enabled).map((d) => ({ key: d.key, label: d.label }))}
          onPick={(key) => {
            if (sheet.back === 'reserve') { change(withReserve(order, { day: key })); setSheet({ kind: 'reserve' }); } else { change(withReturnDay(order, view, key)); close(); }
          }}
          onClose={() => setSheet(sheet.back === 'reserve' ? { kind: 'reserve' } : null)}
        />
      );
    case 'area':
      return (
        <ChoiceSheet
          title={sheet.area.label}
          choices={sheet.area.places.map((p) => ({ key: p.key, label: p.label }))}
          onPick={(key) => { change(withReturnPlace(order, { mode: 'vehicle', placeKey: key })); close(); }}
          onClose={close}
        />
      );
    case 'variants':
      return view.picker?.variants ? (
        <ChoiceSheet
          title={view.picker.variants.label}
          choices={view.picker.variants.options.map((o) => ({ key: o.key, label: o.label }))}
          onPick={(key) => { change(withOpenVariant(order, key)); close(); }}
          onClose={close}
        />
      ) : null;
    case 'pay':
      // ③ 결제(V4 접수 확정 창): 확정되면 초안을 지우고 새 접수의 접수증으로(주소를 바꿔 뒤로 가기는 장부).
      return (
        <CheckoutDialog
          draft={order.draft}
          onClose={close}
          onDone={(orderId) => { clearNewOrder(); go({ name: 'slip', orderId }, { replace: true }); }}
        />
      );
  }
}
