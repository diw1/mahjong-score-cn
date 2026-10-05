'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Engine = require('./engine.js');

// Explicit legacy presets keep original-app references stable when the user defaults change.
function referenceRules(n = 4) {
  return { ...Engine.defaultRules(n), startPoints: n === 3 ? 35000 : 25000, returnPoints: n === 3 ? 40000 : 30000, uma: n === 3 ? [20, 0, -20] : [20, 10, -10, -20], chipPT: 0 };
}

const ids = ['a', 'b', 'c', 'd'];
const total = (rows, field) => rows.reduce((value, row) => value + row[field], 0);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, actual + ' != ' + expected);
function game(points, chips, playerIds = ids) {
  return { id: 'g1', players: points.map((points, index) => ({ playerId: playerIds[index], points, chips: chips ? chips[index] : 0 })) };
}
function session(rules, games, playerIds = ids, extra = {}) {
  return { id: 's1', playerIds, rules, games, tableFee: 0, ...extra };
}
function reconstructedTransfers(rows, transfers) {
  const result = new Map(rows.map(row => [row.playerId, 0]));
  result.set('__table__', 0);
  for (const transfer of transfers) {
    assert.ok(transfer.amount > 0);
    assert.notEqual(transfer.from, transfer.to);
    result.set(transfer.from, result.get(transfer.from) - transfer.amount);
    result.set(transfer.to, result.get(transfer.to) + transfer.amount);
  }
  for (const row of rows) near(result.get(row.playerId), row.netMoney);
  near(result.get('__table__'), total(rows, 'fee'));
}

test('reference final scores, oka, uma and signed chip exchanges produce the documented result', () => {
  const rules = { ...referenceRules(), pointRate: 10, chipValue: 50 };
  const result = Engine.calculateGame(rules, game([5000, 60000, 10000, 25000], [0, 3, -3, 0]));
  assert.deepEqual(result.entries.map(row => row.rank), [4, 1, 3, 2]);
  assert.deepEqual(result.entries.map(row => row.scorePT), [-45, 70, -30, 5]);
  assert.deepEqual(result.entries.map(row => row.money), [-450, 850, -450, 50]);
  near(total(result.entries, 'scorePT'), 0);
  near(total(result.entries, 'money'), 0);
});

test('raw hundreds survive the unrounded decimal calculation', () => {
  const result = Engine.calculateGame({ ...referenceRules(), rounding: 'none' }, game([40300, 29700, 20000, 10000]));
  assert.deepEqual(result.entries.map(row => row.scorePT), [50.3, 9.7, -20, -40]);
  near(total(result.entries, 'scorePT'), 0);
});

test('three-player oka comes from three starting stacks', () => {
  const rules = { ...referenceRules(3), rounding: 'none' };
  const result = Engine.calculateGame(rules, game([45100, 35100, 24800], undefined, ids.slice(0, 3)));
  assert.deepEqual(result.entries.map(row => row.scorePT), [40.1, -4.9, -35.2]);
  near(total(result.entries, 'scorePT'), 0);
});

test('split ties share their occupied uma and top oka, with unbiased average placement', () => {
  const rules = { ...referenceRules(), tieMode: 'split' };
  const tiedGame = game([35000, 35000, 20000, 10000]);
  const result = Engine.calculateGame(rules, tiedGame);
  assert.deepEqual(result.entries.map(row => row.rank), [1, 1, 3, 4]);
  assert.deepEqual(result.entries.map(row => row.scorePT), [30, 30, -20, -40]);
  const rows = Engine.aggregateSession(session(rules, [tiedGame]));
  assert.deepEqual(rows.map(row => row.averageRank), [1.5, 1.5, 3, 4]);
  assert.deepEqual(rows.map(row => row.firsts), [1, 1, 0, 0]);
  assert.deepEqual(rows.map(row => row.lasts), [0, 0, 0, 1]);
});

test('seat priority treats earlier input as higher place and matches reference tied columns', () => {
  const rules = { ...referenceRules(), tieMode: 'seat', rounding: 'fiveSix' };
  const result = Engine.calculateGame(rules, game([30000, 2000, 38000, 30000]));
  assert.deepEqual(result.entries.map(row => row.rank), [2, 4, 1, 3]);
  assert.deepEqual(result.entries.map(row => row.scorePT), [10, -48, 48, -10]);
});

test('rounding acts on raw final points and allocates residual to the top place', () => {
  const rules = { ...referenceRules(), rounding: 'floor' };
  const result = Engine.calculateGame(rules, game([40200, 29900, 20000, 9900]));
  assert.deepEqual(result.entries.map(row => row.scorePT), [52, 9, -20, -41]);
  assert.equal(result.warnings.length, 1);
  near(total(result.entries, 'scorePT'), 0);
  const reference = Engine.calculateGame({ ...rules, rounding: 'fiveSix' }, game([1000, 30000, 4300, 64700]));
  assert.deepEqual(reference.entries.map(row => row.scorePT), [-49, 10, -36, 75]);
});

