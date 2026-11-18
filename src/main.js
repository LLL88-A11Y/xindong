// 心懂前端：对话 + 多角色发言 + 情绪卡片 + 决策打分表

// 品牌标记：对话气泡 + 心。用内联 SVG，不依赖系统的 emoji 字体（有的环境里 emoji 会直接显示成空白）
const MARK = '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 4C9.4 4 4 8.9 4 15c0 3.1 1.4 5.9 3.7 7.9L6.6 28l5.3-2.7c1.3.5 2.7.7 4.1.7 6.6 0 12-4.9 12-11S22.6 4 16 4z"/><path class="mark-heart" d="M16 21s-6-3.6-6-7.4c0-2 1.5-3.4 3.3-3.4 1.2 0 2.1.7 2.7 1.6.6-.9 1.5-1.6 2.7-1.6 1.8 0 3.3 1.4 3.3 3.4C22 17.4 16 21 16 21z"/></svg>';
const ROLES = {
  host: { name: '心懂', avatar: MARK },
  guide: { name: '心懂', avatar: MARK },
  notice: { name: '心懂', avatar: MARK }, // 出错说明：中性灰，和心懂说话、危机求助都区分开
  rational: { name: '理性派', avatar: '理' },
  emotional: { name: '感性派', avatar: '感' },
  tenth: { name: '第十人', avatar: '十' },
  premortem: { name: '验尸官 · 事前验尸', avatar: '验' },
};
const MEETING_ROLES = new Set(['rational', 'emotional', 'tenth', 'premortem']);
const SEATS = [['rational', '理性派'], ['emotional', '感性派'], ['tenth', '第十人'], ['premortem', '验尸官']];
const MEETING_START = '内心会议室';
const PLACEHOLDER = {
  '': '说说你在纠结的事…',
  decision: '你在哪几个选项之间纠结？你最在乎什么？',
  vent: '想说什么都可以，我在听…',
  relation: '和谁之间发生了什么？可以贴聊天记录或截图',
};

const $ = (id) => document.getElementById(id);
const els = {
  app: document.querySelector('.app'),
  messages: $('messages'), welcome: $('welcome'), form: $('form'), input: $('input'),
  send: $('send'), stop: $('stop'), attach: $('attach'), file: $('file'),
  memBtn: $('memBtn'), memoryCard: $('memoryCard'), memModal: $('memModal'), memList: $('memList'), memClear: $('memClear'),
  ocr: $('ocr'), ocrStatus: $('ocrStatus'), ocrRows: $('ocrRows'), ocrUse: $('ocrUse'), ocrCancel: $('ocrCancel'), newChat: $('newChat'), modes: $('modes'), examples: $('examples'),
  insightBody: $('insightBody'), notmeHint: $('notmeHint'), decisionEmpty: $('decisionEmpty'), decisionCard: $('decisionCard'), decisionBody: $('decisionBody'), tabs: $('tabs'), panelDot: $('panelDot'),
};

// ---------- 本地存储（只为刷新后还能看到，读写失败不影响使用） ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const CONV_KEY = 'eo_conversation_id';
const STATE_KEY = 'xindong_state_v1';

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
function getConversationId() {
  let id = null;
  try { id = localStorage.getItem(CONV_KEY); } catch { /* ignore */ }
  if (!id) { id = uuid(); try { localStorage.setItem(CONV_KEY, id); } catch { /* ignore */ } }
  return id;
}
let conversationId = getConversationId();
// 设备号：只用来做"每台设备每小时最多 N 条"的限流，换对话不变
const DEVICE_KEY = 'xindong_device_v1';
let deviceId = '';
try { deviceId = localStorage.getItem(DEVICE_KEY) || ''; if (!deviceId) { deviceId = uuid(); localStorage.setItem(DEVICE_KEY, deviceId); } } catch { /* ignore */ }

// state.history：发给后端的 {role, content}；state.items：界面上显示的内容（用于刷新恢复）
// state.rejected：这次对话里点过「不准」的解读；state.weightsByUser：权重是用户亲手调的
// state.recentCrisis：这段对话出现过危险信号。服务器的对话记录可能没存上，由这里记住，只记这一件事，不记内容
const emptyState = () => ({ history: [], items: [], decision: null, scores: null, weights: null, weightsByUser: false, rejected: [], memoryOffered: false, recentCrisis: false });
let state = { ...emptyState(), ...store.get(STATE_KEY, {}) };
let mode = '';
let busy = false;
let controller = null;
// 本轮是倾诉 / 情绪低落 / 危机，或者用户选了「只想倾诉」→ 打分表收起（每轮重新判断）；calmOpen：用户自己点开了
let turnCalm = false;
let calmOpen = false;
// 开会期间先不亮出打分结果：等四个人说完再看，免得先入为主
let meetingLive = false;

// ---------- 简易 Markdown（先转义，再处理加粗和列表） ----------
function esc(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function inline(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'); }
const UL_RE = /^[-*•]\s+(.*)/;
const BQ_RE = /^>\s?(.+)/;
const OL_RE = /^(\d+)[.、)](?!\d)\s*(.*)/; // (?!\d)：行首的"1.5万"不是列表
const listType = (line) => (UL_RE.test(line) ? 'ul' : OL_RE.test(line) ? 'ol' : null);
function md(text) {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim());
  let html = ''; let list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  lines.forEach((line, i) => {
    let m;
    if ((m = line.match(UL_RE))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = line.match(OL_RE))) { if (list !== 'ol') { close(); html += `<ol start="${Number(m[1]) || 1}">`; list = 'ol'; } html += `<li>${inline(m[2])}</li>`; }
    else if ((m = line.match(BQ_RE))) {
      close();
      html += `<blockquote class="draft"><span>${inline(m[1])}</span><button type="button" class="copy" data-copy>复制</button></blockquote>`;
    }
    else if (!line) {
      // 模型常在列表项之间空一行：下一条非空行还是同类列表项，就不关列表，编号才能接着数
      const next = lines.slice(i + 1).find(Boolean);
      if (!next || listType(next) !== list) close();
    }
    else { close(); html += `<p>${inline(line.replace(/^#+\s*/, ''))}</p>`; }
  });
  close();
  return html;
}

