const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { createMemoryRepository, createService } = require('../src/returns/service.js');
const { seedOperations } = require('../src/returns/demo.js');
const Demo = require('../src/workflows/demo.js');
const { fixture, person, shop, van, errorCode } = require('./workflows-fixtures.cjs');
async function demo() {
  const context = vm.createContext({ window: {}, Intl, Date }); vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, 'fixtures/legacy-demo-data.js'), 'utf8'), context);
  const data = context.window.SkiOpsData, repository = createMemoryRepository();
  const store = createService(repository, { shopId: 'demo-shop', actor: { id: 'demo-store', role: 'store' } });
  const driver = createService(repository, { shopId: 'demo-shop', actor: { id: 'demo-driver', role: 'driver', vehicleId: 'demo-van-1' } });
  seedOperations(store, driver, data.orders); const f = Demo.create(repository, data.today); await f.seed(store.sync().orders); return { f, data, store, repository };
}
test('migrated legacy orders and new vehicle ledger share custody without double counting', async () => {
  const { f } = await demo(); const before = f.snap().revision; f.importOrder(f.orders.get('R-024'), true); assert.equal(f.snap().revision, before);
  assert.equal(f.store.vehicle({vehicleId:f.vehicleId}).totals.find(s=>s.sku==='ski').current,1);
  const task = f.snap().tasks.find(t=>t.orderId==='R-021'&&t.status==='waiting'), selected=f.assets(task.assetIds).find(a=>a.sku==='ski').id;
  f.run('stock.move',{kind:'collect',assetIds:[selected],from:{kind:'customer',id:'R-021'},to:f.van,taskId:task.id},'driver');
  assert.equal(f.projectOrder('R-021').totals.customerQuantity,4); assert.equal(f.projectOrder('R-021').totals.vehicleQuantity,1);
  assert.equal(f.store.vehicle({vehicleId:f.vehicleId}).totals.find(s=>s.sku==='ski').current,2);
  f.run('stock.move',{kind:'receive',assetIds:[selected],from:f.van,to:f.shop});
  assert.equal(f.projectOrder('R-021').totals.shopQuantity,1); assert.equal(f.store.vehicle({vehicleId:f.vehicleId}).totals.find(s=>s.sku==='ski').current,1);
});
test('legacy unissued gear can be loaded once, delivered, then appears issued in rental detail', async () => {
  const {f,data}=await demo(); f.dispatchOrder('R-022',{date:data.today,time:'16:40',place:'설천 주차장'});
  assert.equal(f.projectOrder('R-022').items.filter(i=>i.category!=='liftTicket').reduce((n,i)=>n+i.issuedQuantity,0),0);
  assert.throws(()=>f.dispatchOrder('R-022',{date:data.today,time:'16:40',place:'설천 주차장'}));
  const t=f.snap().tasks.find(t=>t.orderId==='R-022'&&t.kind==='delivery');
  f.run('stock.move',{kind:'deliver',from:f.van,to:{kind:'customer',id:'R-022'},taskId:t.id,assetIds:t.assetIds},'driver');
  assert.equal(f.projectOrder('R-022').totals.customerQuantity,3);
  assert.equal(f.projectOrder('R-022').totals.unissuedQuantity,1);
});
test('legacy ticket actual SKU and quantities are recorded atomically with its reservation', async () => {
  const {f,data}=await demo(); const before=f.snap().revision;
  assert.throws(()=>f.issueLegacyTicket('R-026','lift-afternoon',{sku:'ticket-4h',quantity:5,ticket:f.ticket(data.today,'ticket-4h','09:00','13:00')}));
  assert.equal(f.snap().revision,before);
  f.issueLegacyTicket('R-026','lift-afternoon',{sku:'ticket-4h',quantity:2,ticket:f.ticket(data.today,'ticket-4h','09:00','13:00')});
  assert.equal(f.projectOrder('R-026').totals.customerQuantity,2); assert.equal(f.projectOrder('R-026').totals.unissuedQuantity,2);
});
test('form dispatch is atomic; partial equipment delivery records a person only when all their pieces arrive', async()=>{
  const f=fixture(), form=await f.form('dispatch',1); await form.submit([person()]);
  f.call('intake.review',{id:'dispatch',submissionVersion:1}); f.call('intake.prepare',{id:'dispatch',reviewVersion:1,personIds:['person-1']});
  const ids=[...f.call('stock.receive',{sku:'ski',quantity:1}).assetIds,...f.call('stock.receive',{sku:'helmet',quantity:1}).assetIds];
  const payload={id:'dispatch',reviewVersion:1,people:[{personId:'person-1',assetIds:ids}],vehicleId:'van-1',taskId:'task',date:'2026-09-09',time:'10:00',place:'광장'};
  const before=f.store.snapshot().revision; assert.throws(()=>f.call('intake.dispatch',{...payload,time:'25:00'})); assert.equal(f.store.snapshot().revision,before); assert.equal(f.driver.vehicle().equipmentCount,0);
  f.call('intake.dispatch',payload); assert.equal(f.driver.vehicle().equipmentCount,1); assert.equal(f.store.intake('dispatch').issuedPeople,0);
  assert.throws(()=>f.call('task.status',{id:'task',status:'cancelled'}),errorCode('NO_CHANGE'));
  assert.throws(()=>f.call('intake.dispatch',{...payload,taskId:'duplicate'}),errorCode('NO_CHANGE'));
  f.move('deliver',[ids[0]],van,{kind:'customer',id:'dispatch'},{taskId:'task'},f.driver); assert.equal(f.store.intake('dispatch').issuedPeople,0);
  f.move('deliver',[ids[1]],van,{kind:'customer',id:'dispatch'},{taskId:'task'},f.driver); assert.equal(f.store.intake('dispatch').issuedPeople,1);
});
test('changing an allocated reservation time cannot overlap another customer on the same physical ticket',()=>{
  const f=fixture(); f.book('a',[{id:'l',useDate:'2026-09-09',ticketType:'ticket-6h',quantity:1,startTime:'09:00',endTime:'12:00'}]); f.book('b',[{id:'l',useDate:'2026-09-09',ticketType:'ticket-6h',quantity:1,startTime:'12:00',endTime:'15:00'}]);
  const ids=f.issue(1); f.call('ticket.allocate',{reservationId:'a',lineId:'l',assetIds:ids}); f.call('ticket.allocate',{reservationId:'b',lineId:'l',assetIds:ids});
  const rev=f.store.snapshot().revision; assert.throws(()=>f.call('reservation.time',{reservationId:'b',lineId:'l',startTime:'11:00',endTime:'15:00'}),errorCode('TICKET_UNAVAILABLE')); assert.equal(f.store.snapshot().revision,rev);
});
test('direct returns reduce the corresponding remaining collection, and correction restores it', async()=>{
  const {f}=await demo(); const t=f.snap().tasks.find(t=>t.customerId==='R-021'&&t.status==='waiting'); const ids=t.assetIds;
  f.returnCustomer('R-021',[ids[0]]); assert.equal(f.remaining(f.snap().tasks.find(x=>x.id===t.id)).length,ids.length-1);
  f.returnCustomer('R-021',ids.slice(1)); assert.equal(f.snap().tasks.find(x=>x.id===t.id).status,'completed');
  const m=f.store.history().movements.at(-1); f.run('movement.undo',{movementId:m.id,reason:'직접반납 기록 정정'}); assert.equal(f.snap().tasks.find(x=>x.id===t.id).status,'in_progress'); assert.equal(f.remaining(f.snap().tasks.find(x=>x.id===t.id)).length,ids.length-1);
});
test('restoring a cancelled reservation does not resurrect its old allocation',()=>{
  const f=fixture(); f.book('a'); f.book('b'); const ids=f.issue(1); f.call('ticket.allocate',{reservationId:'a',lineId:'line-1',assetIds:ids}); f.call('reservation.cancel',{reservationId:'a',lineId:'line-1',quantity:1}); f.call('ticket.allocate',{reservationId:'b',lineId:'line-1',assetIds:ids}); f.call('reservation.restore',{reservationId:'a',lineId:'line-1',quantity:1});
  const a=f.store.reservations().rows.find(r=>r.reservationId==='a'); assert.equal(a.secured,0); assert.equal(a.needIssue,1);
});