test('four-player rotation counts played games and leaves a registered sitout at zero', () => {
  const rules = { ...referenceRules(), pointRate: 1 };
  const playerIds = ['a', 'b', 'c', 'd', 'e', 'f'];
  const games = [game([40000, 30000, 20000, 10000]), game([10000, 40000, 30000, 20000], undefined, ['a', 'b', 'c', 'e'])];
  const rows = Engine.aggregateSession(session(rules, games, playerIds));
  assert.deepEqual(rows.map(row => row.games), [2, 2, 2, 1, 1, 0]);
  assert.deepEqual(rows.map(row => row.averageRank), [2.5, 1.5, 2.5, 4, 3, 0]);
  assert.equal(rows[5].grossMoney, 0);
  near(total(rows, 'totalPT'), 0);
  near(total(rows, 'grossMoney'), 0);
});

test('negative final points retain their full score and count busts', () => {
  const rules = referenceRules();
  const rows = Engine.aggregateSession(session(rules, [game([-1000, 41000, 30000, 30000])]));
  assert.equal(rows[0].totalPT, -51);
  assert.equal(rows[0].busts, 1);
});

test('three-way ties and fractional rates preserve cash exactly to cents', () => {
  const rules = { ...referenceRules(), tieMode: 'split', pointRate: 0.01, chipValue: 0.005 };
  const result = Engine.calculateGame(rules, game([30000, 30000, 30000, 10000], [1, 0, 0, -1]));
  near(total(result.entries, 'scorePT'), 0);
  near(total(result.entries, 'pointMoney'), 0);
  near(total(result.entries, 'chipMoney'), 0);
  near(total(result.entries, 'money'), 0);
  assert.deepEqual(result.entries.map(row => row.chipMoney), [0.01, 0, 0, -0.01]);
  for (const entry of result.entries) near(entry.money * 100, Math.round(entry.money * 100));
});

test('equal fees allocate a leftover cent and settle into the separate fee recipient', () => {
  const rules = referenceRules(3);
  const rows = Engine.aggregateSession(session(rules, [], ids.slice(0, 3), { tableFee: 1 }));
  assert.deepEqual(rows.map(row => row.fee), [0.34, 0.33, 0.33]);
  near(total(rows, 'netMoney'), -1);
  const transfers = Engine.settleBalances(rows);
  assert.deepEqual(transfers, [{ from: 'a', to: '__table__', amount: 0.34 }, { from: 'b', to: '__table__', amount: 0.33 }, { from: 'c', to: '__table__', amount: 0.33 }]);
  reconstructedTransfers(rows, transfers);
});

test('explicit fees, chip revenue and point revenue settle in whole cents', () => {
  const rules = { ...referenceRules(), pointRate: 10, chipValue: 50 };
  const rows = Engine.aggregateSession(session(rules, [game([5000, 60000, 10000, 25000], [0, 3, -3, 0])], ids,
    { tableFee: 25, fees: { a: 5, b: 10, c: 5, d: 5 } }));
  assert.deepEqual(rows.map(row => row.netMoney), [-455, 840, -455, 45]);
  near(total(rows, 'grossMoney'), 0);
  near(total(rows, 'netMoney'), -25);
  reconstructedTransfers(rows, Engine.settleBalances(rows));
});

test('editing and removing source games recomputes all derived numbers without mutation', () => {
  const rules = { ...referenceRules(), pointRate: 1 };
  const source = session(rules, [game([40000, 30000, 20000, 10000])]);
  const original = structuredClone(source);
  const before = Engine.aggregateSession(source);
  assert.deepEqual(source, original);
  source.games[0].players[0].points = 10000;
  source.games[0].players[3].points = 40000;
  const after = Engine.aggregateSession(source);
  assert.equal(before[0].firsts, 1);
  assert.equal(after[0].firsts, 0);
  assert.equal(after[3].firsts, 1);
  source.games = [];
  const empty = Engine.aggregateSession(source);
  assert.ok(empty.every(row => row.games === 0 && row.totalPT === 0 && row.grossMoney === 0));
});

