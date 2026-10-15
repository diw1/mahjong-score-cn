'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Settlement = require('./paipu-settlement.js');
const names = ['示例甲', '示例乙', '示例丙', '示例丁'];
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, actual + ' != ' + expected);
function fixture() {
  return {
    id: '260101-11111111-1111-4111-8111-111111111111',
    url: 'https://mahjongsoul.game.yo-star.com/?paipu=260101-11111111-1111-4111-8111-111111111111_a12345678',
    players: names.map((name, seat) => ({ id: 'p' + seat, seat, name })), startPoints: 25000,
    rounds: [
      { id: 'win1', label: '第1局赤1', winner: 2, from: 1, zimo: false, aka: 1, ura: 0, ippatsu: false, yakumanUnits: 0 },
      { id: 'win2', label: '一发', winner: 0, zimo: true, aka: 0, ura: 0, ippatsu: true, yakumanUnits: 0 },
      { id: 'win3', label: '赤2', winner: 2, zimo: true, aka: 2, ura: 0, ippatsu: false, yakumanUnits: 0 }
    ],
    result: [25000, -1100, 63900, 12200].map((points, seat) => ({ seat, points }))
  };
}

test('103 reproduces the authorized reference result and its three payout rows', () => {
  // mjget.fun /api/v4summary, mode103, authorized sample, retrieved 2026-10-15.
  // The normalized hand events/points here encode the public reference for unit testing;
  // IDs and names are synthetic. This arithmetic test does not assert end-to-end download success.
  const result = Settlement.calculate(fixture());
  assert.deepEqual(result.entries.map(row => row.basePT), [0, -26.1, 38.9, -12.8]);
  assert.deepEqual(result.entries.map(row => row.chips), [1, -4, 6, -3]);
  assert.deepEqual(result.entries.map(row => row.chipPT), [3, -12, 18, -9]);
  assert.deepEqual(result.entries.map(row => row.money), [30, -381, 569, -218]);
  assert.deepEqual(result.events.map(event => event.delta.map(row => row.chips)), [[0, -1, 1, 0], [3, -1, -1, -1], [-2, -2, 6, -2]]);
  assert.equal(result.warnings.length, 0);
  Object.values(result.totals).forEach(value => near(value, 0));
});

test('red, ura and ippatsu are independently auditable; tsumo charges every other player', () => {
  const record = fixture();
  record.rounds = [{ id: 'bonus', winner: 'p1', zimo: true, aka: 2, ura: 3, ippatsu: true, closed: false, yakumanUnits: 0 }];
  const result = Settlement.calculate(record);
  assert.deepEqual(result.entries.map(row => row.chips), [-6, 18, -6, -6]);
  assert.deepEqual(result.events[0].details.map(detail => [detail.type, detail.count]), [['aka', 2], ['ura', 3], ['ippatsu', 1]]);
  assert.equal(result.events[0].details.every(detail => detail.transfers.length === 3), true);
  assert.equal(result.events[0].transfers.reduce((total, transfer) => total + transfer.chips, 0), 18);
});

test('ron charges only the discarder and double ron pays both winners separately', () => {
  const record = fixture();
  record.rounds = [{ id: 'same-round', winner: 0, from: 3, zimo: false, aka: 1, ura: 2, ippatsu: true, yakumanUnits: 0 },
    { id: 'same-round', winner: 1, from: 3, zimo: false, aka: 0, ura: 1, ippatsu: false, yakumanUnits: 0 }];
  const result = Settlement.calculate(record);
  assert.deepEqual(result.entries.map(row => row.chips), [4, 1, 0, -5]);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[0].transfers.length, 1);
});

test('legacy yakuman labels never substitute for verified units or restrict open hands', () => {
  const record = fixture();
  record.rounds = [{ winner: 0, from: 1, zimo: false, aka: 0, ura: 0, ippatsu: false, yakuman: 3, yakumanUnits: 0 }];
  assert.deepEqual(Settlement.calculate(record).entries.map(row => row.chips), [0, 0, 0, 0]);
  record.rounds[0].aka = 2;
  record.rounds[0].closed = false;
  assert.deepEqual(Settlement.calculate(record).entries.map(row => row.chips), [2, -2, 0, 0]);
});

