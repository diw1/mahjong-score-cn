/* Independent local settlement of normalized Mahjong Soul records. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PaipuSettlement = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EPS = 1e-8;
  const FIELDS = ['basePT', 'umaPT', 'chips', 'chipPT', 'totalPT', 'money'];
  const OFFICIAL_FIELDS = ['mahjongPT', 'chips', 'chipPT', 'totalPT', 'money'];
  const SOURCES = [{ key: 'aka', label: '红宝牌' }, { key: 'ura', label: '里宝牌' }, { key: 'ippatsu', label: '一发' }, { key: 'yakuman', label: '役满' }];

  class PaipuError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'PaipuError';
      this.code = code || 'INVALID_RECORD';
    }
  }
  function check(condition, message, code) { if (!condition) throw new PaipuError(message, code); }
  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function clean(value) { return Math.abs(value) < EPS ? 0 : Number(value.toFixed(10)); }
  function sum(values) { return values.reduce((total, value) => total + value, 0); }
  function id(value, label) {
    check((typeof value === 'string' && value.trim() !== '') || Number.isSafeInteger(value), (label || '玩家') + ' ID 无效。');
    return String(value);
  }
  function nonnegative(value, label) { check(finite(value) && value >= 0, label + '必须是非负数。', 'INVALID_RULE'); }
  function count(value, label) {
    const result = value === undefined ? 0 : value;
    check(Number.isSafeInteger(result) && result >= 0, label + '必须是非负整数。');
    return result;
  }
  function roundedCents(value) {
    check(finite(value) && Math.abs(value * 100) < Number.MAX_SAFE_INTEGER / 4, '结算金额过大。');
    return Math.sign(value) * Math.floor(Math.abs(value * 100) + 0.5 + EPS);
  }

  // Preserve the total to the cent; distribute fractional cents by largest remainder.
  function moneyCents(values) {
    values.forEach(roundedCents);
    const raw = values.map(value => value * 100);
    const cents = raw.map(value => Math.floor(value + EPS));
    let remaining = roundedCents(sum(values)) - sum(cents);
    check(Number.isSafeInteger(remaining) && Math.abs(remaining) <= values.length, '金额尾差无法分配。');
    const order = raw.map((value, index) => ({ index, remainder: value - cents[index] }))
      .sort((a, b) => remaining >= 0 ? b.remainder - a.remainder || a.index - b.index : a.remainder - b.remainder || a.index - b.index);
    for (let index = 0; remaining !== 0; index++) {
      const step = remaining > 0 ? 1 : -1;
      cents[order[index].index] += step;
      remaining -= step;
    }
    return cents;
  }

  function normalizeRules(input, playerCount) {
    const rules = Object.assign({ chipPT: 3, pointRate: 10, returnPoints: 25000, uma: Array(playerCount).fill(0), tieMode: 'seat', yakumanRonChips: 10, yakumanTsumoChips: 5, doubleYakuman: 'count' }, input || {});
    check(rules.scoreMode === undefined || rules.scoreMode === 'custom' || rules.scoreMode === 'official', '麻将 PT 来源规则无效。', 'INVALID_RULE');
    nonnegative(rules.chipPT, '每祝 PT');
    nonnegative(rules.pointRate, '每 PT 金额');
    check(Number.isSafeInteger(rules.yakumanRonChips) && rules.yakumanRonChips >= 0, '役满荣和每份祝数必须是非负整数。', 'INVALID_RULE');
    check(Number.isSafeInteger(rules.yakumanTsumoChips) && rules.yakumanTsumoChips >= 0, '役满自摸每家每份祝数必须是非负整数。', 'INVALID_RULE');
    check(rules.doubleYakuman === 'count' || rules.doubleYakuman === 'single', '役满倍数处理无效。', 'INVALID_RULE');
    if (rules.scoreMode === 'official') {
      // Official PT already includes the game's own rank/return rules. Keep
      // inactive local options out of the result rather than applying them twice.
      return { scoreMode: 'official', chipPT: rules.chipPT, pointRate: rules.pointRate, tieMode: 'seat',
        yakumanRonChips: rules.yakumanRonChips, yakumanTsumoChips: rules.yakumanTsumoChips, doubleYakuman: rules.doubleYakuman };
    }
    check(Number.isSafeInteger(rules.returnPoints) && rules.returnPoints > 0 && rules.returnPoints % 100 === 0,
      '返还点数必须是正整数且为 100 的倍数。', 'INVALID_RULE');
    // A no-uma profile is equivalent for three and four players; nonzero profiles are not.
    if (Array.isArray(rules.uma) && [3, 4].includes(rules.uma.length) && rules.uma.every(value => value === 0)) {
      rules.uma = Array(playerCount).fill(0);
    }
    check(Array.isArray(rules.uma) && rules.uma.length === playerCount && rules.uma.every(finite), '顺位马数量或数值无效。', 'INVALID_RULE');
    check(Math.abs(sum(rules.uma)) < EPS, '顺位马合计必须为 0。', 'INVALID_RULE');
    check(rules.tieMode === 'seat' || rules.tieMode === 'split', '同分顺位处理无效。', 'INVALID_RULE');
    rules.uma = rules.uma.slice();
    return rules;
  }

  function scoreFields(rules) { return rules.scoreMode === 'official' ? OFFICIAL_FIELDS : FIELDS; }
  function totals(entries, rules) {
    return Object.fromEntries(scoreFields(rules).map(field => [field, clean(sum(entries.map(entry => entry[field])))]));
  }

  function calculate(record, inputRules) {
    check(record && typeof record === 'object', '牌谱记录无效。');
    check(Array.isArray(record.players) && [3, 4].includes(record.players.length), '仅支持三人或四人牌谱。', 'PLAYER_COUNT');
    const playerCount = record.players.length;
    const recordId = id(record.id, '牌谱');
    const rules = normalizeRules(inputRules, playerCount);
    const official = rules.scoreMode === 'official';
    const players = record.players.map(player => {
      check(player && typeof player === 'object', '玩家信息无效。');
      check(Number.isInteger(player.seat) && player.seat >= 0 && player.seat < playerCount, '玩家座位无效。');
      return { id: id(player.id), seat: player.seat, name: typeof player.name === 'string' ? player.name : String(player.id) };
    }).sort((a, b) => a.seat - b.seat);
    check(new Set(players.map(player => player.id)).size === playerCount, '牌谱玩家 ID 不能重复。', 'DUPLICATE_PLAYER');
    check(new Set(players.map(player => player.seat)).size === playerCount, '牌谱座位不能重复。', 'DUPLICATE_SEAT');
    const byId = new Map(players.map(player => [player.id, player]));
    const bySeat = new Map(players.map(player => [player.seat, player]));
    const resolve = (value, label) => {
      const player = typeof value === 'number' ? bySeat.get(value) : byId.get(String(value));
      check(!!player, (label || '和牌') + '玩家无效。');
      return player;
    };
    const startPoints = record.startPoints === undefined ? 25000 : record.startPoints;
    if (!official) check(Number.isSafeInteger(startPoints) && startPoints > 0 && startPoints % 100 === 0, '起始点数无效。');
    check(Array.isArray(record.result) && record.result.length === playerCount, '终局结果不完整。');
    const results = new Map();
    const officialScores = new Map();
    for (const result of record.result) {
      check(result && typeof result === 'object', '终局结果无效。');
      const player = resolve(result.seat, '终局');
      check(!results.has(player.id), '终局结果包含重复玩家。');
      check(Number.isSafeInteger(result.points) && (official || result.points % 100 === 0), official ? '终局点数必须是安全整数。' : '终局点数必须是 100 的整数倍。');
      check(Math.abs(result.points) <= Number.MAX_SAFE_INTEGER / (playerCount + 1), '终局点数过大。');
      results.set(player.id, result.points);
      if (official) {
        check(result.officialPT !== undefined, '牌谱缺少雀魂官方麻将 PT，请重新读取完整原始牌谱。', 'MISSING_OFFICIAL_PT');
        const scaled = finite(result.officialPT) ? Math.round(result.officialPT * 1000) : NaN;
        check(Number.isInteger(scaled) && scaled >= -2147483648 && scaled <= 2147483647 && result.officialPT === scaled / 1000,
          '雀魂官方麻将 PT 必须是有效的官方千分位数值。', 'INVALID_OFFICIAL_PT');
        officialScores.set(player.id, clean(result.officialPT));
      }
    }
    if (!official) check(sum([...results.values()]) === startPoints * playerCount,
      '终局点数合计应为 ' + startPoints * playerCount + '。', 'POINTS_TOTAL');
    check(Array.isArray(record.rounds), '牌谱和牌明细缺失。');
    const entries = players.map(player => ({
      playerId: player.id, seat: player.seat, name: player.name, points: results.get(player.id),
      ...(official ? { mahjongPT: officialScores.get(player.id) } : { basePT: clean((results.get(player.id) - rules.returnPoints) / 1000), umaPT: 0 }),
      rank: 0, chips: 0, chipPT: 0, totalPT: 0, money: 0
    }));
    const entryById = new Map(entries.map(entry => [entry.playerId, entry]));
    const sorted = entries.slice().sort((a, b) => b.points - a.points || a.seat - b.seat);
    for (let position = 0; position < sorted.length;) {
      let end = position + 1;
      if (rules.tieMode === 'split') while (end < sorted.length && sorted[end].points === sorted[position].points) end++;
      const umaPT = official ? 0 : clean(sum(rules.uma.slice(position, end)) / (end - position));
      for (let index = position; index < end; index++) {
        sorted[index].rank = position + 1;
        if (!official) sorted[index].umaPT = umaPT;
      }
      position = end;
    }
    let missingYakuman = false, disabledYakuman = false;
    const events = record.rounds.map((round, index) => {
      check(round && typeof round === 'object', '和牌明细无效。');
      const winner = resolve(round.winner, '和牌');
      check(typeof round.zimo === 'boolean', '和牌明细须说明自摸或荣和。');
      const from = round.zimo ? null : resolve(round.from, '放铳');
      check(!from || from.id !== winner.id, '荣和放铳者不能是和牌者。');
      const aka = count(round.aka, '红宝牌数');
      const ura = count(round.ura, '里宝牌数');
      check(round.menzen === undefined || typeof round.menzen === 'boolean', '门清标记须为布尔值。');
      check(aka === 0 || round.menzen !== undefined, '含红宝牌的和牌缺少门清信息，请重新读取完整原始牌谱。', 'MENZEN_METADATA_REQUIRED');
      const allStar = round.menzen === true && aka === 3;
      const redChips = round.menzen === true ? allStar ? 5 : aka : 0;
      check(round.ippatsu === undefined || typeof round.ippatsu === 'boolean', '一发标记须为布尔值。');
      const chipsPerUnit = round.zimo ? rules.yakumanTsumoChips : rules.yakumanRonChips;
      const hasYakuman = round.yakumanUnits !== undefined;
      check(hasYakuman || chipsPerUnit === 0, '和牌明细缺少役满份数，请重新读取原始牌谱补齐元信息。', 'YAKUMAN_METADATA_REQUIRED');
      const yakumanUnits = hasYakuman ? count(round.yakumanUnits, '役满份数') : 0;
      const chargedUnits = yakumanUnits > 0 ? rules.doubleYakuman === 'single' ? 1 : yakumanUnits : 0;
      const yakuman = chargedUnits * chipsPerUnit;
      check(Number.isSafeInteger(yakuman), '役满祝数过大。');
      if (!hasYakuman) missingYakuman = true;
      if (yakumanUnits > 0 && chipsPerUnit === 0) disabledYakuman = true;
      const counts = { aka: redChips, ura, ippatsu: round.ippatsu ? 1 : 0, yakuman };
      const payers = round.zimo ? players.filter(player => player.id !== winner.id) : [from];
      const delta = new Map(players.map(player => [player.id, 0]));
      const details = SOURCES.filter(source => counts[source.key] > 0 || source.key === 'aka' && aka > 0 || source.key === 'yakuman' && yakumanUnits > 0).map(source => {
        const transfers = counts[source.key] > 0 ? payers.map(payer => ({ from: payer.id, to: winner.id, chips: counts[source.key] })) : [];
        transfers.forEach(transfer => {
          delta.set(transfer.from, delta.get(transfer.from) - transfer.chips);
          delta.set(transfer.to, delta.get(transfer.to) + transfer.chips);
        });
        const label = source.key !== 'aka' ? source.label : allStar ? 'All Star（门清 3 张红 5）' : round.menzen === false ? '红宝牌（副露，' + aka + ' 张不计祝）' : '红宝牌（门清）';
        return { type: source.key, label, count: counts[source.key], transfers,
          ...(source.key === 'aka' ? { akaCount: aka, allStar, menzen: round.menzen } : {}),
          ...(source.key === 'yakuman' ? { yakumanUnits, chargedUnits, chipsPerUnit } : {}) };
      });
      delta.forEach((chips, playerId) => { entryById.get(playerId).chips += chips; });
      const chipsPerPayer = redChips + ura + counts.ippatsu + yakuman;
      return {
        id: round.id === undefined ? recordId + '-win-' + (index + 1) : String(round.id),
        label: typeof round.label === 'string' ? round.label : '和牌 ' + (index + 1),
        winner: winner.id, winnerSeat: winner.seat, from: from ? from.id : null, zimo: round.zimo,
        yakumanUnits: hasYakuman ? yakumanUnits : null,
        details, transfers: chipsPerPayer ? payers.map(payer => ({ from: payer.id, to: winner.id, chips: chipsPerPayer })) : [],
        delta: players.map(player => ({ playerId: player.id, chips: delta.get(player.id) })), chipsPerPayer
      };
    });
    entries.forEach(entry => {
      entry.chipPT = clean(entry.chips * rules.chipPT);
      entry.totalPT = clean((official ? entry.mahjongPT : entry.basePT + entry.umaPT) + entry.chipPT);
      check(finite(entry.totalPT) && Number.isSafeInteger(entry.chips), '祝仪数量或积分过大。');
    });
    const cents = moneyCents(entries.map(entry => entry.totalPT * rules.pointRate));
    entries.forEach((entry, index) => { entry.money = cents[index] === 0 ? 0 : cents[index] / 100; });
    const warnings = [];
    if (missingYakuman) warnings.push('部分和牌明细缺少役满份数；役满祝未计入，请重新读取原始牌谱补齐元信息。');
    if (disabledYakuman) warnings.push('检测到役满，但对应役满祝数设为 0，当前未另计役满祝。');
    if (!official && rules.returnPoints !== startPoints) warnings.push('返点与起始点不同；本模块按素点公式计算，未加入头名奖（Oka），总 PT 和金额可能不为 0。');
    if (!official && rules.uma.some(value => value !== 0)) warnings.push('已使用自定义顺位马；该结果与原站 103 的无顺位马结果不同。');
    return { id: recordId, url: typeof record.url === 'string' ? record.url : '', rules, entries, events, totals: totals(entries, rules), warnings };
  }

  function aggregateRecords(records, rules) {
    check(Array.isArray(records), '牌谱列表无效。');
    if (records.length === 0) {
      const normalized = normalizeRules(rules, rules && Array.isArray(rules.uma) ? rules.uma.length : 4);
      return { records: [], entries: [], totals: totals([], normalized), warnings: [] };
    }
    const seen = new Set();
    const calculated = records.map(record => {
      const key = id(record && record.id, '牌谱');
      check(!seen.has(key), '重复牌谱：' + key + '。', 'DUPLICATE_RECORD');
      seen.add(key);
      return calculate(record, rules);
    });
    const byId = new Map();
    const fields = scoreFields(calculated[0].rules);
    const rankTotals = new Map();
    const centsById = new Map();
    calculated.forEach(result => result.entries.forEach(entry => {
      if (!byId.has(entry.playerId)) {
        byId.set(entry.playerId, { playerId: entry.playerId, name: entry.name, names: [], games: 0,
          ...Object.fromEntries(fields.map(field => [field, 0])), averageRank: 0, firsts: 0, lasts: 0 });
        rankTotals.set(entry.playerId, 0);
        centsById.set(entry.playerId, 0);
      }
      const row = byId.get(entry.playerId);
      row.name = entry.name;
      if (!row.names.includes(entry.name)) row.names.push(entry.name);
      row.games++;
      fields.filter(field => field !== 'money').forEach(field => { row[field] += entry[field]; });
      const tiedCount = result.rules.tieMode === 'split' ? result.entries.filter(other => other.rank === entry.rank).length : 1;
      rankTotals.set(entry.playerId, rankTotals.get(entry.playerId) + entry.rank + (tiedCount - 1) / 2);
      centsById.set(entry.playerId, centsById.get(entry.playerId) + roundedCents(entry.money));
      if (entry.rank === 1) row.firsts++;
      if (entry.rank + tiedCount - 1 === result.entries.length) row.lasts++;
    }));
    const entries = [...byId.values()];
    entries.forEach(row => {
      fields.filter(field => field !== 'money').forEach(field => { row[field] = clean(row[field]); });
      row.money = centsById.get(row.playerId) / 100;
      row.averageRank = clean(rankTotals.get(row.playerId) / row.games);
    });
    const warnings = calculated.flatMap(result => result.warnings.map(warning => '牌谱 ' + result.id + '：' + warning));
    const names = new Map();
    entries.forEach(entry => {
      const existing = names.get(entry.name);
      if (existing && existing !== entry.playerId) warnings.push('昵称“' + entry.name + '”对应不同玩家 ID，已分别统计。');
      else names.set(entry.name, entry.playerId);
    });
    return { records: calculated, entries, totals: totals(entries, calculated[0].rules), warnings };
  }

  return Object.freeze({ calculate, aggregateRecords, PaipuError });
});