test('invalid points, identity, chips, fees and unsupported options fail clearly', () => {
  const rules = referenceRules();
  assert.throws(() => Engine.calculateGame(rules, game([40000, 30000, 20000, 9000])), /合计必须/);
  assert.throws(() => Engine.calculateGame(rules, game([40001, 29999, 20000, 10000])), /100 的倍数/);
  assert.throws(() => Engine.calculateGame(rules, game([NaN, 30000, 20000, 10000])), /整数/);
  assert.throws(() => Engine.calculateGame(rules, game([40000, 30000, 20000, 10000], undefined, ['a', 'a', 'c', 'd'])), /重复/);
  assert.throws(() => Engine.calculateGame({ ...rules, chipValue: 1 }, game([40000, 30000, 20000, 10000], [1, 0, 0, 0])), /祝仪收支/);
  assert.throws(() => Engine.calculateGame({ ...rules, uma: [20, 10, -10, 0] }, game([40000, 30000, 20000, 10000])), /顺位马/);
  assert.throws(() => Engine.aggregateSession(session(rules, [], ids, { tableFee: 10, fees: { a: 5 } })), /台费合计/);
  assert.throws(() => Engine.aggregateSession(session(rules, [], ids, { tableFee: 0.001 })), /两位小数/);
  assert.throws(() => Engine.aggregateSession(session(rules, [game([40000, 30000, 20000, 10000], undefined, ['a', 'b', 'c', 'x'])])), /未登记/);
  assert.throws(() => Engine.calculateGame({ ...rules, negativeSettlement: false }, game([40000, 30000, 20000, 10000])), /暂未支持/);
  assert.throws(() => Engine.settleBalances([{ playerId: 'a', netMoney: 1, fee: 0 }]), /不平衡/);
});

test('verified person and table yakitori payouts reproduce the developer examples', () => {
  const source = game([40000, 30000, 20000, 10000]);
  source.players[0].yakitori = true;
  source.players[1].yakitori = true;
  const base = Engine.calculateGame(referenceRules(), source).entries.map(row => row.scorePT);
  const person = Engine.calculateGame({ ...referenceRules(), yakitoriPT: 10, yakitoriMode: 'person' }, source);
  const table = Engine.calculateGame({ ...referenceRules(), yakitoriPT: 10, yakitoriMode: 'table' }, source);
  assert.deepEqual(person.entries.map((row, index) => row.scorePT - base[index]), [-20, -20, 20, 20]);
  assert.deepEqual(table.entries.map((row, index) => row.scorePT - base[index]), [-5, -5, 5, 5]);
  near(total(person.entries, 'scorePT'), 0);
  near(total(table.entries, 'scorePT'), 0);
  source.players.forEach(player => { player.yakitori = true; });
  const allFlagged = Engine.calculateGame({ ...referenceRules(), yakitoriPT: 10 }, source);
  assert.deepEqual(allFlagged.entries.map(row => row.scorePT), base);
  assert.match(allFlagged.warnings[0], /全部玩家/);
});

test('tobi transfers preserve raw points and pay each selected hitter separately', () => {
  const rules = { ...referenceRules(), tobiBonusPT: 10 };
  const source = game([-1000, 0, 40000, 61000]);
  source.tobiTransfers = [{ from: 'a', to: 'c' }, { from: 'b', to: 'd' }];
  const base = Engine.calculateGame(referenceRules(), source).entries.map(row => row.scorePT);
  const result = Engine.calculateGame(rules, source);
  assert.deepEqual(result.entries.map(row => row.points), [-1000, 0, 40000, 61000]);
  assert.deepEqual(result.entries.map((row, index) => row.scorePT - base[index]), [-10, -10, 10, 10]);
  near(total(result.entries, 'scorePT'), 0);
  assert.equal(result.warnings.length, 0);
  assert.throws(() => Engine.calculateGame(rules, { ...source, tobiTransfers: [{ from: 'c', to: 'd' }] }), /0 或负数/);
  assert.throws(() => Engine.calculateGame(rules, { ...source, tobiTransfers: [{ from: 'a', to: 'c' }, { from: 'a', to: 'd' }] }), /只能支付一次/);
  assert.throws(() => Engine.calculateGame(rules, { ...source, tobiTransfers: [{ from: 'a', to: 'x' }] }), /本局玩家/);
  const missing = Engine.calculateGame(rules, { ...source, tobiTransfers: [] });
  assert.match(missing.warnings[0], /未选择/);
  const legacy = Engine.calculateGame(rules, { ...source, tobiTransfers: undefined, tobiWinnerId: 'd' });
  assert.deepEqual(legacy.entries.map((row, index) => row.scorePT - base[index]), [-10, -10, 0, 20]);
});

test('per-game rule overrides affect scoring, money and tied statistics without changing other games', () => {
  const rules = { ...referenceRules(), pointRate: 1 };
  const first = game([35000, 35000, 20000, 10000]);
  const second = { ...first, id: 'g2', rules: { ...rules, tieMode: 'split', pointRate: 2, uma: [30, 10, -10, -30] } };
  const rows = Engine.aggregateSession(session(rules, [first, second]));
  assert.deepEqual(rows.map(row => row.totalPT), [80, 50, -40, -90]);
  assert.deepEqual(rows.map(row => row.grossMoney), [115, 85, -60, -140]);
  assert.deepEqual(rows.map(row => row.averageRank), [1.25, 1.75, 3, 4]);
  near(total(rows, 'grossMoney'), 0);
  assert.throws(() => Engine.calculateGame(rules, { ...first, rules: referenceRules(3) }), /不能改变场次人数/);
});

