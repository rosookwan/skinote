const { createMemoryRepository } = require('../src/returns/service.js');
const { createService, publicRequest } = require('../src/workflows/service.js');
const { newIntakeCommand, newCommand } = require('../src/workflows/client.js');
const ctx = { shopId: 'shop-1', actor: { id: 'counter-1', role: 'store' } };
const driverCtx = { shopId: 'shop-1', actor: { id: 'driver-1', role: 'driver', vehicleId: 'van-1' } };
const customer = { name: '홍길동', phone: '010-1111-2222' };
const ticket = { validFrom: '2026-09-09T00:00:00+09:00', validTo: '2026-09-11T00:00:00+09:00', acceptedTypes: ['ticket-3h', 'ticket-4h', 'ticket-6h'], transferable: true, vendorId: 'resort-1' };
const shop = { kind: 'shop', id: 'shop-1' }, van = { kind: 'vehicle', id: 'van-1' };
const person = (i = 1) => ({ id: 'person-' + i, name: '일행' + i, equipment: i % 2 ? 'ski' : 'board', heightCm: 170, footMm: 260, clothing: false, clothingSize: '', helmet: true });
const errorCode = code => error => error.code === code;
function fixture(repository = createMemoryRepository(), adapters = {}) {
  let at = '2026-09-09T00:00:00.000Z', sequence = 0;
  const clock = () => at, store = createService(repository, ctx, clock, adapters), driver = createService(repository, driverCtx, clock);
  const call = (type, payload, who = store, requestId = 'test-' + ++sequence) => who.execute({ type, payload, expectedVersion: store.snapshot().revision, requestId });
  const book = (id, lines = [{ id: 'line-1', useDate: '2026-09-09', ticketType: 'ticket-6h', quantity: 1 }]) => call('reservation.create', { id, customer, lines });
  const issue = (quantity, extra = {}) => call('ticket.issue', { sku: 'ticket-6h', quantity, ticket, ...extra }).assetIds;
  const move = (kind, assetIds, from, to, extra = {}, who = store) => call('stock.move', { kind, assetIds, from, to, ...extra }, who);
  const task = (id, kind, customerId, assetIds = [], time = '09:00') => call('task.save', { id, kind, customerId, assetIds, vehicleId: 'van-1', date: '2026-09-09', time, place: '스키장 입구', title: id });
  async function form(id = 'form-1', count = 1) {
    const { command, accessToken } = await newIntakeCommand(store.snapshot(), { id, customer, expectedPeople: count, date: '2026-09-09', expiresAt: '2026-09-12T00:00:00.000Z', delivery: { date: '2026-09-09', time: '09:00', place: '스키장', vehicleId: 'van-1' } });
    store.execute(command);
    const access = { shopId: ctx.shopId, formId: id, accessToken };
    const submit = (people, version = 0, status = 'submitted') => publicRequest(repository, access, newCommand('intake.submit', version, { id, people, status }), clock);
    return { access, accessToken, submit, get: () => publicRequest(repository, access, null, clock) };
  }
  return { repository, store, driver, clock, setTime: value => { at = value; }, call, book, issue, move, task, form };
}
module.exports = { fixture, ctx, driverCtx, customer, ticket, shop, van, person, errorCode };
