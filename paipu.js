(function () {
  'use strict';
  const STORAGE_KEY = 'mahjong-paipu-cn-v1';
  const BACKUP_TYPE = 'paipu-settlement-backup';
  const DEFAULT_RULES = { scoreMode: 'official', chipPT: 3, pointRate: 10, yakumanRonChips: 10, yakumanTsumoChips: 5, doubleYakuman: 'count' };
  const PUBLIC_READ_ENABLED = window.PaipuCloud?.publicReadEnabled === true;
  const $ = (id) => document.getElementById(id);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const recordKey = (value) => String(value).toLowerCase();
  const escapeHTML = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const format = (value, decimals = 2) => Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: decimals });
  const signed = (value, decimals = 3) => (value > 0 ? '+' : '') + format(value, decimals);
  const numberHTML = (value, decimals = 3) => '<span class="' + (value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral') + '">' + escapeHTML(signed(value || 0, decimals)) + '</span>';
  const emptyStore = () => ({ type: BACKUP_TYPE, schemaVersion: 1, rules: clone(DEFAULT_RULES), records: [] });
  let store = emptyStore();
  let readFailed = false;
  let writeFailed = false;
  let originalRaw = null;
  let busy = false;
  let controller = null;
  let jobs = [];
  let aggregate = null;

  function modules() {
    if (!window.PaipuClient || typeof window.PaipuClient.fetchRecord !== 'function' || typeof window.PaipuClient.validateRecord !== 'function' || !window.PaipuSettlement || typeof window.PaipuSettlement.calculate !== 'function' || typeof window.PaipuSettlement.aggregateRecords !== 'function') throw new Error('牌谱解析模块未加载完整，请联网刷新页面。');
    return { client: window.PaipuClient, settlement: window.PaipuSettlement };
  }
  function numeric(value, label, min, max, unit) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || Math.abs(value / unit - Math.round(value / unit)) > 0.000001) throw new Error(label + '数值无效；最小单位为 ' + unit);
    return value;
  }
  function validateRules(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('计算规则格式不正确');
    return {
      ...clone(DEFAULT_RULES),
      chipPT: numeric(raw.chipPT, '每祝 PT', 0, 1000, 0.1),
      pointRate: numeric(raw.pointRate, '折算倍率', 0, 100000, 0.01),
    };
  }
  function calculateRecord(record, rules, allowMissingMetadata = false) {
    const activeRules = validateRules(rules);
    try { return modules().settlement.calculate(record, activeRules); }
    catch (error) {
      if (!allowMissingMetadata || !['YAKUMAN_METADATA_REQUIRED', 'MISSING_OFFICIAL_PT', 'MENZEN_METADATA_REQUIRED'].includes(error.code)) throw error;
      // Validate the known event data without making up official scores or yakuman metadata.
      // This legacy-mode validation result is discarded, never displayed or stored.
      const known = { ...record, rounds: record.rounds.map((round) => round.aka > 0 && round.menzen === undefined ? { ...round, aka: 0 } : round) };
      // Unknown red-chip eligibility is omitted only in this discarded validation copy.
      modules().settlement.calculate(known, { ...activeRules, scoreMode: 'custom', returnPoints: record.startPoints, uma: Array(record.players.length).fill(0), yakumanRonChips: 0, yakumanTsumoChips: 0 });
      return null;
    }
  }
  function aggregatePageRecords(records, rules, allowMissingMetadata = false) {
    const activeRules = validateRules(rules), seen = new Set();
    let incomplete = false;
    records.forEach((record) => {
      if (seen.has(recordKey(record.id))) throw new Error('重复牌谱：' + record.id + '。');
      seen.add(recordKey(record.id));
      if (allowMissingMetadata && !calculateRecord(record, activeRules, true)) incomplete = true;
    });
    if (incomplete) return null;
    return modules().settlement.aggregateRecords(records, activeRules);
  }
  function needsMetadata(record) {
    return record.result.some((entry) => entry.officialPT === undefined) || record.rounds.some((round) => round.yakumanUnits === undefined || round.aka > 0 && round.menzen === undefined);
  }
  function validatedRecord(raw) {
    const checked = modules().client.validateRecord(clone(raw));
    const record = checked && typeof checked === 'object' ? checked : raw;
    if (!record || typeof record.id !== 'string' || !record.id || !Array.isArray(record.players)) throw new Error('解析结果缺少牌谱 ID 或成员');
    return clone(record);
  }
  function validateBackup(raw) {
    if (!raw || raw.type !== BACKUP_TYPE || raw.schemaVersion !== 1 || !Array.isArray(raw.records) || raw.records.length > 1000) throw new Error('请选择有效的牌谱解析 JSON 备份');
    const rules = validateRules(raw.rules);
    const seen = new Set();
    const records = raw.records.map((item) => { const record = validatedRecord(item); if (seen.has(recordKey(record.id))) throw new Error('备份含重复牌谱，未导入'); seen.add(recordKey(record.id)); return record; });
    if (records.length) aggregatePageRecords(records, rules, true);
    return { type: BACKUP_TYPE, schemaVersion: 1, rules, records };
  }
  function status(message, kind = '') { $('status').textContent = message; $('status').className = 'status' + (kind ? ' ' + kind : ''); }
  function storageWarning() {
    const messages = [];
    if (readFailed) messages.push('本机牌谱存档无法读取或校验，自动保存已暂停。当前显示内存结果。请导入有效备份，或明确确认清空牌谱存档后恢复保存。');
    if (writeFailed) messages.push('当前更改尚未成功保存到浏览器，关闭页面可能丢失。请立即导出 JSON 备份。');
    $('storage-warning').hidden = !messages.length;
    $('storage-message').textContent = messages.join(' ');
    $('export-original').hidden = originalRaw === null;
  }
  function save(allowRecovery = false) {
    if (readFailed && !allowRecovery) { storageWarning(); return false; }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      writeFailed = false;
      if (allowRecovery) { readFailed = false; originalRaw = null; }
      storageWarning();
      return true;
    } catch (_) { writeFailed = true; storageWarning(); return false; }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== null) {
        originalRaw = raw;
        const parsed = JSON.parse(raw);
        store = validateBackup(parsed); originalRaw = null;
        if (JSON.stringify(parsed.rules) !== JSON.stringify(store.rules)) save();
      }
    } catch (_) { readFailed = true; }
    storageWarning();
  }
  function fillRules() {
    $('chip-pt').value = store.rules.chipPT;
    $('point-rate').value = store.rules.pointRate;
  }
  function readRules() {
    const f = $('paipu-form');
    const read = (name) => f.elements[name].value === '' ? NaN : Number(f.elements[name].value);
    return validateRules({ chipPT: read('chipPT'), pointRate: read('pointRate') });
  }
  function applyRules() {
    try {
      const rules = readRules();
      if (store.records.length) aggregatePageRecords(store.records, rules, true);
      store.rules = rules;
      $('rule-error').hidden = true;
      save(); renderResults();
      return true;
    } catch (e) { $('rule-error').textContent = '当前规则未应用：' + (e.message || '请检查数值') + '。结果保留上次有效规则。'; $('rule-error').hidden = false; return false; }
  }
  function setBusy(value, cancellable = false) {
    busy = value;
    $('input-fields').disabled = value;
    $('cancel-button').hidden = !value || !cancellable;
    $('cancel-button').disabled = false;
    ['import-backup', 'clear-data', 'warning-clear'].forEach((id) => $(id).disabled = value);
    document.querySelectorAll('[data-remove], [data-refresh-missing]').forEach((button) => button.disabled = value);
    $('parse-button').textContent = value ? '正在读取…' : '读取并计算牌谱';
  }
  function renderJobs() {
    $('jobs').hidden = !jobs.length;
    $('jobs').innerHTML = jobs.map((job, i) => '<li class="' + escapeHTML(job.state) + '"><span class="job-index">第 ' + (i + 1) + ' 条</span><span class="job-message">' + escapeHTML(job.message) + '</span></li>').join('');
  }
  function safeURL(raw) { try { const url = new URL(raw); return url.protocol === 'https:' ? url.href : ''; } catch (_) { return ''; } }
  function warningsHTML(warnings) { return warnings && warnings.length ? '<ul class="result-warnings">' + warnings.map((warning) => '<li>' + escapeHTML(typeof warning === 'string' ? warning : warning.message || '请核对牌谱数据') + '</li>').join('') + '</ul>' : ''; }
  function recordTable(result) {
    return '<div class="table-scroll"><table class="result-table"><thead><tr><th>成员</th><th>最终点数</th><th>顺位</th><th>麻将 PT</th><th>净祝数</th><th>祝仪 PT</th><th>总 PT</th><th>折算数</th></tr></thead><tbody>' + result.entries.map((entry) => '<tr><td>' + escapeHTML(entry.name) + '</td><td>' + format(entry.points, 0) + '</td><td>' + format(entry.rank, 1) + '</td><td>' + numberHTML(entry.mahjongPT) + '</td><td>' + numberHTML(entry.chips) + '</td><td>' + numberHTML(entry.chipPT) + '</td><td>' + numberHTML(entry.totalPT) + '</td><td>' + numberHTML(entry.money, 2) + '</td></tr>').join('') + '</tbody></table></div>';
  }
  function eventsHTML(record, result) {
    const names = new Map(record.players.map((player) => [player.id, player.name]));
    const name = (id) => names.get(id) || '未知成员';
    if (!result.events.length) return '<p class="no-events">这份牌谱没有可显示的和牌事件。</p>';
    const trigger = (detail) => {
      if (detail.type === 'aka' && detail.allStar) return '<li>All Star：门清 3 张红 5 → 每名付款者 ' + format(detail.count, 0) + ' 祝（替代普通红牌的 3 祝）</li>';
      if (detail.type === 'aka' && detail.menzen === false) return '<li>副露后红 5 不计祝（' + format(detail.akaCount, 0) + ' 张红 5）</li>';
      return detail.type === 'yakuman' ? '<li class="yakuman-trigger">役满 ' + (detail.chargedUnits == null ? '份数未提供' : format(detail.chargedUnits, 0) + ' 份') + ' × 每份 ' + (detail.chipsPerUnit == null ? '单价未提供' : format(detail.chipsPerUnit, 0) + ' 祝') + ' = 每名付款者 ' + format(detail.count, 0) + ' 祝' + (detail.yakumanUnits == null ? '' : '（牌谱 ' + format(detail.yakumanUnits, 0) + ' 倍）') + '</li>' : '<li>' + escapeHTML(detail.label) + ' × ' + format(detail.count, 0) + '</li>';
    };
    return result.events.map((event) => '<details class="round-detail"><summary>' + escapeHTML(event.label || '和牌') + ' · ' + escapeHTML(name(event.winner)) + ' ' + (event.zimo ? '自摸' : '荣和') + '<span>' + (event.chipsPerPayer ? '每名付款者 ' + format(event.chipsPerPayer, 0) + ' 祝' : '无祝仪') + '</span></summary>' + (event.details.length ? '<ul class="trigger-list">' + event.details.map(trigger).join('') + '</ul>' : '<p>本次和牌没有按当前规则计入的祝仪。</p>') + (event.transfers.length ? '<ul class="payment-list">' + event.transfers.map((transfer) => '<li><span>' + escapeHTML(name(transfer.from)) + ' → ' + escapeHTML(name(transfer.to)) + '</span><b>' + format(transfer.chips, 0) + ' 祝 · ' + format(transfer.chips * store.rules.chipPT) + ' PT</b></li>').join('') + '</ul>' : '') + '</details>').join('');
  }
  function renderResults() {
    $('export-backup').disabled = !store.records.length;
    $('warning-backup').disabled = !store.records.length;
    $('export-csv').disabled = !store.records.length;
    if (!store.records.length) { aggregate = null; $('results').innerHTML = '<div class="empty-state"><strong>还没有牌谱结算结果</strong>粘贴牌谱链接开始读取，或导入完整牌谱 JSON / 解析备份。</div>'; return; }
    try {
      aggregate = aggregatePageRecords(store.records, store.rules);
      const totals = aggregate.totals;
      let html = '<section class="result-section"><div class="section-heading"><h2>累计结算</h2><span>' + store.records.length + ' 份牌谱 · 每祝 ' + format(store.rules.chipPT) + ' PT</span></div><div class="table-scroll"><table class="result-table"><thead><tr><th>成员</th><th>牌谱数</th><th>麻将 PT</th><th>净祝数</th><th>祝仪 PT</th><th>总 PT</th><th>折算数</th></tr></thead><tbody>' + aggregate.entries.map((entry) => '<tr><td title="' + escapeHTML((entry.names || [entry.name]).join(' / ')) + '">' + escapeHTML(entry.name) + '</td><td>' + format(entry.games, 0) + '</td><td>' + numberHTML(entry.mahjongPT) + '</td><td>' + numberHTML(entry.chips) + '</td><td>' + numberHTML(entry.chipPT) + '</td><td>' + numberHTML(entry.totalPT) + '</td><td>' + numberHTML(entry.money, 2) + '</td></tr>').join('') + '</tbody><tfoot><tr><td>合计</td><td>—</td><td>' + numberHTML(totals.mahjongPT) + '</td><td>' + numberHTML(totals.chips) + '</td><td>' + numberHTML(totals.chipPT) + '</td><td>' + numberHTML(totals.totalPT) + '</td><td>' + numberHTML(totals.money, 2) + '</td></tr></tfoot></table></div><p class="result-note">按雀魂成员 ID 合并，同名成员不会自动合并。表格可左右滑动；下方可展开每份牌谱与逐局祝仪。</p>' + warningsHTML(aggregate.warnings) + '</section><section class="result-section"><div class="section-heading"><h2>逐谱与逐局明细</h2></div>';
      aggregate.records.forEach((result, i) => {
        const record = store.records.find((item) => item.id === result.id);
        if (!record) return;
        const url = safeURL(record.url);
        html += '<details class="paipu-record"' + (aggregate.records.length === 1 ? ' open' : '') + '><summary>牌谱 ' + (i + 1) + '<span>' + record.players.length + ' 人 · ' + result.events.length + ' 次和牌</span></summary><div class="record-content"><div class="record-meta">' + (url ? '<a href="' + escapeHTML(url) + '" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">打开原始牌谱 ↗</a>' : '<span></span>') + '<button type="button" data-remove="' + escapeHTML(record.id) + '"' + (busy ? ' disabled' : '') + '>移除这份结果</button></div><p class="record-id">牌谱 ID：' + escapeHTML(record.id) + '</p>' + recordTable(result) + warningsHTML(result.warnings) + '<h3 class="round-heading">逐局祝仪明细</h3>' + eventsHTML(record, result) + '</div></details>';
      });
      $('results').innerHTML = html + '</section>';
    } catch (e) {
      aggregate = null; $('export-csv').disabled = true;
      const missing = ['YAKUMAN_METADATA_REQUIRED', 'MISSING_OFFICIAL_PT', 'MENZEN_METADATA_REQUIRED'].includes(e.code);
      const refreshable = missing && store.records.some((record) => needsMetadata(record) && safeURL(record.url));
      $('results').innerHTML = '<div class="notice error" role="alert"><p>' + (missing ? '已保留 ' + store.records.length + ' 份牌谱。旧解析缺少官方结算分、役满或门清信息，暂不能结算。重新读取同一链接或导入完整原始牌谱即可补齐，不会重复累计；缺失信息不会当作 0。' : '结算失败：' + escapeHTML(e.message || '请检查规则与解析结果') + '。已保存的牌谱仍保留，可先导出 JSON 备份。') + '</p>' + (refreshable ? '<button type="button" data-refresh-missing' + (busy ? ' disabled' : '') + '>补齐旧牌谱信息</button>' : '') + '</div>';
    }
  }
  async function parse(event) {
    event.preventDefault(); if (busy) return;
    try { modules(); } catch (e) { status(e.message, 'error'); return; }
    if (!applyRules()) { $('rule-error').scrollIntoView({ block: 'nearest' }); return; }
    if (navigator.onLine === false) { status(store.records.length ? '已按当前规则重算本机保存的牌谱。读取新牌谱需要联网。' : '当前已离线。请导入已解析的 JSON，或联网后读取新牌谱。', 'warning'); return; }
    const urls = $('paipu-urls').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!urls.length) { status('请先粘贴牌谱链接，每行一个。', 'error'); $('paipu-urls').focus(); return; }
    if (urls.length > 100) { status('一次最多读取 100 个牌谱链接，请分批读取。', 'error'); return; }
    controller = new AbortController(); setBusy(true, true);
    jobs = urls.map((url) => ({ url, state: 'pending', message: '等待读取' })); renderJobs();
    let added = 0, refreshed = 0, skipped = 0, failed = 0, cancelled = false, connectionError = '';
    const seenInputs = new Set();
    try {
      if (!window.PaipuCloud || typeof window.PaipuCloud.connect !== 'function') throw new Error(PUBLIC_READ_ENABLED ? '公共牌谱连接模块未加载，请刷新页面后重试。' : '私有后台连接模块未加载，请刷新页面，或打开云端牌谱页面继续。');
      // In private mode connect opens its fixed-origin popup before this handler awaits.
      const connection = window.PaipuCloud.connect({ signal: controller.signal });
      status(PUBLIC_READ_ENABLED ? '正在连接公共牌谱服务，无需登录个人雀魂账号。' : '请在私有后台窗口中完成登录与授权。若无法连接，可打开云端牌谱页面继续。');
      const loader = await connection;
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (controller.signal.aborted) { cancelled = true; break; }
        if (seenInputs.has(job.url)) { job.state = 'skipped'; job.message = '重复输入，跳过本条'; skipped++; renderJobs(); continue; }
        if (store.records.some((record) => record.url === job.url && !needsMetadata(record))) { job.state = 'skipped'; job.message = '已存在，跳过重复牌谱'; skipped++; renderJobs(); continue; }
        seenInputs.add(job.url); job.state = 'loading'; job.message = '正在读取牌谱…'; status('正在读取第 ' + (i + 1) + ' / ' + jobs.length + ' 条牌谱'); renderJobs();
        try {
          const raw = await modules().client.fetchRecord(job.url, { loader, signal: controller.signal, onProgress: (progress) => { if (job.state !== 'loading') return; const message = typeof progress === 'string' ? progress : progress?.message; if (message) { job.message = String(message).slice(0, 200); renderJobs(); } } });
          if (controller.signal.aborted) { cancelled = true; job.state = 'cancelled'; job.message = '已取消，未加入结果'; break; }
          const record = validatedRecord(raw);
          calculateRecord(record, store.rules);
          const existing = store.records.findIndex((item) => recordKey(item.id) === recordKey(record.id));
          if (existing >= 0 && !needsMetadata(store.records[existing])) { skipped++; job.state = 'skipped'; job.message = '牌谱 ID 已存在，未重复累计'; }
          else {
            if (existing >= 0) { store.records[existing] = record; refreshed++; job.message = '已补齐旧牌谱信息，未重复累计'; }
            else { store.records.push(record); added++; job.message = '读取并计算完成'; }
            job.state = 'done'; save(); renderResults();
          }
        } catch (e) {
          if (controller.signal.aborted || e.name === 'AbortError') { cancelled = true; job.state = 'cancelled'; job.message = '已取消，未加入结果'; break; }
          failed++; job.state = 'failed'; job.message = e.message || '读取失败，请检查链接后重试';
        }
        renderJobs();
      }
    } catch (e) {
      if (controller.signal.aborted || e.name === 'AbortError') cancelled = true;
      else {
        connectionError = e.message || (PUBLIC_READ_ENABLED ? '公共牌谱服务连接失败，请稍后重试。' : '私有后台连接失败，请打开云端牌谱页面继续。');
        jobs.forEach((job) => { if (job.state === 'pending' || job.state === 'loading') { job.state = 'failed'; job.message = connectionError; failed++; } });
      }
    } finally {
      jobs.forEach((job) => { if (job.state === 'pending' || job.state === 'loading') { job.state = 'cancelled'; job.message = '已取消，尚未读取'; } });
      setBusy(false); controller = null; renderJobs(); renderResults();
      status((connectionError ? connectionError + ' ' : '') + (cancelled ? '已取消剩余读取。' : '本次读取结束。') + '新增 ' + added + ' 份，补齐 ' + refreshed + ' 份，重复跳过 ' + skipped + ' 份，失败 ' + failed + ' 份。' + (failed ? '未成功的牌谱没有计入结算。' : ''), failed || cancelled ? 'warning' : '');
    }
  }
  function download(filename, content, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const link = document.createElement('a'); link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function fileDate() { const date = new Date(); return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0'); }
  function exportBackup() { try { download('牌谱解析备份-' + fileDate() + '.json', JSON.stringify(store, null, 2), 'application/json'); } catch (e) { status('备份导出失败：' + e.message, 'error'); } }
  function csvCell(value) { let text = String(value == null ? '' : value); if (typeof value !== 'number' && /^[=+\-@\t\r\n]/.test(text)) text = "'" + text; return '"' + text.replace(/"/g, '""') + '"'; }
  function exportCSV() {
    try {
      if (!store.records.length) return;
      const result = aggregatePageRecords(store.records, store.rules);
      const lines = [['类型', '牌谱 ID', '成员 ID', '成员', '牌谱数', '最终点数', '顺位', '麻将 PT', '净祝数', '祝仪 PT', '总 PT', '折算数', '局', '和牌者', '方式', '触发', '触发祝数（每名付款者）', '付款者', '收款者', '支付祝数', '牌谱役满倍数', '役满计费份数', '役满每份祝数', '役满荣和每份祝数设置', '役满自摸每家每份设置', '役满倍数规则']];
      const addRow = (row, detail) => lines.push([...row, detail?.type === 'yakuman' ? detail.yakumanUnits ?? '' : '', detail?.type === 'yakuman' ? detail.chargedUnits ?? '' : '', detail?.type === 'yakuman' ? detail.chipsPerUnit ?? '' : '', store.rules.yakumanRonChips, store.rules.yakumanTsumoChips, store.rules.doubleYakuman]);
      result.entries.forEach((entry) => addRow(['累计结算', '', entry.playerId, entry.name, entry.games, '', '', entry.mahjongPT, entry.chips, entry.chipPT, entry.totalPT, entry.money, '', '', '', '', '', '', '', '']));
      result.records.forEach((record) => {
        record.entries.forEach((entry) => addRow(['逐谱结算', record.id, entry.playerId, entry.name, 1, entry.points, entry.rank, entry.mahjongPT, entry.chips, entry.chipPT, entry.totalPT, entry.money, '', '', '', '', '', '', '', '']));
        const names = new Map(record.entries.map((entry) => [entry.playerId, entry.name]));
        record.events.forEach((event) => {
          if (!event.details.length) addRow(['和牌明细', record.id, '', '', '', '', '', '', '', '', '', '', event.label, names.get(event.winner), event.zimo ? '自摸' : '荣和', '无祝仪', 0, '', '', 0]);
          event.details.forEach((detail) => {
            if (!detail.transfers.length) addRow(['祝仪来源明细', record.id, '', '', '', '', '', '', '', '', '', '', event.label, names.get(event.winner), event.zimo ? '自摸' : '荣和', detail.label, detail.count, '', names.get(event.winner), 0], detail);
            detail.transfers.forEach((transfer) => addRow(['祝仪支付明细', record.id, '', '', '', '', '', '', '', '', '', '', event.label, names.get(event.winner), event.zimo ? '自摸' : '荣和', detail.label, detail.count, names.get(transfer.from), names.get(transfer.to), transfer.chips], detail));
          });
        });
      });
      download('牌谱结算-' + fileDate() + '.csv', '\uFEFF' + lines.map((line) => line.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
    } catch (e) { status('CSV 未导出：' + (e.message || '结算失败'), 'error'); }
  }
  async function importFile(file) {
    if (!file || busy) return;
    if (file.size > 20 * 1024 * 1024) { status('备份文件超过 20 MB，未导入。', 'error'); return; }
    setBusy(true);
    try {
      const raw = JSON.parse(await file.text());
      let message, replaceBackup = false;
      if (raw && raw.type === BACKUP_TYPE) {
        const candidate = validateBackup(raw);
        if (!window.confirm('导入 ' + candidate.records.length + ' 份牌谱并替换当前牌谱结果及计算规则？建议先导出当前备份。')) { status('已取消导入，当前结果保留。'); return; }
        store = candidate; replaceBackup = true; fillRules(); $('rule-error').hidden = true;
        message = '已导入 ' + store.records.length + ' 份牌谱备份';
      } else {
        const client = modules().client;
        let parsed;
        if (raw && typeof raw.id === 'string' && Array.isArray(raw.players) && Array.isArray(raw.rounds) && Array.isArray(raw.result)) parsed = raw;
        else {
          if (typeof client.parseRecord !== 'function') throw new Error('原始牌谱解码模块尚未加载，暂时可导入解析结果备份');
          parsed = await client.parseRecord(raw);
        }
        const record = validatedRecord(parsed);
        calculateRecord(record, store.rules, true);
        const existing = store.records.findIndex((item) => recordKey(item.id) === recordKey(record.id));
        const refresh = existing >= 0 && needsMetadata(store.records[existing]) && !needsMetadata(record);
        if (existing >= 0 && !refresh) { status('该牌谱 ID 已存在，未重复加入或累计。补齐旧记录需要包含官方结算分、役满及红牌门清信息的完整牌谱。'); return; }
        if (!window.confirm((refresh ? '用完整解析补齐这份旧牌谱信息？不会重复累计。' : '将这份 ' + record.players.length + ' 人牌谱加入当前结果，并按当前规则计算？') + (readFailed ? '原存档自动保存已暂停，本次只加入内存结果；请导出备份后再恢复保存。' : '现有结果会保留。'))) { status('已取消导入，当前结果保留。'); return; }
        if (refresh) store.records[existing] = record;
        else store.records.push(record);
        message = refresh ? '已补齐 1 份旧牌谱，未重复累计' : '已解析并加入 1 份牌谱';
      }
      jobs = []; renderJobs();
      const saved = save(replaceBackup); renderResults();
      status(saved ? message + '，已保存到当前浏览器。' : message + '，但未能保存到浏览器。请立即导出备份。', saved ? '' : 'warning');
    } catch (e) { status('文件未导入：' + (e.message || '文件格式不正确') + '。当前结果保留。', 'error'); }
    finally { setBusy(false); }
  }
  function clearData() {
    if (busy || !window.confirm('清空当前浏览器保存的全部牌谱解析结果和计算规则？请先导出备份。')) return;
    store = emptyStore(); jobs = []; fillRules(); renderJobs(); renderResults(); $('rule-error').hidden = true;
    const saved = save(true);
    status(saved ? '牌谱存档已清空。' : '内存结果已清空，但浏览器存档更新失败。请查看上方提示。', saved ? '' : 'warning');
  }
  function networkState() { $('network-note').hidden = navigator.onLine !== false; }

  $('paipu-form').addEventListener('submit', parse);
  $('paipu-form').addEventListener('input', (event) => { if (event.target.id !== 'paipu-urls' && !busy) applyRules(); });
  $('cancel-button').addEventListener('click', () => { if (controller) { controller.abort(); $('cancel-button').disabled = true; status('正在取消剩余读取…', 'warning'); } });
  $('import-backup').addEventListener('click', () => { $('backup-file').value = ''; $('backup-file').click(); });
  $('backup-file').addEventListener('change', () => importFile($('backup-file').files[0]));
  $('export-backup').addEventListener('click', exportBackup);
  $('warning-backup').addEventListener('click', exportBackup);
  $('export-csv').addEventListener('click', exportCSV);
  $('clear-data').addEventListener('click', clearData);
  $('warning-clear').addEventListener('click', clearData);
  $('export-original').addEventListener('click', () => { if (originalRaw !== null) download('牌谱原始存档-' + fileDate() + '.txt', originalRaw, 'text/plain;charset=utf-8'); });
  $('results').addEventListener('click', (event) => {
    if (busy) return;
    if (event.target.closest('[data-refresh-missing]')) {
      $('paipu-urls').value = store.records.filter((record) => needsMetadata(record) && safeURL(record.url)).map((record) => record.url).slice(0, 100).join('\n');
      $('paipu-form').requestSubmit(); return;
    }
    const button = event.target.closest('[data-remove]');
    if (!button || !window.confirm('移除这份牌谱的解析结果？')) return;
    store.records = store.records.filter((record) => record.id !== button.dataset.remove); const saved = save(); renderResults(); status(saved ? '这份牌谱已移除。' : '内存中的结果已移除，浏览器存档尚未更新。', saved ? '' : 'warning');
  });
  window.addEventListener('offline', networkState);
  window.addEventListener('online', networkState);
  try { modules(); } catch (e) { $('module-error').textContent = e.message; $('module-error').hidden = false; $('parse-button').disabled = true; }
  if (PUBLIC_READ_ENABLED) {
    document.querySelector('.local-note').textContent = '解析结果仅保存在当前浏览器，可导出备份。读取新牌谱通过公共云端专用账号完成，无需登录个人雀魂账号；已保存的结果可离线重算。';
    document.querySelector('.cloud-note').textContent = '读取时仅提交牌谱链接。若公共服务尚未就绪或繁忙，会逐条显示错误，未成功的牌谱不会计入结算。';
  } else if (window.PaipuCloud && typeof location !== 'undefined' && location.origin === window.PaipuCloud.backendOrigin) $('cloud-continue').hidden = true;
  load(); fillRules(); renderResults(); networkState();
})();