test('browser UMD export exposes the same API without CommonJS', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('./engine.js'), 'utf8'), context);
  assert.equal(typeof context.ScoreEngine.calculateGame, 'function');
  assert.equal(context.ScoreEngine.defaultRules(3).playerCount, 3);
  assert.equal(context.ScoreEngine.defaultRules(3).startPoints, 25000);
  assert.equal(context.ScoreEngine.defaultRules(3).returnPoints, 25000);
  assert.equal(context.ScoreEngine.defaultRules(4).uma.join(','), '15,5,-5,-15');
});

test('user defaults use 25000 start and return for both player counts with requested uma', () => {
  assert.equal(Engine.defaultRules().playerCount, 4);
  for (const count of [3, 4]) {
    const rules = Engine.defaultRules(count);
    assert.equal(rules.startPoints, 25000);
    assert.equal(rules.returnPoints, 25000);
    assert.deepEqual(rules.uma, count === 4 ? [15, 5, -5, -15] : [20, 0, -20]);
    assert.equal(rules.rounding, 'fiveSix');
    assert.equal(rules.chipPT, 3);
    assert.equal(rules.chipValue, 0);
  }
});

test('user four-player defaults have no oka and retain balanced chip and cash settlement', () => {
  const rules = { ...Engine.defaultRules(4), pointRate: 10 };
  const source = game([39000, 27000, 23000, 11000], [2, -1, -3, 2]);
  const result = Engine.calculateGame(rules, source);
  assert.deepEqual(result.entries.map(row => row.mahjongPT), [29, 7, -7, -29]);
  assert.deepEqual(result.entries.map(row => row.chipScorePT), [6, -3, -9, 6]);
  assert.deepEqual(result.entries.map(row => row.scorePT), [35, 4, -16, -23]);
  assert.deepEqual(result.entries.map(row => row.money), [350, 40, -160, -230]);
  near(total(result.entries, 'scorePT'), 0);
  near(total(result.entries, 'money'), 0);
  const rows = Engine.aggregateSession(session(rules, [source], ids, { tableFee: 40 }));
  assert.deepEqual(rows.map(row => row.netMoney), [340, 30, -170, -240]);
  reconstructedTransfers(rows, Engine.settleBalances(rows));
});

test('user three-player defaults validate 75000 total and have no oka', () => {
  const rules = { ...Engine.defaultRules(3), rounding: 'none' };
  const result = Engine.calculateGame(rules, game([35000, 25000, 15000], undefined, ids.slice(0, 3)));
  assert.deepEqual(result.entries.map(row => row.scorePT), [30, 0, -30]);
  assert.equal(result.warnings.length, 0);
  near(total(result.entries, 'scorePT'), 0);
  assert.throws(() => Engine.calculateGame(rules, game([45000, 35000, 25000], undefined, ids.slice(0, 3))), /75000/);
});

test('user equal scores honor input priority or split all uma without a hidden top award', () => {
  const source = game([25000, 25000, 25000, 25000]);
  const seat = Engine.calculateGame(Engine.defaultRules(4), source);
  assert.deepEqual(seat.entries.map(row => row.rank), [1, 2, 3, 4]);
  assert.deepEqual(seat.entries.map(row => row.scorePT), [15, 5, -5, -15]);
  const split = Engine.calculateGame({ ...Engine.defaultRules(4), tieMode: 'split' }, source);
  assert.deepEqual(split.entries.map(row => row.scorePT), [0, 0, 0, 0]);
  const tied = Engine.calculateGame({ ...Engine.defaultRules(4), tieMode: 'split' }, game([33000, 33000, 20000, 14000]));
  assert.deepEqual(tied.entries.map(row => row.scorePT), [18, 18, -10, -26]);
});

test('user default negative points and five-six rounding retain full losses', () => {
  const four = Engine.calculateGame(Engine.defaultRules(4), game([-1500, 41500, 30000, 30000]));
  assert.deepEqual(four.entries.map(row => row.scorePT), [-41, 31, 10, 0]);
  const three = Engine.calculateGame(Engine.defaultRules(3), game([-1000, 31000, 45000], undefined, ids.slice(0, 3)));
  assert.deepEqual(three.entries.map(row => row.scorePT), [-46, 6, 40]);
  near(total(four.entries, 'scorePT'), 0);
  near(total(three.entries, 'scorePT'), 0);
});

test('user default rounding residual is assigned to first and keeps PT and money balanced', () => {
  const result = Engine.calculateGame({ ...Engine.defaultRules(4), rounding: 'floor', pointRate: 10 }, game([40200, 29900, 20000, 9900]));
  assert.deepEqual(result.entries.map(row => row.scorePT), [32, 9, -10, -31]);
  assert.deepEqual(result.entries.map(row => row.money), [320, 90, -100, -310]);
  assert.equal(result.warnings.length, 1);
  near(total(result.entries, 'scorePT'), 0);
});

