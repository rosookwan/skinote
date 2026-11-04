// 실제 저장소에서 요청·확인·해제와 재열기를 확인한다. 운영 DB를 쓰지 않는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDay } from '@skinote/domain/sample';
import { openPins, pendingIssue } from '@skinote/domain';
import { COUNTER, envelope, provisioned, T0, rowCounts } from './helpers.ts';

test('배달 긴급의 같은 요청 · 확인 · 해제가 저장 후에도 보존된다', () => {
 const {db,store,reopen}=provisioned();
 try {
  const empty=store.state(T0); const day=sampleDay({date:'2026-12-26',epoch:empty.epoch,ids:'demo'});
  store.importDay({date:'2026-12-26',orders:day.orders,pins:[],deposits:day.deposits,paymentGroups:day.paymentGroups},'import:urgent',T0,COUNTER);
  let s=store.state(T0); const o=s.orders.find(o=>o.pickup.mode==='vehicle'&&pendingIssue(o))!;
  const request=envelope('task.pin',{taskId:'deliver:'+o.id},s);
  assert.equal(store.command(request,COUNTER,T0+1).outcome,'applied');
  const counts=rowCounts(db); store.command(request,COUNTER,T0+2); assert.deepEqual(rowCounts(db),counts);
  s=reopen().state(T0+2); const p=openPins(s)[0]!; assert.equal(p.id,request.requestId); assert.equal(p.requestedAt,T0+1); assert.equal(p.vehicleId,o.pickup.vehicleId);
  assert.equal(store.command(envelope('notification.ack',{notificationId:p.id},s),COUNTER,T0+3).outcome,'applied');
  s=reopen().state(T0+3); assert.equal(openPins(s)[0]!.status,'acknowledged'); assert.equal(pendingIssue(s.orders.find(x=>x.id===o.id)!),true);
  assert.equal(store.command(envelope('task.unpin',{pinId:p.id},s),COUNTER,T0+4).outcome,'applied');
  s=reopen().state(T0+4); assert.equal(openPins(s).length,0); assert.equal(s.pins[0]!.releasedAt,T0+4);
  assert.equal(store.command(envelope('notification.ack',{notificationId:p.id},s),COUNTER,T0+5).outcome,'superseded');
 } finally {db.close();}
});