// 危机回复里的热线号码，手机上点一下就能拨
const TEL = { '12356': '12356', '400-161-9995': '4001619995', '110': '110', '120': '120', '12338': '12338' };
const telify = (html) => html.replace(/<b>(12356|400-161-9995|110|120|12338)<\/b>/g, (_, n) => `<a href="tel:${TEL[n]}"><b>${n}</b></a>`);
const bubbleHTML = (role, text) => (role === 'guide' || role === 'notice' ? telify(md(text)) : md(text));

// ---------- 渲染消息 ----------
// 只有用户本来就在底部附近时才跟着滚；往上翻着看前面的发言时，不把人拉回去
let followBottom = true;
els.messages.addEventListener('scroll', () => {
  const m = els.messages;
  followBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
});
function scrollDown(force = false) {
  if (force) followBottom = true;
  if (followBottom) els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: 'instant' });
}

function addUser(text) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="avatar"></div><div class="body"><div class="bubble"></div></div>`;
  div.querySelector('.bubble').textContent = text;
  els.messages.appendChild(div);
  scrollDown(true); // 用户自己发的消息：一定滚到底
  return div;
}

const stanceBadge = (s) => (s ? `<span class="stance">${esc(s)}</span>` : '');

function addSpeaker(role, text = '', stance = '') {
  const r = ROLES[role] || ROLES.host;
  const div = document.createElement('div');
  div.className = `msg r-${role}`;
  div.innerHTML = `<div class="avatar">${r.avatar}</div><div class="body"><div class="name"><span>${esc(r.name)}</span>${stanceBadge(stance)}</div><div class="bubble"></div></div>`;
  const bubble = div.querySelector('.bubble');
  bubble.innerHTML = text ? bubbleHTML(role, text) : '<span class="typing"><i></i><i></i><i></i></span>';
  els.messages.appendChild(div);
  scrollDown();
  return bubble;
}

function addBanner(text) {
  const div = document.createElement('div');
  div.className = 'meeting-banner';
  div.textContent = text;
  els.messages.appendChild(div);
  return div;
}

// ---------- 内心会议室的席位条：开会时固定在顶部，轮到谁谁亮；开完留在对话里当"会议纪要" ----------
const seatStance = (s) => (s ? s.replace(/^倾向：/, '').replace(/^检查：/, '检查 ') : '');
function addSeats(item, live) {
  const div = document.createElement('div');
  div.className = `seats${live ? ' live' : ''}`;
  div.innerHTML = `<div class="seats-title">${live ? '内心会议室 · 开会中' : '内心会议室'}</div>
    <div class="seats-row">${SEATS.map(([role, name]) => {
      const s = item.stances?.[role] || '';
      return `<button type="button" class="seat s-${role}${live ? '' : ' done'}" data-seat="${role}">
        <i></i><span class="seat-name">${name}</span><span class="seat-stance" title="${esc(s)}">${esc(seatStance(s))}</span></button>`;
    }).join('')}</div>`;
  els.messages.appendChild(div);
  return div;
}
function markSeat(el, role, title = '内心会议室 · 开会中') {
  el.querySelectorAll('.seat.speaking').forEach((s) => s.classList.replace('speaking', 'done'));
  if (role) el.querySelector(`[data-seat="${role}"]`)?.classList.add('speaking');
  el.querySelector('.seats-title').textContent = title;
}
function setSeatStance(el, role, stance) {
  const s = el.querySelector(`[data-seat="${role}"] .seat-stance`);
  if (s) { s.textContent = seatStance(stance); s.title = stance; }
}
function endSeats(el, aborted) {
  el.classList.remove('live');
  el.querySelectorAll('.seat').forEach((s) => { s.classList.remove('speaking'); s.classList.add('done'); });
  el.querySelector('.seats-title').textContent = aborted ? '内心会议室 · 已停止' : '内心会议室';
}
// 点席位：跳到这个角色在这次会议里的发言
els.messages.addEventListener('click', (e) => {
  const seat = e.target.closest('.seat'); if (!seat) return;
  for (let n = seat.closest('.seats').nextElementSibling; n && !n.classList.contains('seats'); n = n.nextElementSibling) {
    if (n.classList.contains(`r-${seat.dataset.seat}`)) { n.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  }
});

let statusEl = null;
function setStatus(text) {
  if (!text) { statusEl?.remove(); statusEl = null; return; }
  if (!statusEl) { statusEl = document.createElement('div'); statusEl.className = 'status'; }
  statusEl.innerHTML = `<span class="typing"><i></i><i></i><i></i></span>${esc(text)}`;
  els.messages.appendChild(statusEl);
  scrollDown();
}

function restore() {
  if (!state.items.length) return;
  els.welcome.classList.add('hidden');
  for (const it of state.items) {
    if (it.kind === 'user') addUser(it.text);
    else if (it.kind === 'seats') addSeats(it, false);
    else if (it.kind === 'banner') addBanner(it.text === '内心会议室 · 开会中' ? MEETING_START : it.text); // 旧版存档
    else addSpeaker(it.role, it.text, it.stance);
  }
  if (state.decision) renderDecision(state.decision, state.scores);
}

// ---------- 情绪卡片（每轮重新生成，不累积） ----------
// 解读背后的知识条目：默认收起，点开看定义和出处。只有核对通过的才叫"出处"
function basisHTML(k) {
  if (!k?.definition) return '';
  const origin = k.status === '通过' ? `出处：${esc(k.source)}`
    : k.status === '部分' ? `参考：${esc(k.source)}。这段说明由心懂整理，不是书中原文。`
    : '这段说明由心懂整理，暂无可核对的出处。';
  return `<details class="basis"><summary>知识依据</summary><p>${esc(k.definition)}</p><p class="quote">${origin}</p><p class="quote">这是对这个词的说明，不是对你的判断。</p></details>`;
}

let turnInsight = null; // 这一轮的模式和风险，决定要不要问"记住这件事吗"
function renderInsight(ev) {
  const { emotions = [], distortions = [], risk } = ev;
  turnInsight = { mode: ev.mode, risk };
  if (risk === 'high' && !state.recentCrisis) { state.recentCrisis = true; save(); }
  turnCalm = (risk && risk !== 'none') || ev.mode === 'vent';
  calmOpen = false;
  syncDecisionCard();
  markPanel();
  els.insightBody.className = '';
  // 危机时这里不做任何分析，只放求助方式（后端也不会发情绪和思维解读）
  if (risk === 'high') {
    const other = ev.at_risk === 'other';
    els.insightBody.innerHTML = `<div class="risk-card">
      <b>${other ? '先帮 TA 确认安全' : '现在最重要的是你的安全'}</b>
      <a href="tel:110"><b>110</b>遇到紧急危险，报警</a>
      <a href="tel:120"><b>120</b>需要急救</a>
      <a href="tel:12356"><b>12356</b>全国心理援助热线（24 小时）</a>
      <a href="tel:4001619995"><b>400-161-9995</b>希望 24 热线</a>
      ${other ? '' : '<a href="tel:12338"><b>12338</b>遭受家庭暴力：全国妇女维权热线</a>'}
      <p>${other ? '你也可以先打 12356，问问该怎么帮 TA。这一次我不做任何分析。' : '这一次我不做任何分析。也可以马上联系一个你信任的人，让 TA 陪着你。'}</p>
    </div>`;
    return;
  }
  if (ev.unavailable) {
    els.insightBody.innerHTML = '<div class="empty">AI 暂时没回应，这次没法分析。</div>';
    return;
  }
  let html = '';
  if (risk === 'concern') {
    html += `<div class="risk-note">如果你现在很难受，可以拨打 <a href="tel:12356"><b>12356</b></a> 全国心理援助热线，或联系你信任的人。</div>`;
  }
  if (!emotions.length && !distortions.length) {
    html += `<div class="empty">这次没听出明显的情绪，就不乱猜了。</div>`;
  }
  insightItems = [];
  const notme = (item) => `<button class="notme" data-reject="${insightItems.push(item) - 1}">不准</button>`;
  for (const e of emotions) {
    html += `<div class="emo" data-item><div class="emo-top"><span>${esc(e.name)}</span><span class="quote">强度 ${e.intensity}/5</span></div>
      <div class="bar"><i style="width:${e.intensity * 20}%"></i></div>
      <div class="item-foot"><span class="quote">依据：“${esc(e.evidence)}”</span>${notme({ kind: 'emotion', label: e.name, quote: e.evidence })}</div>${basisHTML(e.knowledge)}</div>`;
  }
  for (const d of distortions) {
    html += `<div class="distort" data-item><div>“${esc(d.quote)}”</div>
      <div>可能有一点 <b>${esc(d.type)}</b> 的味道：${esc((d.explain || '').replace(/^这句话?可能有一?点[^：:，,。]*[：:，,]?\s*/, ''))}</div>
      ${d.reframe ? `<div class="reframe">换个角度：${esc(d.reframe)}</div>` : ''}
      <div class="item-foot">${notme({ kind: 'distortion', label: d.type, quote: d.quote })}</div>${basisHTML(d.knowledge)}</div>`;
  }
  els.insightBody.innerHTML = html;
  els.notmeHint.classList.toggle('hidden', !insightItems.length);
}

// 「不准」：只收回这一条；下一轮把它告诉后端，这次对话里不再这样说（新对话清零）
let insightItems = [];
els.insightBody.addEventListener('click', (e) => {
  const b = e.target.closest('[data-reject]'); if (!b) return;
  const item = insightItems[Number(b.dataset.reject)]; if (!item) return;
  if (!state.rejected.some((r) => r.kind === item.kind && r.label === item.label && r.quote === item.quote)) state.rejected.push(item);
  save();
  b.closest('[data-item]').innerHTML = `<div class="notme-done">好，这条收回了。这次对话里不会再这样说。你最了解你自己。</div>`;
});

// ---------- 决策打分表 ----------
// 还没有要做的决定 → 整张卡不出现；倾诉、低落、危机时 → 收起来
function syncDecisionCard() {
  const has = !!state.decision?.options?.length;
  els.decisionCard.classList.toggle('hidden', !has);
  els.decisionEmpty.classList.toggle('hidden', has);
  els.decisionCard.classList.toggle('calm', has && (turnCalm || mode === 'vent') && !calmOpen);
}
els.decisionCard.addEventListener('click', (e) => {
  if (!e.target.closest('[data-open-decision]')) return;
  calmOpen = true;
  syncDecisionCard();
});

const dkey = (d) => JSON.stringify([d?.options, d?.criteria?.map((c) => c.name)]);
// 打分表显示的是"上次开会时的选项和方面"：用户补充新情况后不清空，等下次开会再更新
const tableDecision = () => (state.scores?.length && state.scoredDecision) || state.decision;

function renderDecision(current, scores) {
  syncDecisionCard();
  if (!current || !current.options?.length) return;
  const stale = !!(scores?.length && state.scoredDecision && dkey(state.scoredDecision) !== dkey(current));
  const decision = stale ? state.scoredDecision : current;
  const crit = decision.criteria || [];
  if (!state.weights || Object.keys(state.weights).join() !== crit.map((c) => c.name).join()) {
    state.weights = Object.fromEntries(crit.map((c) => [c.name, c.weight]));
  }
  let html = `<div class="dq">${esc(decision.question || '你的选择')}</div>`;
  if (!scores?.length) {
    html += `<div class="empty">选项：${decision.options.map(esc).join(' / ')}<br>在乎的方面：${crit.map((c) => esc(c.name)).join('、') || '还不清楚'}<br>信息够了就会开会打分。</div>`;
    els.decisionBody.className = ''; els.decisionBody.innerHTML = html; return;
  }
  const tied = crit.length >= 2 && !state.weightsByUser && new Set(crit.map((c) => state.weights[c.name])).size === 1;
  html += `<div class="weights">${crit.map((c) => `
    <label class="w-row"><span>${esc(c.name)}</span>
      <input type="range" min="0" max="5" step="1" value="${state.weights[c.name]}" data-w="${esc(c.name)}">
      <span>${state.weights[c.name]}</span></label>`).join('')}</div>
    ${tied ? weightNote(crit) : ''}
    <div class="result" id="result"></div>
    ${stale ? '<div class="opt-note">你补充了新情况，这张表还是上次开会的结果；下次开会会把新情况算进去。</div>' : ''}
    <div class="scorenote">带「估」的分数是按常识估计的（你还没说到这方面的具体情况）；虚线框表示这个选项大部分分数是估计的。</div>`;
  els.decisionBody.className = '';
  els.decisionBody.innerHTML = html;
  renderTotals(decision, scores);
  markPanel();
}

// 权重全一样：不替用户猜轻重，只说明一句；想排的话点开再排
let ranking = null; // 正在排序时：已点的方面名（按重要程度）
function weightNote(crit) {
  if (!ranking) {
    return `<div class="w-note">你说这几项一样重要，所以按同等权重算。如果其实有轻重，拖动滑块，或者直接告诉我"其实××最重要"。
      <button type="button" data-rank-start>按重要程度排一下</button></div>`;
  }
  return `<div class="w-note">从最重要的开始，依次点一下：<div class="rank">${crit.map((c) => {
    const i = ranking.indexOf(c.name);
    return `<button type="button" data-rank="${esc(c.name)}" class="${i >= 0 ? 'on' : ''}">${i >= 0 ? `${i + 1} · ` : ''}${esc(c.name)}</button>`;
  }).join('')}</div></div>`;
}

function renderTotals(decision, scores) {
  if (meetingLive) { $('result').innerHTML = '<div class="opt-note">大家还在讨论，等会议结束再看结果，免得先入为主。</div>'; return; }
  const W = state.weights; const sumW = Object.values(W).reduce((a, b) => a + b, 0) || 1;
  // basis 是 1.3.0 新加的；旧存档按理由判断
  const isGuess = (p) => (p.basis ? p.basis === 'guess' : /信息不足|估计|常识/.test(p.reason || ''));
  const rows = decision.options.map((o) => {
    const parts = decision.criteria.map((c) => scores.find((s) => s.option === o && s.criterion === c.name) || { score: 5, reason: '信息不足', criterion: c.name, basis: 'guess' });
    const total = parts.reduce((a, p) => a + p.score * (W[p.criterion] ?? 0), 0) / sumW;
    return { o, total, parts, guessy: parts.filter(isGuess).length * 2 >= parts.length };
  });
  const cells = rows.flatMap((r) => r.parts);
  const mostlyGuess = cells.filter(isGuess).length * 2 >= cells.length;
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  const gap = sorted.length > 1 ? sorted[0].total - sorted[1].total : 0;
  // 只有分数大多有依据、而且领先得够多，才标「领先」，不让估计出来的数字显得很权威
  const leader = !mostlyGuess && gap >= 0.5 ? sorted[0] : null;
  let note = '';
  if (mostlyGuess) {
    const unknown = decision.criteria.filter((c) => rows.every((r) => isGuess(r.parts.find((p) => p.criterion === c.name))));
    note = `现在大部分分数是估计的，先别太当真。${unknown.length ? `这些方面你还没说到具体情况：${unknown.map((c) => esc(c.name)).join('、')}。` : ''}补充后会更准。`;
  } else if (rows.length > 1 && gap < 0.5) {
    note = '几个选项分数很接近，关键看你更在乎什么。';
  }
  $('result').innerHTML = (note ? `<div class="opt-note">${note}</div>` : '') + rows.map((r) => `
    <div class="opt ${r === leader ? 'best' : ''} ${r.guessy ? 'guessy' : ''}">
      <div class="opt-top"><span class="opt-title"><span class="opt-name">${esc(r.o)}</span>${r === leader ? '<span class="lead">领先</span>' : ''}</span>
        <span class="total ${mostlyGuess ? 'muted' : ''}">${mostlyGuess ? '≈' : ''}${r.total.toFixed(1)}</span></div>
      <div class="bar"><i style="width:${r.total * 10}%"></i></div>
      <details><summary>各项得分</summary><table>${r.parts.map((p) => `<tr><td>${esc(p.criterion)}</td><td>${p.score}${isGuess(p) ? '<span class="g">估</span>' : ''}</td><td>${esc(p.reason || '')}</td></tr>`).join('')}</table></details>
    </div>`).join('');
}

els.decisionBody.addEventListener('input', (e) => {
  const name = e.target.dataset?.w; if (!name) return;
  state.weights[name] = Number(e.target.value);
  state.weightsByUser = true;
  e.target.nextElementSibling.textContent = e.target.value;
  els.decisionBody.querySelector('.w-note')?.remove();
  ranking = null;
  renderTotals(tableDecision(), state.scores);
  save();
});

els.decisionBody.addEventListener('click', (e) => {
  if (e.target.closest('[data-rank-start]')) { ranking = []; renderDecision(state.decision, state.scores); return; }
  const b = e.target.closest('[data-rank]'); if (!b || !ranking) return;
  const name = b.dataset.rank;
  if (!ranking.includes(name)) ranking.push(name);
  const crit = state.decision.criteria;
  if (ranking.length === crit.length) {
    // 最重要的 5 分，往下依次减 1，最低 1 分
    ranking.forEach((n, i) => { state.weights[n] = Math.max(1, 5 - i); });
    state.weightsByUser = true;
    ranking = null;
    save();
  }
  renderDecision(state.decision, state.scores);
});

function markPanel() { if (!els.app.classList.contains('show-panel')) els.panelDot.classList.add('on'); }

// ---------- 发送与流式读取 ----------
function save() { store.set(STATE_KEY, state); }

function setBusy(v) {
  busy = v;
  els.send.disabled = v;
  els.stop.classList.toggle('hidden', !v);
  els.send.classList.toggle('hidden', v);
}

async function send(text) {
  if (busy || !text.trim()) return;
  turnInsight = null;
  els.welcome.classList.add('hidden');
  const userDiv = addUser(text);
  const outgoing = [...state.history, { role: 'user', content: text }];
  const historyBefore = state.history; const itemsBefore = state.items.length;
  // 发了新消息，之前那些报错的「再试一次」就收掉：只能重试最新的一轮，旧的重试会把后面的对话也撤掉
  els.messages.querySelectorAll('.retry-btn, .retry button').forEach((x) => x.remove());
  // 旧的报错折成一行：同一段说明（热线、恢复时间）只在最新那条完整显示，点开还能看原文
  els.messages.querySelectorAll('.r-notice .bubble:not(.folded)').forEach((bb) => {
    bb.classList.add('folded');
    bb.innerHTML = `<details><summary>这一轮没能回答</summary>${bb.innerHTML}</details>`;
  });
  setBusy(true);
  setStatus('心懂在听…');
  controller = new AbortController();

  const newItems = [{ kind: 'user', text }];
  let current = null; // { role, text, stance, bubble }
  let replyText = '';
  let sawDone = false;
  let errorText = '';
  let seats = null; // 这一轮开了会：{ el, item, spoke }
  let offerMeeting = false;

  const finishSpeaker = () => {
    if (!current) return;
    if (current.text) {
      newItems.push({ kind: 'speaker', role: current.role, text: current.text, stance: current.stance || '' });
      if (seats && MEETING_ROLES.has(current.role)) seats.spoke = true;
    } else {
      current.bubble.closest('.msg').remove(); // 只删没出字的空气泡
    }
    current = null;
  };

  const handle = (ev) => {
    switch (ev.type) {
      case 'status': setStatus(ev.content); break;
      case 'insight': renderInsight(ev); break;
      case 'decision': {
        // 选项和方面没变 → 保留已有打分；变了 → 旧分数作废，等下次开会
        // 选项或方面变了：上次的打分先留着（标成"上次开会的结果"），下次开会再更新
        state.decision = ev.decision;
        renderDecision(ev.decision, state.scores);
        break;
      }
      case 'scores': {
        // 重新开会：用户亲手调过的权重保留（方面没变的话），否则按分析员给的重来
        const same = state.weights && Object.keys(state.weights).join() === ev.decision.criteria.map((c) => c.name).join();
        if (!(state.weightsByUser && same)) { state.weights = null; state.weightsByUser = false; }
        state.decision = ev.decision; state.scores = ev.scores; state.scoredDecision = ev.decision;
        meetingLive = true; // 打分只在开会时出现
        renderDecision(ev.decision, ev.scores);
        break;
      }
      case 'speaker':
        finishSpeaker();
        setStatus('');
        if (MEETING_ROLES.has(ev.role)) {
          if (!seats) {
            const item = { kind: 'seats', stances: {} };
            seats = { el: addSeats(item, true), item };
            newItems.push(item);
          }
          markSeat(seats.el, ev.role);
        } else if (seats) markSeat(seats.el, null, '内心会议室 · 主持人总结');
        current = { role: ev.role, text: '', stance: '', bubble: addSpeaker(ev.role) };
        break;
      case 'stance':
        if (current?.role === ev.role) {
          current.stance = ev.stance;
          current.bubble.closest('.msg').querySelector('.name').insertAdjacentHTML('beforeend', stanceBadge(ev.stance));
        }
        if (seats) { seats.item.stances[ev.role] = ev.stance; setSeatStance(seats.el, ev.role, ev.stance); }
        break;
      case 'ai_response':
        if (!current) current = { role: ev.role || 'host', text: '', bubble: addSpeaker(ev.role || 'host') };
        current.text += ev.content || '';
        current.bubble.innerHTML = bubbleHTML(current.role, current.text);
        scrollDown();
        break;
      case 'speaker_end':
        if (current) replyText += `【${(ROLES[current.role] || ROLES.host).name}】${current.text}\n\n`;
        finishSpeaker();
        break;
      case 'error_message': errorText = ev.content || '出错了'; break;
      case 'offer_meeting': offerMeeting = true; break;
      default: break;
    }
  };

  try {
    const resp = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'makers-conversation-id': conversationId },
      body: JSON.stringify({
        messages: outgoing, mode, device: deviceId || undefined,
        rejected: state.rejected,
        recent_crisis: state.recentCrisis || undefined,
        weights: state.weightsByUser ? state.weights : undefined,
      }),
      signal: controller.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`服务器返回 ${resp.status}`);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!sawDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { sawDone = true; break; }
        if (payload) { try { handle(JSON.parse(payload)); } catch { /* skip bad chunk */ } }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') errorText = errorText || e.message;
  }

  if (current) { if (current.text) replyText += current.text; finishSpeaker(); }
  setStatus('');
  if (meetingLive) { meetingLive = false; if (state.decision && state.scores) renderDecision(state.decision, state.scores); }
  const aborted = controller.signal.aborted;
  controller = null;
  setBusy(false);

  if (replyText.trim()) {
    // 成功（或停止前已有回复）：写入历史
    if (seats && !seats.spoke) {
      // 一个人都没说上话（AI 没回应）：不留四个空席位和"会议结束"
      seats.el.remove();
      newItems.splice(newItems.indexOf(seats.item), 1);
    } else if (seats) {
      endSeats(seats.el, aborted);
      const t = aborted ? '会议已停止' : '会议结束';
      addBanner(t); newItems.push({ kind: 'banner', text: t });
      scrollDown();
    }
    state.history = [...outgoing, { role: 'assistant', content: replyText.trim() }].slice(-30);
    state.items.push(...newItems);
    save();
    if (errorText) {
      addErrorBubble(errorText, () => {
        for (let n = userDiv; n; ) { const next = n.nextElementSibling; n.remove(); n = next; }
        state.history = historyBefore; state.items.length = itemsBefore; save();
        send(text);
      });
    }
    else if (offerMeeting) addMeetingOffer();
    // 开完会、或者聊完一段关系：问一句要不要记住这件事。倾诉和危机从不问
    else if (!aborted && turnInsight?.risk === 'none') {
      if (seats && state.decision?.question) offerRemember('decision', state.decision.question);
      else if (turnInsight.mode === 'relation') offerRemember('relation', relationTitle(text));
    }
  } else {
    // 失败：这条用户消息不进入历史，标记为失败并允许重试
    seats?.el.remove();
    userDiv.classList.add('failed');
    const tip = document.createElement('div');
    tip.className = 'retry';
    tip.innerHTML = aborted ? '已停止' : `${telify(inline(!sawDone ? '连接中断' : errorText || '没有收到回复'))} <button>再试一次</button>`;
    tip.querySelector('button')?.addEventListener('click', () => { userDiv.remove(); send(text); });
    userDiv.querySelector('.body').appendChild(tip);
  }
}

// 出错说明：一句话说清楚，热线能直接拨，下面有「再试一次」
// 「再试一次」：先撤掉这一轮（用户那句 + 回复 + 报错），再重发，对话里不会出现两遍同样的话
function addErrorBubble(msg, retry) {
  const bubble = addSpeaker('notice', msg);
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'retry-btn'; b.textContent = '再试一次';
  b.addEventListener('click', () => { if (!busy) retry(); });
  bubble.appendChild(b);
}

// ---------- 交互 ----------
els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || busy) return;
  els.input.value = ''; autosize();
  send(text);
});
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.form.requestSubmit(); }
});
// 高度跟着内容走；没超过最大高度时不显示滚动条（不同系统的字体行高不一样，差一两个像素就会冒出滚动条）
function autosize() {
  const t = els.input;
  t.style.height = 'auto';
  const border = t.offsetHeight - t.clientHeight;
  const full = t.scrollHeight + border;
  t.style.height = Math.min(160, full) + 'px';
  t.style.overflowY = full > 160 ? 'auto' : 'hidden';
}
els.input.addEventListener('input', autosize);

els.examples.addEventListener('click', (e) => {
  // 示例只是帮用户起个头：填进输入框，改完再自己发，不替用户发出去
  const b = e.target.closest('button'); if (!b) return;
  els.input.value = b.textContent.trim();
  autosize(); els.input.focus();
  els.input.setSelectionRange(els.input.value.length, els.input.value.length);
});

function setMode(m) {
  mode = m;
  els.modes.querySelectorAll('.mode').forEach((x) => x.classList.toggle('active', x.dataset.mode === m));
  els.input.placeholder = PLACEHOLDER[m] ?? PLACEHOLDER[''];
  calmOpen = false;
  syncDecisionCard();
}
els.modes.addEventListener('click', (e) => {
  const b = e.target.closest('.mode'); if (b) setMode(b.dataset.mode);
});

els.stop.addEventListener('click', () => {
  controller?.abort();
  // /stop 不带 makers-conversation-id 头，只在 body 里传
  fetch('/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_id: conversationId }) }).catch(() => {});
});

els.newChat.addEventListener('click', () => {
  if (busy) return;
  conversationId = uuid();
  try { localStorage.setItem(CONV_KEY, conversationId); } catch { /* ignore */ }
  state = emptyState();
  ranking = null;
  store.del(STATE_KEY);
  els.messages.querySelectorAll('.msg, .meeting-banner, .status, .seats, .remember, .meet-offer').forEach((n) => n.remove());
  hideOcr();
  statusEl = null;
  els.welcome.classList.remove('hidden');
  els.insightBody.className = 'empty'; els.insightBody.textContent = '还没有内容，先聊几句吧。';
  els.decisionBody.className = 'empty'; els.decisionBody.textContent = '';
  turnCalm = false; calmOpen = false; meetingLive = false; syncDecisionCard();
  setMode('');
  showView('chat');
  renderMemoryCard();
  els.panelDot.classList.remove('on');
  els.input.value = ''; autosize();
});

function showView(view) {
  els.tabs.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.view === view));
  els.app.classList.toggle('show-panel', view === 'panel');
  if (view === 'panel') els.panelDot.classList.remove('on');
}
els.tabs.addEventListener('click', (e) => {
  const b = e.target.closest('.tab'); if (b) showView(b.dataset.view);
});

// ---------- 记住的事：只存在这台设备的浏览器里，用户点了「记住」才记，只记标题 ----------
// 底层原则：心懂不会悄悄拿过去的事推测现在。过去的事只由页面列出来，用户点「接着聊」才放进输入框；
// 点「我已经解决了这个问题了」之后，这件事不会再出现在"上次聊到的事"里。
const MEM_KEY = 'xindong_memory_v1';
const memory = { items: store.get(MEM_KEY, { items: [] }).items || [] };
const saveMemory = () => store.set(MEM_KEY, { items: memory.items });
const fmtDate = (d) => { const [, m, day] = (d || '').split('-'); return m ? `${Number(m)}月${Number(day)}日` : ''; };

// 标题太长时在句号、问号处截断，其次在逗号处，不截在半句话中间
function cutTitle(s, max = 30) {
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const stop = Math.max(...['。', '！', '？', '!', '?'].map((p) => head.lastIndexOf(p)));
  if (stop >= 8) return head.slice(0, stop + 1);
  const comma = Math.max(...['，', ',', '；'].map((p) => head.lastIndexOf(p)));
  return `${comma >= 8 ? head.slice(0, comma) : head}…`;
}

// 关系类的标题：用户自己写的那句话（去掉贴进来的聊天记录）；只有聊天记录时，带上对方的第一句
function relationTitle(text) {
  const own = text.replace(/【聊天记录】[\s\S]*?(\n\s*\n|$)/, '').trim();
  if (own) return cutTitle(own);
  const first = text.match(/^对方：(.+)$/m)?.[1];
  return first ? `和对方的沟通：「${cutTitle(first, 14)}」` : '和对方的沟通';
}

function offerRemember(kind, title) {
  if (state.memoryOffered || !title) return;
  if (memory.items.some((m) => m.title === title && m.status === 'open')) return;
  state.memoryOffered = true; save();
  const div = document.createElement('div');
  div.className = 'remember';
  div.innerHTML = `<div>要我记住这件事吗？下次打开心懂时，可以接着聊。</div>
    <input type="text" maxlength="40" aria-label="要记住的事">
    <div class="remember-actions"><button type="button" class="ghost" data-skip>不用了</button><button type="button" class="send" data-keep>记住</button></div>
    <p class="hint">只存在这台设备的浏览器里；只记这件事，不记你的情绪和心理状态。标题可以改。</p>`;
  div.querySelector('input').value = title;
  div.addEventListener('click', (e) => {
    if (e.target.closest('[data-keep]')) {
      const t = div.querySelector('input').value.trim() || title;
      memory.items.unshift({ id: uuid(), kind, title: t, date: new Date().toISOString().slice(0, 10), status: 'open' });
      // 最多留 100 件：先删最早的"已经解决了"，再删最早的
      while (memory.items.length > 100) {
        const i = memory.items.map((m) => m.status).lastIndexOf('resolved');
        memory.items.splice(i >= 0 ? i : memory.items.length - 1, 1);
      }
      saveMemory();
      div.innerHTML = '<div class="notme-done">记住了。可以在右上角「记得的事」里查看或删除。</div>';
    } else if (e.target.closest('[data-skip]')) div.remove();
  });
  els.messages.appendChild(div);
  scrollDown();
}

function memoryItemHTML(m, inCard) {
  const tag = m.status === 'resolved' ? '已经解决了' : m.kind === 'relation' ? '关系' : '决定';
  return `<div class="memory-item" data-id="${m.id}">
    <div class="memory-title"><b>${esc(m.title)}</b><span>${esc(fmtDate(m.date))} · ${tag}</span></div>
    <div class="memory-actions">
      ${inCard ? '<button type="button" data-mem="continue">接着聊</button>' : ''}
      ${m.status === 'open' ? '<button type="button" data-mem="resolve">我已经解决了这个问题了</button>' : ''}
      <button type="button" data-mem="delete">删掉</button>
    </div></div>`;
}
function renderMemoryCard() {
  const all = memory.items.filter((m) => m.status === 'open');
  const open = all.slice(0, 3); // 欢迎页只放最近 3 件，其余在「记得的事」里
  els.memoryCard.classList.toggle('hidden', !open.length);
  els.memoryCard.innerHTML = open.length
    ? '<div class="memory-head">上次聊到的事</div>' + open.map((m) => memoryItemHTML(m, true)).join('')
      + (all.length > 3 ? `<div class="memory-more">还有 ${all.length - 3} 件，在右上角「记得的事」里。</div>` : '')
    : '';
}
function renderMemoryList() {
  els.memClear.classList.toggle('hidden', !memory.items.length);
  els.memList.innerHTML = memory.items.length ? memory.items.map((m) => memoryItemHTML(m, false)).join('') : '<div class="empty">还没有记住任何事。</div>';
}
function onMemoryClick(e) {
  const b = e.target.closest('[data-mem]'); if (!b) return;
  const row = b.closest('.memory-item');
  const m = memory.items.find((x) => x.id === row.dataset.id); if (!m) return;
  const act = b.dataset.mem;
  if (act === 'continue') {
    setMode(m.kind === 'relation' ? 'relation' : 'decision');
    els.input.value = `上次聊到「${m.title}」，现在`;
    autosize(); els.input.focus(); els.input.setSelectionRange(els.input.value.length, els.input.value.length);
    return;
  }
  if (act === 'resolve') m.status = 'resolved';
  if (act === 'delete') memory.items = memory.items.filter((x) => x !== m);
  saveMemory();
  row.innerHTML = `<div class="notme-done">${act === 'resolve' ? '好，以后不会再提这件事。' : '删掉了。'}</div>`;
  setTimeout(() => { renderMemoryCard(); if (!els.memModal.classList.contains('hidden')) renderMemoryList(); }, 1200);
}
els.memoryCard.addEventListener('click', onMemoryClick);
els.memList.addEventListener('click', onMemoryClick);
els.memBtn.addEventListener('click', () => { renderMemoryList(); els.memModal.classList.remove('hidden'); });
els.memModal.addEventListener('click', (e) => { if (e.target === els.memModal || e.target.closest('[data-close]')) els.memModal.classList.add('hidden'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') els.memModal.classList.add('hidden'); });
els.memClear.addEventListener('click', () => {
  if (!memory.items.length || !confirm('删掉心懂记得的所有事？删掉后不能恢复。')) return;
  memory.items = []; saveMemory(); renderMemoryList(); renderMemoryCard();
});

// "要现在开会吗"下面的按钮：点了就开会；用户也可以继续补充
function addMeetingOffer() {
  els.messages.querySelectorAll('.meet-offer').forEach((n) => n.remove()); // 只留最新的一个
  const div = document.createElement('div');
  div.className = 'meet-offer';
  div.innerHTML = '<button type="button" class="send">现在开会</button><span>或者继续补充</span>';
  div.querySelector('button').addEventListener('click', () => { if (busy) return; div.remove(); send('开会吧'); });
  els.messages.appendChild(div);
  scrollDown();
}

// ---------- 回复草稿：一键复制 ----------
els.messages.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]'); if (!b) return;
  const span = b.parentElement.querySelector('span');
  try {
    await navigator.clipboard.writeText(span.textContent);
    b.textContent = '已复制';
  } catch {
    // 不支持剪贴板（比如非 https 或旧浏览器）：选中文字，让用户自己复制
    const r = document.createRange(); r.selectNodeContents(span);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    b.textContent = matchMedia('(pointer: coarse)').matches ? '已选中，长按复制' : `已选中，按 ${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'}C 复制`;
  }
  setTimeout(() => { b.textContent = '复制'; }, 1800);
});

