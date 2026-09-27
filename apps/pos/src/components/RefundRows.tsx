// 환불 줄 자리(할인 · 취소 · 초과 수납 환불 창 공용, features-1 E4b): 두 줄 자리를 늘 남기고, 환불이 셋 이상이면 그 자리 안에서 쪽을 넘긴다
// (`‹ 1 / 2쪽 ›`, 오른쪽). 모든 환불 줄이 금액과 수단 버튼을 가진다 — 예전의 `외 {n}건 · 같은 수단`은 가장 큰 환불을 금액 · 수단 없이 숨겼다(2026-09-27
// 점검). 줄의 차례(금액이 큰 것부터)와 글은 읽기 모델이 준다. 화면은 쪽 수만 센다.
import type { RefundLineView } from '@skinote/contract';
import { ChoiceRow, Pager, TextFit } from '@skinote/ui';
import { useState } from 'react';
import { say } from '../app/strings.ts';

/** 환불 줄 자리(두 줄). */
export const REFUND_LINE_ROWS = 2;

/** 환불 줄의 쪽(두 줄씩). */
export function refundPages<T>(lines: readonly T[], rows = REFUND_LINE_ROWS): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < lines.length; i += rows) pages.push(lines.slice(i, i + rows));
  return pages.length ? pages : [[]];
}

export interface RefundRowsProps {
  lines: readonly RefundLineView[];
  /** 환불 줄의 수단을 바꿈(그 수납의 수단 · 현금). */
  onMethod: (paymentId: string, methodKey: string) => void;
}

export function RefundRows({ lines, onMethod }: RefundRowsProps) {
  const [page, setPage] = useState(0);
  const pages = refundPages(lines);
  const current = Math.min(page, pages.length - 1);
  const shown = pages[current] ?? [];
  const paged = pages.length > 1;
  return (
    <div className={'pos-discount-refunds' + (paged ? ' is-paged' : '')} aria-label={say('refundRow')}>
      {Array.from({ length: REFUND_LINE_ROWS }, (_, i) => shown[i] ?? null).map((line, i) => (
        <div key={i} className={'pos-discount-refund' + (line ? '' : ' is-blank')} {...(line ? {} : { 'aria-hidden': true })}>
          {line ? (
            <>
              <TextFit className="pos-discount-refund-text" input={{ mode: 'parts', parts: line.parts }} />
              {line.methods.length > 1 ? (
                <ChoiceRow options={line.methods} label={say('refundRow')} onPress={(key) => onMethod(line.paymentId, key)} />
              ) : null}
            </>
          ) : null}
        </div>
      ))}
      {paged ? (
        <div className="pos-discount-refund-pager">
          <Pager page={current} pageCount={pages.length} onChange={setPage} label={say('refundRow')} />
        </div>
      ) : null}
    </div>
  );
}
