const R = require('../src/returns/domain.js');
const ctx = { shopId: 'shop-1', actor: { id: 'staff-1', role: 'store' }, at: '2026-09-07T08:00:00.000Z' };
const sample = () => ({ customer: { id: 'customer-1', name: '가상 고객' }, rental: { startDate: '2026-09-07', endDate: '2026-09-08', amountWon: 120000 }, vehicleId: 'van-1', items: [
  { id: 'ski', label: '스키', category: 'equipment', plannedQuantity: 2, usage: [{ date: '2026-09-07', quantity: 2 }, { date: '2026-09-08', quantity: 2 }] },
  { id: 'clothes', label: '의류', category: 'clothing', plannedQuantity: 2 },
  { id: 'ticket', label: '리프트권', category: 'liftTicket', plannedQuantity: 2 }
] });
let sequence = 0;
function run(order, type, payload, overrides = {}, context = ctx) {
  return R.execute(order, { type, payload, orderId: order?.id ?? 'order-1', expectedVersion: order?.version ?? 0, requestId: 'request-' + (++sequence), ...overrides }, context);
}
function create(input = sample()) { return run(null, 'create', input).order; }
function issued(input = sample()) {
  const order = create(input);
  return run(order, 'issue', { items: order.items.map(item => ({ itemId: item.id, quantity: item.plannedQuantity, returnQuantity: item.plannedReturnQuantity })) }).order;
}
const errorCode = code => error => error.code === code;

module.exports = { R, ctx, sample, run, create, issued, errorCode };
