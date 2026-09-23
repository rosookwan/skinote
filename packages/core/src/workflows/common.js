(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../returns/domain.js'));
  else root.SkiWorkflowCommon = factory(root.SkiReturns);
})(globalThis, function (R) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const fail = (code, message) => { throw new R.ReturnError(code, message); };
  function keys(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_INPUT', '입력 항목을 확인해 주세요.');
    return value;
  }
  function id(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) fail('INVALID_INPUT', '관리번호를 확인해 주세요.');
    return value;
  }
  function string(value, max = 160, optional = false) {
    if (optional && (value == null || value === '')) return '';
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail('INVALID_INPUT', '입력 내용을 확인해 주세요.');
    return value.trim();
  }
  function integer(value, min = 0, max = 10000) {
    if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INPUT', '수량이나 버전을 확인해 주세요.');
    return value;
  }
  function oneOf(value, choices) {
    if (!choices.includes(value)) fail('INVALID_INPUT', '선택 항목을 확인해 주세요.');
    return value;
  }
  function list(value, max = 500, empty = false) {
    if (!Array.isArray(value) || (!empty && !value.length) || value.length > max) fail('INVALID_INPUT', '목록의 개수를 확인해 주세요.');
    return value;
  }
  function ids(value) {
    const result = list(value).map(id);
    if (new Set(result).size !== result.length) fail('INVALID_INPUT', '같은 항목을 두 번 선택했습니다.');
    return result;
  }
  function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail('INVALID_INPUT', '날짜를 확인해 주세요.');
    return value;
  }
  function time(value) {
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('INVALID_INPUT', '시간을 확인해 주세요.');
    return value;
  }
  function instant(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail('INVALID_INPUT', '시간대가 포함된 시각을 확인해 주세요.');
    date(value.slice(0, 10)); time(value.slice(11, 16));
    return new Date(value).toISOString();
  }
  const day = at => new Date(Date.parse(instant(at)) + 9 * 3600000).toISOString().slice(0, 10);
  const nextDate = value => new Date(Date.parse(date(value)) + 86400000).toISOString().slice(0, 10);
  function customer(value) {
    keys(value, ['name', 'phone']);
    const phone = string(value.phone, 24);
    if (!/^\+?[0-9 ()-]{7,24}$/.test(phone) || phone.replace(/\D/g, '').length < 7) fail('INVALID_INPUT', '연락처를 확인해 주세요.');
    return { name: string(value.name, 60), phone };
  }
  function find(rows, value, label = '항목') {
    const row = rows.find(row => row.id === id(value));
    if (!row) fail('NOT_FOUND', label + '을 찾을 수 없습니다.');
    return row;
  }
  function store(context) { if (context.actor.role !== 'store') fail('FORBIDDEN', '매장에서 처리해 주세요.'); }
  function vehicle(context, vehicleId) {
    id(vehicleId);
    if (context.actor.role === 'driver' && context.actor.vehicleId !== vehicleId) fail('FORBIDDEN', '담당 차량의 업무만 처리할 수 있습니다.');
  }
  function context(value, guest = false) {
    id(value?.shopId); id(value?.actor?.id);
    oneOf(value.actor.role, guest ? ['store', 'driver', 'customer'] : ['store', 'driver']);
    if (value.actor.role === 'driver') id(value.actor.vehicleId);
    if (value.actor.role === 'customer') id(value.formId);
    return value;
  }
  return { copy, fail, keys, id, string, integer, oneOf, list, ids, date, time, instant, day, nextDate, customer, find, store, vehicle, context, canonical: R.canonical };
});
