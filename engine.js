/* Original post-game riichi scoring and settlement engine. No external dependencies. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScoreEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TABLE_ID = '__table__';
  const EPSILON = 1e-8;

  class ScoreValidationError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'ScoreValidationError';
      this.code = code || 'INVALID_DATA';
    }
  }

  function fail(message, code) { throw new ScoreValidationError(message, code); }
  function assert(condition, message, code) { if (!condition) fail(message, code); }
  function isNumber(value) { return typeof value === 'number' && Number.isFinite(value); }
  function sum(values) { return values.reduce((total, value) => total + value, 0); }
  function clean(value) { return Math.abs(value) < EPSILON ? 0 : Number(value.toFixed(10)); }
  function idKey(id) {
    assert((typeof id === 'string' && id.trim().length > 0) || Number.isSafeInteger(id), '玩家 ID 无效。');
    assert(String(id) !== TABLE_ID, '玩家 ID 与台费收款方冲突。');
    return String(id);
  }
  function assertUniqueIds(ids, message) {
    const keys = ids.map(idKey);
    assert(new Set(keys).size === keys.length, message || '玩家不能重复。');
    return keys;
  }
  function integer(value, name) { assert(Number.isSafeInteger(value), name + '必须是整数。'); }
  function nonnegative(value, name) { assert(isNumber(value) && value >= 0, name + '必须是非负数。'); }
  function exactCents(value, name) {
    assert(isNumber(value), name + '必须是有效金额。');
    const cents = Math.round(value * 100);
    assert(Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) < EPSILON, name + '最多保留两位小数。');
    return cents;
  }
  function money(cents) { return cents === 0 ? 0 : cents / 100; }

  function defaultRules(playerCount) {
    const count = playerCount === undefined ? 4 : playerCount;
    assert(count === 3 || count === 4, '仅支持三人或四人日麻。');
    return {
      playerCount: count,
      startPoints: 25000,
      returnPoints: 25000,
      uma: count === 3 ? [20, 0, -20] : [15, 5, -5, -15],
      tieMode: 'seat',
      rounding: 'fiveSix',
      pointRate: 0,
      chipPT: 3,
      chipValue: 0,
      tobiBonusPT: 0,
      yakitoriPT: 0,
      yakitoriMode: 'person',
      negativeSettlement: true
    };
  }

  function validateRules(input) {
    assert(input && typeof input === 'object', '缺少场次规则。');
    const rules = Object.assign(defaultRules(input.playerCount), input);
    // Old backups stored direct chip money only; a missing PT rate must not change their scores.
    rules.chipPT = Object.prototype.hasOwnProperty.call(input, 'chipPT') ? input.chipPT : 0;
    assert(rules.playerCount === 3 || rules.playerCount === 4, '仅支持三人或四人日麻。');
    integer(rules.startPoints, '起始点数');
    integer(rules.returnPoints, '返点');
    assert(rules.startPoints > 0 && rules.startPoints % 100 === 0, '起始点数必须是正数且为 100 的倍数。');
    assert(rules.returnPoints > 0 && rules.returnPoints % 100 === 0, '返点必须是正数且为 100 的倍数。');
    assert(Number.isSafeInteger(rules.startPoints * rules.playerCount), '起始点数过大。');
    assert(Array.isArray(rules.uma) && rules.uma.length === rules.playerCount, '顺位马数量必须与人数一致。');
    assert(rules.uma.every(isNumber) && Math.abs(sum(rules.uma)) < EPSILON, '顺位马必须是有效数字且合计为 0。');
    assert(rules.tieMode === 'split' || rules.tieMode === 'seat', '并列处理方式无效。');
    assert(['none', 'round', 'fiveSix', 'ceil', 'floor'].includes(rules.rounding), '素点取整方式无效。');
    nonnegative(rules.pointRate, '点数兑换率');
    nonnegative(rules.chipPT, '每祝价值');
    assert(Math.abs(rules.chipPT * 10 - Math.round(rules.chipPT * 10)) < EPSILON, '每祝价值最多保留一位小数。');
    nonnegative(rules.chipValue, '祝仪单价');
    nonnegative(rules.tobiBonusPT, '飞人奖励');
    nonnegative(rules.yakitoriPT, '烧鸡罚分');
    assert(rules.yakitoriMode === 'person' || rules.yakitoriMode === 'table', '烧鸡罚分方式无效。');
    assert(typeof rules.negativeSettlement === 'boolean', '负点结算设置无效。');
    assert(rules.negativeSettlement,
      '暂未支持关闭负点结算；负分玩家须按实际终局点数结算。', 'UNSUPPORTED_RULE');
    return rules;
  }

  function gameRules(inputRules, game) {
    const base = validateRules(inputRules);
    const override = game && (game.rules || game.rulesOverride);
    if (!override) return base;
    assert(typeof override === 'object' && !Array.isArray(override), '本局规则覆盖无效。');
    const merged = Object.assign({}, base, override);
    if (Object.prototype.hasOwnProperty.call(override, 'playerCount') && !Object.prototype.hasOwnProperty.call(override, 'chipPT')) merged.chipPT = 0;
    const rules = validateRules(merged);
    assert(rules.playerCount === base.playerCount, '本局规则不能改变场次人数。');
    return rules;
  }

  function roundPT(value, mode) {
    if (mode === 'round') return Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
    if (mode === 'fiveSix') return Math.sign(value) * Math.floor(Math.abs(value) + 0.4 + EPSILON);
    if (mode === 'ceil') return Math.ceil(value);
    if (mode === 'floor') return Math.floor(value);
    return value;
  }

  // Allocate fractional cents deterministically while preserving the requested total.
  function allocateCents(values, targetCents) {
    const raw = values.map(value => value * 100);
    assert(raw.every(value => isNumber(value) && Math.abs(value) < Number.MAX_SAFE_INTEGER / 4), '结算金额过大。');
    const cents = raw.map(value => Math.floor(value + EPSILON));
    let difference = targetCents - sum(cents);
    assert(Number.isSafeInteger(difference) && Math.abs(difference) <= values.length, '金额无法保持收支平衡。');
    const order = raw.map((value, index) => ({ index, remainder: value - cents[index] }))
      .sort((a, b) => difference >= 0 ? b.remainder - a.remainder || a.index - b.index : a.remainder - b.remainder || a.index - b.index);
    for (let i = 0; difference !== 0; i++) {
      const direction = difference > 0 ? 1 : -1;
      cents[order[i].index] += direction;
      difference -= direction;
    }
    return cents;
  }

  function calculateGame(inputRules, game) {
    const rules = gameRules(inputRules, game);
    assert(game && Array.isArray(game.players), '缺少终局分数。');
    assert(game.players.length === rules.playerCount, '终局玩家人数与规则不一致。');
    assert(game.players.every(player => player && typeof player === 'object'), '终局玩家数据无效。');
    assertUniqueIds(game.players.map(player => player.playerId));
    const players = game.players.map((player, seat) => {
      integer(player.points, '终局点数');
      assert(player.points % 100 === 0, '终局点数必须为 100 的倍数。');
      const chips = player.chips === undefined ? 0 : player.chips;
      integer(chips, '祝仪数量');
      assert(player.yakitori === undefined || typeof player.yakitori === 'boolean', '烧鸡标记无效。');
      return { playerId: player.playerId, points: player.points, chips, yakitori: player.yakitori === true, seat };
    });
    assert(sum(players.map(player => player.points)) === rules.playerCount * rules.startPoints,
      '终局点数合计必须为 ' + rules.playerCount * rules.startPoints + '。', 'POINTS_TOTAL');
    if (rules.chipPT > 0 || rules.chipValue > 0) assert(sum(players.map(player => player.chips)) === 0, '祝仪收支合计必须为 0。', 'CHIPS_TOTAL');
    const sorted = players.slice().sort((a, b) => b.points - a.points || a.seat - b.seat);
    const resultBySeat = new Array(players.length);
    const warnings = [];
    const okaPT = rules.playerCount * (rules.returnPoints - rules.startPoints) / 1000;
    const topCount = rules.tieMode === 'split' ? sorted.filter(player => player.points === sorted[0].points).length : 1;

    for (let position = 0; position < sorted.length;) {
      let end = position + 1;
      if (rules.tieMode === 'split') while (end < sorted.length && sorted[end].points === sorted[position].points) end++;
      const groupSize = end - position;
      const groupUma = sum(rules.uma.slice(position, end)) / groupSize;
      for (let index = position; index < end; index++) {
        const player = sorted[index];
        resultBySeat[player.seat] = {
          playerId: player.playerId,
          points: player.points,
          rank: position + 1,
          scorePT: roundPT(player.points / 1000, rules.rounding) - rules.returnPoints / 1000 + groupUma + (position === 0 ? okaPT / topCount : 0),
          chipNet: player.chips,
          pointMoney: 0,
          chipMoney: 0,
          money: 0
        };
      }
      position = end;
    }

    const roundingDifference = -sum(resultBySeat.map(entry => entry.scorePT));
    if (Math.abs(roundingDifference) > EPSILON) {
      for (const player of sorted.slice(0, topCount)) resultBySeat[player.seat].scorePT += roundingDifference / topCount;
      warnings.push('素点取整尾差 ' + clean(roundingDifference) + ' PT 已计入头名，保持积分收支平衡。');
    }

    if (rules.yakitoriPT > 0) {
      const flagged = players.filter(player => player.yakitori);
      const receivers = players.filter(player => !player.yakitori);
      if (flagged.length > 0 && receivers.length === 0) {
        warnings.push('本局全部玩家均标记烧鸡，无可收款者，未扣烧鸡罚分。');
      } else if (flagged.length > 0) {
        const paid = rules.yakitoriMode === 'person' ? rules.yakitoriPT * receivers.length : rules.yakitoriPT / flagged.length;
        const received = rules.yakitoriMode === 'person' ? rules.yakitoriPT * flagged.length : rules.yakitoriPT / receivers.length;
        flagged.forEach(player => { resultBySeat[player.seat].scorePT -= paid; });
        receivers.forEach(player => { resultBySeat[player.seat].scorePT += received; });
      }
    }

    if (rules.tobiBonusPT > 0) {
      let transfers = game.tobiTransfers;
      if (transfers === undefined || transfers === null) {
        transfers = game.tobiWinnerId === undefined || game.tobiWinnerId === null || game.tobiWinnerId === '' ? [] :
          players.filter(player => player.points <= 0 && idKey(player.playerId) !== idKey(game.tobiWinnerId))
            .map(player => ({ from: player.playerId, to: game.tobiWinnerId }));
      }
      assert(Array.isArray(transfers), '飞人奖励记录无效。');
      const playerById = new Map(players.map(player => [idKey(player.playerId), player]));
      const paidBy = new Set();
      for (const transfer of transfers) {
        assert(transfer && typeof transfer === 'object', '飞人奖励记录无效。');
        const fromKey = idKey(transfer.from);
        const toKey = idKey(transfer.to);
        assert(playerById.has(fromKey) && playerById.has(toKey), '飞人奖励双方必须为本局玩家。');
        assert(fromKey !== toKey, '飞人奖励不能付给自己。');
        assert(!paidBy.has(fromKey), '每位被击飞玩家只能支付一次飞人奖励。');
        const from = playerById.get(fromKey);
        const to = playerById.get(toKey);
        assert(from.points <= 0, '飞人奖励付款人的终局点数必须为 0 或负数。');
        paidBy.add(fromKey);
        resultBySeat[from.seat].scorePT -= rules.tobiBonusPT;
        resultBySeat[to.seat].scorePT += rules.tobiBonusPT;
      }
      if (players.some(player => player.points <= 0 && !paidBy.has(idKey(player.playerId)))) {
        warnings.push('存在 0 分或负分玩家未选择飞人奖励收款人，该项奖励尚未计入。');
      }
    }

    resultBySeat.forEach(entry => {
      entry.mahjongPT = clean(entry.scorePT);
      entry.chipScorePT = clean(entry.chipNet * rules.chipPT);
      entry.scorePT = clean(entry.mahjongPT + entry.chipScorePT);
    });
    const pointCents = allocateCents(resultBySeat.map(entry => entry.scorePT * rules.pointRate), 0);
    const chipCents = allocateCents(resultBySeat.map(entry => entry.chipNet * rules.chipValue), 0);
    resultBySeat.forEach((entry, index) => {
      entry.pointMoney = money(pointCents[index]);
      entry.chipMoney = money(chipCents[index]);
      entry.money = money(pointCents[index] + chipCents[index]);
    });
    return { entries: resultBySeat, warnings };
  }

  function aggregateSession(session) {
    assert(session && typeof session === 'object', '场次数据无效。');
    const rules = validateRules(session.rules);
    assert(Array.isArray(session.playerIds) && session.playerIds.length >= rules.playerCount, '场次玩家数量不足。');
    const keys = assertUniqueIds(session.playerIds);
    assert(Array.isArray(session.games), '场次对局列表无效。');
    const rows = session.playerIds.map(playerId => ({
      playerId, games: 0, totalPT: 0, chips: 0, grossMoney: 0, fee: 0, netMoney: 0,
      mahjongPT: 0, chipScorePT: 0, legacyChipNet: 0,
      finalChipNet: 0, finalChipScorePT: 0, finalChipMoney: 0,
      averageRank: 0, firsts: 0, lasts: 0, busts: 0
    }));
    const rowById = new Map(rows.map(row => [idKey(row.playerId), row]));
    const rankTotals = new Map(keys.map(key => [key, 0]));
    const moneyTotals = new Map(keys.map(key => [key, 0]));
    for (const game of session.games) {
      const result = calculateGame(rules, game);
      const effectiveRules = gameRules(rules, game);
      for (const entry of result.entries) {
        const key = idKey(entry.playerId);
        assert(rowById.has(key), '对局包含未登记的场次玩家。');
        const row = rowById.get(key);
        const tiedCount = effectiveRules.tieMode === 'split' ? result.entries.filter(other => other.rank === entry.rank).length : 1;
        row.games++;
        row.mahjongPT += entry.mahjongPT;
        row.chipScorePT += entry.chipScorePT;
        row.totalPT += entry.scorePT;
        row.legacyChipNet += entry.chipNet;
        row.chips += entry.chipNet;
        moneyTotals.set(key, moneyTotals.get(key) + exactCents(entry.money, '对局金额'));
        rankTotals.set(key, rankTotals.get(key) + entry.rank + (tiedCount - 1) / 2);
        if (entry.rank === 1) row.firsts++;
        if (entry.rank + tiedCount - 1 === rules.playerCount) row.lasts++;
        if (entry.points < 0) row.busts++;
      }
    }
    // Final room-wide chip quantities are an additional settlement, never repeated per game.
    const finalChips = session.finalChips;
    if (finalChips !== undefined && finalChips !== null) {
      assert(typeof finalChips === 'object' && !Array.isArray(finalChips), '整场祝仪数量记录无效。');
      assert(Object.keys(finalChips).every(key => rowById.has(key)), '整场祝仪包含未登记的玩家。');
      rows.forEach((row, index) => {
        const key = keys[index];
        const count = Object.prototype.hasOwnProperty.call(finalChips, key) ? finalChips[key] : 0;
        integer(count, '整场祝仪数量');
        row.finalChipNet = count;
        row.finalChipScorePT = clean(count * rules.chipPT);
        assert(isNumber(row.finalChipScorePT), '整场祝仪积分过大。');
        row.chips += count;
        row.chipScorePT += row.finalChipScorePT;
        row.totalPT += row.finalChipScorePT;
      });
    }
    if (rules.chipPT > 0) {
      assert(sum(rows.map(row => row.finalChipNet)) === 0, '整场祝仪净数量合计必须为 0。', 'CHIPS_TOTAL');
    }
    const finalChipCents = allocateCents(rows.map(row => row.finalChipScorePT * rules.pointRate), 0);
    rows.forEach((row, index) => {
      const key = keys[index];
      row.finalChipMoney = money(finalChipCents[index]);
      moneyTotals.set(key, moneyTotals.get(key) + finalChipCents[index]);
    });
    const tableFee = session.tableFee === undefined ? 0 : session.tableFee;
    nonnegative(tableFee, '台费');
    const tableFeeCents = exactCents(tableFee, '台费');
    let feeCents;
    if (session.fees === undefined || session.fees === null) {
      feeCents = allocateCents(rows.map(() => tableFee / rows.length), tableFeeCents);
    } else {
      assert(typeof session.fees === 'object' && !Array.isArray(session.fees), '玩家台费分配无效。');
      assert(Object.keys(session.fees).every(key => rowById.has(key)), '台费包含未登记的玩家。');
      feeCents = keys.map(key => {
        const fee = Object.prototype.hasOwnProperty.call(session.fees, key) ? session.fees[key] : 0;
        nonnegative(fee, '玩家台费');
        return exactCents(fee, '玩家台费');
      });
      assert(sum(feeCents) === tableFeeCents, '玩家台费合计必须等于场次台费。', 'FEES_TOTAL');
    }
    rows.forEach((row, index) => {
      const key = keys[index];
      row.mahjongPT = clean(row.mahjongPT);
      row.chipScorePT = clean(row.chipScorePT);
      row.totalPT = clean(row.totalPT);
      row.grossMoney = money(moneyTotals.get(key));
      row.fee = money(feeCents[index]);
      row.netMoney = money(moneyTotals.get(key) - feeCents[index]);
      row.averageRank = row.games ? clean(rankTotals.get(key) / row.games) : 0;
    });
    return rows;
  }

  function settleBalances(rows) {
    assert(Array.isArray(rows), '结算列表无效。');
    assert(rows.every(row => row && typeof row === 'object'), '结算玩家数据无效。');
    assertUniqueIds(rows.map(row => row.playerId));
    let totalFeeCents = 0;
    const balances = rows.map(row => {
      const fee = row.fee === undefined ? 0 : row.fee;
      nonnegative(fee, '玩家台费');
      totalFeeCents += exactCents(fee, '玩家台费');
      return { id: row.playerId, cents: exactCents(row.netMoney, '玩家净额') };
    });
    if (totalFeeCents > 0) balances.push({ id: TABLE_ID, cents: totalFeeCents });
    assert(sum(balances.map(balance => balance.cents)) === 0, '净额与台费收支不平衡，无法结算。', 'BALANCE_TOTAL');
    const creditors = balances.filter(balance => balance.cents > 0).sort((a, b) => b.cents - a.cents);
    const debtors = balances.filter(balance => balance.cents < 0).map(balance => ({ id: balance.id, cents: -balance.cents }))
      .sort((a, b) => b.cents - a.cents);
    const transfers = [];
    let debtorIndex = 0;
    let creditorIndex = 0;
    while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
      const debtor = debtors[debtorIndex];
      const creditor = creditors[creditorIndex];
      const cents = Math.min(debtor.cents, creditor.cents);
      transfers.push({ from: debtor.id, to: creditor.id, amount: money(cents) });
      debtor.cents -= cents;
      creditor.cents -= cents;
      if (debtor.cents === 0) debtorIndex++;
      if (creditor.cents === 0) creditorIndex++;
    }
    return transfers;
  }

  return Object.freeze({ defaultRules, calculateGame, aggregateSession, settleBalances, ScoreValidationError, TABLE_ID });
});