test('confirmed default yakuman payments are ten for ron and five from each tsumo payer', () => {
  const record = fixture();
  record.rounds = [{ winner: 0, from: 1, zimo: false, yakumanUnits: 1 }];
  const ron = Settlement.calculate(record);
  assert.deepEqual(ron.entries.map(row => row.chips), [10, -10, 0, 0]);
  assert.equal(ron.rules.doubleYakuman, 'count');
  assert.deepEqual(ron.events[0].details[0], { type: 'yakuman', label: '役满', count: 10, yakumanUnits: 1, chargedUnits: 1, chipsPerUnit: 10, transfers: [{ from: 'p1', to: 'p0', chips: 10 }] });
  record.rounds = [{ winner: 0, zimo: true, yakumanUnits: 1 }];
  const tsumo = Settlement.calculate(record);
  assert.deepEqual(tsumo.entries.map(row => row.chips), [15, -5, -5, -5]);
  assert.equal(tsumo.events[0].details[0].chipsPerUnit, 5);
  assert.equal(tsumo.events[0].transfers.length, 3);
});

test('double and compound yakuman stack official units while single mode caps each win', () => {
  const record = fixture();
  record.rounds = [{ winner: 0, from: 3, zimo: false, yakumanUnits: 2, yakumanCount: 1 }, { winner: 1, zimo: true, yakumanUnits: 3, yakumanCount: 2 }];
  const before = structuredClone(record), result = Settlement.calculate(record);
  assert.deepEqual(result.events.map(event => event.chipsPerPayer), [20, 15]);
  assert.deepEqual(result.events.map(event => event.yakumanUnits), [2, 3]);
  assert.deepEqual(result.entries.map(row => row.chips), [5, 45, -15, -35]);
  assert.deepEqual(Settlement.calculate(record, { doubleYakuman: 'single' }).events.map(event => event.chipsPerPayer), [10, 5]);
  assert.deepEqual(record, before);
});

test('yakuman adds to red, ura and ippatsu as a separate auditable source', () => {
  const record = fixture();
  record.rounds = [{ winner: 1, from: 3, zimo: false, aka: 2, ura: 3, ippatsu: true, yakumanUnits: 2 }];
  const result = Settlement.calculate(record);
  assert.deepEqual(result.entries.map(row => row.chips), [0, 26, 0, -26]);
  assert.deepEqual(result.events[0].details.map(detail => [detail.type, detail.count]), [['aka', 2], ['ura', 3], ['ippatsu', 1], ['yakuman', 20]]);
  assert.equal(result.events[0].chipsPerPayer, 26);
  near(result.totals.chips, 0); near(result.totals.money, 0);
  record.rounds[0].zimo = true; delete record.rounds[0].from;
  const tsumo = Settlement.calculate(record);
  assert.deepEqual(tsumo.entries.map(row => row.chips), [-16, 48, -16, -16]);
});

test('three-player yakuman tsumo charges only two actual opponents per unit', () => {
  const record = fixture(); record.players = record.players.slice(0, 3);
  record.startPoints = 35000; record.result = [50000, 35000, 20000].map((points, seat) => ({ seat, points }));
  record.rounds = [{ winner: 2, zimo: true, yakumanUnits: 2 }];
  const result = Settlement.calculate(record, { returnPoints: 35000 });
  assert.deepEqual(result.entries.map(row => row.chips), [-10, -10, 20]);
  assert.equal(result.events[0].details[0].transfers.length, 2);
  record.rounds = [{ winner: 2, from: 0, zimo: false, yakumanUnits: 2 }];
  assert.deepEqual(Settlement.calculate(record, { returnPoints: 35000 }).entries.map(row => row.chips), [-20, 0, 20]);
});

test('missing yakuman metadata is explicit, and a deliberate zero price never silently invents it', () => {
  const record = fixture(); record.rounds = [{ winner: 0, from: 1, zimo: false, aka: 1 }];
  assert.throws(() => Settlement.calculate(record), error => error.code === 'YAKUMAN_METADATA_REQUIRED');
  const disabled = Settlement.calculate(record, { yakumanRonChips: 0, yakumanTsumoChips: 0 });
  assert.deepEqual(disabled.entries.map(row => row.chips), [1, -1, 0, 0]);
  assert.equal(disabled.events[0].yakumanUnits, null);
  assert.ok(disabled.warnings.some(message => message.includes('缺少役满份数')));
  record.rounds[0].yakumanUnits = 2;
  const knownDisabled = Settlement.calculate(record, { yakumanRonChips: 0 });
  assert.equal(knownDisabled.events[0].details.find(detail => detail.type === 'yakuman').count, 0);
  assert.ok(knownDisabled.warnings.some(message => message.includes('设为 0')));
});