// ---------- 聊天截图：在本机识别成文字，用户确认后才放进输入框 ----------
// 识别结果每条一行：点「对方 / 我」换边（最常见的识别错误），文字可以改，× 删掉，也可以补一条
const ocrRowHTML = (r) => `<div class="ocr-row${r.unsure ? ' unsure' : ''}"${r.conf != null ? ` data-conf="${r.conf}"` : ''}>
  <button type="button" class="who${r.who === '我' ? ' me' : ''}" data-who title="点一下换边">${r.who}</button>
  <textarea rows="1" maxlength="600" aria-label="这一条的内容${r.unsure ? '（可能认错了）' : ''}"${r.text ? '' : ' placeholder="没认出字，可以手动补上；空着就不用"'}>${esc(r.text)}</textarea>
  <button type="button" class="del" data-del aria-label="删掉这一条">×</button></div>`;
const fitRow = (t) => { t.style.height = 'auto'; t.style.height = `${t.scrollHeight + 2}px`; };

function showOcr(status, rows) {
  els.ocr.classList.remove('hidden');
  els.ocrStatus.textContent = status;
  if (rows) {
    els.ocrRows.innerHTML = rows.map(ocrRowHTML).join('') + '<button type="button" class="add" data-add>＋ 加一条</button>';
    els.ocrRows.querySelectorAll('textarea').forEach(fitRow);
    els.ocrRows.scrollTop = 0;
    markMoreRows();
  }
  els.ocrUse.disabled = !rows; // 识别中不能点
}
function hideOcr() { els.ocr.classList.add('hidden'); els.ocrRows.innerHTML = ''; }