test('new customer returns keep their identity and vehicle custody after the last item is collected', async()=>{
  const {f}=await demo(), id='morning';
  const task=f.snap().tasks.find(t=>t.customerId===id&&t.kind==='collection');
  assert.equal(f.projectOrder(id).totals.customerQuantity,4);
  f.run('stock.move',{kind:'collect',assetIds:task.assetIds,from:{kind:'customer',id},to:f.van,taskId:task.id},'driver');
  assert.equal(f.projectOrder(id).totals.customerQuantity,0); assert.equal(f.projectOrder(id).totals.vehicleQuantity,4); assert.equal(f.projectOrder(id).status,'awaiting_shop');
  f.run('stock.move',{kind:'receive',assetIds:task.assetIds,from:f.van,to:f.shop});
  assert.equal(f.projectOrder(id).totals.vehicleQuantity,0); assert.equal(f.projectOrder(id).totals.shopQuantity,4);
});

async function deliveryOrder(options = {}) {
  const d = await demo(), { f, data, store } = d;
  const id = 'new-delivery', plan = { method: 'delivery', date: data.today, time: '18:00', place: '설천 주차장', vehicleId: 'demo-van-1' };
  const order = store.execute({ type: 'create', orderId: id, requestId: id + '-create', expectedVersion: 0, payload: {
    customer: { id: 'new-customer', name: '분리 배달 고객', phone: '010-0000-9999' }, rental: { startDate: data.today, endDate: data.day(1) }, vehicleId: 'demo-van-1',
    pickupPlan: { equipment: plan, liftTicket: { ...plan, date: data.day(1), time: '12:00', ...options.ticketPlan } },
    returnPlan: { method: 'vehicle', date: data.day(1), time: '18:00', place: '만선 광장' },
    items: [{ id: 'ski', label: '스키', category: 'equipment', plannedQuantity: 2, usage: [{ date: data.today, quantity: 2 }, { date: data.day(1), quantity: 2 }] }, { id: 'lift-ticket', label: '주간권 성인', category: 'liftTicket', plannedQuantity: 2, usage: [{ date: data.day(1), quantity: 2 }] }]
  } }).order;
  const before = f.snap().assets.length; f.importOrder(order);
  return { ...d, id, order, before };
}
test('new delivery intake creates two real planned tasks with dates, zero stock movement and no duplicates', async () => {
  const { f, id, order, before, data, store } = await deliveryOrder();
  const tasks = f.snap().tasks.filter(t => t.orderId === id);
  assert.equal(tasks.length, 2); assert.equal(f.snap().assets.length, before);
  assert.equal(store.get(id).pickupPlan.liftTicket.date, data.day(1));
  assert.equal(tasks.find(t => t.id.endsWith('equipment')).plannedItems[0].quantity, 2, 'usage days must not multiply physical equipment');
  assert.equal(f.store.board({ vehicleId: f.vehicleId, date: data.day(1) }).pending.find(t => t.orderId === id).remainingQuantity, 2);
  const revision = f.snap().revision; f.importOrder(order); assert.equal(f.snap().revision, revision);
  assert.throws(() => f.run('task.status', { id: tasks[0].id, status: 'completed' }), errorCode('QUANTITY_EXCEEDED'));
});
test('customer direct pickup completes only selected equipment and keeps future unissued tickets pending', async () => {
  const { f, id, data } = await deliveryOrder();
  let rows = f.deliveryCandidates(id, 'equipment'); f.completeDelivery(id, 'equipment', [rows[0].id]);
  assert.equal(f.projectOrder(id).items.find(i => i.id === 'ski').customerQuantity, 1);
  assert.equal(f.remainingQuantity(f.deliveryTasks(id, 'equipment')[0]), 1);
  f.completeDelivery(id, 'equipment', f.deliveryCandidates(id, 'equipment').map(a => a.id));
  assert.equal(f.deliveryTasks(id, 'equipment').length, 0);
  const ticket = f.deliveryTasks(id, 'liftTicket')[0]; assert.equal(ticket.date, data.day(1)); assert.equal(f.remainingQuantity(ticket), 2);
  assert.equal(f.store.history().movements.filter(m => m.taskId?.startsWith(id)).every(m => m.from.kind === 'shop' && m.kind === 'deliver'), true);
  const revision = f.snap().revision;
  assert.throws(() => f.completeDelivery(id, 'equipment', [rows[0].id])); assert.equal(f.snap().revision, revision);
  assert.throws(() => f.completeDelivery(id, 'liftTicket', [rows[0].id])); assert.equal(f.snap().revision, revision);
  assert.equal(f.snap().tasks.filter(t => t.orderId === id && t.kind === 'collection').flatMap(t => t.assetIds).length, 2);
});
test('ticket preparation stays in shop; partial loading and delivery leave unissued tickets on both boards', async () => {
  const { f, id, data } = await deliveryOrder(); const values = { sku: 'ticket-4h', quantity: 1, ticket: f.ticket(data.day(1), 'ticket-4h', '12:00', '16:00') };
  f.issueLegacyTicket(id, 'lift-ticket', values);
  let task = f.deliveryTasks(id, 'liftTicket')[0]; const first = task.assetIds[0];
  assert.equal(f.assets([first])[0].location.kind, 'shop'); assert.equal(f.projectOrder(id).items.find(i => i.id === 'lift-ticket').issuedQuantity, 0);
  assert.equal(f.remainingQuantity(task), 2); f.loadDelivery(task.id);
  f.run('stock.move', { kind: 'deliver', from: f.van, to: { kind: 'customer', id }, taskId: task.id, assetIds: [first] }, 'driver');
  task = f.deliveryTasks(id, 'liftTicket')[0]; assert.equal(f.remainingQuantity(task), 1);
  assert.equal(f.store.board({ vehicleId: f.vehicleId, date: data.day(1) }).pending.find(t => t.id === task.id).remainingQuantity, 1);
  assert.throws(() => f.run('task.status', { id: task.id, status: 'completed' }), errorCode('QUANTITY_EXCEEDED'));
  f.issueLegacyTicket(id, 'lift-ticket', values);
  f.completeDelivery(id, 'liftTicket', f.deliveryCandidates(id, 'liftTicket').map(a => a.id));
  assert.equal(f.deliveryTasks(id, 'liftTicket').length, 0); assert.equal(f.remainingQuantity(f.deliveryTasks(id, 'equipment')[0]), 2);
  assert.equal(f.projectOrder(id).items.find(i => i.id === 'lift-ticket').customerQuantity, 2);
  const revision = f.snap().revision; assert.throws(() => f.issueLegacyTicket(id, 'lift-ticket', values)); assert.equal(f.snap().revision, revision);
});
test('separate delivery vehicle is preserved and a different driver cannot process it', async () => {
  const { f, id, data } = await deliveryOrder({ ticketPlan: { vehicleId: 'demo-van-2' } });
  const task = f.deliveryTasks(id, 'liftTicket')[0];
  assert.equal(f.store.board({ vehicleId: 'demo-van-2', date: data.day(1) }).pending.find(t => t.id === task.id).remainingQuantity, 2);
  assert.throws(() => f.run('task.status', { id: task.id, status: 'in_progress' }, 'driver'), errorCode('FORBIDDEN'));
  const revision = f.snap().revision;
  assert.throws(() => f.run('task.allocate', { id: task.id, items: [{ itemId: 'lift-ticket', assetIds: f.deliveryCandidates(id, 'equipment').map(a => a.id) }] }));
  assert.equal(f.snap().revision, revision);
});
test('missing equipment stock cannot hide a delivery request or fabricate loaded stock', async () => {
  const { f, id } = await deliveryOrder();
  const ids = f.snap().assets.filter(a => a.sku === 'ski' && a.location.kind === 'shop').map(a => a.id);
  f.run('stock.move', { kind: 'deliver', from: f.shop, to: { kind: 'customer', id: 'other-customer' }, assetIds: ids });
  const task = f.deliveryTasks(id, 'equipment')[0], revision = f.snap().revision, count = f.snap().assets.length;
  assert.throws(() => f.loadDelivery(task.id)); assert.equal(f.snap().revision, revision); assert.equal(f.snap().assets.length, count);
  assert.equal(f.store.board({ vehicleId: f.vehicleId, date: task.date }).pending.find(t => t.id === task.id).remainingQuantity, 2);
});
