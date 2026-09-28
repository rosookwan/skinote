// A4 인쇄 문서(features-1 §8-3, E16): 카운터 `수거 목록`의 `인쇄`와 접수증 옆 동작 `인쇄`가 브라우저 인쇄 창으로 내보내는 종이. 같은 읽기 모델(인쇄 판:
// ledgerView collection_list · orderSlip의 deviceClass 'print')을 A4 쪽(794 × 1123, 여백 12mm)으로 나눈다. 번호는 수거 목록이 온전한 번호(`010-0000-0025`, 기사가 들고 나가는 종이),
// 접수증이 가린 번호(`010-****-0025`)다.
//   - 쪽마다: 머리(매장 이름 · 전화, 제목 · 이어지는 쪽은 `(계속)`) · 표 · 바닥(쪽 `1 / 2쪽` · `인쇄 16:40`, 12px).
//   - 수거 목록: 팀 · 전화 · 품목 · 반납 · 차량(설정 collection_list/print의 칸), 한 줄 28px, 반쯤 잘린 줄 없이 쪽을 나눈다(layout printPages).
//   - 대여 접수증: 칸(날짜 · 구분 · 대표자 · 연락처 · 인원), 품목 표(품목 · 수량 · 금액), 출처 줄, 돈(청구 · 수납 · 미수), 일정(수령 · 반납).
// 글자는 인쇄 등급(DeviceProfile print: 본문 14 · 쪽 번호 12)의 변수다. 화면은 셈하지 않는다: 줄 · 칸 · 글은 읽기 모델 그대로다.
import type { LedgerCell, LedgerColumnRow, LedgerViewResult, OrderSlip, ResolvedLedgerView } from '@skinote/contract';
import { printPages } from '@skinote/layout';
import { TextFit, fillTitle, formatItem, formatTime, formatWon, t, useUi, type DeviceProfile } from '@skinote/ui';
import type { CSSProperties, ReactNode } from 'react';
import { say } from '../app/strings.ts';

/** A4 한 쪽(96dpi CSS px)과 여백 12mm. */
export const A4 = { width: 794, height: 1123, marginPx: 45 } as const;

/** 쪽 안의 높이(모양 계산, 업무 규칙이 아님): 머리 · 표 머리 · 바닥을 뺀 줄 자리. 줄은 인쇄 등급의 줄 높이(28). */
export function printGeometry(profile: Pick<DeviceProfile, 'titleFontPx' | 'bodyFontPx' | 'minFontPx' | 'bodyLineHeight' | 'tableHeadPx' | 'rowPx' | 'space'>) {
  const line = (px: number) => Math.ceil(px * profile.bodyLineHeight);
  const headPx = line(profile.titleFontPx) + line(profile.bodyFontPx) + 2 * profile.space.s;
  const footPx = line(profile.minFontPx) + profile.space.s;
  const bodyPx = A4.height - 2 * A4.marginPx - headPx - footPx;
  return { headPx, footPx, bodyPx, rowPx: profile.rowPx, tableHeadPx: profile.tableHeadPx };
}

/** 칸 값의 글(인쇄는 한 줄 글). */
function cellText(cell: LedgerCell | undefined): { text?: string; parts?: { text: string; drop: number }[]; items?: string[] } {
  if (!cell) return { text: '' };
  switch (cell.renderer) {
    case 'team': return { text: cell.name + ' · ' + cell.last4 };
    case 'action': return { text: cell.phone ?? '' };
    case 'items': return { items: cell.items.map(formatItem) };
    case 'promise':
    case 'place':
    case 'vehicle':
    case 'text':
    case 'attribute':
      return { parts: cell.parts.map((p) => ({ text: p.text, drop: p.drop })) };
    default:
      return { text: '' };
  }
}

function Cell({ cell }: { cell: LedgerCell | undefined }) {
  const v = cellText(cell);
  if (v.items) return <TextFit input={{ mode: 'items', items: v.items }} />;
  if (v.parts) return <TextFit input={{ mode: 'parts', parts: v.parts }} />;
  return <TextFit input={{ mode: 'words', text: v.text ?? '' }} />;
}

interface PageFrameProps {
  title: string;
  shop: { shopName: string; shopPhone: string };
  page: number;
  pages: number;
  printedAt: string;
  children: ReactNode;
}

/** A4 쪽 하나(머리 · 몸 · 바닥). */
function PageFrame({ title, shop, page, pages, printedAt, children }: PageFrameProps) {
  const style: CSSProperties = { width: A4.width, height: A4.height, padding: A4.marginPx };
  return (
    <section className="pos-print-page" style={style} aria-label={title}>
      <header className="pos-print-head">
        <p className="pos-print-shop">{shop.shopName}{shop.shopPhone ? ' · ' + say('printShopPhone', { phone: shop.shopPhone }) : ''}</p>
        <h1 className="pos-print-title">{title}</h1>
      </header>
      <div className="pos-print-body">{children}</div>
      <footer className="pos-print-foot">
        <span>{say('printPage', { page, pages })}</span>
        <span>{say('printedAt', { time: printedAt })}</span>
      </footer>
    </section>
  );
}

/** 칸 폭(원하는 폭 em의 비율). */
const colWidths = (columns: readonly LedgerColumnRow[]) => {
  const total = columns.reduce((n, c) => n + c.preferred_width_em, 0) || 1;
  return columns.map((c) => (100 * c.preferred_width_em) / total + '%');
};

export interface CollectionPrintProps {
  result: LedgerViewResult;
  view: ResolvedLedgerView;
  /** 이 쪽만 그린다(화면 주소 #/print/…?page=2, 1부터). 없으면 모든 쪽(인쇄). */
  only?: number;
}