test('explicit historical rules remain unchanged when new defaults are used for later games', () => {
  const base = { ...Engine.defaultRules(4), pointRate: 1 };
  const historical = { ...game([35000, 35000, 20000, 10000]), rules: { ...referenceRules(4), pointRate: 1 } };
  const current = { ...game([35000, 35000, 20000, 10000]), id: 'g2' };
  const source = session(base, [historical, current]);
  const before = structuredClone(source);
  assert.deepEqual(Engine.calculateGame(base, historical).entries.map(row => row.scorePT), [45, 15, -20, -40]);
  assert.deepEqual(Engine.calculateGame(base, current).entries.map(row => row.scorePT), [25, 15, -10, -30]);
  const rows = Engine.aggregateSession(source);
  assert.deepEqual(rows.map(row => row.totalPT), [70, 30, -30, -70]);
  assert.deepEqual(rows.map(row => row.grossMoney), [70, 30, -30, -70]);
  assert.deepEqual(source, before);
});

test('PT chips require balanced net quantities even when no cash exchange rate is configured', () => {
  const rules = Engine.defaultRules(4);
  const source = game([39000, 27000, 23000, 11000], [2, -1, -3, 2]);
  const result = Engine.calculateGame(rules, source);
  assert.deepEqual(result.entries.map(row => row.scorePT), [35, 4, -16, -23]);
  assert.deepEqual(result.entries.map(row => row.money), [0, 0, 0, 0]);
  near(total(result.entries, 'chipScorePT'), 0);
  near(total(result.entries, 'scorePT'), 0);
  assert.throws(() => Engine.calculateGame(rules, game([39000, 27000, 23000, 11000], [1, 0, 0, 0])), /祝仪收支/);
  const noChips = Engine.calculateGame(rules, game([39000, 27000, 23000, 11000]));
  assert.deepEqual(noChips.entries.map(row => row.chipNet), [0, 0, 0, 0]);
  assert.deepEqual(noChips.entries.map(row => row.chipScorePT), [0, 0, 0, 0]);
});

test('changing PT chip rate or using a per-game rate recalculates the combined PT and money', () => {
  const rules = { ...Engine.defaultRules(4), pointRate: 10 };
  const source = game([39000, 27000, 23000, 11000], [2, -1, -3, 2]);
  const five = Engine.calculateGame({ ...rules, chipPT: 5 }, source);
  assert.deepEqual(five.entries.map(row => row.chipScorePT), [10, -5, -15, 10]);
  assert.deepEqual(five.entries.map(row => row.scorePT), [39, 2, -22, -19]);
  assert.deepEqual(five.entries.map(row => row.pointMoney), [390, 20, -220, -190]);
  assert.deepEqual(five.entries.map(row => row.chipMoney), [0, 0, 0, 0]);
  const second = { ...source, id: 'g2', rules: { chipPT: 5 } };
  const rows = Engine.aggregateSession(session(rules, [source, second]));
  assert.deepEqual(rows.map(row => row.totalPT), [74, 6, -38, -42]);
  assert.deepEqual(rows.map(row => row.grossMoney), [740, 60, -380, -420]);
  near(total(rows, 'totalPT'), 0);
  near(total(rows, 'grossMoney'), 0);
  assert.equal(rules.chipPT, 3);
});

test('legacy backup rules with no chipPT retain original PT and direct chip cash', () => {
  const legacy = { ...referenceRules(4), pointRate: 10, chipValue: 50 };
  delete legacy.chipPT;
  const source = game([5000, 60000, 10000, 25000], [0, 3, -3, 0]);
  const result = Engine.calculateGame(legacy, source);
  assert.deepEqual(result.entries.map(row => row.mahjongPT), [-45, 70, -30, 5]);
  assert.deepEqual(result.entries.map(row => row.chipScorePT), [0, 0, 0, 0]);
  assert.deepEqual(result.entries.map(row => row.scorePT), [-45, 70, -30, 5]);
  assert.deepEqual(result.entries.map(row => row.chipMoney), [0, 150, -150, 0]);
  assert.deepEqual(result.entries.map(row => row.money), [-450, 850, -450, 50]);
  const rows = Engine.aggregateSession(session(legacy, [source]));
  assert.deepEqual(rows.map(row => row.totalPT), [-45, 70, -30, 5]);
  assert.deepEqual(rows.map(row => row.grossMoney), [-450, 850, -450, 50]);
});