els.ocrRows.addEventListener('click', (e) => {
  const who = e.target.closest('[data-who]');
  if (who) { const toMe = who.textContent === '对方'; who.textContent = toMe ? '我' : '对方'; who.classList.toggle('me', toMe); return; }
  const del = e.target.closest('[data-del]');
  if (del) { del.closest('.ocr-row').remove(); return; }
  const add = e.target.closest('[data-add]');
  if (add) { add.insertAdjacentHTML('beforebegin', ocrRowHTML({ who: '对方', text: '' })); add.previousElementSibling.querySelector('textarea').focus(); }
});
els.ocrRows.addEventListener('input', (e) => { if (e.target.matches('textarea')) fitRow(e.target); });
// 下面还有没看到的条目时，底部渐隐，提示可以往下滑
function markMoreRows() { const r = els.ocrRows; r.classList.toggle('more', r.scrollHeight - r.scrollTop - r.clientHeight > 4); }
els.ocrRows.addEventListener('scroll', markMoreRows);

els.attach.addEventListener('click', () => { if (!busy) els.file.click(); });
els.file.addEventListener('change', async () => {
  const files = [...els.file.files].slice(0, 3);
  els.file.value = '';
  if (!files.length) return;
  els.ocrRows.innerHTML = '';
  showOcr('正在准备识别…第一次要下载约 6MB 的识别组件，之后就快了。');
  try {
    const { readChat } = await import('./ocr.js');
    const rows = [];
    for (const [i, f] of files.entries()) {
      const prefix = files.length > 1 ? `第 ${i + 1}/${files.length} 张：` : '';
      rows.push(...await readChat(f, (s) => showOcr(prefix + s)));
    }
    const unsure = rows.filter((r) => r.unsure).length;
    showOcr(rows.length ? (unsure ? `识别好了，共 ${rows.length} 条，其中 ${unsure} 条标黄的可能认错了，重点看看：` : `识别好了，共 ${rows.length} 条。可能有错字，扫一眼再确认：`) : '没认出文字。可以换一张清楚点的截图，或者直接把聊天内容粘贴进来。', rows);
  } catch (e) {
    showOcr(`识别失败（${e.message}）。也可以直接把聊天内容粘贴进来。`, []);
  }
});
els.ocrCancel.addEventListener('click', hideOcr);
els.ocrUse.addEventListener('click', () => {
  const lines = [...els.ocrRows.querySelectorAll('.ocr-row')]
    .map((r) => [r.querySelector('[data-who]').textContent, r.querySelector('textarea').value.replace(/\s*\n\s*/g, ' ').trim()])
    .filter(([, t]) => t)
    .map(([who, t]) => `${who}：${t}`);
  if (lines.length) {
    els.input.value = `【聊天记录】\n${lines.join('\n')}\n\n${els.input.value.trim()}`.trimEnd() + '\n';
    setMode('relation');
    autosize();
    els.input.focus();
    els.input.setSelectionRange(els.input.value.length, els.input.value.length);
    els.input.scrollTop = 0; // 先让用户看到聊天记录的开头；一打字会自动滚到光标处
  }
  hideOcr();
});

restore();
syncDecisionCard();
renderMemoryCard();
autosize();