/** A4 수거 목록(인쇄 판). */
export function CollectionPrint({ result, view, only }: CollectionPrintProps) {
  const { profile, timezone } = useUi();
  const geo = printGeometry(profile);
  const title = fillTitle(say('printCollections', { date: '{date}', vehicle: '{vehicle}' }), result.titleValues);
  const pages = printPages(result.rows.map(() => geo.rowPx), geo.bodyPx - geo.tableHeadPx);
  const shop = result.printHead ?? { shopName: '', shopPhone: '' };
  const printedAt = formatTime(result.serverTime, timezone);
  const widths = colWidths(view.columns);
  return (
    <>
      {pages.map((p, i) => (only !== undefined && only !== i + 1 ? null : (
        <PageFrame key={i} title={p.continued ? say('printContinued', { title }) : title} shop={shop} page={i + 1} pages={pages.length} printedAt={printedAt}>
          {result.rows.length === 0 ? <p className="pos-print-empty">{say('printEmpty')}</p> : (
            <table className="pos-print-table">
              <colgroup>{widths.map((w, j) => <col key={j} style={{ width: w }} />)}</colgroup>
              <thead><tr>{view.columns.map((c) => <th key={c.column_key} scope="col">{c.header_label}</th>)}</tr></thead>
              <tbody>
                {result.rows.slice(p.from, p.to).map((row) => (
                  <tr key={row.id}>{view.columns.map((c) => <td key={c.column_key}><Cell cell={row.cells[c.column_key]} /></td>)}</tr>
                ))}
              </tbody>
            </table>
          )}
        </PageFrame>
      )))}
    </>
  );
}

export interface SlipPrintProps {
  slip: OrderSlip;
  view: ResolvedLedgerView;
  only?: number;
}

/** A4 대여 접수증(인쇄 판): 칸 · 품목 표 · 출처 줄 · 돈 · 일정. 품목이 한 쪽을 넘으면 다음 쪽 `(계속)`. */
export function SlipPrint({ slip, view, only }: SlipPrintProps) {
  const { profile, timezone } = useUi();
  const geo = printGeometry(profile);
  const title = t('slipTitle') + ' · ' + slip.receiptNo;
  const shop = slip.printHead ?? { shopName: '', shopPhone: '' };
  const printedAt = formatTime(slip.serverTime, timezone);
  // 첫 쪽: 칸 한 줄 · 돈 한 줄 · 일정 두 줄을 먼저 뺀 자리에 품목 · 출처 줄. 그다음 쪽은 품목만.
  const fixed = 4 * geo.rowPx + profile.space.m;
  const items = [...slip.lines.map(() => geo.rowPx), ...(slip.adjustments ?? []).map(() => geo.rowPx)];
  const pages = printPages(items, geo.bodyPx - geo.tableHeadPx, geo.bodyPx - geo.tableHeadPx - fixed);
  const rows: { key: string; cells: ReactNode[] }[] = [
    ...slip.lines.map((l) => ({
      key: l.id,
      cells: view.columns.map((c) => {
        const cell = l.cells[c.column_key];
        if (cell?.renderer === 'money') return <TextFit key={c.column_key} input={{ mode: 'alts', alts: cell.alts }} />;
        return <Cell key={c.column_key} cell={cell} />;
      }),
    })),
    ...(slip.adjustments ?? []).map((a) => ({
      key: a.key,
      cells: [
        <TextFit key="text" input={{ mode: 'parts', parts: a.parts }} />,
        null,
        a.amount !== undefined ? <TextFit key="amount" input={{ mode: 'words', text: formatWon(a.amount) }} /> : null,
      ],
    })),
  ];
  const widths = colWidths(view.columns);
  const money = [t('charged', { amount: formatWon(slip.money.charged) }), t('paid', { amount: formatWon(slip.money.paid) }), t('due', { amount: formatWon(slip.money.due) })].join(' · ');
  return (
    <>
      {pages.map((p, i) => (only !== undefined && only !== i + 1 ? null : (
        <PageFrame key={i} title={p.continued ? say('printContinued', { title }) : title} shop={shop} page={i + 1} pages={pages.length} printedAt={printedAt}>
          {i === 0 ? (
            <p className="pos-print-line">
              <TextFit input={{ mode: 'parts', parts: slip.fields.map((f) => ({ text: f.label + ' ' + f.value, drop: f.drop })) }} />
            </p>
          ) : null}
          <table className="pos-print-table">
            <colgroup>{widths.map((w, j) => <col key={j} style={{ width: w }} />)}</colgroup>
            <thead><tr>{view.columns.map((c, j) => <th key={c.column_key} scope="col" className={j > 0 ? 'align-end' : undefined}>{c.header_label}</th>)}</tr></thead>
            <tbody>
              {rows.slice(p.from, p.to).map((row) => (
                <tr key={row.key}>{row.cells.slice(0, view.columns.length).map((cell, j) => <td key={j} className={j > 0 ? 'align-end' : undefined}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {i === 0 ? (
            <>
              <p className="pos-print-line is-strong"><TextFit input={{ mode: 'words', text: money }} /></p>
              {slip.promises.lines.map((line) => (
                <p key={line.kind} className="pos-print-line">
                  <TextFit input={{ mode: 'parts', parts: [{ text: t(line.kind === 'pickup' ? 'pickup' : 'giveBack') + ' ' + line.when, drop: 0 }, ...line.parts] }} />
                </p>
              ))}
            </>
          ) : null}
        </PageFrame>
      )))}
    </>
  );
}