test('legacy direct chip money and explicit PT chip rate remain separately identifiable', () => {
  const rules = { ...Engine.defaultRules(4), pointRate: 10, chipValue: 50 };
  const result = Engine.calculateGame(rules, game([39000, 27000, 23000, 11000], [2, -1, -3, 2]));
  assert.deepEqual(result.entries.map(row => row.scorePT), [35, 4, -16, -23]);
  assert.deepEqual(result.entries.map(row => row.pointMoney), [350, 40, -160, -230]);
  assert.deepEqual(result.entries.map(row => row.chipMoney), [100, -50, -150, 100]);
  assert.deepEqual(result.entries.map(row => row.money), [450, -10, -310, -130]);
  near(total(result.entries, 'money'), 0);
});

test('PT chip rate validates finite nonnegative values in tenths', () => {
  const rules = Engine.defaultRules(4);
  const source = game([39000, 27000, 23000, 11000], [2, -1, -3, 2]);
  const fractional = Engine.calculateGame({ ...rules, chipPT: 2.5 }, source);
  assert.deepEqual(fractional.entries.map(row => row.chipScorePT), [5, -2.5, -7.5, 5]);
  assert.deepEqual(fractional.entries.map(row => row.scorePT), [34, 4.5, -14.5, -24]);
  const disabled = Engine.calculateGame({ ...rules, chipPT: 0 }, source);
  assert.deepEqual(disabled.entries.map(row => row.scorePT), [29, 7, -7, -29]);
  for (const invalid of [-1, Infinity, NaN, '3', null, undefined]) {
    assert.throws(() => Engine.calculateGame({ ...rules, chipPT: invalid }, source), /每祝价值/);
  }
  assert.throws(() => Engine.calculateGame({ ...rules, chipPT: 0.01 }, source), /一位小数/);
});

test('full legacy game rules missing chipPT stay at zero while partial overrides inherit the current rate', () => {
  const base = { ...Engine.defaultRules(4), pointRate: 10 };
  const oldRule = { ...referenceRules(4), pointRate: 10, chipValue: 50 };
  delete oldRule.chipPT;
  const oldGame = { ...game([5000, 60000, 10000, 25000], [0, 3, -3, 0]), rules: oldRule };
  const oldResult = Engine.calculateGame(base, oldGame);
  assert.deepEqual(oldResult.entries.map(row => row.chipScorePT), [0, 0, 0, 0]);
  assert.deepEqual(oldResult.entries.map(row => row.scorePT), [-45, 70, -30, 5]);
  assert.deepEqual(oldResult.entries.map(row => row.money), [-450, 850, -450, 50]);
  const inherited = Engine.calculateGame(base, { ...game([39000, 27000, 23000, 11000], [2, -1, -3, 2]), rules: { pointRate: 20 } });
  assert.deepEqual(inherited.entries.map(row => row.chipScorePT), [6, -3, -9, 6]);
  assert.deepEqual(inherited.entries.map(row => row.money), [700, 80, -320, -460]);
});

test('final room chips are applied once after two games and leave game results unchanged', () => {
  const rules = { ...Engine.defaultRules(4), pointRate: 10 };
  const first = game([39000, 27000, 23000, 11000]);
  const second = { ...game([11000, 23000, 27000, 39000]), id: 'g2' };
  const source = session(rules, [first, second], ids, { finalChips: { a: 2, b: -1, c: -3, d: 2 } });
  const before = structuredClone(source);
  const rows = Engine.aggregateSession(source);
  assert.deepEqual(rows.map(row => row.mahjongPT), [0, 0, 0, 0]);
  assert.deepEqual(rows.map(row => row.legacyChipNet), [0, 0, 0, 0]);
  assert.deepEqual(rows.map(row => row.finalChipNet), [2, -1, -3, 2]);
  assert.deepEqual(rows.map(row => row.finalChipScorePT), [6, -3, -9, 6]);
  assert.deepEqual(rows.map(row => row.chipScorePT), [6, -3, -9, 6]);
  assert.deepEqual(rows.map(row => row.totalPT), [6, -3, -9, 6]);
  assert.deepEqual(rows.map(row => row.chips), [2, -1, -3, 2]);
  assert.deepEqual(rows.map(row => row.finalChipMoney), [60, -30, -90, 60]);
  assert.deepEqual(rows.map(row => row.grossMoney), [60, -30, -90, 60]);
  assert.deepEqual(rows.map(row => row.games), [2, 2, 2, 2]);
  assert.deepEqual(source, before);
  assert.deepEqual(Engine.calculateGame(rules, first).entries.map(row => row.scorePT), [29, 7, -7, -29]);
});