test('yakuman prices, modes and official unit metadata reject invalid inputs', () => {
  const record = fixture(); record.rounds = [{ winner: 0, from: 1, zimo: false, yakumanUnits: 1 }];
  for (const rules of [{ yakumanRonChips: -1 }, { yakumanRonChips: 0.5 }, { yakumanTsumoChips: '5' }, { doubleYakuman: 'guess' }])
    assert.throws(() => Settlement.calculate(record, rules), error => error.code === 'INVALID_RULE');
  for (const yakumanUnits of [null, -1, 0.5, '2', Infinity])
    assert.throws(() => Settlement.calculate({ ...record, rounds: [{ ...record.rounds[0], yakumanUnits }] }), /役满份数/);
  assert.throws(() => Settlement.calculate({ ...record, rounds: [{ ...record.rounds[0], yakumanUnits: 2 }] }, { yakumanRonChips: Number.MAX_SAFE_INTEGER }), /役满祝数过大/);
});

test('yakuman aggregation balances and applies configured prices once per record', () => {
  const first = fixture(); first.rounds = [{ winner: 0, from: 1, zimo: false, yakumanUnits: 2 }];
  const second = { ...fixture(), id: 'synthetic-yakuman-second', rounds: [{ winner: 2, zimo: true, yakumanUnits: 1 }] };
  const result = Settlement.aggregateRecords([first, second], { yakumanRonChips: 7, yakumanTsumoChips: 4 });
  assert.deepEqual(result.entries.map(row => row.chips), [10, -18, 12, -4]);
  assert.deepEqual(result.entries.map(row => row.chipPT), [30, -54, 36, -12]);
  near(result.totals.chips, 0); near(result.totals.chipPT, 0); near(result.totals.money, 0);
});

test('configurable chip PT and explicit local uma alter settlement without changing source points', () => {
  const record = fixture();
  const before = structuredClone(record);
  const result = Settlement.calculate(record, { chipPT: 5, pointRate: 2, uma: [15, 5, -5, -15] });
  assert.deepEqual(result.entries.map(row => row.rank), [2, 4, 1, 3]);
  assert.deepEqual(result.entries.map(row => row.umaPT), [5, -15, 15, -5]);
  assert.deepEqual(result.entries.map(row => row.totalPT), [10, -61.1, 83.9, -32.8]);
  assert.deepEqual(result.entries.map(row => row.money), [20, -122.2, 167.8, -65.6]);
  assert.match(result.warnings[0], /顺位马/);
  assert.deepEqual(record, before);
});

test('three-player tsumo charges the other two players and retains the declared starting pool', () => {
  const record = fixture();
  record.players = record.players.slice(0, 3);
  record.startPoints = 35000;
  record.result = [50000, 35000, 20000].map((points, seat) => ({ seat, points }));
  record.rounds = [{ winner: 0, zimo: true, ura: 1, yakumanUnits: 0 }];
  const result = Settlement.calculate(record, { returnPoints: 35000 });
  assert.deepEqual(result.entries.map(row => row.chips), [2, -1, -1]);
  near(result.totals.totalPT, 0);
  assert.equal(result.events[0].transfers.length, 2);
  assert.equal(Settlement.calculate(record, { returnPoints: 35000, uma: [0, 0, 0, 0] }).entries.length, 3);
  assert.throws(() => Settlement.calculate(record, { returnPoints: 35000, uma: [15, 5, -5, -15] }), /顺位马数量/);
});

test('a pure-points profile aggregates three- and four-player records without inventing sanma uma', () => {
  const four = fixture();
  const three = fixture(); three.id = 'three-player';
  three.players = three.players.slice(0, 3);
  three.result = [35000, 25000, 15000].map((points, seat) => ({ seat, points }));
  three.rounds = [{ winner: 0, zimo: true, aka: 1, yakumanUnits: 0 }];
  const result = Settlement.aggregateRecords([four, three], { uma: [0, 0, 0, 0] });
  assert.equal(result.records[0].rules.uma.length, 4);
  assert.equal(result.records[1].rules.uma.length, 3);
  assert.equal(result.entries.find(entry => entry.playerId === 'p0').games, 2);
  assert.equal(result.entries.find(entry => entry.playerId === 'p3').games, 1);
  near(result.totals.totalPT, 0);
  near(result.totals.money, 0);
});

