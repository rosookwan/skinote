// 인쇄 뿌리(features-1 §8-3, E16): 카운터 `수거 목록`의 `인쇄`와 접수증 옆 동작 `인쇄`. 인쇄 판 읽기 모델을 받아 A4 문서(PrintDocument)를 body 바로
// 아래 뿌리(.pos-print-host)에 그리고 브라우저 인쇄 창(window.print)을 연다. 화면에서는 뿌리가 보이지 않고, 인쇄할 때는 그것만 보인다(app.css의
// @media print). 인쇄 작업(print_jobs)은 적지 않는다(§0-2): 서버는 인쇄 판 수거 목록을 읽을 때 개인정보 열람 기록(list_print)을 남긴다.
// 같은 문서를 연결하지 않은 주소 #/print/collections/:date · #/print/orders/:orderId(PrintScreen)에 화면으로도 그린다: 규칙 검사기가 인쇄 등급(A4)으로
// 잰다(쪽 하나씩, ?page=2).
import {
  resolveLedgerView, visibleView, type LedgerViewResult, type OrderSlip, type ResolvedLedgerView,
} from '@skinote/contract';
import { DeviceProfileProvider } from '@skinote/ui';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useClient, useConfig } from '../app/client.tsx';
import { say } from '../app/strings.ts';
import { A4, CollectionPrint, SlipPrint } from './PrintDocument.tsx';

/** 인쇄할 것: 그날 · 차량의 수거 목록, 또는 접수 하나의 대여 접수증. */
export type PrintJob = { kind: 'collection'; date: string | null; vehicleId: string | null } | { kind: 'slip'; orderId: string };

type Loaded = { kind: 'collection'; result: LedgerViewResult; view: ResolvedLedgerView } | { kind: 'slip'; slip: OrderSlip; view: ResolvedLedgerView };

/** 인쇄 판 읽기 모델과 화면 설정(인쇄 판 칸)을 받는다. 못 받으면 failed. */
function usePrintData(job: PrintJob): { data: Loaded | null; failed: boolean } {
  const client = useClient();
  const config = useConfig();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const key = JSON.stringify(job);
  useEffect(() => {
    if (!config) return;
    let alive = true;
    const resolved = resolveLedgerView(config.ledgerViews, job.kind === 'collection' ? 'collection_list' : 'order_slip', 'print');
    const view = resolved ? visibleView(resolved, config.features) : null;
    if (!view) { setFailed(true); return; }
    const load: Promise<Loaded> = job.kind === 'collection'
      ? client.ledgerView('collection_list', { ...(job.date ? { date: job.date } : {}), ...(job.vehicleId ? { vehicleId: job.vehicleId } : {}), deviceClass: 'print' })
        .then((result) => ({ kind: 'collection' as const, result, view }))
      : client.query('orderSlip', { orderId: job.orderId, deviceClass: 'print' }).then((slip) => ({ kind: 'slip' as const, slip, view }));
    load.then((next) => { if (alive) setData(next); }, () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [client, config, key]);
  return { data, failed };
}

function Document({ data, only }: { data: Loaded; only?: number }) {
  const page = only !== undefined ? { only } : {};
  return data.kind === 'collection' ? <CollectionPrint result={data.result} view={data.view} {...page} /> : <SlipPrint slip={data.slip} view={data.view} {...page} />;
}

export interface PrintHostProps {
  job: PrintJob;
  /** 인쇄 창을 닫았다(인쇄했든 취소했든). */
  onDone: () => void;
  /** 문서를 받지 못함: 부르는 쪽이 한 줄 알림. */
  onFail: (line: string) => void;
}

/** 보이지 않는 인쇄 문서를 붙이고 인쇄 창을 연다. */
export function PrintHost({ job, onDone, onFail }: PrintHostProps) {
  const config = useConfig();
  const { data, failed } = usePrintData(job);
  useEffect(() => { if (failed) onFail(say('printUnreadable')); }, [failed]);
  useEffect(() => {
    if (!data) return;
    // 문서를 그린 다음 틀에 인쇄 창(글꼴을 읽은 뒤): 인쇄 창은 닫힐 때까지 멈춘다.
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      try { window.print(); } finally { onDone(); }
    };
    const frame = requestAnimationFrame(() => { void document.fonts.ready.then(run); });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [data]);
  if (!data) return null;
  return createPortal(
    <div className="pos-print-host" data-print-job={job.kind}>
      <DeviceProfileProvider role="counter" timezone={config?.timezone ?? 'Asia/Seoul'} deviceClass="print" size={{ width: A4.width, height: A4.height }}>
        <Document data={data} />
      </DeviceProfileProvider>
    </div>,
    document.body,
  );
}

/** 인쇄 문서를 화면에(연결하지 않은 주소, 규칙 검사기가 A4 인쇄 등급으로 잰다). 쪽 하나씩(page 1부터). */
export function PrintScreen({ job, page }: { job: PrintJob; page: number }) {
  const config = useConfig();
  const { data, failed } = usePrintData(job);
  return (
    <DeviceProfileProvider role="counter" timezone={config?.timezone ?? 'Asia/Seoul'} deviceClass="print" size={{ width: A4.width, height: A4.height }} className="pos-print-screen">
      {failed ? <p className="pos-print-empty" role="status">{say('printUnreadable')}</p> : null}
      {data ? <div className="pos-print-one" data-page={page}><Document data={data} only={page} /></div> : null}
    </DeviceProfileProvider>
  );
}