test('final chip pricing uses room rules and changes without changing any game data or overrides', () => {
  const rules = { ...Engine.defaultRules(4), pointRate: 10 };
  const first = game([39000, 27000, 23000, 11000]);
  const second = { ...game([11000, 23000, 27000, 39000]), id: 'g2', rules: { pointRate: 20, chipPT: 100 } };
  const source = session(rules, [first, second], ids, { finalChips: { a: 2, b: -1, c: -3, d: 2 } });
  const beforeGames = structuredClone(source.games);
  const three = Engine.aggregateSession(source);
  assert.deepEqual(three.map(row => row.finalChipScorePT), [6, -3, -9, 6]);
  assert.deepEqual(three.map(row => row.finalChipMoney), [60, -30, -90, 60]);
  source.rules.chipPT = 5;
  const five = Engine.aggregateSession(source);
  assert.deepEqual(five.map(row => row.finalChipScorePT), [10, -5, -15, 10]);
  assert.deepEqual(five.map(row => row.finalChipMoney), [100, -50, -150, 100]);
  assert.deepEqual(five.map((row, i) => row.grossMoney - three[i].grossMoney), [40, -20, -60, 40]);
  assert.deepEqual(five.map(row => row.mahjongPT), three.map(row => row.mahjongPT));
  assert.deepEqual(source.games, beforeGames);
});

test('registered sitouts and rooms with no games can settle final chips without adding game statistics', () => {
  const rules = { ...Engine.defaultRules(4), pointRate: 10 };
  const roster = [...ids, 'e'];
  const source = session(rules, [game([39000, 27000, 23000, 11000])], roster, { finalChips: { a: -2, e: 2 } });
  const rows = Engine.aggregateSession(source);
  const sitout = rows.find(row => row.playerId === 'e');
  assert.equal(sitout.games, 0);
  assert.equal(sitout.averageRank, 0);
  assert.equal(sitout.firsts, 0);
  assert.equal(sitout.lasts, 0);
  assert.equal(sitout.mahjongPT, 0);
  assert.equal(sitout.totalPT, 6);
  assert.equal(sitout.netMoney, 60);
  const noGames = Engine.aggregateSession(session({ ...Engine.defaultRules(3), pointRate: 10 }, [], ids.slice(0, 3), { finalChips: { a: 1, b: -1 } }));
  assert.deepEqual(noGames.map(row => row.totalPT), [3, -3, 0]);
  assert.deepEqual(noGames.map(row => row.netMoney), [30, -30, 0]);
  assert.ok(noGames.every(row => row.games === 0 && row.averageRank === 0));
  reconstructedTransfers(noGames, Engine.settleBalances(noGames));
});

test('final chip map validates registered IDs, safe integer counts and enabled net totals', () => {
  const rules = Engine.defaultRules(4);
  for (const invalid of [[], 'bad', 5, true]) {
    assert.throws(() => Engine.aggregateSession(session(rules, [], ids, { finalChips: invalid })), /整场祝仪/);
  }
  assert.throws(() => Engine.aggregateSession(session(rules, [], ids, { finalChips: { x: 0 } })), /未登记/);
  assert.throws(() => Engine.aggregateSession(session(rules, [], ids, { finalChips: { __table__: 0 } })), /未登记/);
  for (const invalid of [0.1, NaN, Infinity, '2', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => Engine.aggregateSession(session(rules, [], ids, { finalChips: { a: invalid } })), /整数/);
  }
  assert.throws(() => Engine.aggregateSession(session(rules, [], ids, { finalChips: { a: 1 } })), /合计必须为 0/);
  const legacyCashOnly = Engine.aggregateSession(session({ ...rules, chipPT: 0, chipValue: 50 }, [], ids, { finalChips: { a: 1 } }));
  assert.equal(legacyCashOnly[0].finalChipNet, 1);
  assert.equal(legacyCashOnly[0].finalChipMoney, 0);
  assert.equal(legacyCashOnly[0].grossMoney, 0);
  const disabled = Engine.aggregateSession(session({ ...rules, chipPT: 0, chipValue: 0 }, [], ids, { finalChips: { a: 1 } }));
  assert.equal(disabled[0].finalChipNet, 1);
  assert.equal(disabled[0].totalPT, 0);
  assert.equal(disabled[0].netMoney, 0);
});

test('missing and null final chips retain old 1.0.0 and 1.0.1 scores and money without double counting', () => {
  const oldCashRules = { ...referenceRules(4), pointRate: 10, chipValue: 50 };
  delete oldCashRules.chipPT;
  const oldCashGame = game([5000, 60000, 10000, 25000], [0, 3, -3, 0]);
  const oldPTRules = { ...Engine.defaultRules(4), pointRate: 10 };
  const oldPTGame = game([39000, 27000, 23000, 11000], [2, -1, -3, 2]);
  for (const [rules, sourceGame, pt, cash] of [
    [oldCashRules, oldCashGame, [-45, 70, -30, 5], [-450, 850, -450, 50]],
    [oldPTRules, oldPTGame, [35, 4, -16, -23], [350, 40, -160, -230]]
  ]) {
    for (const extra of [{}, { finalChips: null }, { finalChips: {} }]) {
      const rows = Engine.aggregateSession(session(rules, [sourceGame], ids, extra));
      assert.deepEqual(rows.map(row => row.totalPT), pt);
      assert.deepEqual(rows.map(row => row.grossMoney), cash);
      assert.deepEqual(rows.map(row => row.legacyChipNet), sourceGame.players.map(row => row.chips));
      assert.ok(rows.every(row => row.finalChipNet === 0 && row.finalChipScorePT === 0 && row.finalChipMoney === 0));
    }
  }
});

