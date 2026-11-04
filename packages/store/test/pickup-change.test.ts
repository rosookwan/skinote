// 픽업 체크만 변경하며 기존 일정·돈·장비를 보호한다. 실제 DB는 쓰지 않는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDay } from '@skinote/domain/sample';
import { COUNTER, envelope, provisioned, T0, rowCounts } from './helpers.ts';

test('기존 접수 픽업 체크: 저장·해제·재전송·다른 카운터 충돌', () => {
  const { db, store, reopen } = provisioned();
  try {
    const base = store.state(T0);
    const day = sampleDay({date:'2026-12-26',epoch:base.epoch,ids:'demo'});
    store.importDay({date:'2026-12-26',orders:day.orders,pins:day.pins,deposits:day.deposits,paymentGroups:day.paymentGroups},'import:pickup',T0,COUNTER);
    let state=store.state(T0); const before=structuredClone(state.orders[0]!); const orderId=before.id;
    const turnOn=envelope('order.customer_pickup',{orderId,enabled:true,expected:false},state);
    const stale=envelope('order.customer_pickup',{orderId,enabled:true,expected:false},state);
    const result=store.command(turnOn,COUNTER,T0+1); assert.equal(result.outcome,'applied',JSON.stringify(result.error));
    const counts=rowCounts(db); assert.deepEqual(store.command(turnOn,COUNTER,T0+2),result); assert.deepEqual(rowCounts(db),counts);
    state=reopen().state(T0+2); const marked=state.orders.find(o=>o.id===orderId)!;
    assert.equal(marked.customerPickup,true); const {customerPickup:_,...rest}=marked; assert.deepEqual(rest,before);
    assert.equal(store.command(envelope('order.customer_pickup',{orderId,enabled:false,expected:true},state),COUNTER,T0+3).outcome,'applied');
    state=reopen().state(T0+3); assert.deepEqual(state.orders.find(o=>o.id===orderId),before);
    assert.equal(store.command(stale,COUNTER,T0+4).outcome,'conflict','켜기·끄기 뒤에도 오래된 기준은 덮어쓰지 않는다');
    assert.deepEqual(reopen().state(T0+4).orders.find(o=>o.id===orderId),before);
  } finally { db.close(); }
});