test('tied scores use seat priority by default, with explicit split uma available', () => {
  const record = fixture();
  record.result = [35000, 35000, 20000, 10000].map((points, seat) => ({ seat, points }));
  record.rounds = [];
  const seat = Settlement.calculate(record, { uma: [15, 5, -5, -15] });
  assert.deepEqual(seat.entries.map(row => row.rank), [1, 2, 3, 4]);
  const split = Settlement.calculate(record, { uma: [15, 5, -5, -15], tieMode: 'split' });
  assert.deepEqual(split.entries.map(row => row.rank), [1, 1, 3, 4]);
  assert.deepEqual(split.entries.map(row => row.umaPT), [10, 10, -5, -15]);
});

test('aggregation merges stable IDs across changed names and seats, never identical nicknames', () => {
  const first = fixture();
  const second = fixture(); second.id = 'another';
  second.players[0].name = 'changed-name';
  second.players[1].name = first.players[2].name;
  second.players[1].id = 'a-different-person';
  const result = Settlement.aggregateRecords([first, second]);
  assert.equal(result.entries.length, 5);
  const player = result.entries.find(row => row.playerId === 'p0');
  assert.equal(player.games, 2);
  assert.deepEqual(player.names, [names[0], 'changed-name']);
  assert.equal(player.chips, 2);
  assert.equal(result.entries.find(row => row.playerId === 'a-different-person').games, 1);
  assert.ok(result.warnings.some(warning => warning.includes('不同玩家 ID')));
  Object.values(result.totals).forEach(value => near(value, 0));
});

test('record duplicates and invalid parties/counts/results fail with explicit errors', () => {
  const record = fixture();
  assert.throws(() => Settlement.aggregateRecords([record, record]), error => error.code === 'DUPLICATE_RECORD');
  assert.throws(() => Settlement.calculate({ ...record, players: record.players.map((player, index) => ({ ...player, id: index === 1 ? 'p0' : player.id })) }), /ID 不能重复/);
  assert.throws(() => Settlement.calculate({ ...record, rounds: [{ winner: 0, from: 0, zimo: false }] }), /不能是和牌者/);
  assert.throws(() => Settlement.calculate({ ...record, rounds: [{ winner: 0, from: 4, zimo: false }] }), /放铳玩家/);
  assert.throws(() => Settlement.calculate({ ...record, rounds: [{ winner: 0, zimo: true, aka: 1.5 }] }), /红宝牌数/);
  assert.throws(() => Settlement.calculate({ ...record, rounds: [{ winner: 0, zimo: true, ippatsu: 1 }] }), /布尔值/);
  assert.throws(() => Settlement.calculate({ ...record, result: record.result.map(row => ({ ...row, points: 10000 })) }), /合计应为/);
  assert.throws(() => Settlement.calculate(record, { chipPT: -1 }), /每祝 PT/);
  assert.throws(() => Settlement.calculate(record, { uma: [10, 0, 0, 0] }), /合计必须/);
});

test('an empty record list still validates editable rules and returns empty zero totals', () => {
  const result = Settlement.aggregateRecords([], { chipPT: 5, uma: [15, 5, -5, -15] });
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.totals, { basePT: 0, umaPT: 0, chips: 0, chipPT: 0, totalPT: 0, money: 0 });
  assert.throws(() => Settlement.aggregateRecords([], { uma: [15, 5, 0, 0] }), /合计必须/);
});

test('nonzero return-point offset is explicit and is never hidden by cash balancing', () => {
  const result = Settlement.calculate(fixture(), { returnPoints: 30000 });
  assert.equal(result.totals.basePT, -20);
  assert.equal(result.totals.totalPT, -20);
  assert.equal(result.totals.money, -200);
  assert.ok(result.warnings.some(warning => warning.includes('未加入头名奖')));
});

test('fractional monetary cents are allocated once and remain balanced in aggregation', () => {
  const record = fixture();
  const rules = { chipPT: 1 / 3, pointRate: 0.01 };
  const result = Settlement.calculate(record, rules);
  near(result.totals.money, 0);
  result.entries.forEach(entry => near(entry.money * 100, Math.round(entry.money * 100)));
  const aggregate = Settlement.aggregateRecords([record, { ...record, id: 'second' }], rules);
  near(aggregate.totals.money, 0);
  assert.deepEqual(aggregate.entries.map(entry => entry.money), result.entries.map(entry => entry.money * 2));
});

test('browser UMD export works without external libraries', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('./paipu-settlement.js'), 'utf8'), context);
  assert.equal(typeof context.PaipuSettlement.calculate, 'function');
  assert.equal(typeof context.PaipuSettlement.aggregateRecords, 'function');
});