test('historical per-game chips and final additional room chips coexist with separate audit fields', () => {
  const rules = { ...Engine.defaultRules(4), pointRate: 10, chipValue: 50 };
  const sourceGame = { ...game([39000, 27000, 23000, 11000], [2, -1, -3, 2]), rules: { chipPT: 5, chipValue: 20, pointRate: 2 } };
  const source = session(rules, [sourceGame], ids, { finalChips: { a: -1, b: 2, c: 0, d: -1 } });
  const rows = Engine.aggregateSession(source);
  assert.deepEqual(rows.map(row => row.mahjongPT), [29, 7, -7, -29]);
  assert.deepEqual(rows.map(row => row.legacyChipNet), [2, -1, -3, 2]);
  assert.deepEqual(rows.map(row => row.finalChipNet), [-1, 2, 0, -1]);
  assert.deepEqual(rows.map(row => row.chips), [1, 1, -3, 1]);
  assert.deepEqual(rows.map(row => row.finalChipScorePT), [-3, 6, 0, -3]);
  assert.deepEqual(rows.map(row => row.chipScorePT), [7, 1, -15, 7]);
  assert.deepEqual(rows.map(row => row.totalPT), [36, 8, -22, -22]);
  assert.deepEqual(rows.map(row => row.finalChipMoney), [-30, 60, 0, -30]);
  assert.deepEqual(rows.map(row => row.grossMoney), [88, 44, -104, -28]);
  near(total(rows, 'totalPT'), 0);
  near(total(rows, 'grossMoney'), 0);
  reconstructedTransfers(rows, Engine.settleBalances(rows));
});

test('final PT chips convert once into exact cents without legacy cash and remain balanced with fees', () => {
  const rules = { ...Engine.defaultRules(3), chipPT: 2.5, pointRate: 0.03, chipValue: 0.005 };
  const source = session(rules, [], ids.slice(0, 3), { finalChips: { a: 1, b: -1 }, tableFee: 0.05 });
  const rows = Engine.aggregateSession(source);
  assert.deepEqual(rows.map(row => row.finalChipScorePT), [2.5, -2.5, 0]);
  assert.deepEqual(rows.map(row => row.finalChipMoney), [0.08, -0.08, 0]);
  assert.deepEqual(rows.map(row => row.fee), [0.02, 0.02, 0.01]);
  assert.deepEqual(rows.map(row => row.netMoney), [0.06, -0.1, -0.01]);
  near(total(rows, 'finalChipMoney'), 0);
  near(total(rows, 'grossMoney'), 0);
  near(total(rows, 'netMoney'), -0.05);
  reconstructedTransfers(rows, Engine.settleBalances(rows));
  const halfCent = Engine.aggregateSession(session({ ...rules, chipPT: 0.1, pointRate: 0.05, chipValue: 0 }, [], ids.slice(0, 3), { finalChips: { a: 1, b: -1 } }));
  assert.deepEqual(halfCent.map(row => row.finalChipMoney), [0.01, -0.01, 0]);
});

test('final room chips add only six at 3 PT and rate two while legacy game chips retain cash fifty', () => {
  const rules = { ...Engine.defaultRules(4), pointRate: 2, chipPT: 3, chipValue: 50 };
  const oldRule = { ...referenceRules(4), pointRate: 2, chipValue: 50 };
  delete oldRule.chipPT;
  const oldGame = { ...game([5000, 60000, 10000, 25000], [0, 3, -3, 0]), rules: oldRule };
  const before = Engine.aggregateSession(session(rules, [oldGame]));
  assert.deepEqual(before.map(row => row.grossMoney), [-90, 290, -210, 10]);
  const after = Engine.aggregateSession(session(rules, [oldGame], ids, { finalChips: { a: 1, b: -1 } }));
  assert.deepEqual(after.map(row => row.finalChipMoney), [6, -6, 0, 0]);
  assert.deepEqual(after.map((row, i) => row.grossMoney - before[i].grossMoney), [6, -6, 0, 0]);
  assert.deepEqual(after.map(row => row.grossMoney), [-84, 284, -210, 10]);
  assert.deepEqual(after.map(row => row.legacyChipNet), [0, 3, -3, 0]);
  assert.deepEqual(Engine.calculateGame(rules, oldGame).entries.map(row => row.chipMoney), [0, 150, -150, 0]);
  near(total(after, 'grossMoney'), 0);
  reconstructedTransfers(after, Engine.settleBalances(after));
});
