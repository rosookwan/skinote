// 긴급 요청은 작업 완료와 별개이며 실제 차량 범위로 보존한다.
import { describe, expect, it } from 'vitest';
import { openPins, pinTask, vehicleScope, pendingIssue, ledgerView, runQuery, overlayQueue, orderTasks } from '../src/index.ts';
import { at, first, online, envelopeOf, ctx, moveToVan } from './offline-helpers.ts';
import { applyCommand } from '../src/commands.ts';

const make = () => { const s = first(); s.pins = []; return s; };
const now = at(16, 0);
const tasks = (s: ReturnType<typeof first>) => s.orders.filter(o => o.giveBack.mode === 'vehicle' && o.lines.some(l => l.issued > l.collected + l.returned)).slice(0, 3).map(o => 'collect:' + o.id);

describe('긴급 요청의 다건 · 해제 · 담당 범위', () => {
  it('세 요청은 모두 남고 확인은 완료를 만들지 않으며 미확인이 먼저다', () => {
    const s = make(); const ids = tasks(s); expect(ids).toHaveLength(3);
    ids.forEach((taskId, i) => expect(online(s, {type:'task.pin',payload:{taskId}}, now+i).outcome).toBe('applied'));
    const before = structuredClone(s.orders);
    const firstPin = openPins(s)[0]!;
    expect(online(s,{type:'notification.ack',payload:{notificationId:firstPin.id}},now+5).outcome).toBe('applied');
    expect(openPins(s)).toHaveLength(3);
    expect(openPins(s).at(-1)!.id).toBe(firstPin.id);
    expect(s.orders).toEqual(before);
  });
  it('같은 봉투와 다른 요청번호의 중복 탭이 새 긴급을 만들지 않는다', () => {
    const s=make(); const taskId=tasks(s)[0]!;
    const e=envelopeOf(s,{type:'task.pin',payload:{taskId}});
    applyCommand(s,e,now); applyCommand(s,e,now+1);
    expect(online(s,{type:'task.pin',payload:{taskId}},now+2).outcome).toBe('superseded');
    expect(openPins(s)).toHaveLength(1); expect(s.pins[0]!.id).toBe(e.requestId);
  });
  it('해제 후 늦은 확인은 다시 살리지 않고 새 요청은 별도 번호다', () => {
    const s=make(); const taskId=tasks(s)[0]!; online(s,{type:'task.pin',payload:{taskId}},now);
    const pin=s.pins[0]!; online(s,{type:'task.unpin',payload:{pinId:pin.id}},now+1);
    expect(online(s,{type:'notification.ack',payload:{notificationId:pin.id}},now+2).outcome).toBe('superseded');
    expect(openPins(s)).toHaveLength(0); expect(pin.status).toBe('requested');
    online(s,{type:'task.pin',payload:{taskId}},now+3);
    expect(openPins(s)).toHaveLength(1); expect(openPins(s)[0]!.id).not.toBe(pin.id);
  });
  it('배달도 기존 긴급을 쓰며 아직 지급하지 않은 장비는 그대로다', () => {
    const s=make(); const o=s.orders.find(o=>o.pickup.mode==='vehicle' && pendingIssue(o))!;
    expect(o).toBeDefined(); const taskId='deliver:'+o.id;
    expect(online(s,{type:'task.pin',payload:{taskId}},now).outcome).toBe('applied');
    expect(pinTask(s,s.pins[0]!)?.id).toBe(taskId); expect(pendingIssue(o)).toBe(true);
    expect(vehicleScope(s,o.pickup.vehicleId!).pins).toHaveLength(1);
    expect(vehicleScope(s,o.pickup.vehicleId==='v1'?'v2':'v1').pins).toHaveLength(0);
  });
  it('배달 긴급은 같은 차량의 양쪽 목록에 보이고 다른 차량에는 없다', () => {
    const s=make(); const o=s.orders.find(o=>o.pickup.mode==='vehicle' && pendingIssue(o))!;
    online(s,{type:'task.pin',payload:{taskId:'deliver:'+o.id}},now);
    for(const viewKey of ['collection_list','delivery_list']) {
      const view=ledgerView(s,viewKey,{vehicleId:o.pickup.vehicleId!,deviceClass:'driver_tablet'},ctx(now));
      expect(view.pins?.map(p=>p.taskId)).toEqual(['deliver:'+o.id]);
    }
    const slip=runQuery(s,'orderSlip',{orderId:o.id},ctx(now));
    expect(slip.urgentTasks?.some(t=>t.taskId==='deliver:'+o.id && t.pin)).toBe(true);
  });
  it('오프라인 확인은 전송 대기로 읽고 서버의 확인 상태를 바꾸지 않는다', () => {
    const s=make(); const taskId=tasks(s)[0]!;online(s,{type:'task.pin',payload:{taskId}},now);
    const pin=s.pins[0]!; const ack=envelopeOf(s,{type:'notification.ack',payload:{notificationId:pin.id}},{deviceSeq:1});
    const over=overlayQueue(s,[{envelope:ack,at:now+1,state:'queued'}]);
    expect(s.pins[0]!.status).toBe('requested');
    const view=runQuery(over.state,'reviewList',{},ctx(now+1));
    expect(view.pins?.[0]?.pendingAck).toBe(true);
    expect(view.pins?.[0]?.status).toBe('acknowledged');
    applyCommand(s,ack,now+2);expect(s.pins[0]!.pendingAck).toBeUndefined();
  });
  it('차량 재배정은 옛 긴급을 새 기사에게 넘기지 않고 다시 요청하면 새 담당만 받는다', () => {
    const s=make(); const orderId='o25'; const taskId='collect:'+orderId;
    online(s,{type:'task.pin',payload:{taskId}},now); const old=s.pins[0]!;
    moveToVan(s,orderId,'v2',now+1); expect(openPins(s)).toHaveLength(0);
    expect(online(s,{type:'notification.ack',payload:{notificationId:old.id}},now+2).outcome).toBe('superseded');
    const movedTask=orderTasks(s.orders.find(o=>o.id===orderId)!).find(t=>t.promise.vehicleId==='v2')!;
    expect(movedTask).toBeDefined();
    expect(online(s,{type:'task.pin',payload:{taskId:movedTask.id}},now+3).outcome).toBe('applied');
    expect(openPins(s)).toHaveLength(1);expect(openPins(s)[0]!.vehicleId).toBe('v2');
    expect(openPins(s).some(p=>p.id===old.id)).toBe(false);expect(openPins(vehicleScope(s,'v1'))).toHaveLength(0);
  });
  it('부분 수거는 긴급에 남고 전부 수거해도 매장 입고를 대신하지 않는다', () => {
    const s=make();const taskId=tasks(s)[0]!;online(s,{type:'task.pin',payload:{taskId}},now);
    const o=pinTask(s,s.pins[0]!)!.order;const line=o.lines.find(l=>l.issued-l.collected-l.returned>1)!;expect(line).toBeDefined();
    online(s,{type:'stock.collect',payload:{taskId,lines:[{lineId:line.id,quantity:1}]}},now+1);
    expect(openPins(s)).toHaveLength(1);
    online(s,{type:'stock.collect',payload:{taskId,lines:o.lines.filter(l=>l.returnable).map(l=>({lineId:l.id,quantity:l.issued-l.collected-l.returned})).filter(l=>l.quantity>0)}},now+2);
    expect(openPins(s)).toHaveLength(0);expect(line.collected).toBeGreaterThan(line.received);
  });
  it('없는 명시 업무를 같은 팀의 다른 업무로 바꾸지 않는다', () => {
    const s=make(); const id=tasks(s)[0]!;
    expect(pinTask(s,{id:'bad',orderId:id.split(':')[1]!,taskId:id+':missing',at:now,status:'requested'})).toBeUndefined();
  });
});
