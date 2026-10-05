(function () {
  'use strict';
  const STORAGE_KEY = 'mahjong-score-cn-v1';
  const AVATARS = ['👨🏻', '👩🏻', '🧑🏻', '👨🏼', '👩🏼', '👴🏻', '👵🏻', '🐼', '🐱', '🐶', '🐰', '🦊', '🐻', '🐯', '🐸', '🐧', '🐨', '🀄', '🌸', '⭐'];
  const ICON_PATHS = {
    home: '<path d="M3 11 12 3l9 8M5 10v11h5v-7h4v7h5V10"/>',
    score: '<path d="M4 21V9h4v12M10 21V3h4v18M16 21V13h4v8M2 21h20"/>',
    rules: '<path d="M5 3h14v18H5zM9 7h6M9 12h6M9 17h4"/>',
    members: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    settings: '<path d="m9 3-.5 3-2 .9-2.6-1.1-2 3.4 2.3 1.8v2l-2.3 1.8 2 3.4 2.6-1.1 2 .9.5 3h4l.5-3 2-.9 2.6 1.1 2-3.4-2.3-1.8v-2l2.3-1.8-2-3.4-2.6 1.1-2-.9-.5-3Z"/><circle cx="11" cy="12" r="3"/>',
    back: '<path d="m15 4-8 8 8 8"/>', next: '<path d="m9 4 8 8-8 8"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    delete: '<path d="M5 7h14M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="1"/><path d="M7 3v4M17 3v4M3 10h18M7 14h2M12 14h2M7 18h2"/>',
    filter: '<path d="M4 5h16M7 12h10M10 19h4"/><circle cx="8" cy="5" r="2"/><circle cx="16" cy="12" r="2"/>',
    export: '<path d="M12 3v12m-4-4 4 4 4-4M4 15v6h16v-6"/>',
    edit: '<path d="m14 4 6 6M4 20l1-6L16 3l5 5-11 11-6 1Z"/>',
    check: '<path d="m5 12 4 4L20 5"/>',
    duplicate: '<rect x="8" y="8" width="13" height="13" rx="1"/><path d="M16 8V3H3v13h5"/>',
  };
  const icon = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICON_PATHS[name] || ICON_PATHS.rules) + '</svg>';
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const uid = (prefix) => prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  const dateToday = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const today = dateToday();
  const currentMonth = today.slice(0, 7);
  const emptyStore = () => ({ schemaVersion: 1, players: [], sessions: [], settings: { currency: '¥', viewMode: 'pt', filter: { period: 'all', value: currentMonth, from: '', to: '' }, rulePresets: [] } });
  const stateUI = { tab: 'home', sessionId: null, memberId: null, modal: null, search: '', collapsedGroups: [] };
  let data = emptyStore();
  let toastTimer;
  let draft = null;
  let importedData = null;
  let storageReadFailed = false;
  let storageWriteFailed = false;
  let originalStorageRaw = null;
  let calculationError = '';
  const engine = () => window.ScoreEngine;
  const defaultRules = (n) => engine() ? engine().defaultRules(n) : ({ playerCount: n, startPoints: 25000, returnPoints: 25000, uma: n === 3 ? [20, 0, -20] : [15, 5, -5, -15], tieMode: 'seat', rounding: 'fiveSix', pointRate: 0, chipPT: 3, chipValue: 0, tobiBonusPT: 0, yakitoriPT: 0, yakitoriMode: 'person', negativeSettlement: true });
  const findPlayer = (id) => data.players.find((p) => p.id === id);
  const playerName = (id) => id === '__table__' ? '台费收款方' : (findPlayer(id)?.name || '未知成员');
  const findSession = (id) => data.sessions.find((s) => s.id === id);
  const activePlayers = () => data.players.filter((p) => !p.archived).sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name, 'zh-CN'));
  const orderedPlayers = (ids) => ids.map(findPlayer).filter(Boolean).sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name, 'zh-CN'));
  const cssSign = (n) => n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral';
  function fmt(n, decimals = 1) { return Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: decimals }); }
  function signed(n, decimals = 1) { return (n > 0 ? '+' : '') + fmt(n, decimals); }
  const currency = () => data.settings.currency || '¥';
  const valueHtml = (n, money = false) => '<span class="' + cssSign(n) + '">' + (money ? esc(currency()) : '') + esc(signed(n, money ? 2 : 1)) + '</span>';
  const avatar = (p, extra = '') => '<span class="avatar ' + extra + '" aria-hidden="true">' + esc(p?.avatar || '🀄') + '</span>';
  const safeAggregate = (s) => { try { return engine().aggregateSession(s); } catch (e) { calculationError = e.message || '规则或金额无效'; console.error(e); refreshStorageWarning(); return []; } };
  function toast(text) { const el = document.getElementById('toast'); el.textContent = text; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200); }
  function storageWarningHtml() {
    const messages = [];
    if (storageReadFailed) messages.push('原存档读取失败，自动保存已暂停。当前显示的是内存数据，不代表原存档。请导入有效备份，或在设置中明确确认清空。');
    if (storageWriteFailed) messages.push('当前更改尚未成功保存，关闭应用可能丢失。请立即导出 JSON 备份。');
    if (calculationError) messages.push('成绩统计失败：' + calculationError + '。当前汇总不可用，CSV 导出已暂停。');
    return messages.length ? '<div class="storage-warning" role="alert"><div>' + messages.map(esc).join('<br>') + '</div><button data-action="export-backup">导出内存备份</button>' + (originalStorageRaw !== null ? '<button data-action="export-original">导出原始存档</button>' : '') + '<button data-action="settings">打开设置</button></div>' : '';
  }
  function refreshStorageWarning() { const slot = document.getElementById('storage-warning-slot'); if (slot) slot.innerHTML = storageWarningHtml(); }
  function save(options = {}) {
    if (storageReadFailed && !options.allowRecovery) { refreshStorageWarning(); toast('原存档读取失败，自动保存已暂停。请先导入有效备份或明确确认清空。'); return false; }
    const payload = JSON.stringify(data);
    try {
      if (window.Android && typeof window.Android.saveData === 'function') {
        const saved = window.Android.saveData(payload);
        if (saved === false || saved === 'false') throw new Error('保存失败');
      } else localStorage.setItem(STORAGE_KEY, payload);
      storageWriteFailed = false;
      if (options.allowRecovery) { storageReadFailed = false; originalStorageRaw = null; }
      refreshStorageWarning();
      return true;
    } catch (e) { storageWriteFailed = true; refreshStorageWarning(); toast('保存失败，请立即导出备份。' + (e.message || '')); return false; }
  }
  function persistAndRender(successMessage, options = {}) { const saved = save(options); render(); if (saved && successMessage) toast(successMessage); return saved; }
  function load() {
    try {
      const payload = window.Android && typeof window.Android.readData === 'function' ? window.Android.readData() : localStorage.getItem(STORAGE_KEY);
      if (payload && payload !== 'null') {
        originalStorageRaw = String(payload);
        const parsed = JSON.parse(payload);
        if (parsed?.__storageReadError === true) { originalStorageRaw = null; throw new Error('原存档无法读取'); }
        data = validateStore(parsed);
        originalStorageRaw = null;
      }
    } catch (e) { storageReadFailed = true; toast('本机数据读取失败，自动保存已暂停。请在设置中导入备份。'); }
  }
  function filterSessions() {
    const f = data.settings.filter;
    return data.sessions.filter((s) => f.period === 'all' || (f.period === 'month' && s.date.slice(0, 7) === f.value.slice(0, 7)) || (f.period === 'year' && s.date.slice(0, 4) === f.value.slice(0, 4)) || (f.period === 'custom' && (!f.from || s.date >= f.from) && (!f.to || s.date <= f.to))).sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  }
  function periodLabel() { const f = data.settings.filter; return f.period === 'all' ? '全部期间' : f.period === 'month' ? f.value.slice(0, 4) + '年' + Number(f.value.slice(5, 7)) + '月' : f.period === 'year' ? f.value.slice(0, 4) + '年' : (f.from || '起始') + ' ～ ' + (f.to || '至今'); }
  function totalsFor(sessions) {
    const result = new Map();
    sessions.forEach((s) => safeAggregate(s).forEach((r) => {
      const item = result.get(r.playerId) || { playerId: r.playerId, games: 0, totalPT: 0, chips: 0, grossMoney: 0, netMoney: 0, fee: 0, firsts: 0, lasts: 0, busts: 0, rankSum: 0, rankCounts: [0, 0, 0, 0] };
      ['games', 'totalPT', 'chips', 'grossMoney', 'netMoney', 'fee', 'firsts', 'lasts', 'busts'].forEach((k) => item[k] += r[k] || 0);
      item.rankSum += r.averageRank * r.games;
      result.set(r.playerId, item);
    }));
    sessions.forEach((s) => s.games.forEach((g) => {
      try { engine().calculateGame(g.rules || s.rules, g).entries.forEach((r) => { const item = result.get(r.playerId); if (item && r.rank >= 1 && r.rank <= 4) item.rankCounts[r.rank - 1]++; }); } catch (_) { /* Invalid imported games are rejected before loading. */ }
    }));
    return [...result.values()].map((r) => ({ ...r, averageRank: r.games ? r.rankSum / r.games : 0 }));
  }
  function render() {
    const selectedSession = stateUI.sessionId && findSession(stateUI.sessionId);
    const selectedMember = stateUI.memberId && findPlayer(stateUI.memberId);
    const title = selectedSession ? (selectedSession.title || selectedSession.date.replace(/-/g, '/')) : selectedMember ? '成员成绩' : ({ home: '麻将成绩', scores: '成绩统计', rules: '规则', members: '成员' }[stateUI.tab]);
    const detail = !!selectedSession || !!selectedMember;
    const content = selectedSession ? sessionPage(selectedSession) : selectedMember ? memberPage(selectedMember) : ({ home: homePage, scores: scoresPage, rules: rulesPage, members: membersPage }[stateUI.tab])();
    const hasFilter = !selectedSession && stateUI.tab !== 'rules' && !(!selectedMember && stateUI.tab === 'members');
    const fabAction = selectedSession ? '' : !selectedMember && stateUI.tab === 'members' ? 'new-player' : stateUI.tab === 'rules' ? 'new-preset' : '';
    const headerRight = selectedSession ? '<button class="icon-button" data-action="session-statistics" data-id="' + esc(selectedSession.id) + '" aria-label="本次成绩统计">' + icon('score') + '</button>' : '<button class="icon-button" data-action="settings" aria-label="设置与备份">' + icon('settings') + '</button>';
    document.getElementById('app').innerHTML = '<header class="app-header">' + (detail || ['scores', 'rules'].includes(stateUI.tab) ? '<button class="icon-button" data-action="back" aria-label="返回">' + icon('back') + '</button>' : '<span class="icon-button app-mark" aria-hidden="true">🀄</span>') + '<h1>' + esc(title) + '</h1>' + headerRight + '</header><div id="storage-warning-slot">' + storageWarningHtml() + '</div><main class="' + (!hasFilter ? 'no-filter' : '') + (selectedSession ? ' ledger-page' : '') + '">' + content + '</main>' + (fabAction ? '<button class="fab no-filter" data-action="' + fabAction + '" aria-label="' + (stateUI.tab === 'members' ? '添加成员' : '添加规则') + '">' + icon('add') + '</button>' : '') + (hasFilter ? filterBar() : '') + '<nav class="bottom-nav" aria-label="页面"><button data-action="tab" data-tab="home" class="' + (stateUI.tab !== 'members' ? 'active' : '') + '">' + icon('home') + '首页</button><button data-action="tab" data-tab="members" class="' + (stateUI.tab === 'members' ? 'active' : '') + '">' + icon('members') + '成员</button></nav>';
  }
  function empty(title, description, action, button) { return '<div class="empty-state"><div class="empty-tile">🀄</div><h2>' + esc(title) + '</h2><p>' + esc(description) + '</p>' + (action ? '<button class="primary-button" data-action="' + action + '">' + esc(button) + '</button>' : '') + '</div>'; }
  function homePage() {
    if (!data.sessions.length) return empty('打完一局，记下成绩', '先添加一起打牌的成员，再创建记录。输入每局最终点数，自动计算顺位、成绩和收支。', 'new-session', '新建记录') + '<div style="text-align:center"><button class="subtle-button" data-action="examples">查看示例记录</button></div>';
    const sessions = filterSessions();
    if (!sessions.length) return empty('这段期间还没有记录', '切换月份或选择全部期间，查看已保存的对局。', 'all-period', '查看全部期间');
    const groups = new Map(); sessions.forEach((s) => { const key = JSON.stringify([s.group || '', [...s.playerIds].sort()]); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(s); });
    let html = '<div class="page-label"><button data-action="filter">' + esc(periodLabel()) + ' · ' + esc(data.settings.viewMode === 'money' ? '收支' : '成绩 PT') + '</button><button class="subtle-button" data-action="tab" data-tab="scores" style="padding:3px 0">成绩统计</button></div>';
    groups.forEach((list, groupKey) => {
      const group = list[0].group || '默认分组';
      const collapsed = stateUI.collapsedGroups.includes(groupKey);
      const players = orderedPlayers([...new Set(list.flatMap((s) => s.playerIds))]);
      const totals = totalsFor(list);
      const money = data.settings.viewMode === 'money';
      html += '<section class="score-panel"><div class="group-top">' + (group !== '默认分组' ? '<span class="group-label">' + esc(group) + '</span>' : '<span></span>') + '<div class="group-tools"><button class="icon-button" data-action="export-group" data-ids="' + esc(list.map((s) => s.id).join(',')) + '" aria-label="导出本分组成绩">' + icon('export') + '</button><button class="icon-button" data-action="toggle-group" data-key="' + esc(groupKey) + '" aria-label="' + (collapsed ? '展开记录' : '收起记录') + '" aria-expanded="' + !collapsed + '">' + icon(collapsed ? 'next' : 'back') + '</button></div></div><div class="table-scroll"><div style="min-width:calc(' + players.length + ' * 74px)"><div class="score-grid" style="--cols:' + players.length + '">' + players.map((p) => { const r = totals.find((r) => r.playerId === p.id); return '<button class="member-cell" data-action="member" data-id="' + esc(p.id) + '">' + avatar(p) + '<span class="member-name">' + esc(p.name) + '</span><div class="member-total">' + valueHtml(money ? r?.netMoney : r?.totalPT, money) + '</div></button>'; }).join('') + '</div>';
      if (!collapsed) list.forEach((s) => {
        const rows = safeAggregate(s);
        html += '<article class="session-card" data-action="session" data-id="' + esc(s.id) + '" tabindex="0" role="button" aria-label="打开' + esc(s.title || s.date) + '"><div class="session-title-row"><div class="title">' + (s.title ? '<strong>' + esc(s.title) + '</strong>' : '') + '<span class="session-date">' + icon('calendar') + esc(s.date.replace(/-/g, '/')) + '<span class="badge">' + s.games.length + ' 局</span></span></div><div class="session-actions"><button class="icon-button" data-action="clone-session" data-id="' + esc(s.id) + '" aria-label="继承规则新建">' + icon('add') + '</button><button class="icon-button delete" data-action="delete-session" data-id="' + esc(s.id) + '" aria-label="删除记录">' + icon('delete') + '</button></div></div><div class="score-grid session-values" style="--cols:' + players.length + '">' + players.map((p) => { const r = rows.find((r) => r.playerId === p.id); return '<div>' + (r ? valueHtml(money ? r.netMoney : r.totalPT, money) : '<span style="color:#b1b9b3">—</span>') + '</div>'; }).join('') + '</div></article>';
      });
      html += '</div></div></section>';
    });
    return html;
  }
  function filterBar() { return '<div class="operation-bar"><button data-action="filter" aria-label="筛选日期与显示">' + icon('filter') + '</button><button data-action="export-backup" aria-label="备份记录">' + icon('export') + '</button><button data-action="new-session" aria-label="新建记录">' + icon('add') + '</button></div>'; }
  function scoresPage() {
    const sessions = filterSessions();
    const rows = totalsFor(sessions).sort((a, b) => b.totalPT - a.totalPT);
    if (!rows.some((r) => r.games)) return empty('还没有已录入的成绩', '完成对局后输入最终点数，这里会汇总成绩和顺位。', 'new-session', '新建记录');
    const games = sessions.reduce((n, s) => n + s.games.length, 0);
    const money = data.settings.viewMode === 'money';
    return '<div class="stat-total"><div><span class="stat-value">' + sessions.length + '</span><span class="stat-label">场次记录</span></div><div><span class="stat-value">' + games + '</span><span class="stat-label">对局</span></div><div><span class="stat-value">' + rows.length + '</span><span class="stat-label">成员</span></div></div><div class="page-label"><span>' + esc(periodLabel()) + '</span><button class="subtle-button" style="padding:0" data-action="export-csv">导出 CSV</button></div><div class="list-panel"><table class="ranking-table"><thead><tr><th>成员</th><th>局数</th><th>平均顺位</th><th>' + (money ? '收支' : '成绩 PT') + '</th></tr></thead><tbody>' + rows.map((r) => '<tr data-action="member" data-id="' + esc(r.playerId) + '"><td class="name-col">' + avatar(findPlayer(r.playerId)) + esc(playerName(r.playerId)) + '</td><td>' + r.games + '</td><td>' + (r.games ? fmt(r.averageRank, 2) : '—') + '</td><td>' + valueHtml(money ? r.netMoney : r.totalPT, money) + '</td></tr>').join('') + '</tbody></table></div><p class="inline-note">点击成员查看顺位次数、月度汇总和历史成绩。轮休的对局不计入该成员统计。</p>';
  }
  function membersPage() {
    const players = activePlayers();
    if (!data.players.length) return empty('添加一起打牌的成员', '成员只需一个名字。以后新建记录时可直接选择，历史成绩也会持续汇总。', 'new-player', '添加成员');
    const allTotals = totalsFor(data.sessions);
    const row = (p) => { const r = allTotals.find((r) => r.playerId === p.id); return '<button class="list-row" data-action="member" data-id="' + esc(p.id) + '">' + avatar(p) + '<span class="row-text"><strong>' + esc(p.name) + (p.favorite ? ' <span class="favorite">★</span>' : '') + '</strong><small>' + (r?.games || 0) + ' 局 · 累计成绩 ' + signed(r?.totalPT || 0) + ' PT' + (p.archived ? ' · 已归档' : '') + '</small></span>' + icon('next') + '</button>'; };
    return '<div class="page-label"><span>' + players.length + ' 位成员</span><button class="subtle-button" style="padding:0" data-action="new-player">添加成员</button></div><div class="list-panel">' + players.map(row).join('') + '</div>' + (data.players.some((p) => p.archived) ? '<div class="list-section-title">已归档成员</div><div class="list-panel">' + data.players.filter((p) => p.archived).map(row).join('') + '</div>' : '') + '<p class="inline-note">收藏成员会排在前面。修改姓名会同步更新历史记录的显示。</p>';
  }
  function rulesDescription(r) { return r.playerCount + ' 人 · ' + fmt(r.startPoints, 0) + ' 起 / ' + fmt(r.returnPoints, 0) + ' 返 · 马 ' + r.uma.join(' / '); }
  function rulesPage() {
    const presets = data.settings.rulePresets || [];
    return '<p class="inline-note">新建记录时选择规则，也可以继承上一次的规则与成员。</p><div class="list-section-title">常用规则</div><div class="list-panel">' + [4, 3].map((n) => '<button class="list-row" data-action="default-rule" data-n="' + n + '"><span class="row-text"><strong>' + n + ' 人麻将 · 默认</strong><small>' + esc(rulesDescription(defaultRules(n))) + '</small></span>' + icon('next') + '</button>').join('') + presets.map((p) => '<button class="list-row" data-action="edit-preset" data-id="' + esc(p.id) + '"><span class="row-text"><strong>' + esc(p.name) + '</strong><small>' + esc(rulesDescription(p.rules)) + '</small></span>' + icon('edit') + '</button>').join('') + '</div>' + (data.sessions.length ? '<div class="list-section-title">记录中的规则</div><div class="list-panel">' + [...data.sessions].sort((a, b) => b.date.localeCompare(a.date)).map((s) => '<button class="list-row" data-action="session-rules" data-id="' + esc(s.id) + '"><span class="row-text"><strong>' + esc(s.title || s.date) + '</strong><small>' + esc(rulesDescription(s.rules)) + '</small></span>' + icon('next') + '</button>').join('') + '</div>' : '') + '<button class="secondary-button full-button" data-action="new-preset">保存自定义规则</button>';
  }
  function historicalChips(s) { return s.games.some((g) => g.players.some((p) => p.chips)); }
  function preserveHistoricalChipRules(s, nextChipPT) {
    return (s.rules.chipPT || 0) === nextChipPT ? s.games : s.games.map((g) => !g.rules && g.players.some((p) => p.chips) ? { ...g, rules: clone(s.rules) } : g);
  }
  function finalChipsCard(s, players, rows) {
    const entered = !!s.finalChips;
    return '<section class="final-chips-card" aria-label="整场祝仪"><div class="final-chips-header"><h2>整场祝仪</h2><span>每祝 ' + fmt(s.rules.chipPT || 0, 1) + ' PT</span></div><p class="inline-note">整场结束后统一录入一次。获得填正数，支付填负数，默认均为 0。</p>' + (historicalChips(s) ? '<p class="legacy-chip-note">旧记录中的逐局祝仪已保留。这里仅录入尚未记过的新增祝仪，避免重复计算。</p>' : '') + '<div class="table-scroll"><table class="compact-table final-chips-table"><thead><tr><th>成员</th><th>本次净数量</th><th>本次祝仪 PT</th><th>总成绩 PT</th></tr></thead><tbody>' + players.map((p) => { const r = rows.find((r) => r.playerId === p.id); return '<tr><td>' + esc(p.name) + '</td><td>' + valueHtml(s.finalChips?.[p.id] || 0) + '</td><td>' + valueHtml(r?.finalChipScorePT || 0) + '</td><td>' + valueHtml(r?.totalPT || 0) + '</td></tr>'; }).join('') + '</tbody></table></div><button class="secondary-button full-button" data-action="final-chips" data-id="' + esc(s.id) + '">' + (entered ? '修改整场祝仪' : '录入整场祝仪') + '</button></section>';
  }
  function sessionPage(s) {
    const players = orderedPlayers(s.playerIds);
    const rows = safeAggregate(s);
    const effectiveRules = [s.rules, ...s.games.map((g) => g.rules || s.rules)];
    const hasIncome = s.tableFee > 0 || effectiveRules.some((r) => r.pointRate > 0 || r.chipValue > 0);
    let html = '<div class="table-top"><span class="inline-note">' + esc(s.date.replace(/-/g, '/')) + ' · ' + s.rules.playerCount + ' 人麻将 · ' + s.games.length + ' 局' + (s.group ? ' · ' + esc(s.group) : '') + '</span><button class="secondary-button" data-action="edit-session" data-id="' + esc(s.id) + '">编辑记录</button><button class="secondary-button" data-action="export-session" data-id="' + esc(s.id) + '">CSV</button></div><div class="table-scroll"><table class="score-table" style="--cols:' + players.length + '"><thead><tr><th><button class="pill" style="padding:7px;font-size:12px;border-radius:5px" data-action="session-rules" data-id="' + esc(s.id) + '">规则</button></th>' + players.map((p) => '<th><button data-action="member" data-id="' + esc(p.id) + '">' + avatar(p) + '<span class="member-name">' + esc(p.name) + '</span></button></th>').join('') + '</tr></thead><tbody>';
    const ranks = totalsFor([s]);
    html += '<tr class="total-row rank-counts-row"><td>顺位次数</td>' + players.map((p) => { const r = ranks.find((r) => r.playerId === p.id); return '<td title="按第1位至末位顺序">' + (r?.rankCounts || [0, 0, 0, 0]).slice(0, s.rules.playerCount).join(' ') + '</td>'; }).join('') + '</tr>';
    html += '<tr class="total-row"><td>总成绩</td>' + players.map((p) => '<td>' + signed(rows.find((r) => r.playerId === p.id)?.totalPT || 0) + '</td>').join('') + '</tr>';
    html += '<tr class="total-row"><td>祝仪总量</td>' + players.map((p) => '<td>' + signed(rows.find((r) => r.playerId === p.id)?.chips || 0, 0) + '</td>').join('') + '</tr>';
    if (hasIncome) html += '<tr class="total-row"><td>收支</td>' + players.map((p) => '<td>' + esc(currency()) + signed(rows.find((r) => r.playerId === p.id)?.netMoney || 0, 2) + '</td>').join('') + '</tr>';
    if (s.tableFee > 0) html += '<tr class="fee-row"><td>台费</td>' + players.map((p) => '<td>−' + esc(currency()) + fmt(rows.find((r) => r.playerId === p.id)?.fee || 0, 2) + '</td>').join('') + '</tr>';
    s.games.forEach((g, i) => { let result; try { result = engine().calculateGame(g.rules || s.rules, g); } catch (_) { result = { entries: [] }; } html += '<tr class="game-row" data-action="edit-game" data-id="' + esc(g.id) + '"><td class="round-label"><span class="round-button">第 ' + (i + 1) + ' 局</span>' + (g.rules ? '<span class="round-time">独立规则</span>' : '') + '</td>' + players.map((p) => { const r = result.entries.find((r) => r.playerId === p.id); const pt = r?.mahjongPT ?? r?.scorePT; return r ? '<td><div class="points-box"><span class="points-caption">点数</span><div class="points-digits">' + fmt(r.points / 100, 0) + '<small>00</small></div><span class="points-line"></span></div><div class="score-pt ' + cssSign(pt) + '">' + signed(pt) + '</div>' + (r.chipNet ? '<div class="chip-cell">历史祝仪 ' + signed(r.chipNet, 0) + '</div>' : '') + '</td>' : '<td style="color:#a7b0a9">轮休</td>'; }).join('') + '</tr>'; });
    html += '</tbody></table></div><p class="inline-note">' + (s.games.length ? '每局显示麻将成绩 PT。点击任一局，修改最终点数、成员或删除本局。整场祝仪在下方统一录入。' : '这里记录每局打完后的最终点数。') + '</p><button class="primary-button full-button" data-action="new-game">＋ 录入本局成绩</button>' + finalChipsCard(s, players, rows);
    if (hasIncome) {
      let settlement = []; try { settlement = engine().settleBalances(rows); } catch (_) { /* unavailable */ }
      html += '<div class="list-section-title">收支结算</div>' + (settlement.length ? '<ul class="settlement-list">' + settlement.map((t) => '<li><span>' + esc(playerName(t.from)) + ' → ' + esc(playerName(t.to)) + '</span><b>' + esc(currency()) + fmt(t.amount, 2) + '</b></li>').join('') + '</ul>' : '<p class="inline-note">当前收支已平衡。</p>') + '<p class="inline-note">整场祝仪与台费计入净收支；该表仅帮助核对记录。</p>';
    }
    html += '<div class="action-stack"><button class="secondary-button" data-action="clone-session" data-id="' + esc(s.id) + '">继承规则与成员，新建记录</button></div>';
    return html;
  }
  function showFinalChips(id) {
    const s = findSession(id); if (!s) return;
    const players = orderedPlayers(s.playerIds);
    draft = { kind: 'final-chips', sessionId: id };
    modal('整场祝仪结算', '<p class="inline-note">打完整场后填写每人的净增减。此处每次保存会更新整场数量，不会按回战重复累加。</p>' + (historicalChips(s) ? '<p class="legacy-chip-note">历史逐局祝仪已保留，此处只录新增祝仪。</p>' : '') + field('chipPT', '每祝价值（PT）', s.rules.chipPT || 0, 'min="0" max="1000" step="0.1" required') + '<div class="final-chips-inputs">' + players.map((p) => '<div class="field-row"><label for="final-chip-' + esc(p.id) + '">' + esc(p.name) + '</label><input id="final-chip-' + esc(p.id) + '" name="final-' + esc(p.id) + '" type="number" step="1" min="-100000" max="100000" value="' + esc(s.finalChips?.[p.id] || 0) + '" required aria-label="' + esc(p.name) + '整场祝仪净增减"></div>').join('') + '</div><div id="final-chip-preview"></div><div class="form-error" id="form-error" role="alert"></div>', formFooter('保存整场祝仪'), 'final-chips-form');
    updateFinalChipsPreview();
  }
  function readFinalChipsForm() {
    const f = document.getElementById('final-chips-form'); const s = findSession(draft.sessionId);
    const chipPT = Number(f.elements.chipPT.value);
    const rules = validateRules({ ...s.rules, chipPT });
    const finalChips = Object.fromEntries(s.playerIds.map((id) => { const input = f.elements['final-' + id]; const n = input.value === '' ? NaN : Number(input.value); finite(n, '整场祝仪', -100000, 100000); if (!Number.isInteger(n)) throw new Error('祝仪数量请输入整数'); return [id, n]; }));
    if (chipPT > 0 && Object.values(finalChips).reduce((sum, n) => sum + n, 0) !== 0) throw new Error('整场祝仪净增减总和应为 0');
    const candidate = { ...s, rules, finalChips, games: preserveHistoricalChipRules(s, chipPT) };
    const rows = engine().aggregateSession(candidate);
    return { candidate, rows };
  }
  function updateFinalChipsPreview() {
    try { const { candidate, rows } = readFinalChipsForm(); document.getElementById('final-chip-preview').innerHTML = '<div class="score-sum ok"><span>祝仪净数量合计 ' + fmt(Object.values(candidate.finalChips).reduce((sum, n) => sum + n, 0), 0) + '</span><span>每祝 ' + fmt(candidate.rules.chipPT) + ' PT</span></div><table class="compact-table"><thead><tr><th>成员</th><th>本次祝仪 PT</th><th>总成绩 PT</th></tr></thead><tbody>' + orderedPlayers(candidate.playerIds).map((p) => { const r = rows.find((r) => r.playerId === p.id); return '<tr><td>' + esc(p.name) + '</td><td>' + valueHtml(r?.finalChipScorePT || 0) + '</td><td>' + valueHtml(r?.totalPT || 0) + '</td></tr>'; }).join('') + '</tbody></table>'; }
    catch (e) { document.getElementById('final-chip-preview').innerHTML = '<p class="inline-note negative">' + esc(e.message) + '</p>'; }
  }
  function memberPage(p) {
    const sessions = filterSessions();
    const row = totalsFor(sessions).find((r) => r.playerId === p.id) || { games: 0, totalPT: 0, netMoney: 0, rankCounts: [0, 0, 0, 0], averageRank: 0, firsts: 0, lasts: 0, busts: 0 };
    const maxRank = Math.max(...row.rankCounts, 1);
    const applicable = sessions.filter((s) => s.playerIds.includes(p.id));
    const monthly = new Map(); applicable.forEach((s) => { const r = safeAggregate(s).find((r) => r.playerId === p.id); if (!r || (!r.games && !r.totalPT && !r.netMoney && !r.chips)) return; const key = s.date.slice(0, 7); const m = monthly.get(key) || { games: 0, pt: 0, money: 0 }; m.games += r.games; m.pt += r.totalPT; m.money += r.netMoney; monthly.set(key, m); });
    return '<div class="stat-person">' + avatar(p) + '<div class="row-text"><h2>' + esc(p.name) + (p.favorite ? ' <span class="favorite">★</span>' : '') + '</h2><p>' + esc(periodLabel()) + (p.archived ? ' · 已归档' : '') + '</p></div><button class="icon-button" data-action="edit-player" data-id="' + esc(p.id) + '" aria-label="编辑成员">' + icon('edit') + '</button></div><div class="stat-total"><div><span class="stat-value">' + row.games + '</span><span class="stat-label">对局</span></div><div><span class="stat-value">' + valueHtml(row.totalPT) + '</span><span class="stat-label">成绩 PT</span></div><div><span class="stat-value">' + (row.games ? fmt(row.averageRank, 2) : '—') + '</span><span class="stat-label">平均顺位</span></div></div><div class="list-section-title">顺位次数</div><div class="rank-bars">' + row.rankCounts.map((n, i) => '<div class="bar-col"><strong>' + n + ' 次</strong><div class="bar" style="height:' + Math.max(n / maxRank * 70, 3) + 'px"></div><span>' + (i + 1) + ' 位</span></div>').join('') + '</div><table class="compact-table" style="margin-top:20px"><tbody><tr><td>第一率</td><td>' + (row.games ? fmt(row.firsts / row.games * 100, 1) : '0') + '%</td></tr><tr><td>末位率</td><td>' + (row.games ? fmt(row.lasts / row.games * 100, 1) : '0') + '%</td></tr><tr><td>场均成绩</td><td>' + valueHtml(row.games ? row.totalPT / row.games : 0) + ' PT</td></tr><tr><td>净收支</td><td>' + valueHtml(row.netMoney, true) + '</td></tr><tr><td>被飞次数</td><td>' + row.busts + '</td></tr></tbody></table>' + (monthly.size ? '<div class="list-section-title">月度汇总</div><table class="compact-table"><thead><tr><th>月份</th><th>局数</th><th>成绩 PT</th><th>收支</th></tr></thead><tbody>' + [...monthly.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([m, r]) => '<tr><td>' + esc(m) + '</td><td>' + r.games + '</td><td>' + valueHtml(r.pt) + '</td><td>' + valueHtml(r.money, true) + '</td></tr>').join('') + '</tbody></table>' : '') + '<div class="list-section-title">历史记录</div>' + (applicable.length ? '<div class="list-panel">' + applicable.map((s) => { const r = safeAggregate(s).find((r) => r.playerId === p.id); return '<div class="member-history-row" data-action="session" data-id="' + esc(s.id) + '" role="button" tabindex="0"><div><strong>' + esc(s.title || s.date) + '</strong><small>' + esc(s.date) + ' · ' + (r?.games || 0) + ' 局</small></div><div class="history-value">' + valueHtml(r?.totalPT || 0) + '</div></div>'; }).join('') + '</div>' : '<p class="inline-note">这段期间还没有成绩。</p>');
  }
  function modal(title, content, footer = '', formId = '') {
    stateUI.modal = title;
    document.getElementById('modal-root').innerHTML = '<div class="modal-backdrop"><section class="modal-sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="modal-header"><button class="icon-button" data-action="close-modal" aria-label="关闭">' + icon('close') + '</button><h2>' + esc(title) + '</h2><span style="width:42px"></span></div>' + (formId ? '<form id="' + esc(formId) + '">' : '') + '<div class="modal-content">' + content + '</div>' + (footer ? '<div class="modal-footer">' + footer + '</div>' : '') + (formId ? '</form>' : '') + '</section></div>';
    document.body.style.overflow = 'hidden';
  }
  function closeModal() { document.getElementById('modal-root').innerHTML = ''; document.body.style.overflow = ''; stateUI.modal = null; draft = null; }
  const formFooter = (label = '保存') => '<button class="secondary-button" type="button" data-action="close-modal">取消</button><button class="primary-button" type="submit">' + label + '</button>';
  function showPlayer(id) {
    const p = id ? findPlayer(id) : null;
    draft = { kind: 'player', id: id || null, avatar: p?.avatar || AVATARS[data.players.length % AVATARS.length] };
    modal(p ? '编辑成员' : '添加成员', '<div class="field-row"><label for="player-name">姓名</label><input id="player-name" name="name" value="' + esc(p?.name || '') + '" maxlength="40" required placeholder="输入姓名" autocomplete="off"></div><div class="form-section">头像</div><div class="avatar-picker">' + AVATARS.map((a) => '<button type="button" class="avatar-choice ' + (a === draft.avatar ? 'selected' : '') + '" data-action="choose-avatar" data-avatar="' + esc(a) + '" aria-label="头像' + esc(a) + '">' + esc(a) + '</button>').join('') + '</div><div class="field-row"><label for="player-favorite">收藏成员 · 显示在前面</label><input id="player-favorite" name="favorite" type="checkbox" ' + (p?.favorite ? 'checked' : '') + '></div>' + (p ? '<div class="action-stack"><button class="danger-button" type="button" data-action="remove-player" data-id="' + esc(p.id) + '">' + (data.sessions.some((s) => s.playerIds.includes(p.id)) ? (p.archived ? '恢复成员' : '归档成员') : '删除成员') + '</button></div>' : '') + '<div class="form-error" id="form-error" role="alert"></div>', formFooter(), 'player-form');
  }
  function field(name, label, value, attrs = '', type = 'number') { return '<div class="field-row"><label for="rule-' + esc(name) + '">' + label + '</label><input id="rule-' + esc(name) + '" name="' + esc(name) + '" type="' + type + '" value="' + esc(value) + '" ' + attrs + '></div>'; }
  function selectField(name, label, value, choices) { return '<div class="field-row"><label for="rule-' + name + '">' + label + '</label><select id="rule-' + name + '" name="' + name + '">' + choices.map(([v, t]) => '<option value="' + esc(v) + '" ' + (String(value) === String(v) ? 'selected' : '') + '>' + esc(t) + '</option>').join('') + '</select></div>'; }
  function rulesForm(r, includeChips = true) {
    return '<div class="form-section">起始点数</div>' + field('startPoints', '持有点数', r.startPoints, 'min="100" max="1000000" step="100" required') + '<div class="rule-chips">' + [20000, 25000, 30000, 35000].map((n) => '<button type="button" data-action="rule-number" data-field="startPoints" data-value="' + n + '">' + fmt(n, 0) + '</button>').join('') + '</div>' + field('returnPoints', '返还点数', r.returnPoints, 'min="100" max="1000000" step="100" required') + '<div class="rule-chips">' + [25000, 30000, 35000, 40000].map((n) => '<button type="button" data-action="rule-number" data-field="returnPoints" data-value="' + n + '">' + fmt(n, 0) + '</button>').join('') + '</div><div class="form-section">顺位马</div><div class="uma-inputs" style="--n:' + r.playerCount + '">' + r.uma.map((n, i) => '<label>第 ' + (i + 1) + ' 位<input name="uma' + i + '" type="number" step="0.1" min="-1000" max="1000" value="' + esc(n) + '" required></label>').join('') + '</div><div class="rule-chips"><button type="button" data-action="uma-preset" data-value="0">无</button><button type="button" data-action="uma-preset" data-value="5-10">5 / 10</button><button type="button" data-action="uma-preset" data-value="10-20">10 / 20</button><button type="button" data-action="uma-preset" data-value="10-30">10 / 30</button></div>' + selectField('tieMode', '同分顺位', r.tieMode, [['seat', '按本局成员顺序'], ['split', '马点与头名奖平分']]) + selectField('rounding', '最终点数取整', r.rounding, [['fiveSix', '五舍六入'], ['none', '保留 0.1 PT'], ['round', '四舍五入'], ['ceil', '向上取整'], ['floor', '向下取整']]) + '<div class="inline-note">麻将成绩 = 点数差 / 1,000 + 顺位马。起点与返点差额为头名奖（Oka），另计入头名成绩。' + (includeChips ? '整场总成绩 = 各局麻将成绩合计 + 整场祝仪净数量 × 每祝 PT。' : '整场祝仪在场次页面统一录入。') + '</div><div class="form-section">' + (includeChips ? '收支与整场祝仪' : '收支') + '</div>' + field('pointRate', '每 1 PT 的金额', r.pointRate || 0, 'min="0" max="100000" step="0.01" required') + (includeChips ? field('chipPT', '整场每祝价值（PT）', r.chipPT || 0, 'min="0" max="1000" step="0.1" required') : '') + (r.chipValue > 0 ? '<p class="inline-note">旧版逐局祝仪金额继续保留，单价 ' + esc(currency()) + fmt(r.chipValue, 2) + '。</p>' : '') + '<div class="inline-note">1 PT = 1,000 点；每 PT 金额设为 0 时只统计成绩。</div><details class="form-details"><summary>其他规则 · 飞人奖 / 烧鸟</summary>' + field('tobiBonusPT', '飞人奖（PT）', r.tobiBonusPT || 0, 'min="0" max="1000" step="0.1" required') + field('yakitoriPT', '烧鸟罚分（PT）', r.yakitoriPT || 0, 'min="0" max="1000" step="0.1" required') + selectField('yakitoriMode', '烧鸟罚分方式', r.yakitoriMode || 'person', [['person', '向每名未烧鸟者支付'], ['table', '罚分均分给未烧鸟者']]) + '<div class="inline-note">飞人奖启用后，在每局录入时指定被飞成员向谁支付。烧鸟需在该局勾选。</div></details>';
  }
  function playerSelectGrid(ids) { const players = orderedPlayers([...new Set([...activePlayers().map((p) => p.id), ...ids])]); return players.length ? '<div class="player-check-grid">' + players.map((p) => '<label class="player-check ' + (ids.includes(p.id) ? 'selected' : '') + '"><input type="checkbox" name="selectedPlayer" value="' + esc(p.id) + '" ' + (ids.includes(p.id) ? 'checked' : '') + '>' + avatar(p) + '<span class="member-name">' + esc(p.name) + '</span><span class="check-mark">' + (ids.includes(p.id) ? '✓' : '') + '</span></label>').join('') + '</div>' : '<p class="inline-note">还没有成员，先在下方添加。</p>'; }
  function showSession(id, inheritId) {
    const source = id ? findSession(id) : inheritId ? findSession(inheritId) : null;
    draft = { kind: 'session', id: id || null, rules: clone(source?.rules || defaultRules(4)), playerIds: clone(source?.playerIds || []), originalPlayerIds: clone(id ? source.playerIds : []), title: id ? source.title : '', date: id ? source.date : today, group: source?.group || '', tableFee: id ? source.tableFee || 0 : 0, fees: id ? clone(source.fees || null) : null };
    showSessionDraft();
  }
  function showSessionDraft() {
    const d = draft;
    const presets = data.settings.rulePresets || [];
    modal(d.id ? '编辑记录' : '新建记录', '<div class="segmented"><button type="button" data-action="session-count" data-n="4" class="' + (d.rules.playerCount === 4 ? 'active' : '') + '">4 人麻将</button><button type="button" data-action="session-count" data-n="3" class="' + (d.rules.playerCount === 3 ? 'active' : '') + '">3 人麻将</button></div>' + field('title', '记录名称', d.title || '', 'maxlength="60" placeholder="可留空"', 'text') + field('date', '日期', d.date || today, 'required', 'date') + field('group', '分组', d.group || '', 'maxlength="40" placeholder="例如 周末组"', 'text') + '<div class="form-section">成员 <span id="player-count-note" style="font-weight:400;font-size:11px">至少 ' + d.rules.playerCount + ' 位，最多 8 位（可轮休）</span></div><div id="session-player-grid">' + playerSelectGrid(d.playerIds) + '</div><div class="quick-add"><input id="quick-player-name" placeholder="新成员姓名" maxlength="40" autocomplete="off"><button type="button" data-action="quick-player">添加成员</button></div>' + (presets.length ? '<div class="field-row"><label for="rule-preset-select">套用常用规则</label><select id="rule-preset-select"><option value="">选择规则…</option>' + presets.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('') + '</select></div>' : '') + '<div id="rules-form-area">' + rulesForm(d.rules) + '</div><div class="form-section">台费</div>' + field('tableFee', '本次台费总额', d.tableFee || 0, 'min="0" max="10000000" step="0.01"') + selectField('feeMode', '台费分摊', d.fees ? 'custom' : 'equal', [['equal', '全部成员均分'], ['custom', '自定义分摊']]) + '<div id="fee-custom-area"' + (d.fees ? '' : ' hidden') + '>' + customFeesHtml(d.playerIds, d.fees) + '</div><div class="form-error" id="form-error" role="alert"></div>', formFooter(d.id ? '保存修改' : '创建记录'), 'session-form');
  }
  function customFeesHtml(ids, fees) { return ids.map((id) => '<div class="field-row"><label for="fee-' + esc(id) + '">' + esc(playerName(id)) + '</label><input id="fee-' + esc(id) + '" name="fee-' + esc(id) + '" type="number" min="0" max="10000000" step="0.01" value="' + esc(fees?.[id] || 0) + '"></div>').join('') + '<p class="inline-note">各成员分摊金额之和必须等于台费总额。</p>'; }
  function readRules(form, fallback) {
    const number = (name) => Number(form.elements[name].value);
    const n = fallback.playerCount;
    const r = { ...clone(fallback), playerCount: n, startPoints: number('startPoints'), returnPoints: number('returnPoints'), uma: Array.from({ length: n }, (_, i) => number('uma' + i)), tieMode: form.elements.tieMode.value, rounding: form.elements.rounding.value, pointRate: number('pointRate'), chipPT: form.elements.chipPT ? number('chipPT') : fallback.chipPT || 0, chipValue: fallback.chipValue || 0, tobiBonusPT: number('tobiBonusPT'), yakitoriPT: number('yakitoriPT'), yakitoriMode: form.elements.yakitoriMode.value, negativeSettlement: true };
    return validateRules(r);
  }
  function collectSessionDraft() {
    const f = document.getElementById('session-form'); if (!f || !draft) return;
    draft.title = f.elements.title.value; draft.date = f.elements.date.value; draft.group = f.elements.group.value; draft.tableFee = Number(f.elements.tableFee.value);
    draft.playerIds = [...f.querySelectorAll('[name=selectedPlayer]:checked')].map((e) => e.value);
    try { draft.rules = readRules(f, draft.rules); } catch (_) { /* Preserve last valid rules while switching view. */ }
    draft.fees = f.elements.feeMode.value === 'custom' ? Object.fromEntries(draft.playerIds.map((id) => [id, Number(f.elements['fee-' + id]?.value || 0)])) : null;
  }
  function showPreset(id, n = 4) {
    const preset = (data.settings.rulePresets || []).find((p) => p.id === id);
    draft = { kind: 'preset', id: id || null, rules: clone(preset?.rules || defaultRules(n)) };
    showPresetDraft(preset?.name || '');
  }
  function showPresetDraft(name) { const d = draft; modal(d.id ? '编辑常用规则' : '保存常用规则', '<div class="segmented"><button type="button" data-action="preset-count" data-n="4" class="' + (d.rules.playerCount === 4 ? 'active' : '') + '">4 人麻将</button><button type="button" data-action="preset-count" data-n="3" class="' + (d.rules.playerCount === 3 ? 'active' : '') + '">3 人麻将</button></div>' + field('presetName', '规则名称', name, 'maxlength="40" required placeholder="例如 周末四麻"', 'text') + rulesForm(d.rules) + (d.id ? '<div class="action-stack"><button type="button" class="danger-button" data-action="delete-preset" data-id="' + esc(d.id) + '">删除常用规则</button></div>' : '') + '<div class="form-error" id="form-error" role="alert"></div>', formFooter(), 'preset-form'); }
  function showSessionRules(id) {
    const s = findSession(id); if (!s) return;
    const r = s.rules;
    const rounding = { fiveSix: '五舍六入', none: '保留 0.1 PT', round: '四舍五入', ceil: '向上取整', floor: '向下取整' };
    modal('本次记录规则', '<table class="detail-rule-table"><tbody>' + [['人数', r.playerCount + ' 人'], ['持有点数', fmt(r.startPoints, 0)], ['返还点数', fmt(r.returnPoints, 0)], ['顺位马', r.uma.join(' / ')], ['同分顺位', r.tieMode === 'split' ? '马点与头名奖平分' : '按本局成员顺序'], ['最终点数取整', rounding[r.rounding] || r.rounding], ['每 1 PT 金额', currency() + fmt(r.pointRate || 0, 2)], ['每祝价值', fmt(r.chipPT || 0) + ' PT'], ['飞人奖', fmt(r.tobiBonusPT || 0) + ' PT'], ['烧鸟罚分', fmt(r.yakitoriPT || 0) + ' PT'], ['台费总额', currency() + fmt(s.tableFee || 0, 2)]].map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>').join('') + '</tbody></table><div class="inline-note">修改主规则将重新计算未设置独立规则的历史对局。</div>', '<button class="secondary-button" data-action="close-modal">关闭</button><button class="primary-button" data-action="edit-session" data-id="' + esc(id) + '">修改规则</button>');
  }
  function showGame(id) {
    const s = findSession(stateUI.sessionId); if (!s) return;
    const g = id ? s.games.find((g) => g.id === id) : null;
    const r = clone(g?.rules || s.rules);
    draft = { kind: 'game', id: id || null, sessionId: s.id, rules: r, rulesOverride: !!g?.rules, players: clone(g?.players || s.playerIds.slice(0, r.playerCount).map((playerId) => ({ playerId, points: r.startPoints, chips: 0, yakitori: false }))), historicalChipValues: Object.fromEntries((g?.players || []).map((p) => [p.playerId, p.chips || 0])), autoLast: !g, tobiTransfers: clone(g?.tobiTransfers || []) };
    showGameDraft();
  }
  function showGameDraft() {
    const d = draft; const s = findSession(d.sessionId); const r = d.rules;
    const round = d.id ? s.games.findIndex((g) => g.id === d.id) + 1 : s.games.length + 1;
    modal(d.id ? '编辑第 ' + round + ' 局' : '录入第 ' + round + ' 局成绩', '<p class="inline-note" style="margin:0">输入打完这一局后的最终点数，以 100 点为单位。填 250，右侧 00 表示 25,000 点；可以输入负数。</p><div class="game-entry-grid" style="--n:' + r.playerCount + '">' + d.players.map((p, i) => '<div class="game-entry-cell"><span id="game-avatar-' + i + '">' + avatar(findPlayer(p.playerId)) + '</span><select name="seat' + i + '" aria-label="第' + (i + 1) + '位成员">' + s.playerIds.map((id) => '<option value="' + esc(id) + '" ' + (id === p.playerId ? 'selected' : '') + '>' + esc(playerName(id)) + '</option>').join('') + '</select><label for="game-points-' + i + '">最终点数</label><div class="point-entry-wrap"><input id="game-points-' + i + '" name="points' + i + '" type="number" step="1" min="-10000" max="10000" value="' + esc(p.points / 100) + '" required ' + (d.autoLast && i === r.playerCount - 1 ? 'readonly' : '') + ' aria-label="' + esc(playerName(p.playerId)) + '最终点数（100点单位）"><span class="point-input-suffix" aria-hidden="true">00</span></div>' + (r.yakitoriPT > 0 ? '<label class="yakitori-label"><input type="checkbox" name="yakitori' + i + '" ' + (p.yakitori ? 'checked' : '') + '>烧鸟</label>' : '') + '</div>').join('') + '</div><label class="auto-row"><input type="checkbox" name="autoLast" ' + (d.autoLast ? 'checked' : '') + '>自动补齐最后一人的点数</label><div id="game-sum" class="score-sum"></div>' + (d.players.some((p) => p.chips) ? '<p class="legacy-chip-note">本局历史祝仪只读保留：' + d.players.map((p) => esc(playerName(p.playerId)) + ' ' + signed(p.chips || 0, 0)).join(' / ') + '。新增祝仪请在整场结束后统一录入。</p>' : '') + '<p class="inline-note">祝仪在整场结束后统一录入，当前只记录这一局的麻将成绩。</p>' + (r.tobiBonusPT > 0 ? '<div class="form-section">飞人奖</div>' + d.players.map((p, i) => selectField('tobi' + i, esc(playerName(p.playerId)) + ' 支付给', d.tobiTransfers.find((t) => t.from === p.playerId)?.to || '', [['', '没有被飞 / 不支付'], ...s.playerIds.filter((id) => id !== p.playerId).map((id) => [id, playerName(id)])])).join('') + '<p class="inline-note">只有最终点数小于或等于 0 的成员可指定飞人奖收款方。</p>' : '') + '<div class="preview-box"><div class="preview-title">本局麻将成绩预览 · PT</div><div id="game-preview"></div></div><div class="field-row"><label>本局规则</label><button class="pill" type="button" data-action="game-rules" style="font-size:12px">' + (d.rulesOverride ? '独立规则 · 修改' : '继承主规则 · 修改') + '</button></div>' + (d.rulesOverride ? '<button type="button" class="subtle-button" data-action="game-inherit">恢复继承主规则</button>' : '') + (d.id ? '<div class="action-stack"><button type="button" class="danger-button" data-action="delete-game" data-id="' + esc(d.id) + '">删除本局</button></div>' : '') + '<div class="form-error" id="form-error" role="alert"></div>', formFooter(d.id ? '保存修改' : '保存成绩'), 'game-form');
    updateGamePreview();
  }
  function readGameForm() {
    const f = document.getElementById('game-form'); if (!f || !draft) return null;
    const r = draft.rules;
    const players = Array.from({ length: r.playerCount }, (_, i) => ({ playerId: f.elements['seat' + i].value, points: f.elements['points' + i].value === '' ? NaN : Number(f.elements['points' + i].value) * 100, chips: draft.historicalChipValues[f.elements['seat' + i].value] || 0, yakitori: !!f.elements['yakitori' + i]?.checked }));
    if (f.elements.autoLast.checked) { players[r.playerCount - 1].points = r.startPoints * r.playerCount - players.slice(0, -1).reduce((sum, p) => sum + p.points, 0); f.elements['points' + (r.playerCount - 1)].value = players[r.playerCount - 1].points / 100; }
    const tobiTransfers = players.flatMap((p, i) => { const to = f.elements['tobi' + i]?.value; return p.points <= 0 && to ? [{ from: p.playerId, to }] : []; });
    draft.players = players; draft.autoLast = f.elements.autoLast.checked; draft.tobiTransfers = tobiTransfers;
    return { id: draft.id || uid('game'), players, tobiTransfers, ...(draft.rulesOverride ? { rules: clone(r) } : {}) };
  }
  function updateGamePreview() {
    const f = document.getElementById('game-form'); if (!f) return;
    const g = readGameForm(); const r = draft.rules;
    f.elements['points' + (r.playerCount - 1)].readOnly = f.elements.autoLast.checked;
    g.players.forEach((p, i) => { document.getElementById('game-avatar-' + i).innerHTML = avatar(findPlayer(p.playerId)); f.elements['points' + i].setAttribute('aria-label', playerName(p.playerId) + '最终点数（100点单位）'); });
    const sum = g.players.reduce((n, p) => n + p.points, 0); const expected = r.startPoints * r.playerCount;
    const sumEl = document.getElementById('game-sum'); sumEl.className = 'score-sum ' + (sum === expected ? 'ok' : 'bad'); sumEl.innerHTML = '<span>点数合计 ' + fmt(sum, 0) + '</span><span>' + (sum === expected ? '✓ 合计正确' : '应为 ' + fmt(expected, 0)) + '</span>';
    try { const result = engine().calculateGame(r, g); document.getElementById('game-preview').innerHTML = '<div class="preview-values" style="--n:' + r.playerCount + '">' + g.players.map((p) => { const e = result.entries.find((e) => e.playerId === p.playerId); return '<div><div class="score-pt">' + valueHtml(e?.mahjongPT ?? e?.scorePT) + '</div><small>第 ' + (e?.rank || '—') + ' 位</small>' + (r.pointRate > 0 || r.chipValue > 0 ? '<small>' + valueHtml(e?.money, true) + '</small>' : '') + '</div>'; }).join('') + '</div>' + (result.warnings.length ? '<ul class="warning-list">' + result.warnings.map((w) => '<li>' + esc(typeof w === 'string' ? w : w.message || String(w)) + '</li>').join('') + '</ul>' : ''); } catch (e) { document.getElementById('game-preview').innerHTML = '<div class="form-error">' + esc(e.message || '请检查点数与成员。') + '</div>'; }
  }
  function showGameRules() {
    readGameForm();
    const d = draft;
    modal('本局独立规则', '<p class="inline-note">只影响这一局麻将成绩与收支。人数与记录保持一致；整场祝仪单价在整场结算时修改。</p>' + rulesForm(d.rules, false) + '<div class="form-error" id="form-error" role="alert"></div>', '<button class="secondary-button" type="button" data-action="return-game">返回录入</button><button class="primary-button" type="submit">应用本局</button>', 'game-rules-form');
  }
  function confirmModal(title, text, onConfirm, label = '删除') {
    const previousDraft = draft;
    modal(title, '<div class="confirm-text">' + esc(text) + '</div>', '<button class="secondary-button" data-action="close-modal">取消</button><button class="' + (label === '删除' ? 'danger-button' : 'primary-button') + '" id="confirm-action">' + esc(label) + '</button>');
    draft = previousDraft;
    document.getElementById('confirm-action').addEventListener('click', () => { closeModal(); onConfirm(); });
  }
  function showFilter() {
    const f = data.settings.filter;
    modal('筛选日期与显示', '<div class="filter-form"><label>期间<select name="period"><option value="all" ' + (f.period === 'all' ? 'selected' : '') + '>全部期间</option><option value="month" ' + (f.period === 'month' ? 'selected' : '') + '>按月</option><option value="year" ' + (f.period === 'year' ? 'selected' : '') + '>按年</option><option value="custom" ' + (f.period === 'custom' ? 'selected' : '') + '>自定义日期</option></select></label><label>月份<input name="value" type="month" value="' + esc(f.value.slice(0, 7)) + '"></label><div class="date-pair"><label>开始日期<input name="from" type="date" value="' + esc(f.from || '') + '"></label><label>结束日期<input name="to" type="date" value="' + esc(f.to || '') + '"></label></div><label>显示<select name="viewMode"><option value="pt" ' + (data.settings.viewMode === 'pt' ? 'selected' : '') + '>成绩 PT</option><option value="money" ' + (data.settings.viewMode === 'money' ? 'selected' : '') + '>收支</option></select></label></div><div class="form-error" id="form-error" role="alert"></div>', formFooter('应用'), 'filter-form');
  }
  function showSettings() {
    const shortcuts = '<div class="list-panel"><button class="list-row" data-action="tab" data-tab="rules"><span class="row-text"><strong>常用规则</strong><small>查看与保存 3 人、4 人规则</small></span>' + icon('rules') + '</button><button class="list-row" data-action="tab" data-tab="scores"><span class="row-text"><strong>成绩统计</strong><small>全部成员的成绩与平均顺位</small></span>' + icon('score') + '</button></div>';
    modal('设置与备份', shortcuts + '<div class="list-section-title">数据</div><div class="list-panel"><button class="list-row" data-action="export-backup"><span class="row-text"><strong>导出 JSON 备份</strong><small>包含全部成员、规则和成绩，可用于换机</small></span>' + icon('export') + '</button><button class="list-row" data-action="import-backup"><span class="row-text"><strong>导入 JSON 备份</strong><small>选择文件后核对，确认后替换本机记录</small></span>' + icon('next') + '</button><button class="list-row" data-action="export-all-csv"><span class="row-text"><strong>导出全部 CSV</strong><small>供表格软件查看每局点数、顺位、成绩与收支</small></span>' + icon('export') + '</button></div><div class="list-section-title">金额显示</div><div class="field-row"><label for="currency-select">货币符号</label><select id="currency-select"><option value="¥" ' + (currency() === '¥' ? 'selected' : '') + '>¥</option><option value="$" ' + (currency() === '$' ? 'selected' : '') + '>$</option><option value="A$" ' + (currency() === 'A$' ? 'selected' : '') + '>A$</option><option value="HK$" ' + (currency() === 'HK$' ? 'selected' : '') + '>HK$</option><option value="€" ' + (currency() === '€' ? 'selected' : '') + '>€</option></select></div><div class="list-section-title">使用说明</div><ol class="help-list"><li>添加成员，再创建 3 人或 4 人麻将记录。</li><li>每局结束后录入最终点数。成员人数可大于对局人数，方便轮休。</li><li>整场结束后，在记录最下面统一录入祝仪净数量和每祝 PT。</li><li>按规则自动计算麻将成绩、祝仪 PT 与总收支。</li><li>首页按分组汇总；筛选内选择月、年或全部期间。</li><li>数据保存在本机。请定期导出备份。</li></ol><div class="settings-note">麻将成绩 · 中文版 1.0.2<br>数据保存在当前浏览器本地，不会上传。请定期导出备份。<br>仅用于局后成绩记录。<br>中文版本为独立实现，与原应用作者无隶属关系。</div>' + (!data.sessions.length ? '<button class="secondary-button full-button" data-action="examples">加载示例记录</button>' : '') + '<button class="danger-button full-button" data-action="clear-data">清空本机记录</button>');
  }
  function exportFile(filename, content, mime) {
    try {
      if (window.Android && typeof window.Android.exportFile === 'function') { window.Android.exportFile(filename, content, mime); toast('已打开保存文件窗口'); }
      else { const url = URL.createObjectURL(new Blob([content], { type: mime })); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); toast('导出文件已生成'); }
    } catch (e) { toast('导出失败：' + e.message); }
  }
  const csvCell = (value) => { let s = String(value == null ? '' : value); if (/^[=+\-@\t\r]/.test(s) && typeof value !== 'number') s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  function exportCSV(sessions) {
    if (!sessions.length) { toast('没有可导出的记录'); return; }
    try { sessions.forEach((s) => engine().aggregateSession(s)); }
    catch (e) { calculationError = e.message || '规则或金额无效'; refreshStorageWarning(); toast('统计失败，CSV 未导出：' + calculationError); return; }
    const lines = [['日期', '记录名称', '分组', '局数', '成员', '最终点数', '顺位', '麻将PT', '祝仪PT', '总成绩PT', '祝仪净增减', '点数收支', '旧版祝仪金额', '收支（该行）', '台费分摊（整场）', '整场净收支']];
    sessions.forEach((s) => {
      const rows = safeAggregate(s);
      s.games.forEach((g, i) => engine().calculateGame(g.rules || s.rules, g).entries.forEach((e) => lines.push([s.date, s.title, s.group, i + 1, playerName(e.playerId), e.points, e.rank, e.mahjongPT == null ? e.scorePT : e.mahjongPT, e.chipScorePT || 0, e.scorePT, e.chipNet, e.pointMoney, e.chipMoney, e.money, '', ''])));
      if (s.finalChips) rows.forEach((r) => lines.push([s.date, s.title, s.group, '整场祝仪结算', playerName(r.playerId), '', '', 0, r.finalChipScorePT || 0, r.finalChipScorePT || 0, r.finalChipNet || 0, r.finalChipMoney || 0, 0, r.finalChipMoney || 0, '', '']));
      rows.forEach((r) => lines.push([s.date, s.title, s.group, '整场汇总', playerName(r.playerId), '', '', r.mahjongPT || 0, r.chipScorePT || 0, r.totalPT, r.chips, '', '', r.grossMoney, r.fee, r.netMoney]));
    });
    exportFile('麻将成绩-' + today + '.csv', '\uFEFF' + lines.map((r) => r.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  }
  function finite(value, name, min, max) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(name + '数值无效'); return value; }
  function validateRules(raw) {
    if (!raw || ![3, 4].includes(raw.playerCount)) throw new Error('人数须为 3 或 4');
    const n = raw.playerCount;
    const r = { ...defaultRules(n), ...raw, chipPT: raw.chipPT == null ? 0 : raw.chipPT };
    finite(r.startPoints, '持有点数', 100, 1000000); finite(r.returnPoints, '返还点数', 100, 1000000);
    if (r.startPoints % 100 || r.returnPoints % 100) throw new Error('持有点数与返还点数应为 100 的倍数');
    if (!Array.isArray(r.uma) || r.uma.length !== n) throw new Error('顺位马数量不正确');
    r.uma = r.uma.map((v) => finite(v, '顺位马', -1000, 1000));
    if (Math.abs(r.uma.reduce((a, b) => a + b, 0)) > 0.000001) throw new Error('顺位马总和必须为 0');
    if (!['seat', 'split'].includes(r.tieMode)) throw new Error('同分规则无效');
    if (!['none', 'round', 'ceil', 'floor', 'fiveSix'].includes(r.rounding)) throw new Error('取整规则无效');
    ['pointRate', 'chipPT', 'chipValue', 'tobiBonusPT', 'yakitoriPT'].forEach((k) => finite(r[k] || 0, k, 0, 1000000));
    if (Math.abs(r.chipPT * 10 - Math.round(r.chipPT * 10)) > 0.000001) throw new Error('每祝价值最多保留一位小数');
    if (!['person', 'table'].includes(r.yakitoriMode || 'person')) throw new Error('烧鸟规则无效');
    return { playerCount: n, startPoints: r.startPoints, returnPoints: r.returnPoints, uma: r.uma, tieMode: r.tieMode, rounding: r.rounding, pointRate: r.pointRate || 0, chipPT: r.chipPT || 0, chipValue: r.chipValue || 0, tobiBonusPT: r.tobiBonusPT || 0, yakitoriPT: r.yakitoriPT || 0, yakitoriMode: r.yakitoriMode || 'person', negativeSettlement: true };
  }
  function validateStore(raw) {
    if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.players) || !Array.isArray(raw.sessions)) throw new Error('备份格式或版本不正确');
    if (raw.players.length > 500 || raw.sessions.length > 10000) throw new Error('备份记录过多');
    const playerIds = new Set();
    const idSafe = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id) && id !== '__table__';
    const players = raw.players.map((p) => { if (!p || !idSafe(p.id) || playerIds.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80) throw new Error('成员资料无效或重复'); playerIds.add(p.id); return { id: p.id, name: p.name.trim(), avatar: typeof p.avatar === 'string' && p.avatar.length <= 32 ? p.avatar : '🀄', favorite: !!p.favorite, archived: !!p.archived }; });
    const sessionIds = new Set(); const gameIds = new Set(); let gameCount = 0;
    const sessions = raw.sessions.map((s) => {
      if (!s || !idSafe(s.id) || sessionIds.has(s.id) || typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date) || Number.isNaN(Date.parse(s.date + 'T12:00:00')) || !Array.isArray(s.playerIds) || !Array.isArray(s.games)) throw new Error('记录格式无效');
      sessionIds.add(s.id); const rules = validateRules(s.rules);
      if (s.playerIds.length < rules.playerCount || s.playerIds.length > 8 || new Set(s.playerIds).size !== s.playerIds.length || s.playerIds.some((id) => !playerIds.has(id))) throw new Error('记录的成员无效');
      if (typeof s.title !== 'string' || s.title.length > 80 || typeof (s.group || '') !== 'string' || (s.group || '').length > 80) throw new Error('记录名称无效');
      const tableFee = finite(s.tableFee || 0, '台费', 0, 10000000);
      let fees;
      if (s.fees) { if (typeof s.fees !== 'object' || Array.isArray(s.fees)) throw new Error('台费分摊无效'); fees = {}; s.playerIds.forEach((id) => fees[id] = finite(s.fees[id] || 0, '台费分摊', 0, 10000000)); if (Math.abs(Object.values(fees).reduce((a, b) => a + b, 0) - tableFee) > 0.005) throw new Error('台费分摊总和不匹配'); }
      const games = s.games.map((g) => {
        if (++gameCount > 100000 || !g || !idSafe(g.id) || gameIds.has(g.id) || !Array.isArray(g.players)) throw new Error('对局资料无效');
        gameIds.add(g.id); const gr = g.rules ? validateRules(g.rules) : rules;
        if (gr.playerCount !== rules.playerCount || g.players.length !== gr.playerCount || new Set(g.players.map((p) => p.playerId)).size !== g.players.length) throw new Error('对局人数无效');
        const gp = g.players.map((p) => { if (!p || !s.playerIds.includes(p.playerId)) throw new Error('对局成员不属于本次记录'); finite(p.points, '最终点数', -1000000, 1000000); finite(p.chips || 0, '祝仪', -100000, 100000); if (p.points % 100 || (p.chips || 0) % 1) throw new Error('点数或祝仪单位无效'); return { playerId: p.playerId, points: p.points, chips: p.chips || 0, yakitori: !!p.yakitori }; });
        if (gp.reduce((sum, p) => sum + p.points, 0) !== gr.startPoints * gr.playerCount) throw new Error('对局点数合计不正确');
        if ((gr.chipPT > 0 || gr.chipValue > 0) && gp.reduce((sum, p) => sum + p.chips, 0) !== 0) throw new Error('祝仪净增减总和不为 0');
        const transfers = (g.tobiTransfers || []).map((t) => { if (!t || !gp.some((p) => p.playerId === t.from && p.points <= 0) || !gp.some((p) => p.playerId === t.to) || t.from === t.to) throw new Error('飞人奖设置无效'); return { from: t.from, to: t.to }; });
        if (new Set(transfers.map((t) => t.from)).size !== transfers.length) throw new Error('飞人奖支付重复');
        const game = { id: g.id, players: gp, tobiTransfers: transfers, ...(g.rules ? { rules: gr } : {}) };
        engine().calculateGame(gr, game);
        return game;
      });
      let finalChips;
      if (s.finalChips != null) {
        if (typeof s.finalChips !== 'object' || Array.isArray(s.finalChips) || Object.keys(s.finalChips).some((id) => !s.playerIds.includes(id))) throw new Error('整场祝仪成员无效');
        finalChips = Object.fromEntries(s.playerIds.map((id) => { const n = Object.prototype.hasOwnProperty.call(s.finalChips, id) ? finite(s.finalChips[id], '整场祝仪', -100000, 100000) : 0; if (!Number.isInteger(n)) throw new Error('整场祝仪数量请输入整数'); return [id, n]; }));
        if (rules.chipPT > 0 && Object.values(finalChips).reduce((sum, n) => sum + n, 0) !== 0) throw new Error('整场祝仪净增减总和应为 0');
      }
      const cleanSession = { id: s.id, title: s.title, date: s.date, group: s.group || '', playerIds: [...s.playerIds], rules, games, tableFee, ...(fees ? { fees } : {}), ...(finalChips ? { finalChips } : {}) };
      engine().aggregateSession(cleanSession);
      return cleanSession;
    });
    const settings = raw.settings || {};
    const filter = settings.filter || {};
    return { schemaVersion: 1, players, sessions, settings: { currency: ['¥', '$', 'A$', 'HK$', '€'].includes(settings.currency) ? settings.currency : '¥', viewMode: settings.viewMode === 'money' ? 'money' : 'pt', filter: { period: ['all', 'month', 'year', 'custom'].includes(filter.period) ? filter.period : 'all', value: typeof filter.value === 'string' && /^\d{4}-\d{2}$/.test(filter.value.slice(0, 7)) ? filter.value.slice(0, 7) : currentMonth, from: typeof filter.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(filter.from) ? filter.from : '', to: typeof filter.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(filter.to) ? filter.to : '' }, rulePresets: Array.isArray(settings.rulePresets) ? settings.rulePresets.slice(0, 100).map((p) => { if (!p || !idSafe(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80) throw new Error('常用规则无效'); return { id: p.id, name: p.name.trim(), rules: validateRules(p.rules) }; }) : [] } };
  }
  function importBackup(text) {
    try { if (text.length > 20 * 1024 * 1024) throw new Error('备份文件过大'); importedData = validateStore(JSON.parse(text)); modal('核对导入备份', '<div class="import-summary">成员：' + importedData.players.length + ' 位<br>记录：' + importedData.sessions.length + ' 场<br>对局：' + importedData.sessions.reduce((n, s) => n + s.games.length, 0) + ' 局</div><p class="confirm-text">导入会替换当前本机全部记录。建议先导出当前数据的备份。</p>', '<button class="secondary-button" data-action="close-modal">取消</button><button class="primary-button" data-action="confirm-import">确认替换并导入</button>'); } catch (e) { toast('无法导入：' + (e.message || '文件格式不正确')); importedData = null; }
  }
  function loadExamples() {
    if (data.sessions.length || data.players.length) { toast('已有记录，请在备份后清空数据再查看示例'); return; }
    const r = defaultRules(4); r.pointRate = 1;
    data.players = ['小林', '小陈', '小王', '小李', '小周'].map((name, i) => ({ id: 'example-p' + i, name, avatar: AVATARS[i], favorite: i === 0 }));
    data.sessions = [{ id: 'example-s1', title: '示例 · 周末麻将', date: today, group: '示例组', playerIds: data.players.map((p) => p.id), rules: r, tableFee: 20, finalChips: { 'example-p0': 1, 'example-p1': 0, 'example-p2': -2, 'example-p3': -1, 'example-p4': 2 }, games: [{ id: 'example-g1', players: [{ playerId: 'example-p0', points: 42000, chips: 0 }, { playerId: 'example-p1', points: 28000, chips: 0 }, { playerId: 'example-p2', points: 18000, chips: 0 }, { playerId: 'example-p3', points: 12000, chips: 0 }] }, { id: 'example-g2', players: [{ playerId: 'example-p0', points: 15000, chips: 0 }, { playerId: 'example-p1', points: 21000, chips: 0 }, { playerId: 'example-p2', points: 29000, chips: 0 }, { playerId: 'example-p4', points: 35000, chips: 0 }] }] }];
    closeModal(); persistAndRender('示例已加载，可在设置中清空');
  }
  function showError(message) { const el = document.getElementById('form-error'); if (el) { el.textContent = message; el.scrollIntoView({ block: 'nearest' }); } else toast(message); }
  function back() { if (stateUI.modal) { closeModal(); return true; } if (stateUI.sessionId || stateUI.memberId) { stateUI.sessionId = null; stateUI.memberId = null; render(); return true; } if (stateUI.tab !== 'home') { stateUI.tab = 'home'; render(); return true; } return false; }
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
    const action = button.dataset.action; const id = button.dataset.id;
    try {
      switch (action) {
        case 'tab': stateUI.tab = button.dataset.tab; stateUI.sessionId = null; stateUI.memberId = null; closeModal(); render(); window.scrollTo(0, 0); break;
        case 'back': back(); break;
        case 'close-modal': closeModal(); break;
        case 'settings': showSettings(); break;
        case 'new-player': showPlayer(); break;
        case 'edit-player': showPlayer(id); break;
        case 'choose-avatar': draft.avatar = button.dataset.avatar; document.querySelectorAll('.avatar-choice').forEach((b) => b.classList.toggle('selected', b === button)); break;
        case 'remove-player': { const p = findPlayer(id); const used = data.sessions.some((s) => s.playerIds.includes(id)); if (used) { p.archived = !p.archived; closeModal(); persistAndRender(p.archived ? '已归档，历史成绩保留' : '成员已恢复'); } else confirmModal('删除成员', '删除“' + p.name + '”？该成员没有历史记录。', () => { data.players = data.players.filter((p) => p.id !== id); stateUI.memberId = null; persistAndRender('成员已删除'); }); break; }
        case 'member': stateUI.memberId = id; stateUI.sessionId = null; closeModal(); render(); window.scrollTo(0, 0); break;
        case 'session': stateUI.sessionId = id; stateUI.memberId = null; closeModal(); render(); window.scrollTo(0, 0); break;
        case 'new-session': showSession(); break;
        case 'edit-session': showSession(id); break;
        case 'clone-session': showSession(null, id); break;
        case 'delete-session': { const s = findSession(id); confirmModal('删除记录', '删除“' + (s.title || s.date) + '”及其中 ' + s.games.length + ' 局成绩？删除后无法撤销。', () => { data.sessions = data.sessions.filter((s) => s.id !== id); if (stateUI.sessionId === id) stateUI.sessionId = null; persistAndRender('记录已删除'); }); break; }
        case 'session-count': collectSessionDraft(); if (draft.id && findSession(draft.id).games.length && Number(button.dataset.n) !== draft.rules.playerCount) { showError('已有成绩的记录不能切换人数，请新建记录。'); break; } draft.rules = defaultRules(Number(button.dataset.n)); showSessionDraft(); break;
        case 'quick-player': { const input = document.getElementById('quick-player-name'); const name = input.value.trim(); if (!name) { toast('请输入成员姓名'); break; } if (data.players.some((p) => p.name === name && !p.archived)) { toast('已有同名成员，请直接选择'); break; } collectSessionDraft(); if (draft.playerIds.length >= 8) { toast('最多选择 8 位成员'); break; } const p = { id: uid('player'), name, avatar: AVATARS[data.players.length % AVATARS.length], favorite: false }; data.players.push(p); draft.playerIds.push(p.id); save(); document.getElementById('session-player-grid').innerHTML = playerSelectGrid(draft.playerIds); input.value = ''; document.getElementById('fee-custom-area').innerHTML = customFeesHtml(draft.playerIds, draft.fees); break; }
        case 'rule-number': document.querySelector('[name="' + button.dataset.field + '"]').value = button.dataset.value; break;
        case 'uma-preset': { const n = draft.rules.playerCount; const v = button.dataset.value; const nums = v === '0' ? Array(n).fill(0) : n === 4 ? [Number(v.split('-')[1]), Number(v.split('-')[0]), -Number(v.split('-')[0]), -Number(v.split('-')[1])] : [Number(v.split('-')[1]), 0, -Number(v.split('-')[1])]; nums.forEach((v, i) => document.querySelector('[name="uma' + i + '"]').value = v); break; }
        case 'new-preset': showPreset(); break;
        case 'default-rule': showPreset(null, Number(button.dataset.n)); break;
        case 'edit-preset': showPreset(id); break;
        case 'preset-count': { const f = document.getElementById('preset-form'); const name = f.elements.presetName.value; draft.rules = defaultRules(Number(button.dataset.n)); showPresetDraft(name); break; }
        case 'delete-preset': confirmModal('删除常用规则', '删除该常用规则？已创建记录里的规则会继续保留。', () => { data.settings.rulePresets = data.settings.rulePresets.filter((p) => p.id !== id); persistAndRender('常用规则已删除'); }); break;
        case 'session-rules': showSessionRules(id); break;
        case 'session-statistics': { const s = findSession(id); const rows = totalsFor([s]); modal('本次成绩统计', '<table class="compact-table"><thead><tr><th>成员</th><th>局数</th><th>平均顺位</th><th>成绩 PT</th></tr></thead><tbody>' + rows.map((r) => '<tr><td>' + esc(playerName(r.playerId)) + '</td><td>' + r.games + '</td><td>' + (r.games ? fmt(r.averageRank, 2) : '—') + '</td><td>' + valueHtml(r.totalPT) + '</td></tr>').join('') + '</tbody></table><p class="inline-note">顺位次数按第 1 位至末位排列，可在成绩表绿色汇总行查看。</p>'); break; }
        case 'new-game': showGame(); break;
        case 'edit-game': showGame(id); break;
        case 'delete-game': { const sid = draft.sessionId; confirmModal('删除本局', '删除这一局成绩？删除后会重新汇总本次记录。', () => { const s = findSession(sid); s.games = s.games.filter((g) => g.id !== id); persistAndRender('本局已删除'); }); break; }
        case 'game-rules': showGameRules(); break;
        case 'final-chips': showFinalChips(id); break;
        case 'return-game': showGameDraft(); break;
        case 'game-inherit': readGameForm(); draft.rules = clone(findSession(draft.sessionId).rules); draft.rulesOverride = false; showGameDraft(); break;
        case 'period': data.settings.filter.period = button.dataset.period; if (!data.settings.filter.value) data.settings.filter.value = currentMonth; save(); render(); break;
        case 'all-period': data.settings.filter.period = 'all'; save(); render(); break;
        case 'this-month': data.settings.filter = { ...data.settings.filter, period: 'month', value: currentMonth }; save(); render(); break;
        case 'period-prev': case 'period-next': { const f = data.settings.filter; const sign = action === 'period-prev' ? -1 : 1; if (f.period === 'month') { const d = new Date(Number(f.value.slice(0, 4)), Number(f.value.slice(5, 7)) - 1 + sign, 1); f.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); } else if (f.period === 'year') f.value = (Number(f.value.slice(0, 4)) + sign) + f.value.slice(4); save(); render(); break; }
        case 'view-mode': data.settings.viewMode = data.settings.viewMode === 'money' ? 'pt' : 'money'; save(); render(); break;
        case 'toggle-group': { const key = button.dataset.key; if (stateUI.collapsedGroups.includes(key)) stateUI.collapsedGroups = stateUI.collapsedGroups.filter((k) => k !== key); else stateUI.collapsedGroups.push(key); render(); break; }
        case 'filter': showFilter(); break;
        case 'export-csv': exportCSV(filterSessions()); break;
        case 'export-group': { const ids = button.dataset.ids.split(','); exportCSV(filterSessions().filter((s) => ids.includes(s.id))); break; }
        case 'export-all-csv': exportCSV(data.sessions); break;
        case 'export-session': exportCSV([findSession(id)]); break;
        case 'export-backup': exportFile('麻将成绩备份-' + today + '.json', JSON.stringify(data, null, 2), 'application/json'); break;
        case 'export-original': if (originalStorageRaw !== null) exportFile('麻将成绩原始存档-' + today + '.txt', originalStorageRaw, 'text/plain;charset=utf-8'); break;
        case 'import-backup': document.getElementById('backup-file').value = ''; document.getElementById('backup-file').click(); break;
        case 'confirm-import': if (importedData) { data = importedData; importedData = null; calculationError = ''; stateUI.sessionId = null; stateUI.memberId = null; stateUI.tab = 'home'; closeModal(); persistAndRender('备份已导入', { allowRecovery: true }); } break;
        case 'examples': if (data.players.length || data.sessions.length) { toast('已有数据，示例不会覆盖你的记录'); } else confirmModal('加载示例', '添加 5 位示例成员与 2 局示例成绩。可以在设置中清空。', loadExamples, '加载示例'); break;
        case 'clear-data': confirmModal('清空本机记录', '删除全部成员、记录和常用规则？删除后无法撤销，请先导出备份。', () => { data = emptyStore(); calculationError = ''; stateUI.tab = 'home'; stateUI.sessionId = null; stateUI.memberId = null; persistAndRender('已清空本机记录', { allowRecovery: true }); }); break;
      }
    } catch (e) { showError(e.message || '操作失败'); console.error(e); }
  });
  document.addEventListener('change', (event) => {
    const el = event.target;
    if (el.name === 'selectedPlayer' && draft?.kind === 'session') { const ids = [...document.querySelectorAll('[name=selectedPlayer]:checked')].map((e) => e.value); if (ids.length > 8) { el.checked = false; toast('最多选择 8 位成员'); return; } el.closest('.player-check').classList.toggle('selected', el.checked); el.closest('.player-check').querySelector('.check-mark').textContent = el.checked ? '✓' : ''; draft.playerIds = ids; document.getElementById('fee-custom-area').innerHTML = customFeesHtml(ids, draft.fees); }
    if (el.name === 'feeMode') document.getElementById('fee-custom-area').hidden = el.value !== 'custom';
    if (el.id === 'rule-preset-select' && el.value) { collectSessionDraft(); const p = data.settings.rulePresets.find((p) => p.id === el.value); if (draft.id && findSession(draft.id).games.length && p.rules.playerCount !== draft.rules.playerCount) { showError('已有成绩的记录不能切换人数'); return; } draft.rules = clone(p.rules); showSessionDraft(); }
    if (el.id === 'currency-select') { data.settings.currency = el.value; save(); render(); }
    if (el.closest('#game-form')) updateGamePreview();
    if (el.closest('#final-chips-form')) updateFinalChipsPreview();
    if (el.id === 'backup-file' && el.files?.[0]) { const file = el.files[0]; if (file.size > 20 * 1024 * 1024) { toast('文件过大'); return; } const reader = new FileReader(); reader.onload = () => importBackup(String(reader.result)); reader.onerror = () => toast('文件读取失败'); reader.readAsText(file, 'UTF-8'); }
  });
  document.addEventListener('input', (event) => { if (event.target.closest('#game-form')) updateGamePreview(); if (event.target.closest('#final-chips-form')) updateFinalChipsPreview(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') back(); if (event.key === 'Enter' && event.target.id === 'quick-player-name') { event.preventDefault(); document.querySelector('[data-action=quick-player]').click(); } if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[role=button][data-action]')) { event.preventDefault(); event.target.click(); } });
  document.addEventListener('submit', (event) => {
    const f = event.target; if (!['player-form', 'session-form', 'preset-form', 'game-form', 'game-rules-form', 'final-chips-form', 'filter-form'].includes(f.id)) return;
    event.preventDefault();
    try {
      if (f.id === 'player-form') {
        const name = f.elements.name.value.trim(); if (!name) throw new Error('请输入成员姓名');
        if (data.players.some((p) => p.id !== draft.id && p.name === name && !p.archived)) throw new Error('已有同名成员');
        if (draft.id) Object.assign(findPlayer(draft.id), { name, avatar: draft.avatar, favorite: f.elements.favorite.checked });
        else data.players.push({ id: uid('player'), name, avatar: draft.avatar, favorite: f.elements.favorite.checked });
      } else if (f.id === 'session-form') {
        const rules = readRules(f, draft.rules);
        const playerIds = [...f.querySelectorAll('[name=selectedPlayer]:checked')].map((e) => e.value);
        if (playerIds.length < rules.playerCount || playerIds.length > 8) throw new Error('请选择 ' + rules.playerCount + ' 至 8 位成员');
        if (draft.id) { const current = findSession(draft.id); const usedIds = new Set([...current.games.flatMap((g) => g.players.map((p) => p.playerId)), ...Object.entries(current.finalChips || {}).filter(([, n]) => n !== 0).map(([id]) => id)]); if ([...usedIds].some((id) => !playerIds.includes(id))) throw new Error('有历史成绩或非零整场祝仪的成员不能从本次记录中移除'); }
        const tableFee = Number(f.elements.tableFee.value); finite(tableFee, '台费', 0, 10000000);
        let fees;
        if (f.elements.feeMode.value === 'custom') { fees = Object.fromEntries(playerIds.map((id) => [id, Number(f.elements['fee-' + id]?.value || 0)])); Object.values(fees).forEach((v) => finite(v, '台费分摊', 0, 10000000)); if (Math.abs(Object.values(fees).reduce((a, b) => a + b, 0) - tableFee) > .005) throw new Error('自定义台费合计必须等于台费总额'); }
        const changed = { title: f.elements.title.value.trim(), date: f.elements.date.value, group: f.elements.group.value.trim(), playerIds, rules, tableFee, ...(fees ? { fees } : {}) };
        if (!changed.date) throw new Error('请选择日期');
        if (draft.id) { const s = findSession(draft.id); if (s.games.length && rules.playerCount !== s.rules.playerCount) throw new Error('已有成绩的记录不能切换人数'); if (s.games.some((g) => !g.rules && g.players.reduce((n, p) => n + p.points, 0) !== rules.startPoints * rules.playerCount)) throw new Error('修改持有点数会令已有对局点数合计不匹配，请为旧局设置独立规则或新建记录'); const games = preserveHistoricalChipRules(s, rules.chipPT || 0); const finalChips = s.finalChips ? Object.fromEntries(playerIds.map((id) => [id, s.finalChips[id] || 0])) : null; engine().aggregateSession({ ...s, ...changed, games, ...(finalChips ? { finalChips } : {}) }); delete s.fees; Object.assign(s, changed, { games }, finalChips ? { finalChips } : {}); }
        else { const s = { id: uid('session'), ...changed, games: [] }; data.sessions.push(s); stateUI.sessionId = s.id; stateUI.memberId = null; }
      } else if (f.id === 'preset-form') {
        const rules = readRules(f, draft.rules); const name = f.elements.presetName.value.trim(); if (!name) throw new Error('请输入规则名称');
        const presets = data.settings.rulePresets || (data.settings.rulePresets = []);
        if (draft.id) Object.assign(presets.find((p) => p.id === draft.id), { name, rules }); else presets.push({ id: uid('rule'), name, rules });
      } else if (f.id === 'game-rules-form') {
        const rules = readRules(f, draft.rules); draft.rules = rules; draft.rulesOverride = true; showGameDraft(); return;
      } else if (f.id === 'game-form') {
        const g = readGameForm(); const r = draft.rules; const s = findSession(draft.sessionId);
        if (new Set(g.players.map((p) => p.playerId)).size !== r.playerCount) throw new Error('本局不能重复选择同一成员');
        if (Object.entries(draft.historicalChipValues).some(([id, n]) => n && !g.players.some((p) => p.playerId === id))) throw new Error('有历史祝仪的成员不能从本局移除，原数量须保留');
        if (g.players.some((p) => !Number.isFinite(p.points) || p.points % 100 !== 0)) throw new Error('点数应为 100 的倍数，可以输入负数');
        if (g.players.reduce((n, p) => n + p.points, 0) !== r.startPoints * r.playerCount) throw new Error('最终点数合计应为 ' + fmt(r.startPoints * r.playerCount, 0));
        if (g.players.some((p) => !Number.isInteger(p.chips))) throw new Error('祝仪请输入整数');
        if ((r.chipPT > 0 || r.chipValue > 0) && g.players.reduce((n, p) => n + p.chips, 0) !== 0) throw new Error('祝仪净增减总和应为 0');
        engine().calculateGame(r, g);
        if (draft.id) s.games[s.games.findIndex((item) => item.id === draft.id)] = g; else s.games.push(g);
      } else if (f.id === 'final-chips-form') {
        const { candidate } = readFinalChipsForm(); Object.assign(findSession(draft.sessionId), { rules: candidate.rules, games: candidate.games, finalChips: candidate.finalChips });
      } else if (f.id === 'filter-form') {
        if (f.elements.from.value && f.elements.to.value && f.elements.from.value > f.elements.to.value) throw new Error('开始日期不能晚于结束日期');
        data.settings.filter = { period: f.elements.period.value, value: f.elements.value.value || currentMonth, from: f.elements.from.value, to: f.elements.to.value }; data.settings.viewMode = f.elements.viewMode.value;
      }
      closeModal(); persistAndRender(f.id === 'final-chips-form' ? '整场祝仪已保存' : f.id === 'game-form' ? '本局成绩已保存' : f.id === 'session-form' ? '记录已保存' : f.id === 'filter-form' ? '筛选已应用' : '已保存');
    } catch (e) { showError(e.message || '保存失败'); }
  });
  window.App = { getState: () => clone(data), getUIState: () => clone(stateUI), getStorageStatus: () => ({ storageReadFailed, storageWriteFailed, calculationError, originalRawAvailable: originalStorageRaw !== null }), loadFixture: (fixture) => { data = validateStore(clone(fixture)); calculationError = ''; stateUI.tab = 'home'; stateUI.sessionId = null; stateUI.memberId = null; closeModal(); const saved = save(); render(); return saved; }, back, importBackup, render, validateStore, exportCSV, version: '1.0.2' };
  load(); render();
})();
