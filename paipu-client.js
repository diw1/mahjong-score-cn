/* Independent Mahjong Soul replay decoder. No account login or external runtime dependency. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PaipuClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const MAX_BYTES = 24 * 1024 * 1024;
  const VERSION = 'web-0.11.252';
  const EN_GATEWAY = 'wss://engs.mahjongsoul.com/gateway';
  // Public converter mapping: honvl/Majsoul-to-NAGA, downloadlogsnaga.js YAKU_NAMES.
  const FAN_IDS = { ippatsu: 30, ura: 33, aka: 32 };
  const YAKUMAN_IDS = new Set([35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
  class PaipuError extends Error {
    constructor(code, message, details) { super(message); this.name = 'PaipuError'; this.code = code; if (details) this.details = details; }
  }
  const fail = (code, message, details) => { throw new PaipuError(code, message, details); };
  const check = (ok, message) => { if (!ok) fail('INVALID_RECORD', message); };
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const number = value => Number(value);
  const field = (object, snake, camel) => object && (object[snake] !== undefined ? object[snake] : object[camel]);
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  function bytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (typeof input === 'string') {
      try {
        const decoded = root.atob ? root.atob(input) : Buffer.from(input, 'base64').toString('binary');
        return Uint8Array.from(decoded, c => c.charCodeAt(0));
      } catch (_) { fail('INVALID_RECORD', '牌谱二进制或 Base64 格式无效。'); }
    }
    fail('INVALID_RECORD', '需要牌谱二进制、JSON 或 Base64 数据。');
  }
  function text(data) { try { return utf8.decode(data); } catch (_) { fail('INVALID_RECORD', '牌谱字符串编码无效。'); } }
  function readVarint(data, position) {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      check(position.i < data.length, '牌谱整数不完整。');
      const b = data[position.i++];
      value |= BigInt(b & 127) << shift;
      if (!(b & 128)) return value;
    }
    fail('INVALID_RECORD', '牌谱整数编码过长。');
  }
  function message(input) {
    const data = bytes(input);
    check(data.byteLength <= MAX_BYTES, '牌谱文件超过 24 MiB 限制。');
    const position = { i: 0 }, fields = new Map();
    let count = 0;
    while (position.i < data.length) {
      check(++count <= 250000, '牌谱字段过多。');
      const tag = Number(readVarint(data, position));
      const id = tag >>> 3, wire = tag & 7;
      check(id > 0, '牌谱字段编号无效。');
      let value;
      if (wire === 0) value = readVarint(data, position);
      else if (wire === 2) {
        const length = Number(readVarint(data, position));
        check(Number.isSafeInteger(length) && length >= 0 && position.i + length <= data.length, '牌谱字节长度无效。');
        value = data.subarray(position.i, position.i + length); position.i += length;
      } else if (wire === 1 || wire === 5) {
        const length = wire === 1 ? 8 : 4;
        check(position.i + length <= data.length, '牌谱定长字段不完整。');
        value = data.subarray(position.i, position.i + length); position.i += length;
      } else fail('INVALID_RECORD', '不支持的 Protobuf 字段类型。');
      if (!fields.has(id)) fields.set(id, []);
      fields.get(id).push({ wire, value });
    }
    return fields;
  }
  const all = (m, id) => m.get(id) || [];
  const raw = (m, id) => all(m, id).find(x => x.wire === 2)?.value;
  const uint = (m, id) => Number(all(m, id).find(x => x.wire === 0)?.value || 0n);
  const int = (m, id) => Number(BigInt.asIntN(32, all(m, id).find(x => x.wire === 0)?.value || 0n));
  const string = (m, id) => raw(m, id) ? text(raw(m, id)) : '';
  const nested = (m, id, decode) => all(m, id).filter(x => x.wire === 2).map(x => decode(message(x.value)));
  function ints(m, id) {
    return all(m, id).flatMap(item => {
      if (item.wire === 0) return [Number(BigInt.asIntN(32, item.value))];
      check(item.wire === 2, '点数字段类型无效。');
      const position = { i: 0 }, output = [];
      while (position.i < item.value.length) output.push(Number(BigInt.asIntN(32, readVarint(item.value, position))));
      return output;
    });
  }
  function wrapper(input) {
    if (input && typeof input === 'object' && typeof input.name === 'string' && own(input, 'data')) return input;
    const m = message(input);
    return { name: string(m, 1), data: raw(m, 2) || new Uint8Array() };
  }
  function head(m) {
    const account = data => ({ account_id: uint(data, 1), seat: uint(data, 2), nickname: string(data, 3) });
    const result = raw(m, 12) ? message(raw(m, 12)) : new Map();
    return { uuid: string(m, 1), accounts: [...nested(m, 11, account), ...nested(m, 13, account)], result: { players: nested(result, 1, item => ({ seat: uint(item, 1), part_point_1: int(item, 3), total_point: int(item, 2) })) } };
  }
  function response(input) {
    const m = message(input), error = raw(m, 1) ? message(raw(m, 1)) : new Map();
    return { error: { code: uint(error, 1) }, head: raw(m, 3) ? head(message(raw(m, 3))) : null, data: raw(m, 4), data_url: string(m, 5) };
  }
  function serverError(code) {
    if (!code) return;
    if (Number(code) === 1004) fail('ERR_NOT_LOGIN', '雀魂官方接口要求登录，匿名连接不能读取此牌谱。可导入已取得的原始牌谱文件；本工具不会读取账号或登录凭据。', { serverCode: 1004 });
    fail('SERVER_ERROR', '雀魂返回错误代码 ' + code + '，未取得牌谱。', { serverCode: Number(code) });
  }
  function detailEvents(input) {
    if (input && typeof input === 'object' && !(input instanceof Uint8Array) && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer)) {
      const actions = input.actions || [];
      const records = actions.length ? actions.map(a => a.result).filter(Boolean) : (input.records || []);
      check(Array.isArray(records) && records.length <= 100000, '牌谱事件列表无效。');
      if (!records.length) fail('UNSUPPORTED_RECORD_VERSION', '牌谱没有可解码事件，不能生成祝仪结果。');
      return records.map(event => typeof event === 'object' && typeof event.name === 'string' ? event : wrapper(event));
    }
    const m = message(input), actions = nested(m, 3, a => raw(a, 3)).filter(Boolean);
    const records = actions.length ? actions : all(m, 1).filter(x => x.wire === 2).map(x => x.value);
    check(records.length <= 100000, '牌谱事件过多。');
    if (!records.length) fail('UNSUPPORTED_RECORD_VERSION', '牌谱没有可解码事件，不能生成祝仪结果。');
    return records.map(wrapper);
  }
  function eventData(event) {
    if (event.data && typeof event.data === 'object' && !(event.data instanceof Uint8Array) && !ArrayBuffer.isView(event.data) && !(event.data instanceof ArrayBuffer)) return event.data;
    const m = message(event.data || new Uint8Array());
    const name = event.name.split('.').pop();
    if (name === 'RecordNewRound') return { chang: uint(m, 1), ju: uint(m, 2), ben: uint(m, 3), scores: ints(m, 5) };
    if (name === 'RecordDiscardTile' || name === 'RecordAnGangAddGang') return { seat: uint(m, 1) };
    if (name === 'RecordNoTile') return { scores: nested(m, 3, item => ({ old_scores: ints(item, 2), delta_scores: ints(item, 3) })), hules_history: nested(m, 9, () => ({})) };
    if (name === 'RecordLiuJu') return { gameend: raw(m, 2) ? { scores: ints(message(raw(m, 2)), 1) } : null, hules_history: nested(m, 9, () => ({})) };
    if (name === 'RecordHule') return { scores: ints(m, 5), old_scores: ints(m, 2), delta_scores: ints(m, 3), gameend: raw(m, 6) ? { scores: ints(message(raw(m, 6)), 1) } : null, hules: nested(m, 1, h => ({
      seat: uint(h, 4), zimo: !!uint(h, 5), yiman: !!uint(h, 10), count: uint(h, 11), hand: all(h, 1).map(x => text(x.value)),
      fans: nested(h, 12, f => ({ name: string(f, 1), val: uint(f, 2), id: uint(f, 3) }))
    })) };
    return {};
  }
  function metric(fans, kind) {
    const names = { ippatsu: /一发|一發|一発|ippatsu/i, aka: /赤(?:ドラ|宝|寶)|红(?:宝|寶)|紅(?:宝|寶)|aka/i, ura: /裏(?:ドラ|宝|寶)|里(?:宝|寶)|ura/i };
    return fans.reduce((total, fan) => {
      const matched = Number(fan.id) > 0 ? Number(fan.id) === FAN_IDS[kind] : names[kind].test(fan.name || '');
      if (!matched) return total;
      const value = fan.val === undefined ? 1 : Number(fan.val);
      check(Number.isSafeInteger(value) && value >= 0 && value <= 100, '役种数量无效。');
      return total + value;
    }, 0);
  }
  function yakumanUnits(hule) {
    // HuleInfo.yiman (field 10) distinguishes true yakuman from kazoe.
    // HuleInfo.count (11) is the total multiplier only when yiman is true.
    // Each true-yakuman FanInfo.val is its multiplier, including double yakuman.
    const fans = hule.fans;
    if (!Array.isArray(fans) || !fans.length) fail('YAKUMAN_METADATA_REQUIRED', '和牌缺少完整役种信息，请重新读取原始牌谱。');
    check(hule.yiman === undefined || typeof hule.yiman === 'boolean', '役满标记无效。');
    // The official false flag is authoritative, including local-yaku rule variants.
    if (hule.yiman === false) return 0;
    const identified = fans.filter(f => YAKUMAN_IDS.has(Number(f.id)));
    if (!hule.yiman && !identified.length) return 0;
    let identifiedUnits = 0;
    for (const fan of identified) {
      check(Number.isSafeInteger(fan.val) && fan.val > 0 && fan.val <= 100, '役满倍数信息无效。');
      identifiedUnits += fan.val;
    }
    check(identifiedUnits <= 100, '役满倍数过大。');
    if (hule.yiman === true && hule.count !== undefined && hule.count !== 0) {
      check(Number.isSafeInteger(hule.count) && hule.count > 0 && hule.count <= 100, '役满总倍数无效。');
      check(identifiedUnits <= hule.count && (identified.length !== fans.length || identifiedUnits === hule.count), '役满总倍数与役种不一致。');
      return hule.count;
    }
    // Older JSON may omit the boolean/count while retaining precise official IDs.
    if (identifiedUnits > 0 && (hule.yiman !== true || identified.length === fans.length)) return identifiedUnits;
    fail('YAKUMAN_METADATA_REQUIRED', '无法核实此和牌的役满倍数，请重新读取原始牌谱。');
  }
  function normalize(sourceHead, events, metadata) {
    const h = sourceHead || metadata.head || {};
    const accounts = h.accounts || metadata.players || [];
    const recordId = String(h.uuid || metadata.id || '');
    const players = accounts.map((p, index) => {
      const seat = Number(p.seat === undefined ? 0 : p.seat);
      const accountId = field(p, 'account_id', 'accountId');
      check(p.id !== undefined || accountId || recordId, '缺少可区分匿名玩家的牌谱 ID。');
      return { id: String(p.id !== undefined ? p.id : accountId ? accountId : recordId + ':seat-' + seat), seat, name: p.name || p.nickname || '玩家' + (seat + 1) };
    });
    const rounds = []; let lastSource = null, currentLabel = '', firstScores = null, roundOpen = false, terminals = 0, terminalScores = null;
    events.forEach((event, index) => {
      const name = event.name.split('.').pop(), d = eventData(event);
      if (name.startsWith('RecordHule') && name !== 'RecordHule') fail('UNSUPPORTED_MODE', '当前只支持普通日麻牌谱，不支持此特殊和牌模式。');
      if (name === 'RecordNewRound') {
        if (roundOpen) fail('TRUNCATED_RECORD', '原始牌谱缺少上一局的终局事件，不能计算祝仪。');
        check(Array.isArray(d.scores) && d.scores.length === players.length, '开局点数不完整。');
        roundOpen = true; terminalScores = null;
        currentLabel = ['东', '南', '西', '北'][d.chang || 0] + ((d.ju || 0) + 1) + '局 ' + (d.ben || 0) + '本场';
        if (!firstScores && d.scores?.length) firstScores = d.scores;
        lastSource = null;
      }
      if (name === 'RecordDiscardTile' || name === 'RecordAnGangAddGang') lastSource = Number(d.seat || 0);
      if (name === 'RecordHule') {
        check(roundOpen, '和牌事件缺少对应的开局。');
        check(Array.isArray(d.hules) && d.hules.length > 0, '和牌事件没有和牌者。');
        (d.hules || []).forEach((hule, winIndex) => {
          const zimo = hule.zimo === true, winner = Number(hule.seat || 0);
          const from = zimo ? null : (hule.from !== undefined ? Number(hule.from) : lastSource);
          check(zimo || Number.isInteger(from), '荣和事件缺少可核实的放铳者。');
          rounds.push({ id: 'win-' + index + '-' + winIndex, label: currentLabel || '和牌 ' + (rounds.length + 1), winner, from, zimo,
            aka: metric(hule.fans || [], 'aka'), ura: metric(hule.fans || [], 'ura'), ippatsu: metric(hule.fans || [], 'ippatsu') > 0, yakumanUnits: yakumanUnits(hule) });
        });
        const ending = d.gameend?.scores?.length ? d.gameend.scores : d.scores;
        terminalScores = ending?.length ? ending : d.old_scores?.length === players.length && d.delta_scores?.length === players.length ? d.old_scores.map((n, i) => n + d.delta_scores[i]) : null;
        check(terminalScores && terminalScores.length === players.length && terminalScores.every(Number.isSafeInteger), '和牌终局点数不完整。');
        roundOpen = false; terminals++;
      }
      if (name === 'RecordNoTile' || name === 'RecordLiuJu') {
        check(roundOpen, '流局事件缺少对应的开局。');
        if ((field(d, 'hules_history', 'hulesHistory') || []).length) fail('UNSUPPORTED_MODE', '当前不支持含特殊和牌历史的流局模式。');
        // Draw-end deposits can be awarded in head.result; never use an earlier win as a substitute.
        terminalScores = d.gameend?.scores?.length ? d.gameend.scores : null;
        if (!terminalScores && d.scores?.length === 1) {
          const oldScores = field(d.scores[0], 'old_scores', 'oldScores'), deltas = field(d.scores[0], 'delta_scores', 'deltaScores');
          if (oldScores?.length === players.length && deltas?.length === players.length) terminalScores = oldScores.map((n, i) => n + deltas[i]);
        }
        roundOpen = false; terminals++;
      }
    });
    if (!firstScores || roundOpen || !terminals) fail('TRUNCATED_RECORD', '原始牌谱没有完整的开局与终局事件，不能生成祝仪结果。');
    const resultPlayers = h.result?.players;
    if (!resultPlayers?.length && !metadata.result) fail('RECORD_METADATA_REQUIRED', '牌谱缺少权威终局结果，需要同时导入 head.result 或明确的终局点数。');
    const result = resultPlayers?.length ? resultPlayers.map(p => ({ seat: Number(p.seat || 0), points: Number(field(p, 'part_point_1', 'partPoint1') || 0) })) : metadata.result;
    if (terminalScores && result.some(p => terminalScores[p.seat] !== p.points)) fail('INVALID_RECORD', '原始牌谱最后点数与权威终局结果不一致。');
    const startPoints = metadata.startPoints !== undefined ? metadata.startPoints : firstScores && firstScores.every(n => n === firstScores[0]) ? firstScores[0] : 25000;
    return validateRecord({ id: h.uuid || metadata.id || '', url: metadata.url || '', players, rounds, result, startPoints });
  }
  function validateRecord(input) {
    check(input && typeof input === 'object', '牌谱内容无效。');
    check(Array.isArray(input.players) && [3, 4].includes(input.players.length), '仅支持完整的三人或四人牌谱。');
    const count = input.players.length, ids = new Set(), seats = new Set();
    const players = input.players.map(p => {
      check(p && Number.isInteger(p.seat) && p.seat >= 0 && p.seat < count, '牌谱座位无效。');
      check((typeof p.id === 'string' || Number.isSafeInteger(p.id)) && String(p.id).length > 0 && String(p.id).length <= 100 && !ids.has(String(p.id)) && !seats.has(p.seat), '牌谱玩家 ID 或座位重复。');
      check(typeof p.name === 'string' && p.name.trim() && p.name.length <= 100, '牌谱玩家姓名无效。');
      ids.add(String(p.id)); seats.add(p.seat); return { id: String(p.id), seat: p.seat, name: p.name.trim() };
    }).sort((a, b) => a.seat - b.seat);
    check(Number.isSafeInteger(input.startPoints) && input.startPoints > 0 && input.startPoints <= 1000000, '牌谱起始点数无效。');
    check(Array.isArray(input.result) && input.result.length === count, '牌谱缺少完整终局点数。');
    const resultSeats = new Set();
    const result = input.result.map(p => {
      check(p && seats.has(p.seat) && !resultSeats.has(p.seat) && Number.isSafeInteger(p.points) && Math.abs(p.points) <= 10000000, '终局点数或座位无效。');
      resultSeats.add(p.seat); return { seat: p.seat, points: p.points };
    }).sort((a, b) => a.seat - b.seat);
    check(result.reduce((n, p) => n + p.points, 0) === input.startPoints * count, '终局点数总和与起始点数不符。');
    check(Array.isArray(input.rounds) && input.rounds.length <= 10000, '和牌事件列表无效。');
    const rounds = input.rounds.map((r, index) => {
      check(r && seats.has(r.winner) && typeof r.zimo === 'boolean', '和牌者或自摸标记无效。');
      check(r.zimo || (seats.has(r.from) && r.from !== r.winner), '放铳者无效。');
      for (const key of ['aka', 'ura']) check(Number.isSafeInteger(r[key]) && r[key] >= 0 && r[key] <= 100, '祝仪役种数量无效。');
      check(typeof r.ippatsu === 'boolean', '一发标记无效。');
      const clean = { id: String(r.id || 'win-' + index).slice(0, 100), label: String(r.label || '和牌 ' + (index + 1)).slice(0, 100), winner: r.winner, from: r.zimo ? null : r.from, zimo: r.zimo, aka: r.aka, ura: r.ura, ippatsu: r.ippatsu };
      // Preserve unknown metadata in old normalized files; never label it zero.
      if (r.yakumanUnits !== undefined) {
        check(Number.isSafeInteger(r.yakumanUnits) && r.yakumanUnits >= 0 && r.yakumanUnits <= 100, '役满倍数无效。');
        clean.yakumanUnits = r.yakumanUnits;
      }
      return clean;
    });
    return { id: String(input.id || '').slice(0, 150), url: String(input.url || '').slice(0, 2048), players, rounds, result, startPoints: input.startPoints };
  }
  function parseRecord(input, metadata = {}) {
    if (typeof input === 'string' && /^[\s]*[\[{]/.test(input)) {
      try { input = JSON.parse(input); } catch (_) { fail('INVALID_RECORD', 'JSON 牌谱格式无效。'); }
    }
    if (input && typeof input === 'object' && Array.isArray(input.players) && Array.isArray(input.rounds) && Array.isArray(input.result)) return validateRecord(input);
    let sourceHead = metadata.head, data = input;
    if (input && typeof input === 'object' && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer)) {
      if (input.head || input.error || input.data_url || input.dataUrl) {
        serverError(input.error?.code);
        sourceHead = input.head || sourceHead;
        data = input.data || metadata.recordData;
        if (!data) fail('RECORD_DATA_REQUIRED', '官方响应只有牌谱元信息，需要同时导入对应的原始记录数据。');
      }
      if (data && typeof data.name === 'string' && own(data, 'data')) {
        check(data.name === '.lq.GameDetailRecords' || data.name === 'lq.GameDetailRecords', '需要完整 GameDetailRecords 牌谱。');
        data = data.data;
      }
      if (data && typeof data === 'object' && (Array.isArray(data.records) || Array.isArray(data.actions))) return normalize(sourceHead, detailEvents(data), metadata);
    }
    let rawData = bytes(data);
    if (rawData[0] === 3 && rawData.length > 3) rawData = wrapper(rawData.subarray(3)).data;
    const m = message(rawData);
    const isDetail = all(m, 1).some(item => {
      if (item.wire !== 2) return false;
      try { return /^\.?lq\.Record/.test(wrapper(item.value).name); } catch (_) { return false; }
    }) || all(m, 3).some(item => {
      if (item.wire !== 2) return false;
      try { const result = raw(message(item.value), 3); return result && /^\.?lq\.Record/.test(wrapper(result).name); } catch (_) { return false; }
    });
    let name = '';
    if (raw(m, 1)) { try { name = text(raw(m, 1)); } catch (_) { /* A response error is a nested message, not a string. */ } }
    if (/^\.?lq\./.test(name)) {
      check(/GameDetailRecords$/.test(name), '需要完整 GameDetailRecords 牌谱。'); rawData = raw(m, 2) || new Uint8Array();
    } else if (raw(m, 2) && !raw(m, 3) && !raw(m, 4)) {
      return parseRecord(raw(m, 2), metadata);
    } else if (!isDetail && (raw(m, 3) || raw(m, 4) || (raw(m, 1) && !raw(m, 2) && !all(m, 2).length))) {
      const reply = response(rawData); serverError(reply.error.code);
      if (reply.head) sourceHead = reply.head;
      rawData = reply.data || metadata.recordData;
      if (!rawData) fail('RECORD_DATA_REQUIRED', '官方响应缺少完整记录数据。');
      return parseRecord(rawData, { ...metadata, head: sourceHead });
    }
    return normalize(sourceHead, detailEvents(rawData), metadata);
  }
  function encodeVarint(value) {
    let n = BigInt(value), output = [];
    do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; output.push(b); } while (n);
    return output;
  }
  function encodeField(id, value) {
    if (typeof value === 'string') value = new TextEncoder().encode(value);
    if (value instanceof Uint8Array) return [...encodeVarint(id * 8 + 2), ...encodeVarint(value.length), ...value];
    return [...encodeVarint(id * 8), ...encodeVarint(value)];
  }
  function request(index, name, data) {
    return Uint8Array.from([2, index & 255, index >>> 8, ...encodeField(1, name), ...encodeField(2, data)]);
  }
  function replayLink(link) {
    let url;
    const sharedText = String(link).trim();
    const copiedURL = sharedText.match(/https:\/\/[^\s<>"']+/u);
    try { url = new URL(copiedURL ? copiedURL[0] : sharedText); } catch (_) { fail('INVALID_LINK', '请输入完整的雀魂分享链接。'); }
    check(url.protocol === 'https:' && !url.port && !url.username && !url.password, '牌谱链接必须为不带账号信息的官方 HTTPS 地址。');
    if (!['mahjongsoul.game.yo-star.com', 'mahjongsoul.yo-star.com'].includes(url.hostname)) fail('UNSUPPORTED_REGION', '当前在线读取原型只配置了官方国际服；可使用本地文件解析其他地区。');
    const share = url.searchParams.get('paipu') || '', pieces = share.split('_'), id = pieces[0];
    if (pieces[2] === '2') fail('UNSUPPORTED_LINK', '此牌谱分享 ID 需要额外转换，当前原型不支持。');
    if (!/^(?:\d{6}-)?[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id)) fail('INVALID_LINK', '牌谱链接中的 ID 无效。');
    return { id, url: url.href };
  }
  async function fetchRecord(link, options = {}) {
    const meta = replayLink(link), signal = options.signal;
    if (signal?.aborted) fail('ABORTED', '已取消牌谱读取。');
    const progress = value => { try { options.onProgress?.(value); } catch (_) { /* Progress must not affect parsing. */ } };
    if (options.loader !== undefined) {
      if (typeof options.loader !== 'function') fail('INVALID_LOADER', '原始牌谱读取服务配置无效。');
      progress('读取原始牌谱数据…');
      const loaded = await options.loader({ id: meta.id, url: meta.url }, { signal, onProgress: progress });
      if (signal?.aborted) fail('ABORTED', '已取消牌谱读取。');
      const record = parseRecord(loaded, meta);
      if (record.id.toLowerCase() !== meta.id.toLowerCase()) fail('RECORD_MISMATCH', '返回的牌谱与提交链接不一致，未加入结算。');
      return record;
    }
    if (typeof root.WebSocket !== 'function') fail('UNSUPPORTED_ENVIRONMENT', '此环境没有浏览器 WebSocket，可改用原始牌谱文件。');
    progress('连接雀魂官方牌谱服务…');
    const reply = await new Promise((resolve, reject) => {
      let socket, settled = false;
      const done = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (socket && socket.readyState < 2) socket.close();
        if (error) reject(error); else resolve(value);
      };
      const abort = () => done(new PaipuError('ABORTED', '已取消牌谱读取。'));
      const timer = setTimeout(() => done(new PaipuError('NETWORK_ERROR', '连接雀魂服务超时；可以导入原始牌谱文件。')), 15000);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        socket = new root.WebSocket(EN_GATEWAY); socket.binaryType = 'arraybuffer';
        socket.onopen = () => socket.send(request(1, '.lq.Route.requestConnection', Uint8Array.from([...encodeField(2, 0), ...encodeField(3, 'en-1'), ...encodeField(4, Date.now()), ...encodeField(6, 'Web')])));
        socket.onerror = () => done(new PaipuError('NETWORK_ERROR', '无法连接雀魂官方服务。'));
        socket.onclose = () => { if (!settled) done(new PaipuError('NETWORK_ERROR', '雀魂连接已关闭，未取得牌谱。')); };
        socket.onmessage = async event => {
          try {
            const packet = bytes(typeof Blob !== 'undefined' && event.data instanceof Blob ? await event.data.arrayBuffer() : event.data);
            if (packet[0] !== 3 || packet.length < 3) return;
            const index = packet[1] | (packet[2] << 8), body = wrapper(packet.subarray(3)).data;
            if (index === 1) {
              const route = message(body), error = raw(route, 1); if (error) serverError(uint(message(error), 1));
              progress('读取指定牌谱…');
              socket.send(request(2, '.lq.Lobby.fetchGameRecord', Uint8Array.from([...encodeField(1, meta.id), ...encodeField(2, VERSION)])));
            } else if (index === 2) { const result = response(body); serverError(result.error.code); done(null, result); }
          } catch (error) { done(error instanceof PaipuError ? error : new PaipuError('INVALID_RECORD', '官方牌谱响应无法解码。')); }
        };
      } catch (_) { done(new PaipuError('NETWORK_ERROR', '无法建立雀魂连接。')); }
    });
    if (!reply.data && reply.data_url) {
      const recordUrl = new URL(reply.data_url); check(recordUrl.protocol === 'https:', '官方记录地址必须使用 HTTPS。');
      progress('下载官方记录数据…');
      let result;
      try { result = await root.fetch(recordUrl.href, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' }); }
      catch (_) { fail(signal?.aborted ? 'ABORTED' : 'NETWORK_ERROR', '原始记录下载失败，可能需要文件导入。'); }
      if (!result.ok) fail('NETWORK_ERROR', '官方原始记录下载失败。');
      reply.data = new Uint8Array(await result.arrayBuffer());
    }
    progress('在本机解码牌谱…');
    const record = parseRecord(reply, meta);
    if (record.id.toLowerCase() !== meta.id.toLowerCase()) fail('RECORD_MISMATCH', '返回的牌谱与提交链接不一致，未加入结算。');
    return record;
  }
  return Object.freeze({ fetchRecord, parseRecord, validateRecord, PaipuError, protocolVersion: VERSION });
});
