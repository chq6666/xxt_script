// ==UserScript==
// @name         学习通课程助手（自动任务点 + DeepSeek 答题）
// @namespace    https://local.cxh.helper
// @version      1.3.10
// @description  自动进入未完成任务点：先识别本页结构（课程要求/视频/文档/测验混排）再逐个完成；小节内自动翻页（概览/视频/测验逐页完成）、视频原速观看、PPT/文档自动翻阅、章节测验/作业可选 DeepSeek 自动作答（支持思考模型 deepseek-reasoner：自动适配参数/超时、流式显示思考进度、思考过程可在日志折叠查看）；右下角可视化控制台；未配置 API 时自动跳过答题。
// @author       local
// @license      MIT
// @match        *://*.chaoxing.com/*
// @match        *://chaoxing.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // 防止同一 frame 被重复注入
  if (window.__CXH_BOOTED__) return;
  window.__CXH_BOOTED__ = true;

  const VERSION = '1.3.10';
  const MSG = '__CXH_BRIDGE_V1__';
  const IS_TOP = (() => { try { return window.top === window.self; } catch (e) { return false; } })();
  const FRAME_ID = 'f_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const PAGE = (() => { try { return window; } catch (e) { return window; } })();
  const PAGE_WIN = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  const CFG_KEY = 'cxh.config.v2';
  const PROGRESS_KEY = 'cxh.progress.v3';
  const LOCK_KEY = 'cxh.lock.v2';

  // ---------------------------------------------------------------- 基础工具
  const $ = (sel, root) => {
    try { return (root || document).querySelector(sel); } catch (e) { return null; }
  };
  const $$ = (sel, root) => {
    try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; }
  };
  const text = (el) => {
    if (!el) return '';
    const raw = (el.innerText !== undefined && el.innerText !== null && el.innerText !== '')
      ? el.innerText
      : (el.textContent || '');
    return String(raw).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  };
  const attr = (el, name) => (el && el.getAttribute) ? (el.getAttribute(name) || '') : '';
  const visible = (el) => {
    try {
      if (!el || !el.isConnected) return false;
      if (el.getClientRects().length === 0) return false;
      const win = el.ownerDocument && el.ownerDocument.defaultView;
      if (!win) return false;
      const st = win.getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity || 1) > 0.02;
    } catch (e) { return false; }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (min, max) => min + Math.random() * Math.max(0, max - min);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const now = () => Date.now();
  const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
  const clock = (ts) => {
    const d = new Date(ts || Date.now());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  };
  const duration = (sec) => {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + pad2(m) : m + '') + ':' + pad2(s);
  };
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const truncate = (s, n) => {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  };
  const uuid = () => {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'id_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  };
  const norm = (s) => String(s == null ? '' : s)
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。；：、？！“”‘’（）【】《》〈〉·—…,.;:!?"'`~()\[\]{}<>\/\\|_\-+=*&^%$#@]/g, '')
    .toLowerCase();
  const num = (v, d) => {
    const n = parseFloat(v);
    return isFinite(n) ? n : d;
  };
  const jsonClone = (v) => {
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
  };
  const deepMerge = (base, extra) => {
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra === undefined ? base : extra;
    const out = (base && typeof base === 'object' && !Array.isArray(base)) ? base : {};
    Object.keys(extra).forEach((k) => {
      const v = extra[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(out[k], v);
      else out[k] = v;
    });
    return out;
  };

  // ---------------------------------------------------------------- 存储
  const hasGM = (typeof GM_getValue === 'function' && typeof GM_setValue === 'function');
  const store = {
    get(key, def) {
      try {
        if (hasGM) {
          const v = GM_getValue(key, undefined);
          return (v === undefined || v === null) ? def : v;
        }
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : def;
      } catch (e) { return def; }
    },
    set(key, val) {
      try {
        if (hasGM) GM_setValue(key, val);
        else localStorage.setItem(key, JSON.stringify(val));
      } catch (e) {}
    },
    del(key) {
      try {
        if (hasGM && typeof GM_deleteValue === 'function') GM_deleteValue(key);
        else localStorage.removeItem(key);
      } catch (e) {}
    }
  };

  // ---------------------------------------------------------------- 默认配置
  const DEFAULTS = {
    autoStart: true,          // 打开课程页自动开始
    autoOpenCourse: true,     // 课程列表页自动打开指定课程
    courseName: '大学生职业规划',
    forceNormalSpeed: true,   // 强制 1 倍速（只降不升）
    muted: true,              // 自动静音播放
    keepAlive: true,          // 后台保持播放（阻止页面因切后台暂停）
    autoSubmit: true,         // 答完后自动提交
    answerHomework: true,     // 自动答章节测验/作业
    answerExam: false,        // 自动答考试（默认关闭）
    answerVideoQuiz: true,    // 自动答视频弹窗题
    skipAnswer: false,        // 不作答：遇到题目直接跳过（不调用 API、不填、不提交）
    skipWhenNoApi: true,      // 未配置 API 时跳过答题任务
    taskDelayMin: 2.5,        // 任务间最小延迟（秒）
    taskDelayMax: 6,          // 任务间最大延迟（秒）
    answerGapMin: 2,          // 每题填写间隔（秒），避免过快触发风控
    answerGapMax: 5,
    actionDelayMin: 0.6,      // 页面内操作延迟
    actionDelayMax: 1.8,
    reloadOnStuck: true,      // 卡住时刷新
    protectMode: true,        // 检测到验证码/风控提示立即暂停
    soundOnFinish: true,      // 完成时提示音
    maxTaskMinutes: 240,      // 单个任务点最长处理时间
    api: {
      baseUrl: 'https://api.deepseek.com',
      path: '/chat/completions',
      model: 'deepseek-chat',
      key: '',
      thinking: false,       // 思考模式：使用 deepseek-reasoner（思维链较长，更慢但更准）
      stream: true,          // 思考时流式接收，实时显示思考进度；流式失败自动回退普通请求
      showReasoning: true,   // 在日志里折叠保留模型的思考过程
      temperature: 0.2,
      maxTokens: 4096,
      timeoutSec: 120,
      extraPrompt: ''
    },
    ui: {
      x: null,
      y: null,
      collapsed: false,
      tab: 'overview'
    }
  };

  let CFG = deepMerge(jsonClone(DEFAULTS), store.get(CFG_KEY, {}));
  function saveConfig() {
    store.set(CFG_KEY, CFG);
  }
  function loadProgress() {
    const p = store.get(PROGRESS_KEY, null);
    return Object.assign({ courses: {} }, p && typeof p === 'object' ? p : {});
  }
  let PROGRESS = loadProgress();
  function saveProgress() {
    try {
      const keys = Object.keys(PROGRESS.courses || {});
      if (keys.length > 30) {
        keys.slice(0, keys.length - 30).forEach((k) => { delete PROGRESS.courses[k]; });
      }
      store.set(PROGRESS_KEY, PROGRESS);
    } catch (e) {}
  }
  function courseProgress(courseId) {
    if (!courseId) return { doneChapters: [], doneCards: [], skippedCards: [] };
    PROGRESS.courses = PROGRESS.courses || {};
    const p = PROGRESS.courses[courseId] || {};
    p.doneChapters = Array.isArray(p.doneChapters) ? p.doneChapters : [];
    p.doneCards = Array.isArray(p.doneCards) ? p.doneCards : [];
    p.skippedCards = Array.isArray(p.skippedCards) ? p.skippedCards : [];
    PROGRESS.courses[courseId] = p;
    return p;
  }

  // ---------------------------------------------------------------- 运行状态
  const S = {
    running: false,
    busy: false,
    phase: 'idle',
    message: '待机',
    pageKind: 'unknown',
    course: { id: '', clazzId: '', enc: '', name: '' },
    chapter: null,
    chapters: [],
    cards: [],
    cardsReady: false,
    activeCard: null,
    taskStartedAt: 0,
    taskKey: '',
    taskProgress: '',
    doneTasks: 0,
    totalTasks: 0,
    apiState: 'untested',
    apiInfo: '',
    blocked: false,
    blockReason: '',
    lastTick: 0,
    startedAt: 0,
    sessionTasks: 0,
    errorCount: 0,
    retryCount: 0,
    skipping: false,
    currentUrl: location.href
  };

  // ---------------------------------------------------------------- 日志
  const LOG_MAX = 500;
  const LOGS = [];
  let onLogHook = null;
  function pushLog(level, msg, data) {
    const item = {
      id: uuid(),
      t: now(),
      level: level || 'info',
      msg: String(msg == null ? '' : msg),
      data: data || null
    };
    LOGS.push(item);
    if (LOGS.length > LOG_MAX) LOGS.shift();
    if (IS_TOP) {
      try { if (onLogHook) onLogHook(item); } catch (e) {}
    } else {
      sendUp('log', {
        level: item.level, msg: item.msg, at: item.t,
        reasoning: (item.data && item.data.reasoning) ? String(item.data.reasoning).slice(0, 20000) : null
      });
    }
    try {
      if (level === 'error') console.error('[学习通助手]', msg);
      else if (level === 'warn') console.warn('[学习通助手]', msg);
      else console.log('[学习通助手]', msg);
    } catch (e) {}
    return item;
  }
  const log = (msg, data) => pushLog('info', msg, data);
  const warn = (msg, data) => pushLog('warn', msg, data);
  const error = (msg, data) => pushLog('error', msg, data);
  const success = (msg, data) => pushLog('success', msg, data);

  function setPhase(phase, message) {
    S.phase = phase || S.phase;
    if (message !== undefined) S.message = String(message);
    if (IS_TOP) emit('state');
  }
  function setMessage(message) {
    S.message = String(message == null ? '' : message);
    if (IS_TOP) emit('state');
  }

  // ---------------------------------------------------------------- 事件总线
  const listeners = {};
  function on(evt, fn) {
    (listeners[evt] = listeners[evt] || []).push(fn);
    return () => {
      listeners[evt] = (listeners[evt] || []).filter((f) => f !== fn);
    };
  }
  function emit(evt, payload) {
    (listeners[evt] || []).slice().forEach((fn) => {
      try { fn(payload); } catch (e) { try { console.error(e); } catch (_) {} }
    });
  }

  // ---------------------------------------------------------------- 跨 frame 通信
  // 下行：TOP → 所有后代帧（ttl 递减）；上行：任意帧 → 祖先，直到 TOP。
  function isBridgeMsg(data) {
    return !!(data && typeof data === 'object' && data[MSG]);
  }
  function sendUp(type, payload, extra) {
    if (IS_TOP) return;
    try {
      window.parent.postMessage(Object.assign({
        [MSG]: VERSION,
        dir: 'up',
        type: type,
        payload: payload || null,
        from: FRAME_ID,
        to: 'TOP',
        ts: now()
      }, extra || {}), '*');
    } catch (e) {}
  }
  function sendDownToChildren(type, payload, ttl, extra) {
    const kids = childWindows();
    kids.forEach((w) => {
      try {
        w.postMessage(Object.assign({
          [MSG]: VERSION,
          dir: 'down',
          type: type,
          payload: payload || null,
          from: FRAME_ID,
          ttl: ttl,
          ts: now()
        }, extra || {}), '*');
      } catch (e) {}
    });
    return kids.length;
  }
  function childWindows() {
    const out = [];
    try {
      for (let i = 0; i < window.frames.length; i++) {
        try { out.push(window.frames[i]); } catch (e) {}
      }
    } catch (e) {}
    return out;
  }

  // ---------------------------------------------------------------- 页面识别
  function pathOf(url) {
    try { return new URL(url || location.href).pathname || ''; } catch (e) { return ''; }
  }
  function queryOf(url) {
    try { return new URL(url || location.href).searchParams; } catch (e) { return new URLSearchParams(); }
  }
  function classifyPage() {
    const p = pathOf(location.href);
    const q = queryOf(location.href);
    if (/passport2|fanyalogin|login/i.test(p)) return 'login';
    if (/\/ananas\/modules\/video\//i.test(p)) return 'video';
    if (/\/ananas\/modules\/(pdf|ppt|pptx|doc|docx|image|office)\//i.test(p)) return 'document';
    if (/\/ananas\/modules\/audio\//i.test(p)) return 'audio';
    if (/\/ananas\/modules\/(read|book)\//i.test(p)) return 'read';
    if (/\/ananas\/modules\//i.test(p)) return 'module';
    if (/\/knowledge\/cards/i.test(p)) return 'cards';
    if (/\/work\/doHomeWorkNew|\/work\/selectWorkQuestion|\/mooc-ans\/work\/|\/work\/doHomeWork|\/mooc2\/work\/dowork|\/mooc2-ans\/mooc2\/work\//i.test(p)) return 'work';
    if (/\/exam\/test\/|\/mooc2\/exam\/|\/mooc2-ans\/mooc2\/exam\//i.test(p)) return 'exam';
    if (/\/mooc2-ans\/mycourse\/stu|\/mycourse\/studentstudy|\/mooc-ans\/mycourse\/studentstudy|\/mycourse\/studentcourse/i.test(p)) return 'course';
    if (/courselist|visit\/interaction|mooc2-ans\/visit/i.test(p)) return 'courselist';
    if (/\/zt\/|\/ztnodedetailcontroller\//i.test(p)) return 'read';
    return 'other';
  }
  function pageQuery() {
    const q = queryOf(location.href);
    return {
      courseId: q.get('courseId') || q.get('courseid') || '',
      clazzId: q.get('clazzid') || q.get('classId') || q.get('clazzId') || '',
      chapterId: q.get('chapterId') || q.get('knowledgeid') || q.get('knowledgeId') || '',
      enc: q.get('enc') || ''
    };
  }

  // ---------------------------------------------------------------- 同源文档遍历
  function docsFrom(root, maxDepth) {
    const out = [];
    const seen = new Set();
    const limit = maxDepth == null ? 6 : maxDepth;
    function walk(doc, depth) {
      if (!doc || seen.has(doc) || depth > limit) return;
      seen.add(doc);
      out.push(doc);
      let frames = [];
      try { frames = $$('iframe,frame', doc); } catch (e) { frames = []; }
      frames.forEach((f) => {
        if (!visible(f)) return;
        let cd = null;
        try { cd = f.contentDocument; } catch (e) { cd = null; }
        if (cd) walk(cd, depth + 1);
      });
    }
    walk(root || document, 0);
    return out;
  }
  function queryAllDocs(sel, root) {
    const out = [];
    docsFrom(root).forEach((d) => {
      try { Array.prototype.push.apply(out, $$(sel, d)); } catch (e) {}
    });
    return out;
  }
  function findVideos(root) {
    const out = [];
    docsFrom(root).forEach((d) => {
      $$('video', d).forEach((v) => { if (!out.includes(v)) out.push(v); });
    });
    return out;
  }
  function clickEl(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch (e) {
      try { el.scrollIntoView(); } catch (_) {}
    }
    try {
      const win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      const rect = el.getBoundingClientRect();
      const opts = {
        bubbles: true, cancelable: true, view: win,
        clientX: rect.left + Math.max(2, rect.width / 2),
        clientY: rect.top + Math.max(2, rect.height / 2)
      };
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach((t) => {
        try {
          const E = t.indexOf('pointer') === 0 && win.PointerEvent ? win.PointerEvent : win.MouseEvent;
          el.dispatchEvent(new E(t, Object.assign({}, opts, { button: 0 })));
        } catch (e) {}
      });
      if (typeof el.click === 'function') el.click();
      return true;
    } catch (e) { return false; }
  }
  function fireInput(el, value) {
    try {
      const win = el.ownerDocument.defaultView;
      const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      ['input', 'change', 'keyup', 'blur'].forEach((t) => {
        try { el.dispatchEvent(new win.Event(t, { bubbles: true })); } catch (e) {}
      });
      return true;
    } catch (e) { return false; }
  }
  function waitFor(fn, timeout, interval) {
    const end = now() + (timeout || 15000);
    return new Promise((resolve) => {
      (function loop() {
        let v = false;
        try { v = fn(); } catch (e) { v = false; }
        if (v) return resolve(v);
        if (now() > end) return resolve(null);
        setTimeout(loop, interval || 300);
      })();
    });
  }

  // ---------------------------------------------------------------- DeepSeek 接口
  /* #region cxh-api */
  const API_SYSTEM_PROMPT = [
    '你是中国高校课程的答题助手，擅长职业规划、思政、通识类课程。',
    '你会收到一道或多道题目，题型包括单选、多选、判断、填空、简答。',
    '必须遵守：',
    '1. 只输出一个 JSON 对象，不要输出 Markdown 代码块、解释或多余文字。',
    '2. 输出格式：{"answers":[{"no":1,"choices":["A"],"blanks":[],"text":"","confidence":0.95}]}',
    '3. choices 只能使用题目给出的选项字母（如 A、B、C、D）；多选题返回全部正确字母。',
    '4. 判断题同样使用选项字母作答，不要输出“正确/错误”。',
    '5. 填空题按空格顺序把每个空的答案放进 blanks；简答题把完整答案写进 text；选择题 text 留空。',
    '6. 若题目信息不足无法确定，仍给出最可能的答案，并把 confidence 设到 0.3 以下。',
    '7. 不要编造题目中不存在的选项字母，不要合并多个题的答案。'
  ].join('\n');

  let apiChain = Promise.resolve();
  let apiAbort = null;
  let apiActive = 0;
  let thinkingHintShown = false;

  // ---- 思考模型（deepseek-reasoner）适配 ----
  function isReasonerName(model) {
    const m = String(model == null ? '' : model).trim();
    if (!m) return false;
    return /(?:deepseek[\s._-]*reasoner|deepseek[\s._-]*r1|(?:^|[-_/.])r1(?:$|[-_/.])|reasoner|thinking)/i.test(m);
  }
  function thinkingEnabled() {
    return !!(CFG.api && (CFG.api.thinking || isReasonerName(CFG.api.model)));
  }
  function effectiveMaxTokens() {
    const base = Math.round(num(CFG.api.maxTokens, 4096));
    if (!thinkingEnabled()) return clamp(base, 256, 8192);
    const want = Math.max(base, 16384);
    if (!thinkingHintShown && want > base) {
      thinkingHintShown = true;
      log('思考模型：最大 tokens 已自动提升到 ' + want + '（思维链也计入输出长度）');
    }
    return clamp(want, 2048, 65536);
  }
  function requestTimeoutMs() {
    const base = Math.max(15, num(CFG.api.timeoutSec, 120)) * 1000;
    return thinkingEnabled() ? Math.max(base, 300000) : base;
  }
  // deepseek-reasoner 不支持 temperature / top_p / presence_penalty / frequency_penalty / logprobs /
  // response_format（JSON Output），因此在思考模式下只发送通用参数，避免 400。
  function buildChatBody(messages, opts) {
    opts = opts || {};
    const think = thinkingEnabled();
    const body = {
      model: String(CFG.api.model || '').trim(),
      messages: messages,
      stream: !!opts.stream
    };
    const want = (opts.maxTokens != null) ? Math.round(num(opts.maxTokens, 0)) : effectiveMaxTokens();
    body.max_tokens = clamp(want > 0 ? want : effectiveMaxTokens(), 16, 65536);
    if (!think) {
      body.temperature = clamp(num(opts.temperature, num(CFG.api.temperature, 0.2)), 0, 1.5);
      if (opts.json) body.response_format = { type: 'json_object' };
    }
    return body;
  }

  function redact(value) {
    let s = String(value == null ? '' : value);
    const key = (CFG.api && CFG.api.key) || '';
    if (key && key.length > 6) s = s.split(key).join('******');
    return s.replace(/data:image\/[^\s"']+/g, '[图片]').slice(0, 1200);
  }

  function apiEndpoint() {
    let base = String((CFG.api && CFG.api.baseUrl) || '').trim();
    let path = String((CFG.api && CFG.api.path) || '').trim();
    if (!base) base = 'https://api.deepseek.com';
    base = base.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(base)) return base;
    if (!path) path = '/chat/completions';
    if (path.charAt(0) !== '/') path = '/' + path;
    return base + path;
  }

  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + ((CFG.api && CFG.api.key) || '')
    };
  }

  function apiConfigured() {
    return !!((CFG.api && CFG.api.key && String(CFG.api.key).trim()) && (CFG.api.model && String(CFG.api.model).trim()));
  }

  function apiFetchJSON(body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const url = apiEndpoint();
      const timeout = Math.max(15000, Number(timeoutMs) || requestTimeoutMs());
      if (typeof GM_xmlhttpRequest === 'function') {
        let settled = false;
        let handle = null;
        const finish = (fn, arg) => {
          if (settled) return;
          settled = true;
          apiAbort = null;
          apiActive = Math.max(0, apiActive - 1);
          fn(arg);
        };
        try {
          handle = GM_xmlhttpRequest({
            url: url,
            method: 'POST',
            headers: apiHeaders(),
            data: JSON.stringify(body),
            timeout: timeout,
            anonymous: true,
            onload: (res) => {
              let data = null;
              try { data = JSON.parse(res.responseText); } catch (e) {}
              if (res.status >= 200 && res.status < 300 && !data) {
                const e = new Error('API 返回的不是有效 JSON（HTTP ' + res.status + '），可能被网关或登录页拦截：' + truncate(String(res.responseText || '').trim(), 120));
                e.status = res.status;
                e.streamBroken = true;
                finish(reject, e);
                return;
              }
              if (res.status >= 200 && res.status < 300 && data) finish(resolve, data);
              else {
                const detail = data && data.error && (data.error.message || data.error.code);
                const e = new Error(apiErrorText(res.status, detail));
                e.status = res.status;
                finish(reject, e);
              }
            },
            onerror: () => finish(reject, new Error('无法连接 API（网络错误）。请检查网络、代理或 API 地址。')),
            ontimeout: () => finish(reject, new Error('API 请求超时（' + Math.round(timeout / 1000) + ' 秒），可稍后重试或换更快的模型。')),
            onabort: () => finish(reject, new Error('API 请求已取消'))
          });
          apiAbort = () => {
            try { if (handle && handle.abort) handle.abort(); } catch (e) {}
            finish(reject, new Error('API 请求已取消'));
          };
        } catch (e) {
          finish(reject, e);
        }
      } else {
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (e) {} }, timeout);
        apiAbort = () => { try { ctrl && ctrl.abort(); } catch (e) {} };
        fetch(url, {
          method: 'POST',
          headers: apiHeaders(),
          body: JSON.stringify(body),
          signal: ctrl ? ctrl.signal : undefined
        }).then((r) => r.text().then((t) => {
          let data = null;
          try { data = JSON.parse(t); } catch (e) {}
          if (r.ok && data) return data;
          const detail = data && data.error && (data.error.message || data.error.code);
          const e = new Error(apiErrorText(r.status, detail));
          e.status = r.status;
          throw e;
        })).then(resolve).catch((e) => {
          if (e && e.name === 'AbortError') reject(new Error('API 请求超时'));
          else reject(e && e.status ? e : new Error('无法连接 API（可能是跨域限制）。请改用支持 GM_xmlhttpRequest 的脚本管理器。'));
        }).finally(() => clearTimeout(timer));
      }
    });
  }

  function apiErrorText(status, detail) {
    const map = {
      400: '请求参数错误（可能是模型名或 JSON 模式不支持）',
      401: 'API Key 无效或已失效',
      402: '账户余额不足',
      403: '没有访问权限',
      404: '接口地址或模型不存在',
      422: '请求参数不合法',
      429: '请求过于频繁或额度已用完',
      500: '服务器内部错误',
      502: '网关错误',
      503: '服务暂时不可用',
      504: '网关超时'
    };
    return 'API ' + status + '：' + (detail || map[status] || '请求失败');
  }

  const RETRYABLE = [408, 429, 500, 502, 503, 504];

  // 统一解析 choices/message：兼容 reasoning_content（DeepSeek 官方）与 reasoning（部分中转）
  function extractMessage(data) {
    const out = { content: '', reasoning: '', finishReason: '', usage: null, truncated: false };
    try {
      if (Array.isArray(data && data.choices) && data.choices.length) {
        const c = data.choices[0] || {};
        const msg = c.message || c.delta || {};
        let content = msg.content;
        if (Array.isArray(content)) content = content.map((x) => (x && (x.text || x.content)) || '').join('');
        let reasoning = msg.reasoning_content != null ? msg.reasoning_content : msg.reasoning;
        if (Array.isArray(reasoning)) reasoning = reasoning.map((x) => (x && (x.text || x.content)) || '').join('');
        out.content = content == null ? '' : String(content);
        out.reasoning = reasoning == null ? '' : String(reasoning);
        out.finishReason = c.finish_reason || '';
        out.usage = data.usage || null;
        out.truncated = c.finish_reason === 'length';
        return out;
      }
      if (Array.isArray(data && data.content)) {
        out.content = data.content.map((x) => (x && x.text) || '').join('');
      } else if (typeof (data && data.response) === 'string') {
        out.content = data.response;
      }
    } catch (e) {}
    return out;
  }

  function extractContent(data) {
    return String(extractMessage(data).content || '').trim();
  }

  async function apiRequest(body, opts) {
    opts = opts || {};
    const think = thinkingEnabled();
    const retries = opts.retries == null ? (think ? 1 : 2) : opts.retries;
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (!S.running && !opts.force) throw new Error('已停止运行');
      apiActive++;
      const t0 = now();
      try {
        const data = await apiFetchJSON(body, opts.timeoutMs || requestTimeoutMs());
        const msg = extractMessage(data);
        if (msg.truncated) {
          const et = new Error('回答被截断（finish_reason=length），请调大最大输出长度。');
          et.truncated = true;
          et.reasoning = msg.reasoning;
          throw et;
        }
        if (!msg.content.trim()) {
          if (msg.reasoning.trim()) {
            const et = new Error('模型只返回了思考过程，最终答案为空白（max_tokens=' + body.max_tokens + '）');
            et.thinkingOnly = true;
            et.reasoning = msg.reasoning;
            throw et;
          }
          throw new Error('API 返回内容为空');
        }
        return {
          data: data,
          content: msg.content.trim(),
          reasoning: msg.reasoning.trim(),
          finishReason: msg.finishReason,
          usage: msg.usage,
          ms: now() - t0
        };
      } catch (e) {
        lastErr = e;
        const status = e && e.status;
        const retryable = e && !e.thinkingOnly && !e.truncated &&
          (e.retryable || RETRYABLE.indexOf(status) >= 0 || /超时|网络|连接/.test(e.message || ''));
        if (attempt < retries && retryable) {
          const wait = attempt === 0 ? 2500 : (think ? 8000 : 6000);
          warn('API 请求失败：' + redact(e.message) + '，' + Math.round(wait / 1000) + ' 秒后重试（' + (attempt + 1) + '/' + retries + '）');
          await sleep(wait);
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error('API 请求失败');
  }

  // ---- 流式（SSE）解析：思考模式用来实时显示进度；失败自动回退普通请求 ----
  function createSseParser(onDelta) {
    let buf = '';
    const handleLine = (raw) => {
      const line = String(raw == null ? '' : raw).replace(/\r$/, '');
      if (!line || line.charAt(0) === ':') return;
      const m = /^data\s*:\s?(.*)$/.exec(line);
      if (!m) return;
      const payload = m[1].trim();
      if (!payload || payload === '[DONE]') return;
      let obj = null;
      try { obj = JSON.parse(payload); } catch (e) { return; }
      try { onDelta(obj); } catch (e) {}
    };
    return {
      push: (text, final) => {
        buf += String(text || '');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          handleLine(line);
        }
        if (final) {
          if (buf) handleLine(buf);
          buf = '';
        }
      }
    };
  }

  function apiFetchStream(body, opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        const e = new Error('当前脚本管理器不支持流式请求');
        e.streamBroken = true;
        reject(e);
        return;
      }
      const url = apiEndpoint();
      const timeout = Math.max(30000, Number(opts.timeoutMs) || requestTimeoutMs());
      const t0 = now();
      let settled = false;
      let handle = null;
      let consumed = 0;
      let seen = '';
      let events = 0;
      let content = '';
      let reasoning = '';
      let finishReason = '';
      let usage = null;
      let fatal = null;

      const parser = createSseParser((obj) => {
        if (fatal || !obj || typeof obj !== 'object') return;
        if (obj.error) {
          fatal = new Error('API ' + ((obj.error.code || obj.error.type) || '') + '：' + (obj.error.message || '流式返回错误'));
          return;
        }
        const msg = extractMessage({ choices: obj.choices || [], usage: obj.usage });
        events++;
        if (msg.reasoning) reasoning += msg.reasoning;
        if (msg.content) content += msg.content;
        if (msg.finishReason) finishReason = msg.finishReason;
        if (obj.usage) usage = obj.usage;
        if (opts.onProgress) {
          try { opts.onProgress({ content: content, reasoning: reasoning, elapsedMs: now() - t0 }); } catch (e) {}
        }
      });

      const breakStream = (msg) => {
        const e = new Error(msg);
        e.streamBroken = true;
        return e;
      };

      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        apiAbort = null;
        apiActive = Math.max(0, apiActive - 1);
        fn(arg);
      };

      const consume = (text, final) => {
        text = String(text || '');
        if (text) {
          let chunk = '';
          if (text.length >= consumed && text.slice(0, consumed) === seen) {
            chunk = text.slice(consumed);
          } else {
            // 少数实现给的是增量片段而不是累积文本，按新片段处理
            chunk = text;
          }
          consumed = text.length;
          seen = text;
          if (chunk) parser.push(chunk, false);
        }
        if (final) parser.push('', true);
      };

      try {
        apiActive++;
        handle = GM_xmlhttpRequest({
          url: url,
          method: 'POST',
          headers: Object.assign(apiHeaders(), { 'Accept': 'text/event-stream' }),
          data: JSON.stringify(body),
          timeout: timeout,
          anonymous: true,
          onprogress: (res) => {
            if (settled) return;
            try { consume(res && res.responseText, false); } catch (e) {}
          },
          onload: (res) => {
            if (settled) return;
            const status = Number(res && res.status) || 0;
            if (status >= 200 && status < 300) {
              try { consume(res && res.responseText, true); } catch (e) {}
              if (fatal) { finish(reject, fatal); return; }
              if (!events) {
                // 个别网关会忽略 stream:true 直接回普通 JSON
                let data = null;
                try { data = JSON.parse((res && res.responseText) || ''); } catch (e) {}
                if (data) {
                  const msg = extractMessage(data);
                  if (!msg.content.trim() && !msg.reasoning.trim()) { finish(reject, breakStream('API 返回内容为空')); return; }
                  finish(resolve, {
                    data: data,
                    content: msg.content.trim(),
                    reasoning: msg.reasoning.trim(),
                    finishReason: msg.finishReason,
                    usage: msg.usage,
                    truncated: msg.truncated,
                    ms: now() - t0,
                    streamed: false
                  });
                  return;
                }
                finish(reject, breakStream('流式响应解析失败（没有收到有效数据）'));
                return;
              }
              if (!content.trim() && !reasoning.trim()) { finish(reject, breakStream('流式返回内容为空')); return; }
              finish(resolve, {
                data: null,
                content: content.trim(),
                reasoning: reasoning.trim(),
                finishReason: finishReason,
                usage: usage,
                truncated: finishReason === 'length',
                ms: now() - t0,
                streamed: true
              });
              return;
            }
            let data = null;
            try { data = JSON.parse((res && res.responseText) || ''); } catch (e) {}
            const detail = data && data.error && (data.error.message || data.error.code);
            const e = new Error(apiErrorText(status, detail));
            e.status = status;
            e.streamBroken = status >= 500 || [400, 404, 405, 406, 415].indexOf(status) >= 0;
            finish(reject, e);
          },
          onerror: () => finish(reject, breakStream('无法连接 API（流式请求网络错误）')),
          ontimeout: () => finish(reject, breakStream('流式请求超时（' + Math.round(timeout / 1000) + ' 秒）')),
          onabort: () => finish(reject, new Error('API 请求已取消'))
        });
        apiAbort = () => {
          try { if (handle && handle.abort) handle.abort(); } catch (e) {}
          finish(reject, new Error('API 请求已取消'));
        };
      } catch (e) {
        finish(reject, e);
      }
    });
  }

  async function apiRequestStream(body, opts) {
    opts = opts || {};
    try {
      const r = await apiFetchStream(body, opts);
      if (r.truncated) {
        const e = new Error('流式回答被截断（finish_reason=length），思考可能占满了 max_tokens=' + body.max_tokens);
        e.truncated = true;
        e.reasoning = r.reasoning;
        throw e;
      }
      if (!r.content.trim()) {
        if (r.reasoning.trim()) {
          const e = new Error('模型只返回了思考过程，最终答案为空白（max_tokens=' + body.max_tokens + '）');
          e.thinkingOnly = true;
          e.reasoning = r.reasoning;
          throw e;
        }
        throw new Error('API 返回内容为空');
      }
      return r;
    } catch (e) {
      if (!e || !e.streamBroken) throw e;
      warn('流式接收失败（' + redact(e.message || e) + '），自动改用普通请求重试…');
      const body2 = Object.assign({}, body, { stream: false });
      const opts2 = Object.assign({}, opts, { retries: opts.retries == null ? 1 : opts.retries });
      return await apiRequest(body2, opts2);
    }
  }

  function parseJsonLoose(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(s); } catch (e) {}
    const start = s.indexOf('{'), end = s.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (e) {}
      const arrStart = s.indexOf('['), arrEnd = s.lastIndexOf(']');
      if (arrStart >= 0 && arrEnd > arrStart) {
        try { return JSON.parse(s.slice(arrStart, arrEnd + 1)); } catch (e) {}
      }
    }
    return null;
  }

  function buildQuizPrompt(questions, courseName) {
    const hasFill = questions.some((q) => q.type === 'fill');
    const payload = {
      course: courseName || S.course.name || '',
      count: questions.length,
      note: hasFill ? '填空题题干中被空格断开的位置即待填空位，请按 blanks 数量按顺序给出每个空的答案' : undefined,
      questions: questions.map((q) => ({
        no: q.no,
        type: q.type,
        stem: q.stem,
        options: q.options.map((o) => ({ label: o.label, text: o.text })),
        blanks: q.blankCount || 0
      }))
    };
    let sys = API_SYSTEM_PROMPT;
    if (CFG.api.extraPrompt && String(CFG.api.extraPrompt).trim()) {
      sys += '\n\n补充要求：\n' + String(CFG.api.extraPrompt).trim();
    }
    sys += '\n\n请直接返回 JSON：{"answers":[...]}';
    return [
      { role: 'system', content: sys },
      { role: 'user', content: '请作答以下题目，按 no 对应返回：\n' + JSON.stringify(payload) }
    ];
  }

  function normalizeConfidence(v, d) {
    const n = Number(v);
    if (!isFinite(n)) return d;
    return clamp(n > 1 ? n / 100 : n, 0, 1);
  }

  function normalizeAnswerItem(raw) {
    const a = {
      no: Number(raw && raw.no) || 0,
      choices: [],
      blanks: [],
      text: '',
      confidence: 0.8
    };
    if (!raw || typeof raw !== 'object') return a;
    let ch = raw.choices != null ? raw.choices : raw.answer;
    if (typeof ch === 'string') {
      const t = ch.trim();
      if (/^[A-Za-z](?:\s*[,，、;；\/|]\s*[A-Za-z])*$/.test(t)) ch = t.toUpperCase().match(/[A-Z]/g) || [];
      else if (/^(正确|对|是|true|√|✓)$/i.test(t)) ch = ['__TRUE__'];
      else if (/^(错误|错|否|false|×|✗)$/i.test(t)) ch = ['__FALSE__'];
      else ch = [t];
    }
    if (typeof ch === 'number') ch = [String(ch)];
    if (Array.isArray(ch)) {
      a.choices = ch.map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
    }
    let bl = raw.blanks;
    if (typeof bl === 'string') bl = [bl];
    if (Array.isArray(bl)) a.blanks = bl.map((x) => String(x == null ? '' : x).trim());
    a.text = String(raw.text == null ? (raw.explanation && a.choices.length === 0 ? '' : (raw.answer_text || '')) : raw.text).trim();
    a.confidence = normalizeConfidence(raw.confidence, 0.8);
    return a;
  }

  async function askQuizBatch(questions, courseName) {
    if (!apiConfigured()) throw new Error('未配置 API');
    // 先把字体映射准备好（视频弹窗题等入口不经过 solveQuizPage 的预解析）
    try { await ensureSecretFontMap(); } catch (e) {}
    const messages = buildQuizPrompt(questions, courseName);
    // 体检：发给模型的文本里不能残留加密字形，否则模型只能靠猜
    const promptText = messages.map((m) => String(m.content || '')).join('\n');
    try { window.__CXH_LAST_PROMPT__ = promptText; } catch (e) {};
    const leftover = secretUnknownCount(promptText);
    if (leftover > 0) {
      warn('提示词里有 ' + leftover + ' 个没解出的字形，已保持原样连同题目一起发给模型（模型可结合上下文猜）');
    }
    log('提示词预览：' + truncate(promptText.replace(/\s+/g, ' '), 100));
    const think = thinkingEnabled();
    const useStream = think && CFG.api.stream !== false;
    let maxTokens = effectiveMaxTokens();
    const t0 = now();
    let timer = null;
    if (think) {
      log('思考模式作答：' + questions.length + ' 题（' + String(CFG.api.model || 'reasoner') + '），单题可能需要 20–180 秒');
      timer = setInterval(() => {
        const sec = Math.round((now() - t0) / 1000);
        setMessage('思考中… 已等待 ' + sec + ' 秒' + (useStream ? '' : '（非流式）'));
      }, 1000);
    }
    let res = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const body = buildChatBody(messages, { stream: useStream, json: true, maxTokens: maxTokens });
        const opts = {
          force: true,
          timeoutMs: requestTimeoutMs(),
          thinking: think,
          onProgress: useStream ? (p) => {
            const sec = Math.round((p.elapsedMs || 0) / 1000);
            setMessage('思考中… ' + sec + ' 秒（已思考 ' + (p.reasoning || '').length + ' 字）');
          } : null
        };
        try {
          res = useStream ? await apiRequestStream(body, opts) : await apiRequest(body, opts);
          break;
        } catch (e) {
          const grow = (e && (e.thinkingOnly || e.truncated)) && attempt === 0;
          if (!grow) throw e;
          maxTokens = Math.min(65536, Math.max(16384, maxTokens * 2));
          warn('思考输出被截断或最终答案为空，已把最大 tokens 提升到 ' + maxTokens + ' 后重试…');
        }
      }
    } finally {
      if (timer) clearInterval(timer);
    }
    if (!res) throw new Error('API 请求失败');
    const sec = Math.round((now() - t0) / 1000);
    if (think) {
      log('思考完成：耗时 ' + sec + ' 秒' + (res.reasoning ? '，思维链 ' + res.reasoning.length + ' 字' : '') + (res.streamed ? '（流式）' : ''));
    }
    if (res.reasoning && CFG.api.showReasoning !== false) {
      pushLog('info', '思考过程（' + res.reasoning.length + ' 字）：' + truncate(res.reasoning.replace(/\s+/g, ' '), 90), { reasoning: res.reasoning });
    }
    const parsed = parseJsonLoose(res.content);
    if (!parsed) throw new Error('模型返回的不是有效 JSON：' + truncate(redact(res.content), 160));
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.answers) ? parsed.answers : []);
    if (!arr.length) throw new Error('模型没有返回答案列表');
    return {
      answers: arr.map(normalizeAnswerItem),
      raw: res.content,
      reasoning: res.reasoning || '',
      ms: res.ms
    };
  }

  async function testApiConnection() {
    if (!apiConfigured()) throw new Error('请先填写 API Key 和模型名');
    S.apiState = 'testing';
    S.apiInfo = '正在连接…';
    if (IS_TOP) emit('state');
    const think = thinkingEnabled();
    const body = buildChatBody([
      { role: 'system', content: '你是连通性测试助手。' },
      { role: 'user', content: '只回复两个字：正常' }
    ], { maxTokens: think ? 2048 : 16, temperature: 0, json: false, stream: false });
    const t0 = now();
    try {
      const data = await apiFetchJSON(body, think ? Math.max(60000, Math.min(requestTimeoutMs(), 180000)) : 30000);
      const msg = extractMessage(data);
      if (!msg.content.trim() && msg.reasoning.trim()) {
        throw new Error('模型只返回思考过程、正文为空：请把「最大 tokens」调到 16384 以上，或换用 deepseek-chat');
      }
      S.apiState = 'ok';
      S.apiInfo = '连接正常 · ' + (now() - t0) + 'ms · ' + (think ? '思考模型' : '普通模型') +
        (msg.reasoning.trim() ? '（思维链 ' + msg.reasoning.length + ' 字）' : '') +
        ' · 返回：' + truncate(String(msg.content).trim(), 30);
      log('API 测试成功：' + S.apiInfo);
      if (IS_TOP) emit('state');
      return S.apiInfo;
    } catch (e) {
      S.apiState = 'fail';
      S.apiInfo = redact(e.message || '连接失败');
      error('API 测试失败：' + S.apiInfo);
      if (IS_TOP) emit('state');
      throw e;
    }
  }

  // 串行化 API 调用，避免并发打满额度
  function queueApi(fn) {
    const run = apiChain.then(fn, fn);
    apiChain = run.catch(() => {});
    return run;
  }
  /* #endregion cxh-api */

  // ---------------------------------------------------------------- 答题引擎
  function looseVisible(el) {
    try {
      if (!el || !el.isConnected) return false;
      if (el.getClientRects().length > 0) return true;
      return el.offsetParent !== null;
    } catch (e) { return false; }
  }

  // ---------------------------------------------------------------- 题目字体解密
  /*
   * 学习通部分课程会给题干/选项套 `.font-cxsecret` 字体：DOM 里存的是“加密字形”的
   * 生僻字（如「媏符媊半媌质媎媍媉媋的选项是」），只有用站点自带 font-cxsecret 渲染才
   * 显示成正常汉字。模型看不懂这些乱码，所以这里内置一份「加密字 → 正字」对照表：
   * 用字形匹配（Noto Sans SC / 微软雅黑 / 等线 三字体渲染 + em 方框归一 + 余弦相似）
   * 反查得出 137 个字形对应的汉字，再逐句人工核对过 40 道真实题目。
   * 表随站点字体版本变化才需要更新；一旦遇到表里没有的加密字，宁可跳过也不给模型喂乱码。
   */
  const SECRET_PAIRS =
    [
      '偸白媉原媊合媋则媌流媍食媎饮媏不媐液媑状媒呈媓于媔咽媕吞媖易媗嚼媘咀媙纤媚量媛维',
      '媜素媝含媞多媟少媠制媡品媢味媣限媤激媥刺媦担媧的媨减媩症媫者媬采媭高媯盐媰低媱肪',
      '媲无媳渣媴围媵是媶用媷适媸功媹患媺甲媻进媾能嫀慢嫃性嫄疾嫅消嫆肝嫇脑嫈血嫉硬嫊腹',
      '嫍天嫎术嫏岁嫐哪嫑应嫓普嫕软嫖半嫗其嫘误嫙中嫚对嫛导嫜错嫝脂嫞胆嫟固嫠醇嫡淡嫢餐',
      '嫣清嫤宜嫥蛋嫦富嫧和嫨热嫪造嫫某嫬要嫭验嫮物嫯前嫰胃嫳下嫴类嫵奶嫶菜嫷蔬嫸猪嫹绿',
      '嫽及嫾豆嫿土嬁西嬂柿嬃属嬄列嬅试嬆浓嬇尿嬈缩嬉说嬊点嬋午嬌时嬍根嬎上嬏料嬐补嬑一',
      '嬒充嬓并嬔生嬕加嬖人嬗年嬘速嬚利嬛况嬜困嬞现嬟发嬡通嬪质溓体裊化隗病'
    ].join('');
  const SECRET_RANGES = [[0x5078, 0x5078], [0x5A89, 0x5B2A], [0x6E93, 0x6E93], [0x88CA, 0x88CA], [0x9697, 0x9697]];
  let SECRET_MAP = null;

  function secretMap() {
    if (SECRET_FONT_MAP) return SECRET_FONT_MAP;
    if (SECRET_MAP) return SECRET_MAP;
    const m = Object.create(null);
    for (let i = 0; i + 1 < SECRET_PAIRS.length; i += 2) m[SECRET_PAIRS[i]] = SECRET_PAIRS[i + 1];
    SECRET_MAP = m;
    return m;
  }

  function inSecretRange(ch) {
    const cp = ch.codePointAt(0);
    if (SECRET_FONT_CPS && SECRET_FONT_CPS.has(cp)) return true;
    for (let i = 0; i < SECRET_RANGES.length; i++) {
      if (cp >= SECRET_RANGES[i][0] && cp <= SECRET_RANGES[i][1]) return true;
    }
    return false;
  }

  // 把加密字形换成正常汉字；表里没有的字符原样保留
  function decodeSecret(s) {
    if (!s) return s;
    const m = secretMap();
    let out = '';
    let hit = false;
    for (const ch of String(s)) {
      const d = m[ch];
      if (d) { out += d; hit = true; } else out += ch;
    }
    return hit ? out : String(s);
  }

  // 统计“看起来像加密字形、但对照表里没有”的字符数（用于判断字体是否换版）
  function secretUnknownCount(s) {
    if (!s) return 0;
    const m = secretMap();
    let n = 0;
    for (const ch of String(s)) if (!m[ch] && inSecretRange(ch)) n++;
    return n;
  }

  function questionsNeedDecode(list) {
    return list.some((q) => {
      if (secretUnknownCount(q.stem)) return true;
      return (q.options || []).some((o) => secretUnknownCount(o.text));
    });
  }

  // ---- 运行时字形反查（字体换版自适应）----
  /*
   * 观察到的规律：站点字体里 glyph 的排列顺序 == 明文字符的 unicode 升序。
   * 于是不必再靠“像素猜字”：从 @font-face 取到 TTF，解析 cmap 得到「码位 → gid」，
   * 按 gid 排序后与内置明文序列逐位对齐，就能在字体换版（码位重排）后自动恢复映射。
   * 为防止规律失效把题目解成错的，映射建好后还会做一轮像素抽检（自定义字体渲染
   * vs 系统字体渲染，同字应相似）；抽检不过就继续用内置对照表。
   */
  // ---- 运行时字形反查（字体换版自适应）----
  /*
   * 站点会把题干/选项存成「生僻字 + 自定义字体」：DOM 里是密文，靠 @font-face 才显示成汉字。
   *
   * 已确认两条稳定规律（对 137 字、161 字两个字体版本实测）：
   *   1) 字体里 glyph 的顺序 == 明文字符的 unicode 升序；
   *   2) 同一批字符集只换码位。
   * 所以：解析 TTF 的 cmap 得到「码位 → gid」，按 gid 排序后与“该版本的明文清单”逐位对齐，
   * 即可在换字体后自动恢复映射，不需要再人工造表。
   *
   * 对没收录的新版本：canvas 渲染密文字形，与内置 6763 常用字做像素相似度，再按
   * 「明文 unicode 必须递增」做一次单调 DP 对齐，现场算出映射（较慢，只在新版本首次遇到时跑）。
   * 映射建好后做像素抽检（自定义字体 vs 系统字体，同字应相似）；抽检不过就退回内置表，
   * 解不出来的字不猜、保持原样，和其余题目一起交给模型。
   */
  const SECRET_SORTED = [
    '一上下不中于人低体充其况减列则利制刺前功加化午半原及发合吞含呈味咀和咽品哪嚼困围',
    '固土多天奶宜富对导少尿属岁年并应性患慢担料无时易是普术某柿根流浓消液淡清渣激点热',
    '物状猪现生用甲疾病症白的盐硬类素纤维绿缩者肝肪胃胆能脂脑腹菜蔬蛋血补西要试误说豆',
    '质软进适通速造醇采量错限食餐饮验高'
  ].join('');
  // 各字体版本的明文清单（按 gid 顺序 == unicode 升序）
  const SECRET_INV = Object.create(null);
  SECRET_INV[137] = SECRET_SORTED;
  SECRET_INV[161] = [
    '下不于人以传伤作使侧便保先光免关况出分刘前医协参及发同周味响喝在坐垃塞处多大失定',
    '宜宽察小少尺尿屏崩巾帮年并应度开引影患意感房扶护择持换排推描操效敏无日时明暗有期',
    '本松果柏柔椅正死每毛气氨水油洁流润液温滑漏潴烂照状环理生用畅瘘的禁秘空窗站端管红',
    '纸结缩老者肠肤腐腥臭色苹蒜袋裤褐要观论设该误说质走起越转过进通造部酱量错防阴颜鲜',
    '黄',
  ].join('');
  // 像素反查候选池：GB2312 一、二级汉字
  const SECRET_POOL = [
    '啊阿埃挨哎唉哀皑癌蔼矮艾碍爱隘鞍氨安俺按暗岸胺案肮昂盎凹敖熬翱袄傲奥懊澳芭捌扒叭',
    '吧笆八疤巴拔跋靶把耙坝霸罢爸白柏百摆佰败拜稗斑班搬扳般颁板版扮拌伴瓣半办绊邦帮梆',
    '榜膀绑棒磅蚌镑傍谤苞胞包褒剥薄雹保堡饱宝抱报暴豹鲍爆杯碑悲卑北辈背贝钡倍狈备惫焙',
    '被奔苯本笨崩绷甭泵蹦迸逼鼻比鄙笔彼碧蓖蔽毕毙毖币庇痹闭敝弊必辟壁臂避陛鞭边编贬扁',
    '便变卞辨辩辫遍标彪膘表鳖憋别瘪彬斌濒滨宾摈兵冰柄丙秉饼炳病并玻菠播拨钵波博勃搏铂',
    '箔伯帛舶脖膊渤泊驳捕卜哺补埠不布步簿部怖擦猜裁材才财睬踩采彩菜蔡餐参蚕残惭惨灿苍',
    '舱仓沧藏操糙槽曹草厕策侧册测层蹭插叉茬茶查碴搽察岔差诧拆柴豺搀掺蝉馋谗缠铲产阐颤',
    '昌猖场尝常长偿肠厂敞畅唱倡超抄钞朝嘲潮巢吵炒车扯撤掣彻澈郴臣辰尘晨忱沉陈趁衬撑称',
    '城橙成呈乘程惩澄诚承逞骋秤吃痴持匙池迟弛驰耻齿侈尺赤翅斥炽充冲虫崇宠抽酬畴踌稠愁',
    '筹仇绸瞅丑臭初出橱厨躇锄雏滁除楚础储矗搐触处揣川穿椽传船喘串疮窗幢床闯创吹炊捶锤',
    '垂春椿醇唇淳纯蠢戳绰疵茨磁雌辞慈瓷词此刺赐次聪葱囱匆从丛凑粗醋簇促蹿篡窜摧崔催脆',
    '瘁粹淬翠村存寸磋撮搓措挫错搭达答瘩打大呆歹傣戴带殆代贷袋待逮怠耽担丹单郸掸胆旦氮',
    '但惮淡诞弹蛋当挡党荡档刀捣蹈倒岛祷导到稻悼道盗德得的蹬灯登等瞪凳邓堤低滴迪敌笛狄',
    '涤翟嫡抵底地蒂第帝弟递缔颠掂滇碘点典靛垫电佃甸店惦奠淀殿碉叼雕凋刁掉吊钓调跌爹碟',
    '蝶迭谍叠丁盯叮钉顶鼎锭定订丢东冬董懂动栋侗恫冻洞兜抖斗陡豆逗痘都督毒犊独读堵睹赌',
    '杜镀肚度渡妒端短锻段断缎堆兑队对墩吨蹲敦顿囤钝盾遁掇哆多夺垛躲朵跺舵剁惰堕蛾峨鹅',
    '俄额讹娥恶厄扼遏鄂饿恩而儿耳尔饵洱二贰发罚筏伐乏阀法珐藩帆番翻樊矾钒繁凡烦反返范',
    '贩犯饭泛坊芳方肪房防妨仿访纺放菲非啡飞肥匪诽吠肺废沸费芬酚吩氛分纷坟焚汾粉奋份忿',
    '愤粪丰封枫蜂峰锋风疯烽逢冯缝讽奉凤佛否夫敷肤孵扶拂辐幅氟符伏俘服浮涪福袱弗甫抚辅',
    '俯釜斧脯腑府腐赴副覆赋复傅付阜父腹负富讣附妇缚咐噶嘎该改概钙盖溉干甘杆柑竿肝赶感',
    '秆敢赣冈刚钢缸肛纲岗港杠篙皋高膏羔糕搞镐稿告哥歌搁戈鸽胳疙割革葛格蛤阁隔铬个各给',
    '根跟耕更庚羹埂耿梗工攻功恭龚供躬公宫弓巩汞拱贡共钩勾沟苟狗垢构购够辜菇咕箍估沽孤',
    '姑鼓古蛊骨谷股故顾固雇刮瓜剐寡挂褂乖拐怪棺关官冠观管馆罐惯灌贯光广逛瑰规圭硅归龟',
    '闺轨鬼诡癸桂柜跪贵刽辊滚棍锅郭国果裹过哈骸孩海氦亥害骇酣憨邯韩含涵寒函喊罕翰撼捍',
    '旱憾悍焊汗汉夯杭航壕嚎豪毫郝好耗号浩呵喝荷菏核禾和何合盒貉阂河涸赫褐鹤贺嘿黑痕很',
    '狠恨哼亨横衡恒轰哄烘虹鸿洪宏弘红喉侯猴吼厚候后呼乎忽瑚壶葫胡蝴狐糊湖弧虎唬护互沪',
    '户花哗华猾滑画划化话槐徊怀淮坏欢环桓还缓换患唤痪豢焕涣宦幻荒慌黄磺蝗簧皇凰惶煌晃',
    '幌恍谎灰挥辉徽恢蛔回毁悔慧卉惠晦贿秽会烩汇讳诲绘荤昏婚魂浑混豁活伙火获或惑霍货祸',
    '击圾基机畸稽积箕肌饥迹激讥鸡姬绩缉吉极棘辑籍集及急疾汲即嫉级挤几脊己蓟技冀季伎祭',
    '剂悸济寄寂计记既忌际妓继纪嘉枷夹佳家加荚颊贾甲钾假稼价架驾嫁歼监坚尖笺间煎兼肩艰',
    '奸缄茧检柬碱硷拣捡简俭剪减荐槛鉴践贱见键箭件健舰剑饯渐溅涧建僵姜将浆江疆蒋桨奖讲',
    '匠酱降蕉椒礁焦胶交郊浇骄娇嚼搅铰矫侥脚狡角饺缴绞剿教酵轿较叫窖揭接皆秸街阶截劫节',
    '桔杰捷睫竭洁结解姐戒藉芥界借介疥诫届巾筋斤金今津襟紧锦仅谨进靳晋禁近烬浸尽劲荆兢',
    '茎睛晶鲸京惊精粳经井警景颈静境敬镜径痉靖竟竞净炯窘揪究纠玖韭久灸九酒厩救旧臼舅咎',
    '就疚鞠拘狙疽居驹菊局咀矩举沮聚拒据巨具距踞锯俱句惧炬剧捐鹃娟倦眷卷绢撅攫抉掘倔爵',
    '觉决诀绝均菌钧军君峻俊竣浚郡骏喀咖卡咯开揩楷凯慨刊堪勘坎砍看康慷糠扛抗亢炕考拷烤',
    '靠坷苛柯棵磕颗科壳咳可渴克刻客课肯啃垦恳坑吭空恐孔控抠口扣寇枯哭窟苦酷库裤夸垮挎',
    '跨胯块筷侩快宽款匡筐狂框矿眶旷况亏盔岿窥葵奎魁傀馈愧溃坤昆捆困括扩廓阔垃拉喇蜡腊',
    '辣啦莱来赖蓝婪栏拦篮阑兰澜谰揽览懒缆烂滥琅榔狼廊郎朗浪捞劳牢老佬姥酪烙涝勒乐雷镭',
    '蕾磊累儡垒擂肋类泪棱楞冷厘梨犁黎篱狸离漓理李里鲤礼莉荔吏栗丽厉励砾历利傈例俐痢立',
    '粒沥隶力璃哩俩联莲连镰廉怜涟帘敛脸链恋炼练粮凉梁粱良两辆量晾亮谅撩聊僚疗燎寥辽潦',
    '了撂镣廖料列裂烈劣猎琳林磷霖临邻鳞淋凛赁吝拎玲菱零龄铃伶羚凌灵陵岭领另令溜琉榴硫',
    '馏留刘瘤流柳六龙聋咙笼窿隆垄拢陇楼娄搂篓漏陋芦卢颅庐炉掳卤虏鲁麓碌露路赂鹿潞禄录',
    '陆戮驴吕铝侣旅履屡缕虑氯律率滤绿峦挛孪滦卵乱掠略抡轮伦仑沦纶论萝螺罗逻锣箩骡裸落',
    '洛骆络妈麻玛码蚂马骂嘛吗埋买麦卖迈脉瞒馒蛮满蔓曼慢漫谩芒茫盲氓忙莽猫茅锚毛矛铆卯',
    '茂冒帽貌贸么玫枚梅酶霉煤没眉媒镁每美昧寐妹媚门闷们萌蒙檬盟锰猛梦孟眯醚靡糜迷谜弥',
    '米秘觅泌蜜密幂棉眠绵冕免勉娩缅面苗描瞄藐秒渺庙妙蔑灭民抿皿敏悯闽明螟鸣铭名命谬摸',
    '摹蘑模膜磨摩魔抹末莫墨默沫漠寞陌谋牟某拇牡亩姆母墓暮幕募慕木目睦牧穆拿哪呐钠那娜',
    '纳氖乃奶耐奈南男难囊挠脑恼闹淖呢馁内嫩能妮霓倪泥尼拟你匿腻逆溺蔫拈年碾撵捻念娘酿',
    '鸟尿捏聂孽啮镊镍涅您柠狞凝宁拧泞牛扭钮纽脓浓农弄奴努怒女暖虐疟挪懦糯诺哦欧鸥殴藕',
    '呕偶沤啪趴爬帕怕琶拍排牌徘湃派攀潘盘磐盼畔判叛乓庞旁耪胖抛咆刨炮袍跑泡呸胚培裴赔',
    '陪配佩沛喷盆砰抨烹澎彭蓬棚硼篷膨朋鹏捧碰坯砒霹批披劈琵毗啤脾疲皮匹痞僻屁譬篇偏片',
    '骗飘漂瓢票撇瞥拼频贫品聘乒坪苹萍平凭瓶评屏坡泼颇婆破魄迫粕剖扑铺仆莆葡菩蒲埔朴圃',
    '普浦谱曝瀑期欺栖戚妻七凄漆柒沏其棋奇歧畦崎脐齐旗祈祁骑起岂乞企启契砌器气迄弃汽泣',
    '讫掐恰洽牵扦钎铅千迁签仟谦乾黔钱钳前潜遣浅谴堑嵌欠歉枪呛腔羌墙蔷强抢橇锹敲悄桥瞧',
    '乔侨巧鞘撬翘峭俏窍切茄且怯窃钦侵亲秦琴勤芹擒禽寝沁青轻氢倾卿清擎晴氰情顷请庆琼穷',
    '秋丘邱球求囚酋泅趋区蛆曲躯屈驱渠取娶龋趣去圈颧权醛泉全痊拳犬券劝缺炔瘸却鹊榷确雀',
    '裙群然燃冉染瓤壤攘嚷让饶扰绕惹热壬仁人忍韧任认刃妊纫扔仍日戎茸蓉荣融熔溶容绒冗揉',
    '柔肉茹蠕儒孺如辱乳汝入褥软阮蕊瑞锐闰润若弱撒洒萨腮鳃塞赛三叁伞散桑嗓丧搔骚扫嫂瑟',
    '色涩森僧莎砂杀刹沙纱傻啥煞筛晒珊苫杉山删煽衫闪陕擅赡膳善汕扇缮墒伤商赏晌上尚裳梢',
    '捎稍烧芍勺韶少哨邵绍奢赊蛇舌舍赦摄射慑涉社设砷申呻伸身深娠绅神沈审婶甚肾慎渗声生',
    '甥牲升绳省盛剩胜圣师失狮施湿诗尸虱十石拾时什食蚀实识史矢使屎驶始式示士世柿事拭誓',
    '逝势是嗜噬适仕侍释饰氏市恃室视试收手首守寿授售受瘦兽蔬枢梳殊抒输叔舒淑疏书赎孰熟',
    '薯暑曙署蜀黍鼠属术述树束戍竖墅庶数漱恕刷耍摔衰甩帅栓拴霜双爽谁水睡税吮瞬顺舜说硕',
    '朔烁斯撕嘶思私司丝死肆寺嗣四伺似饲巳松耸怂颂送宋讼诵搜艘擞嗽苏酥俗素速粟僳塑溯宿',
    '诉肃酸蒜算虽隋随绥髓碎岁穗遂隧祟孙损笋蓑梭唆缩琐索锁所塌他它她塔獭挞蹋踏胎苔抬台',
    '泰酞太态汰坍摊贪瘫滩坛檀痰潭谭谈坦毯袒碳探叹炭汤塘搪堂棠膛唐糖倘躺淌趟烫掏涛滔绦',
    '萄桃逃淘陶讨套特藤腾疼誊梯剔踢锑提题蹄啼体替嚏惕涕剃屉天添填田甜恬舔腆挑条迢眺跳',
    '贴铁帖厅听烃汀廷停亭庭挺艇通桐酮瞳同铜彤童桶捅筒统痛偷投头透凸秃突图徒途涂屠土吐',
    '兔湍团推颓腿蜕褪退吞屯臀拖托脱鸵陀驮驼椭妥拓唾挖哇蛙洼娃瓦袜歪外豌弯湾玩顽丸烷完',
    '碗挽晚皖惋宛婉万腕汪王亡枉网往旺望忘妄威巍微危韦违桅围唯惟为潍维苇萎委伟伪尾纬未',
    '蔚味畏胃喂魏位渭谓尉慰卫瘟温蚊文闻纹吻稳紊问嗡翁瓮挝蜗涡窝我斡卧握沃巫呜钨乌污诬',
    '屋无芜梧吾吴毋武五捂午舞伍侮坞戊雾晤物勿务悟误昔熙析西硒矽晰嘻吸锡牺稀息希悉膝夕',
    '惜熄烯溪汐犀檄袭席习媳喜铣洗系隙戏细瞎虾匣霞辖暇峡侠狭下厦夏吓掀锨先仙鲜纤咸贤衔',
    '舷闲涎弦嫌显险现献县腺馅羡宪陷限线相厢镶香箱襄湘乡翔祥详想响享项巷橡像向象萧硝霄',
    '削哮嚣销消宵淆晓小孝校肖啸笑效楔些歇蝎鞋协挟携邪斜胁谐写械卸蟹懈泄泻谢屑薪芯锌欣',
    '辛新忻心信衅星腥猩惺兴刑型形邢行醒幸杏性姓兄凶胸匈汹雄熊休修羞朽嗅锈秀袖绣墟戌需',
    '虚嘘须徐许蓄酗叙旭序畜恤絮婿绪续轩喧宣悬旋玄选癣眩绚靴薛学穴雪血勋熏循旬询寻驯巡',
    '殉汛训讯逊迅压押鸦鸭呀丫芽牙蚜崖衙涯雅哑亚讶焉咽阉烟淹盐严研蜒岩延言颜阎炎沿奄掩',
    '眼衍演艳堰燕厌砚雁唁彦焰宴谚验殃央鸯秧杨扬佯疡羊洋阳氧仰痒养样漾邀腰妖瑶摇尧遥窑',
    '谣姚咬舀药要耀椰噎耶爷野冶也页掖业叶曳腋夜液一壹医揖铱依伊衣颐夷遗移仪胰疑沂宜姨',
    '彝椅蚁倚已乙矣以艺抑易邑屹亿役臆逸肄疫亦裔意毅忆义益溢诣议谊译异翼翌绎茵荫因殷音',
    '阴姻吟银淫寅饮尹引隐印英樱婴鹰应缨莹萤营荧蝇迎赢盈影颖硬映哟拥佣臃痈庸雍踊蛹咏泳',
    '涌永恿勇用幽优悠忧尤由邮铀犹油游酉有友右佑釉诱又幼迂淤于盂榆虞愚舆余俞逾鱼愉渝渔',
    '隅予娱雨与屿禹宇语羽玉域芋郁吁遇喻峪御愈欲狱育誉浴寓裕预豫驭鸳渊冤元垣袁原援辕园',
    '员圆猿源缘远苑愿怨院曰约越跃钥岳粤月悦阅耘云郧匀陨允运蕴酝晕韵孕匝砸杂栽哉灾宰载',
    '再在咱攒暂赞赃脏葬遭糟凿藻枣早澡蚤躁噪造皂灶燥责择则泽贼怎增憎曾赠扎喳渣札轧铡闸',
    '眨栅榨咋乍炸诈摘斋宅窄债寨瞻毡詹粘沾盏斩辗崭展蘸栈占战站湛绽樟章彰漳张掌涨杖丈帐',
    '账仗胀瘴障招昭找沼赵照罩兆肇召遮折哲蛰辙者锗蔗这浙珍斟真甄砧臻贞针侦枕疹诊震振镇',
    '阵蒸挣睁征狰争怔整拯正政帧症郑证芝枝支吱蜘知肢脂汁之织职直植殖执值侄址指止趾只旨',
    '纸志挚掷至致置帜峙制智秩稚质炙痔滞治窒中盅忠钟衷终种肿重仲众舟周州洲诌粥轴肘帚咒',
    '皱宙昼骤珠株蛛朱猪诸诛逐竹烛煮拄瞩嘱主著柱助蛀贮铸筑住注祝驻抓爪拽专砖转撰赚篆桩',
    '庄装妆撞壮状椎锥追赘坠缀谆准捉拙卓桌琢茁酌啄着灼浊兹咨资姿滋淄孜紫仔籽滓子自渍字',
    '鬃棕踪宗综总纵邹走奏揍租足卒族祖诅阻组钻纂嘴醉最罪尊遵昨左佐柞做作坐座亍丌兀丐廿',
    '卅丕亘丞鬲孬噩丨禺丿匕乇夭爻卮氐囟胤馗毓睾鼗丶亟鼐乜乩亓芈孛啬嘏仄厍厝厣厥厮靥赝',
    '匚叵匦匮匾赜卦卣刂刈刎刭刳刿剀剌剞剡剜蒯剽劂劁劐劓冂罔亻仃仉仂仨仡仫仞伛仳伢佤仵',
    '伥伧伉伫佞佧攸佚佝佟佗伲伽佶佴侑侉侃侏佾佻侪佼侬侔俦俨俪俅俚俣俜俑俟俸倩偌俳倬倏',
    '倮倭俾倜倌倥倨偾偃偕偈偎偬偻傥傧傩傺僖儆僭僬僦僮儇儋仝氽佘佥俎龠汆籴兮巽黉馘冁夔',
    '勹匍訇匐凫夙兕亠兖亳衮袤亵脔裒禀嬴蠃羸冫冱冽冼凇冖冢冥讠讦讧讪讴讵讷诂诃诋诏诎诒',
    '诓诔诖诘诙诜诟诠诤诨诩诮诰诳诶诹诼诿谀谂谄谇谌谏谑谒谔谕谖谙谛谘谝谟谠谡谥谧谪谫',
    '谮谯谲谳谵谶卩卺阝阢阡阱阪阽阼陂陉陔陟陧陬陲陴隈隍隗隰邗邛邝邙邬邡邴邳邶邺邸邰郏',
    '郅邾郐郄郇郓郦郢郜郗郛郫郯郾鄄鄢鄞鄣鄱鄯鄹酃酆刍奂劢劬劭劾哿勐勖勰叟燮矍廴凵凼鬯',
    '厶弁畚巯坌垩垡塾墼壅壑圩圬圪圳圹圮圯坜圻坂坩垅坫垆坼坻坨坭坶坳垭垤垌垲埏垧垴垓垠',
    '埕埘埚埙埒垸埴埯埸埤埝堋堍埽埭堀堞堙塄堠塥塬墁墉墚墀馨鼙懿艹艽艿芏芊芨芄芎芑芗芙',
    '芫芸芾芰苈苊苣芘芷芮苋苌苁芩芴芡芪芟苄苎芤苡茉苷苤茏茇苜苴苒苘茌苻苓茑茚茆茔茕苠',
    '苕茜荑荛荜茈莒茼茴茱莛荞茯荏荇荃荟荀茗荠茭茺茳荦荥荨茛荩荬荪荭荮莰荸莳莴莠莪莓莜',
    '莅荼莶莩荽莸荻莘莞莨莺莼菁萁菥菘堇萘萋菝菽菖萜萸萑萆菔菟萏萃菸菹菪菅菀萦菰菡葜葑',
    '葚葙葳蒇蒈葺蒉葸萼葆葩葶蒌蒎萱葭蓁蓍蓐蓦蒽蓓蓊蒿蒺蓠蒡蒹蒴蒗蓥蓣蔌甍蔸蓰蔹蔟蔺蕖',
    '蔻蓿蓼蕙蕈蕨蕤蕞蕺瞢蕃蕲蕻薤薨薇薏蕹薮薜薅薹薷薰藓藁藜藿蘧蘅蘩蘖蘼廾弈夼奁耷奕奚',
    '奘匏尢尥尬尴扌扪抟抻拊拚拗拮挢拶挹捋捃掭揶捱捺掎掴捭掬掊捩掮掼揲揸揠揿揄揞揎摒揆',
    '掾摅摁搋搛搠搌搦搡摞撄摭撖摺撷撸撙撺擀擐擗擤擢攉攥攮弋忒甙弑卟叱叽叩叨叻吒吖吆呋',
    '呒呓呔呖呃吡呗呙吣吲咂咔呷呱呤咚咛咄呶呦咝哐咭哂咴哒咧咦哓哔呲咣哕咻咿哌哙哚哜咩',
    '咪咤哝哏哞唛哧唠哽唔哳唢唣唏唑唧唪啧喏喵啉啭啁啕唿啐唼唷啖啵啶啷唳唰啜喋嗒喃喱喹',
    '喈喁喟啾嗖喑啻嗟喽喾喔喙嗪嗷嗉嘟嗑嗫嗬嗔嗦嗝嗄嗯嗥嗲嗳嗌嗍嗨嗵嗤辔嘞嘈嘌嘁嘤嘣嗾',
    '嘀嘧嘭噘嘹噗嘬噍噢噙噜噌噔嚆噤噱噫噻噼嚅嚓嚯囔囗囝囡囵囫囹囿圄圊圉圜帏帙帔帑帱帻',
    '帼帷幄幔幛幞幡岌屺岍岐岖岈岘岙岑岚岜岵岢岽岬岫岱岣峁岷峄峒峤峋峥崂崃崧崦崮崤崞崆',
    '崛嵘崾崴崽嵬嵛嵯嵝嵫嵋嵊嵩嵴嶂嶙嶝豳嶷巅彳彷徂徇徉後徕徙徜徨徭徵徼衢彡犭犰犴犷犸',
    '狃狁狎狍狒狨狯狩狲狴狷猁狳猃狺狻猗猓猡猊猞猝猕猢猹猥猬猸猱獐獍獗獠獬獯獾舛夥飧夤',
    '夂饣饧饨饩饪饫饬饴饷饽馀馄馇馊馍馐馑馓馔馕庀庑庋庖庥庠庹庵庾庳赓廒廑廛廨廪膺忄忉',
    '忖忏怃忮怄忡忤忾怅怆忪忭忸怙怵怦怛怏怍怩怫怊怿怡恸恹恻恺恂恪恽悖悚悭悝悃悒悌悛惬',
    '悻悱惝惘惆惚悴愠愦愕愣惴愀愎愫慊慵憬憔憧憷懔懵忝隳闩闫闱闳闵闶闼闾阃阄阆阈阊阋阌',
    '阍阏阒阕阖阗阙阚丬爿戕氵汔汜汊沣沅沐沔沌汨汩汴汶沆沩泐泔沭泷泸泱泗沲泠泖泺泫泮沱',
    '泓泯泾洹洧洌浃浈洇洄洙洎洫浍洮洵洚浏浒浔洳涑浯涞涠浞涓涔浜浠浼浣渚淇淅淞渎涿淠渑',
    '淦淝淙渖涫渌涮渫湮湎湫溲湟溆湓湔渲渥湄滟溱溘滠漭滢溥溧溽溻溷滗溴滏溏滂溟潢潆潇漤',
    '漕滹漯漶潋潴漪漉漩澉澍澌潸潲潼潺濑濉澧澹澶濂濡濮濞濠濯瀚瀣瀛瀹瀵灏灞宀宄宕宓宥宸',
    '甯骞搴寤寮褰寰蹇謇辶迓迕迥迮迤迩迦迳迨逅逄逋逦逑逍逖逡逵逶逭逯遄遑遒遐遨遘遢遛暹',
    '遴遽邂邈邃邋彐彗彖彘尻咫屐屙孱屣屦羼弪弩弭艴弼鬻屮妁妃妍妩妪妣妗姊妫妞妤姒妲妯姗',
    '妾娅娆姝娈姣姘姹娌娉娲娴娑娣娓婀婧婊婕娼婢婵胬媪媛婷婺媾嫫媲嫒嫔媸嫠嫣嫱嫖嫦嫘嫜',
    '嬉嬗嬖嬲嬷孀尕尜孚孥孳孑孓孢驵驷驸驺驿驽骀骁骅骈骊骐骒骓骖骘骛骜骝骟骠骢骣骥骧纟',
    '纡纣纥纨纩纭纰纾绀绁绂绉绋绌绐绔绗绛绠绡绨绫绮绯绱绲缍绶绺绻绾缁缂缃缇缈缋缌缏缑',
    '缒缗缙缜缛缟缡缢缣缤缥缦缧缪缫缬缭缯缰缱缲缳缵幺畿巛甾邕玎玑玮玢玟珏珂珑玷玳珀珉',
    '珈珥珙顼琊珩珧珞玺珲琏琪瑛琦琥琨琰琮琬琛琚瑁瑜瑗瑕瑙瑷瑭瑾璜璎璀璁璇璋璞璨璩璐璧',
    '瓒璺韪韫韬杌杓杞杈杩枥枇杪杳枘枧杵枨枞枭枋杷杼柰栉柘栊柩枰栌柙枵柚枳柝栀柃枸柢栎',
    '柁柽栲栳桠桡桎桢桄桤梃栝桕桦桁桧桀栾桊桉栩梵梏桴桷梓桫棂楮棼椟椠棹椤棰椋椁楗棣椐',
    '楱椹楠楂楝榄楫榀榘楸椴槌榇榈槎榉楦楣楹榛榧榻榫榭槔榱槁槊槟榕槠榍槿樯槭樗樘橥槲橄',
    '樾檠橐橛樵檎橹樽樨橘橼檑檐檩檗檫猷獒殁殂殇殄殒殓殍殚殛殡殪轫轭轱轲轳轵轶轸轷轹轺',
    '轼轾辁辂辄辇辋辍辎辏辘辚軎戋戗戛戟戢戡戥戤戬臧瓯瓴瓿甏甑甓攴旮旯旰昊昙杲昃昕昀炅',
    '曷昝昴昱昶昵耆晟晔晁晏晖晡晗晷暄暌暧暝暾曛曜曦曩贲贳贶贻贽赀赅赆赈赉赇赍赕赙觇觊',
    '觋觌觎觏觐觑牮犟牝牦牯牾牿犄犋犍犏犒挈挲掰搿擘耄毪毳毽毵毹氅氇氆氍氕氘氙氚氡氩氤',
    '氪氲攵敕敫牍牒牖爰虢刖肟肜肓肼朊肽肱肫肭肴肷胧胨胩胪胛胂胄胙胍胗朐胝胫胱胴胭脍脎',
    '胲胼朕脒豚脶脞脬脘脲腈腌腓腴腙腚腱腠腩腼腽腭腧塍媵膈膂膑滕膣膪臌朦臊膻臁膦欤欷欹',
    '歃歆歙飑飒飓飕飙飚殳彀毂觳斐齑斓於旆旄旃旌旎旒旖炀炜炖炝炻烀炷炫炱烨烊焐焓焖焯焱',
    '煳煜煨煅煲煊煸煺熘熳熵熨熠燠燔燧燹爝爨灬焘煦熹戾戽扃扈扉礻祀祆祉祛祜祓祚祢祗祠祯',
    '祧祺禅禊禚禧禳忑忐怼恝恚恧恁恙恣悫愆愍慝憩憝懋懑戆肀聿沓泶淼矶矸砀砉砗砘砑斫砭砜',
    '砝砹砺砻砟砼砥砬砣砩硎硭硖硗砦硐硇硌硪碛碓碚碇碜碡碣碲碹碥磔磙磉磬磲礅磴礓礤礞礴',
    '龛黹黻黼盱眄眍盹眇眈眚眢眙眭眦眵眸睐睑睇睃睚睨睢睥睿瞍睽瞀瞌瞑瞟瞠瞰瞵瞽町畀畎畋',
    '畈畛畲畹疃罘罡罟詈罨罴罱罹羁罾盍盥蠲钅钆钇钋钊钌钍钏钐钔钗钕钚钛钜钣钤钫钪钭钬钯',
    '钰钲钴钶钷钸钹钺钼钽钿铄铈铉铊铋铌铍铎铐铑铒铕铖铗铙铘铛铞铟铠铢铤铥铧铨铪铩铫铮',
    '铯铳铴铵铷铹铼铽铿锃锂锆锇锉锊锍锎锏锒锓锔锕锖锘锛锝锞锟锢锪锫锩锬锱锲锴锶锷锸锼',
    '锾锿镂锵镄镅镆镉镌镎镏镒镓镔镖镗镘镙镛镞镟镝镡镢镤镥镦镧镨镩镪镫镬镯镱镲镳锺矧矬',
    '雉秕秭秣秫稆嵇稃稂稞稔稹稷穑黏馥穰皈皎皓皙皤瓞瓠甬鸠鸢鸨鸩鸪鸫鸬鸲鸱鸶鸸鸷鸹鸺鸾',
    '鹁鹂鹄鹆鹇鹈鹉鹋鹌鹎鹑鹕鹗鹚鹛鹜鹞鹣鹦鹧鹨鹩鹪鹫鹬鹱鹭鹳疒疔疖疠疝疬疣疳疴疸痄疱',
    '疰痃痂痖痍痣痨痦痤痫痧瘃痱痼痿瘐瘀瘅瘌瘗瘊瘥瘘瘕瘙瘛瘼瘢瘠癀瘭瘰瘿瘵癃瘾瘳癍癞癔',
    '癜癖癫癯翊竦穸穹窀窆窈窕窦窠窬窨窭窳衤衩衲衽衿袂袢裆袷袼裉裢裎裣裥裱褚裼裨裾裰褡',
    '褙褓褛褊褴褫褶襁襦襻疋胥皲皴矜耒耔耖耜耠耢耥耦耧耩耨耱耋耵聃聆聍聒聩聱覃顸颀颃颉',
    '颌颍颏颔颚颛颞颟颡颢颥颦虍虔虬虮虿虺虼虻蚨蚍蚋蚬蚝蚧蚣蚪蚓蚩蚶蛄蚵蛎蚰蚺蚱蚯蛉蛏',
    '蚴蛩蛱蛲蛭蛳蛐蜓蛞蛴蛟蛘蛑蜃蜇蛸蜈蜊蜍蜉蜣蜻蜞蜥蜮蜚蜾蝈蜴蜱蜩蜷蜿螂蜢蝽蝾蝻蝠蝰',
    '蝌蝮螋蝓蝣蝼蝤蝙蝥螓螯螨蟒蟆螈螅螭螗螃螫蟥螬螵螳蟋蟓螽蟑蟀蟊蟛蟪蟠蟮蠖蠓蟾蠊蠛蠡',
    '蠹蠼缶罂罄罅舐竺竽笈笃笄笕笊笫笏筇笸笪笙笮笱笠笥笤笳笾笞筘筚筅筵筌筝筠筮筻筢筲筱',
    '箐箦箧箸箬箝箨箅箪箜箢箫箴篑篁篌篝篚篥篦篪簌篾篼簏簖簋簟簪簦簸籁籀臾舁舂舄臬衄舡',
    '舢舣舭舯舨舫舸舻舳舴舾艄艉艋艏艚艟艨衾袅袈裘裟襞羝羟羧羯羰羲籼敉粑粝粜粞粢粲粼粽',
    '糁糇糌糍糈糅糗糨艮暨羿翎翕翥翡翦翩翮翳糸絷綦綮繇纛麸麴赳趄趔趑趱赧赭豇豉酊酐酎酏',
    '酤酢酡酰酩酯酽酾酲酴酹醌醅醐醍醑醢醣醪醭醮醯醵醴醺豕鹾趸跫踅蹙蹩趵趿趼趺跄跖跗跚',
    '跞跎跏跛跆跬跷跸跣跹跻跤踉跽踔踝踟踬踮踣踯踺蹀踹踵踽踱蹉蹁蹂蹑蹒蹊蹰蹶蹼蹯蹴躅躏',
    '躔躐躜躞豸貂貊貅貘貔斛觖觞觚觜觥觫觯訾謦靓雩雳雯霆霁霈霏霎霪霭霰霾龀龃龅龆龇龈龉',
    '龊龌黾鼋鼍隹隼隽雎雒瞿雠銎銮鋈錾鍪鏊鎏鐾鑫鱿鲂鲅鲆鲇鲈稣鲋鲎鲐鲑鲒鲔鲕鲚鲛鲞鲟鲠',
    '鲡鲢鲣鲥鲦鲧鲨鲩鲫鲭鲮鲰鲱鲲鲳鲴鲵鲶鲷鲺鲻鲼鲽鳄鳅鳆鳇鳊鳋鳌鳍鳎鳏鳐鳓鳔鳕鳗鳘鳙',
    '鳜鳝鳟鳢靼鞅鞑鞒鞔鞯鞫鞣鞲鞴骱骰骷鹘骶骺骼髁髀髅髂髋髌髑魅魃魇魉魈魍魑飨餍餮饕饔',
    '髟髡髦髯髫髻髭髹鬈鬏鬓鬟鬣麽麾縻麂麇麈麋麒鏖麝麟黛黜黝黠黟黢黩黧黥黪黯鼢鼬鼯鼹鼷',
    '鼽鼾齄',
  ].join('');

  let SECRET_FONT_SRC;          // undefined=还没找过，null=没找到
  let SECRET_FONT_MAP = null;   // 运行时反查出的对照表
  let SECRET_FONT_CPS = null;   // 运行时字体用到的加密码位（Set），换字体也能认出未解密字
  let SECRET_FONT_TRIED = false;
  let SECRET_FONT_INFO = '';
  let SECRET_POOL_VEC = null;   // 候选字池的像素特征缓存
  // 站点字体是「思源黑体 Source Han Sans CN」的子集；本机若有 Noto Sans SC（同源字体）
  // 就几乎能逐字精确对上，没有时浏览器会自动退到微软雅黑等，准确率略低。
  const SECRET_REF_STACK = '"Noto Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", "Source Han Sans CN", "Microsoft YaHei UI", "Microsoft YaHei", "DengXian", "SimSun"';

  // 收集本页（含同源 iframe）里所有带 data: URI 的 @font-face
  function secretFontFaces() {
    const out = [];
    let docs = [];
    try { docs = [document].concat(docsFrom(document, 4) || []); } catch (e) { docs = [document]; }
    for (let i = 0; i < docs.length; i++) {
      let sheets = null;
      try { sheets = docs[i].styleSheets; } catch (e) { sheets = null; }
      if (!sheets) continue;
      for (let j = 0; j < sheets.length; j++) {
        let rules = null;
        try { rules = sheets[j].cssRules; } catch (e) { rules = null; }
        if (!rules) continue;
        for (let k = 0; k < rules.length; k++) {
          const r = rules[k];
          const st = r && r.style;
          if (!st) continue;
          const src = st.getPropertyValue('src') || '';
          if (!src || src.indexOf('data:') < 0) continue;
          const fam = String(st.fontFamily || '').replace(/["']/g, '').trim();
          out.push({ family: fam, src: src });
        }
      }
    }
    return out;
  }

  function secretFontSrc() {
    if (SECRET_FONT_SRC !== undefined) return SECRET_FONT_SRC;
    SECRET_FONT_SRC = null;
    const faces = secretFontFaces();
    if (!faces.length) return null;
    let pick = faces.find((f) => /cxsecret/i.test(f.family)) || null;
    if (!pick) {
      let used = '';
      try {
        const roots = questionRoots(document);
        try {
          const extra = docsFrom(document, 3) || [];
          for (let e = 0; e < extra.length; e++) questionRoots(extra[e]).forEach((r) => roots.push(r));
        } catch (e2) {}
        for (let i = 0; i < roots.length && !used; i++) {
          const el = $('.fontLabel, .clearfix, p', roots[i]) || roots[i];
          used = String((el.ownerDocument.defaultView || window).getComputedStyle(el).fontFamily || '');
        }
      } catch (e) { used = ''; }
      if (used) pick = faces.find((f) => used.indexOf(f.family) >= 0) || null;
    }
    if (!pick) pick = faces[0];
    SECRET_FONT_SRC = pick.src;
    return SECRET_FONT_SRC;
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // 解析 TTF 的 cmap（format 4 / 6 / 12），返回 [码位, gid] 数组
  function ttfCmapPairs(bytes) {
    const u16 = (o) => (bytes[o] << 8) | bytes[o + 1];
    const u32 = (o) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
    if (!bytes || bytes.length < 12) return null;
    const nTables = u16(4);
    const tables = Object.create(null);
    for (let i = 0; i < nTables; i++) {
      const rec = 12 + i * 16;
      if (rec + 16 > bytes.length) break;
      const tag = String.fromCharCode(bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]);
      tables[tag] = { off: u32(rec + 8), len: u32(rec + 12) };
    }
    if (!tables.cmap) return null;
    const cm = tables.cmap.off;
    const nSub = u16(cm + 2);
    const pairs = [];
    for (let i = 0; i < nSub; i++) {
      const sub = cm + u32(cm + 4 + i * 8 + 4);
      if (sub + 4 > bytes.length) continue;
      const fmt = u16(sub);
      if (fmt === 4) {
        const segX2 = u16(sub + 6);
        const segCount = segX2 / 2;
        const endO = sub + 14;
        const startO = endO + segX2 + 2;
        const deltaO = startO + segX2;
        const rangeO = deltaO + segX2;
        for (let sgi = 0; sgi < segCount; sgi++) {
          const end = u16(endO + sgi * 2);
          const start = u16(startO + sgi * 2);
          let delta = u16(deltaO + sgi * 2);
          if (delta >= 32768) delta -= 65536;
          const ro = u16(rangeO + sgi * 2);
          for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
            let gid;
            if (ro === 0) gid = (cp + delta) & 0xffff;
            else {
              const g = u16(rangeO + sgi * 2 + ro + (cp - start) * 2);
              gid = g === 0 ? 0 : (g + delta) & 0xffff;
            }
            if (gid) pairs.push([cp, gid]);
          }
        }
      } else if (fmt === 6) {
        const first = u16(sub + 6);
        const count = u16(sub + 8);
        for (let k = 0; k < count; k++) {
          const gid = u16(sub + 10 + k * 2);
          if (gid) pairs.push([first + k, gid]);
        }
      } else if (fmt === 12) {
        const nGroups = u32(sub + 12);
        for (let gi = 0; gi < nGroups; gi++) {
          const o = sub + 16 + gi * 12;
          const sc = u32(o);
          const ec = u32(o + 4);
          const sg = u32(o + 8);
          for (let cp = sc; cp <= ec; cp++) pairs.push([cp, sg + (cp - sc)]);
        }
      }
    }
    return pairs;
  }

  // 取字体字节：支持 data URI 与同源 URL 两种写法
  async function secretFontBytes(src) {
    const b64 = /base64,([A-Za-z0-9+/=]+)/.exec(src);
    if (b64) return b64ToBytes(b64[1]);
    const m = /url\(["']?([^"')]+)["']?\)/.exec(src);
    if (!m) return null;
    const res = await fetch(m[1]);
    if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
    return new Uint8Array(await res.arrayBuffer());
  }

  // 把字体 src 挂进 document.fonts，返回加载用的 family 名
  async function secretFaceLoad(prefix) {
    const win = window;
    if (!SECRET_FONT_SRC || !win.FontFace) return null;
    const fam = prefix + Math.floor(Math.random() * 1e6);
    try {
      const ff = new win.FontFace(fam, SECRET_FONT_SRC);
      win.document.fonts.add(ff);
      await ff.load();
      return fam;
    } catch (e) { return null; }
  }

  // 单字像素特征：ink-bbox 归一 + splat 累加（复用同一个 canvas）
  const SECRET_CVS = { ctx: null, S: 128, G: 20 };
  function secretCtx() {
    if (SECRET_CVS.ctx) return SECRET_CVS.ctx;
    const cv = window.document.createElement('canvas');
    cv.width = SECRET_CVS.S;
    cv.height = SECRET_CVS.S;
    SECRET_CVS.ctx = cv.getContext('2d', { willReadFrequently: true });
    return SECRET_CVS.ctx;
  }
  function secretFeat(ctx, ch, fontExpr) {
    const S = SECRET_CVS.S;
    const G = SECRET_CVS.G;
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#000';
    ctx.font = '104px ' + (fontExpr ? fontExpr + ', ' : '') + 'sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(ch, 10, 104);
    const d = ctx.getImageData(0, 0, S, S).data;
    let minX = S, minY = S, maxX = -1, maxY = -1;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (d[(y * S + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const v = new Float32Array(G * G);
    if (maxX < 0) return { v: v, n: 1 };
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    const sc = (G - 1) / Math.max(w, h);
    const ox = (G - w * sc) / 2;
    const oy = (G - h * sc) / 2;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const a = d[(y * S + x) * 4 + 3];
        if (!a) continue;
        let gx = Math.floor((x - minX + 0.5) * sc + ox);
        let gy = Math.floor((y - minY + 0.5) * sc + oy);
        if (gx < 0) gx = 0; else if (gx >= G) gx = G - 1;
        if (gy < 0) gy = 0; else if (gy >= G) gy = G - 1;
        v[gy * G + gx] += a / 255;
      }
    }
    let sq = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i] > 1) v[i] = 1;
      sq += v[i] * v[i];
    }
    return { v: v, n: Math.sqrt(sq) || 1 };
  }

  // 像素抽检：加密字（站点字体）vs 明文（系统字体）应相似；返回通过数（0=不通过）
  async function validateSecretMap(map) {
    const fam = await secretFaceLoad('cxhSecretVerify');
    if (!fam) return 0;
    const ctx = secretCtx();
    if (!ctx) return 0;
    const keys = Object.keys(map);
    const step = keys.length > 60 ? 3 : 1;   // 大字体抽样，控制耗时
    let samples = 0;
    let pass = 0;
    for (let i = 0; i < keys.length; i += step) {
      const cipher = keys[i];
      const plain = map[cipher];
      const q = secretFeat(ctx, cipher, '"' + fam + '"');
      const r = secretFeat(ctx, plain, SECRET_REF_STACK);
      if (!q.n || !r.n) { samples++; continue; }
      let dot = 0;
      for (let k2 = 0; k2 < q.v.length; k2++) dot += q.v[k2] * r.v[k2];
      const c = dot / (q.n * r.n);
      samples++;
      if (c >= 0.5) pass++;
    }
    return samples && pass >= Math.ceil(samples * 0.85) ? pass : 0;
  }

  // 候选池像素特征（多系统字体取最大相似度），只算一次
  async function secretPoolVecs() {
    if (SECRET_POOL_VEC) return SECRET_POOL_VEC;
    const ctx = secretCtx();
    if (!ctx) return null;
    const out = [];
    for (let i = 0; i < SECRET_POOL.length; i++) out.push(secretFeat(ctx, SECRET_POOL.charAt(i), SECRET_REF_STACK));
    SECRET_POOL_VEC = out;
    return out;
  }

  // 未知字体版本：像素相似度 + 「明文 unicode 递增」单调 DP，现场反查。
  // 只采用“逐字有把握”的结果：拿不准的字保持原样，和其余题目一起交给模型。
  async function genericSecretMap(cipher) {
    const fam = await secretFaceLoad('cxhSecretGeneric');
    if (!fam) return null;
    const ctx = secretCtx();
    const pool = await secretPoolVecs();
    if (!ctx || !pool) return null;
    const n = cipher.length;
    const m = pool.length;
    const cipherVec = [];
    for (let i0 = 0; i0 < n; i0++) cipherVec.push(secretFeat(ctx, cipher.charAt(i0), '"' + fam + '"'));
    const total = n * m;
    const score = new Float32Array(total);
    for (let i1 = 0; i1 < n; i1++) {
      const A = cipherVec[i1].v;
      const an = cipherVec[i1].n;
      for (let jj = 0; jj < m; jj++) {
        const B = pool[jj].v;
        const bn = pool[jj].n;
        let dot = 0;
        for (let k2 = 0; k2 < A.length; k2++) dot += A[k2] * B[k2];
        score[i1 * m + jj] = an && bn ? dot / (an * bn) : 0;
      }
    }
    // 逐字取最优 + 记录“是否够自信”（分数高、且明显领先第二名）
    const bestIdx = new Int32Array(n);
    const bestVal = new Float32Array(n);
    const secondVal = new Float32Array(n);
    let sumAll = 0;
    for (let i2 = 0; i2 < n; i2++) {
      let b1 = -2, b2 = -2, bi = 0;
      for (let jj = 0; jj < m; jj++) {
        const v = score[i2 * m + jj];
        if (v > b1) { b2 = b1; b1 = v; bi = jj; }
        else if (v > b2) b2 = v;
      }
      bestIdx[i2] = bi;
      bestVal[i2] = b1;
      secondVal[i2] = b2;
      sumAll += b1;
    }
    const mean1 = sumAll / n;
    // 第一轮：逐字闸门（拿不准的先空着，保持原样）
    const GATE = 0.86;
    const GAP = 0.015;
    const map = Object.create(null);
    const weak = [];
    let strong = 0;
    for (let i3 = 0; i3 < n; i3++) {
      const ch = cipher.charAt(i3);
      if (bestVal[i3] >= GATE && bestVal[i3] - secondVal[i3] >= GAP) {
        map[ch] = SECRET_POOL.charAt(bestIdx[i3]);
        strong++;
      } else weak.push(ch);
    }
    if (strong >= n * 0.9) return { map: map, mean: mean1, confident: strong, n: n, mode: 'top1', weak: weak };
    // 第二轮：在「明文 unicode 递增」约束下做单调 DP，再按逐字门限收一部分
    const NEG = -1e9;
    const dp = new Float32Array(total);
    const back = new Int16Array(total);
    for (let jj2 = 0; jj2 < m; jj2++) { dp[jj2] = score[jj2]; back[jj2] = -1; }
    for (let i4 = 1; i4 < n; i4++) {
      let best = NEG;
      let bestK = -1;
      for (let jj3 = 0; jj3 < m; jj3++) {
        if (jj3 > 0) {
          const cand = dp[(i4 - 1) * m + (jj3 - 1)];
          if (cand > best) { best = cand; bestK = jj3 - 1; }
        }
        if (bestK < 0) { dp[i4 * m + jj3] = NEG; back[i4 * m + jj3] = -1; }
        else { dp[i4 * m + jj3] = score[i4 * m + jj3] + best; back[i4 * m + jj3] = bestK; }
      }
    }
    let endJ = -1;
    let endV = NEG;
    for (let jj4 = 0; jj4 < m; jj4++) {
      const v = dp[(n - 1) * m + jj4];
      if (v > endV) { endV = v; endJ = jj4; }
    }
    if (endJ < 0) return Object.keys(map).length ? { map: map, mean: mean1, confident: strong, n: n, mode: 'top1', weak: weak } : null;
    const idx = new Array(n);
    let jj5 = endJ;
    for (let i5 = n - 1; i5 >= 0; i5--) {
      idx[i5] = jj5;
      const prev = back[i5 * m + jj5];
      if (prev < 0 && i5 > 0) return Object.keys(map).length ? { map: map, mean: mean1, confident: strong, n: n, mode: 'top1', weak: weak } : null;
      jj5 = prev;
    }
    const map2 = Object.create(null);
    const weak2 = [];
    let sum = 0;
    let confident = 0;
    for (let i6 = 0; i6 < n; i6++) {
      const ch2 = cipher.charAt(i6);
      const sc = score[i6 * m + idx[i6]];
      sum += sc;
      if (sc >= 0.78) { map2[ch2] = SECRET_POOL.charAt(idx[i6]); confident++; }
      else weak2.push(ch2);
    }
    if (!confident) return Object.keys(map).length ? { map: map, mean: mean1, confident: strong, n: n, mode: 'top1', weak: weak } : null;
    return { map: map2, mean: sum / n, confident: confident, n: n, mode: 'dp', weak: weak2 };
  }

  async function ensureSecretFontMap() {
    if (SECRET_FONT_TRIED) return SECRET_FONT_MAP;
    SECRET_FONT_TRIED = true;
    try {
      const src = secretFontSrc();
      if (!src) { SECRET_FONT_INFO = '未找到站点字体'; return null; }
      const bytes = await secretFontBytes(src);
      const pairs = bytes && ttfCmapPairs(bytes);
      if (!pairs || !pairs.length) { SECRET_FONT_INFO = '字体解析失败'; return null; }
      // 无论映射能否建立，先记住这份字体用到的码位，后续“未解密字”体检才认得出来
      SECRET_FONT_CPS = new Set();
      for (let i = 0; i < pairs.length; i++) SECRET_FONT_CPS.add(pairs[i][0]);
      pairs.sort((a, b) => a[1] - b[1]);
      let cipher = '';
      for (let i = 0; i < pairs.length; i++) cipher += String.fromCharCode(pairs[i][0]);

      const inv = SECRET_INV[pairs.length];
      if (inv && inv.length === pairs.length) {
        const map = Object.create(null);
        for (let i = 0; i < pairs.length; i++) map[cipher.charAt(i)] = inv.charAt(i);
        const ok = await validateSecretMap(map);
        if (ok) {
          SECRET_FONT_MAP = map;
          SECRET_FONT_INFO = '内置字形清单（' + pairs.length + ' 字，抽检 ' + ok + ' 通过）';
          return map;
        }
        SECRET_FONT_INFO = '内置清单抽检未通过';
      } else {
        SECRET_FONT_INFO = '字体含 ' + pairs.length + ' 字（内置清单：' + Object.keys(SECRET_INV).join('/') + '）';
      }
      // 没收录的版本：现场像素反查（可能耗时几秒）
      log('题目字体是本脚本没收录的版本，正在现场反查字形（首次约几秒）…');
      const g = await genericSecretMap(cipher);
      const got = g ? Object.keys(g.map).length : 0;
      if (got) {
        SECRET_FONT_MAP = g.map;
        SECRET_FONT_INFO = '像素反查/' + (g.mode === 'top1' ? '逐字' : '单调对齐') + '（' + got + '/' + g.n + ' 字解出，其余保持原样，平均相似度 ' + g.mean.toFixed(2) + '）';
        return g.map;
      }
      SECRET_FONT_INFO += '，像素反查没解出字';
      return null;
    } catch (e) {
      SECRET_FONT_INFO = '字体方案异常：' + ((e && e.message) || e);
      return null;
    }
  }

  function questionRoots(doc) {
    const all = $$('.TiMu,.questionLi,.question-item,.Py-mian1,.CeYan .TiMu', doc).filter(looseVisible);
    const inner = all.filter((r) => !all.some((o) => o !== r && r.contains(o)));
    const out = [];
    inner.forEach((r) => {
      if (!out.some((x) => x === r || x.contains(r) || r.contains(x))) out.push(r);
    });
    return out;
  }

  function pickStem(root) {
    const sels = ['.Zy_TItle .fontLabel', '.Zy_TItle', '.mark_name', '.question-title', '.stem', '.Py-m1-title', '[class*="stem"]', '[class*="title"]'];
    for (let i = 0; i < sels.length; i++) {
      const el = $$(sels[i], root).find((e) => looseVisible(e) && text(e).length > 0);
      if (el) {
        let s = text(el);
        s = s.replace(/^[（(【\[]?\s*(单选题|多选题|判断题|填空题|简答题|论述题|名词解释|计算题|分析题|材料题)\s*[）)】\]]?\s*/i, '');
        s = s.replace(/^\d+[、.．]\s*/, '');
        if (s.length >= 2) return s;
      }
    }
    let s = text(root);
    return truncate(s, 500);
  }

  function questionType(root, stem) {
    const qtype = attr(root, 'qtype') || attr($('[qtype]', root), 'qtype');
    const tn = attr(root, 'typename') || attr($('[typename]', root), 'typename');
    const s = stem || '';
    const blob = s + ' ' + truncate(text(root), 200) + ' ' + tn;
    if (qtype === '1' || /多选/.test(blob) || $$('input[type="checkbox"]', root).length > 0) return 'multi';
    if (qtype === '3' || /判断/.test(blob) || /^(判断题)$/.test(tn)) return 'judge';
    if (qtype === '2' || /填空/.test(blob)) return 'fill';
    if (qtype === '4' || qtype === '5' || qtype === '6' || /简答|论述|名词解释|计算题|分析题|材料题|问答题|写作|翻译/.test(blob)) return 'essay';
    if ($$('textarea', root).length > 0) return 'essay';
    const txtInputs = $$('input[type="text"]', root).filter(looseVisible);
    if (txtInputs.length > 0) return 'fill';
    if ($$('[contenteditable="true"]', root).length > 0) return 'essay';
    return 'single';
  }

  function optionElements(root) {
    const groups = [
      '.stem_answer .answerBg',
      '.answerList .answerBg',
      'li[role="radio"]',
      'li[role="checkbox"]',
      '.Zy_ulTop > li',
      '.Zy_ulBottom > li',
      '.answerList.singleChoice li',
      '.answerList.multiChoice li',
      '.answerList li',
      '[class*="option"] li',
      'label'
    ];
    for (let i = 0; i < groups.length; i++) {
      let list = $$(groups[i], root).filter(looseVisible);
      list = list.filter((el) => {
        if (el.closest('.Zy_TItle,.question-title,.stem')) return false;
        if (el.querySelector('textarea')) return false;
        if (el.matches('label') && !el.querySelector('input[type="radio"],input[type="checkbox"]')) return false;
        return true;
      });
      if (list.length >= 2) return list;
    }
    const inputs = $$('input[type="radio"],input[type="checkbox"]', root).filter(looseVisible);
    if (inputs.length >= 2) {
      return inputs.map((inp) => {
        const lab = inp.closest('label') || (inp.parentElement && inp.parentElement.tagName === 'LABEL' ? inp.parentElement : null);
        return lab || inp.parentElement || inp;
      });
    }
    return [];
  }

  function optionLabel(el, idx) {
    const numEl = $('.num_option,.num_option_dx,.num_option_xz,.option-label', el);
    let raw = numEl ? text(numEl) : '';
    let m = raw.match(/^([A-Za-z])\s*[.、．:：)）]?/);
    if (m) return m[1].toUpperCase();
    raw = text(el).match(/^([A-Za-z])\s*[.、．:：)）]/);
    if (raw) return raw[1].toUpperCase();
    return String.fromCharCode(65 + idx);
  }

  function optionText(el) {
    try {
      const clone = el.cloneNode(true);
      $$('.num_option,.num_option_dx,.num_option_xz,.option-label,input', clone).forEach((x) => {
        try { x.parentNode.removeChild(x); } catch (e) {}
      });
      let t = text(clone);
      t = t.replace(/^[A-Za-z]\s*[.、．:：)）]\s*/, '');
      return t.trim();
    } catch (e) { return text(el); }
  }

  function parseQuestion(root, idx) {
    const stem = decodeSecret(pickStem(root));
    const type = questionType(root, stem);
    const els = optionElements(root);
    const seen = {};
    const options = [];
    els.forEach((el, i) => {
      const label = optionLabel(el, i);
      const t = decodeSecret(optionText(el));
      if (!t && !/^[A-Z]$/.test(label)) return;
      const dataEl = $('.num_option,.num_option_dx,.num_option_xz', el) || el;
      const data = attr(dataEl, 'data') || attr(el, 'data') || attr(el, 'data-value') || '';
      const input = el.querySelector ? el.querySelector('input[type="radio"],input[type="checkbox"]') : null;
      const key = label + '|' + t;
      if (seen[key]) return;
      seen[key] = true;
      options.push({ label: label, text: t, data: data, el: el, input: input, click: el });
    });
    if (!options.length && (type === 'single' || type === 'multi' || type === 'judge')) {
      // 兜底：整页 radio/checkbox 的 label
      $$('label', root).filter(looseVisible).forEach((lab, i) => {
        if (!lab.querySelector('input[type="radio"],input[type="checkbox"]')) return;
        const t = decodeSecret(optionText(lab));
        if (!t) return;
        options.push({
          label: optionLabel(lab, i), text: t, data: attr(lab, 'data') || '',
          el: lab, input: lab.querySelector('input'), click: lab
        });
      });
    }

    const fields = [];
    $$('textarea,input[type="text"],[contenteditable="true"]', root).forEach((f) => {
      if (!looseVisible(f)) return;
      if (f.tagName === 'INPUT' && f.closest('li,label') && options.some((o) => o.el.contains(f))) return;
      if (fields.indexOf(f) < 0) fields.push(f);
    });
    // 富文本编辑器 iframe
    $$('iframe', root).forEach((f) => {
      let d = null;
      try { d = f.contentDocument; } catch (e) {}
      if (!d) return;
      const body = d.body;
      if (body && (body.getAttribute('contenteditable') === 'true' || d.querySelector('.cke_editable,.ql-editor,[contenteditable="true"]'))) {
        fields.push(d.querySelector('.cke_editable,.ql-editor,[contenteditable="true"]') || body);
      }
    });

    let blankCount = 0;
    if (type === 'fill') {
      blankCount = fields.length;
      if (!blankCount) {
        const m = stem.match(/[_＿]{2,}|【\s*】|（\s*）/g);
        blankCount = m ? m.length : 1;
      }
    }

    return {
      no: idx + 1,
      root: root,
      type: type,
      stem: stem,
      options: options,
      fields: fields,
      blankCount: blankCount
    };
  }

  function collectQuestions(doc) {
    const roots = questionRoots(doc);
    const list = [];
    roots.forEach((r) => {
      try {
        const q = parseQuestion(r, list.length);
        if (!q.stem && !q.options.length) return;
        if (/^[\s\d.、．]*$/.test(q.stem) && q.options.length < 2) return;
        list.push(q);
      } catch (e) {}
    });
    return list;
  }

  /**
   * 找到真正长着题目的文档。
   * 新版 mooc-ans 的作业模块是“外壳 iframe(/ananas/modules/work) → 内层 iframe(/mooc-ans/api/work)”两级嵌套，
   * 外壳文档是空的，只扫外壳会得到 0 道题 → 被误判成“等待中/跳过”→ 整页被当成完成跳走。
   * 这里向下钻同源 iframe，返回题目最多的那个文档；都没有就返回原文档。
   */
  function quizDocFor(doc) {
    if (!doc) return doc;
    let best = doc;
    let bestN = 0;
    try { bestN = questionRoots(doc).length; } catch (e) { bestN = 0; }
    if (bestN) return doc;
    const queue = [{ d: doc, depth: 0 }];
    let steps = 0;
    while (queue.length && steps++ < 24) {
      const cur = queue.shift();
      if (!cur || cur.depth >= 4) continue;
      let frames = [];
      try { frames = $$('iframe', cur.d); } catch (e) { frames = []; }
      for (let i = 0; i < frames.length; i++) {
        let cd = null;
        try { cd = frames[i].contentDocument; } catch (e) { cd = null; }
        if (!cd) continue;
        let n = 0;
        try { n = questionRoots(cd).length; } catch (e) { n = 0; }
        if (n > bestN) { best = cd; bestN = n; }
        queue.push({ d: cd, depth: cur.depth + 1 });
      }
    }
    return best;
  }

  function answerValueInPage(q) {
    try {
      const inp = q.root.querySelector('input[id^="answer"]');
      if (inp && inp.value) return String(inp.value);
    } catch (e) {}
    return '';
  }

  function isOptionSelected(q, opt) {
    if (opt.input && opt.input.checked) return true;
    if (opt.el.getAttribute && opt.el.getAttribute('aria-checked') === 'true') return true;
    if (opt.el.classList && (opt.el.classList.contains('check_answer') || opt.el.classList.contains('check_answer_dx') || opt.el.classList.contains('checked') || opt.el.classList.contains('selected'))) return true;
    const vals = answerValueInPage(q);
    if (vals) {
      const parts = vals.split(/[,，、;；\s|]+/).filter(Boolean);
      if (parts.indexOf(opt.data) >= 0) return true;
      if (parts.indexOf(opt.label) >= 0) return true;
      if (parts.map((x) => x.toUpperCase()).indexOf(opt.label) >= 0) return true;
    }
    return false;
  }

  function choiceTargets(opt) {
    const el = opt.el;
    const arr = [];
    if (opt.input) arr.push(opt.input);
    try {
      const bg = el.querySelector && el.querySelector('.answerBg');
      if (bg && bg !== el) arr.push(bg);
      const ap = el.querySelector && el.querySelector('.answer_p');
      if (ap && ap !== el) arr.push(ap);
    } catch (e) {}
    if (arr.indexOf(el) < 0) arr.push(el);
    return arr;
  }

  async function setChoice(q, opt, should) {
    if (isOptionSelected(q, opt) === !!should) return true;
    const targets = choiceTargets(opt);
    for (let i = 0; i < targets.length; i++) {
      clickEl(targets[i]);
      await sleep(rand(160, 300));
      if (isOptionSelected(q, opt) === !!should) return true;
    }
    return isOptionSelected(q, opt) === !!should;
  }

  async function chooseOptions(q, labels) {
    const want = labels.map((x) => String(x).replace(/[^A-Za-z]/g, '').toUpperCase()).filter((x) => /^[A-Z]$/.test(x));
    if (!want.length) return { ok: false, reason: 'no-labels' };
    const targets = [];
    want.forEach((lb) => {
      let opt = q.options.find((o) => o.label === lb);
      if (!opt) {
        opt = q.options.find((o) => norm(o.text).indexOf(norm(lb)) >= 0 && norm(lb).length > 1);
      }
      if (opt && targets.indexOf(opt) < 0) targets.push(opt);
    });
    if (!targets.length) return { ok: false, reason: 'label-not-found' };

    if (q.type === 'multi') {
      for (let i = 0; i < q.options.length; i++) {
        const o = q.options[i];
        const should = targets.indexOf(o) >= 0;
        if (isOptionSelected(q, o) !== should) {
          await setChoice(q, o, should);
          await sleep(rand(500, 1200));
        }
      }
    } else {
      const o = targets[0];
      if (!isOptionSelected(q, o)) {
        await setChoice(q, o, true);
        await sleep(rand(350, 700));
      }
    }
    await sleep(250);
    const ok = targets.every((o) => isOptionSelected(q, o));
    return { ok: ok, selected: targets.map((o) => o.label), reason: ok ? '' : 'verify-failed' };
  }

  async function fillQuestionFields(q, values) {
    const vals = values.map((x) => String(x == null ? '' : x));
    let fields = q.fields.slice();
    if (!fields.length) {
      try {
        fields = $$('textarea,input[type="text"],[contenteditable="true"]', q.root).filter(looseVisible);
      } catch (e) { fields = []; }
    }
    if (!fields.length) return { ok: false, reason: 'no-field' };
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const v = vals[i] != null ? vals[i] : (vals[0] || '');
      if (!v) continue;
      try {
        if (f.tagName === 'INPUT' || f.tagName === 'TEXTAREA') {
          fireInput(f, v);
        } else {
          const win = f.ownerDocument.defaultView;
          f.focus();
          f.textContent = v;
          try { f.dispatchEvent(new win.InputEvent('input', { bubbles: true, data: v, inputType: 'insertText' })); }
          catch (e) { f.dispatchEvent(new win.Event('input', { bubbles: true })); }
          f.dispatchEvent(new win.Event('change', { bubbles: true }));
        }
        await sleep(rand(100, 220));
      } catch (e) {}
    }
    const got = fields.map((f) => {
      try { return String(f.value != null ? f.value : f.textContent || '').trim(); }
      catch (e) { return ''; }
    }).filter(Boolean).length;
    return { ok: got > 0, filled: got, reason: got ? '' : 'fill-failed' };
  }

  function mapJudge(choices, q) {
    const out = [];
    choices.forEach((c) => {
      const s = String(c).toUpperCase();
      if (s === '__TRUE__' || /^(正确|对|是|TRUE|√|✓)$/.test(String(c))) {
        const o = q.options.find((x) => /正确|对|是|√|✓/.test(x.text)) || q.options[0];
        if (o) out.push(o.label);
      } else if (s === '__FALSE__' || /^(错误|错|否|FALSE|×|✗)$/.test(String(c))) {
        const o = q.options.find((x) => /错误|错|否|×|✗/.test(x.text)) || q.options[1];
        if (o) out.push(o.label);
      } else {
        out.push(c);
      }
    });
    return out;
  }

  // 把模型返回的一个选项（"A"/"A."/"A. 自我认知"/"选项A"/"自我认知"）归一为页面选项字母。
  function choiceTokenToLabel(q, raw) {
    let s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    // 全角字母转半角（模型偶尔返回 Ａ/Ｂ）
    s = s.replace(/[Ａ-Ｚａ-ｚ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
    s = s.replace(/^(?:选项|答案|选择)\s*[:：]?\s*/i, '');
    // 前导字母：A、A.、A、A)；也支持 "A自我认知" 这种无分隔写法
    let m = s.match(/^[（(【\[]*\s*([A-Za-z])\s*(?:[.、．,，:：)）\]】]|\s|$)/);
    if (!m) m = s.match(/^([A-Za-z])\s*(?=[\u4e00-\u9fa5])/);
    if (m) {
      const lb = m[1].toUpperCase();
      if (q.options.some((o) => o.label === lb)) return lb;
    }
    // 去掉前导字母后按选项正文匹配
    const body = s.replace(/^[（(【\[]*\s*[A-Za-z]\s*(?:[.、．,，:：)）\]】]|\s)\s*/, '');
    const nb = norm(body || s);
    if (nb.length >= 2) {
      let hit = q.options.find((o) => norm(o.text) === nb);
      if (!hit) {
        hit = q.options.find((o) => {
          const nt = norm(o.text);
          return nt.length >= 2 && (nt.indexOf(nb) >= 0 || nb.indexOf(nt) >= 0);
        });
      }
      if (hit) return hit.label;
    }
    // 最后才把纯文本当作字母串（如 "AC"）
    if (/^[A-Za-z]$/.test(s)) {
      const lb = s.toUpperCase();
      if (q.options.some((o) => o.label === lb)) return lb;
    }
    return '';
  }

  function resolveAnswer(q, ans) {
    if (!ans) return { choices: [], blanks: [], text: '' };
    let raw = (ans.choices || []).slice();
    if (q.type === 'judge') raw = mapJudge(raw, q);
    const labels = [];
    raw.forEach((c) => {
      const s = String(c == null ? '' : c).trim();
      if (q.type === 'multi' && /^[A-Za-z]{2,4}$/.test(s)) {
        s.toUpperCase().split('').forEach((ch) => {
          if (q.options.some((o) => o.label === ch)) labels.push(ch);
        });
        return;
      }
      const lb = choiceTokenToLabel(q, c);
      if (lb) labels.push(lb);
    });
    // 个别模型把选项写进 text/answer 字段，仅在短文本时兜底
    if (!labels.length && ans.text && String(ans.text).length <= 30) {
      const lb = choiceTokenToLabel(q, ans.text);
      if (lb) labels.push(lb);
    }
    return { choices: Array.from(new Set(labels)), blanks: ans.blanks || [], text: ans.text || '' };
  }

  function isQuizSubmitted(doc) {
    const t = text(doc.body);
    if (/已提交|待批阅|提交成功|已完成/.test(t)) {
      // 避免把“未提交”误判
      if (/未提交|尚未提交/.test(t)) return false;
      return true;
    }
    return false;
  }

  function isExamDoc(doc) {
    try {
      const u = (doc.defaultView && doc.defaultView.location.href) || location.href;
      if (/\/exam\/test\//i.test(u) || /reVersionTestStartNew/i.test(u)) return true;
    } catch (e) {}
    const t = text(doc.body).slice(0, 800);
    // 仅当同时出现考试计时/交卷特征时才认定为考试，避免把普通章节测验误判
    return /剩余时间|考试时长/.test(t) && /交卷|提交试卷/.test(t);
  }

  function submitDialogButtons(doc) {
    const docs = [];
    try { docsFrom(document, 4).forEach((d) => docs.push(d)); } catch (e) {}
    if (docs.indexOf(doc) < 0) docs.push(doc);
    const out = [];
    docs.forEach((d) => {
      let list = [];
      try {
        list = $$('a,button,input[type="button"],input[type="submit"],div[role="button"],span[onclick]', d);
      } catch (e) { list = []; }
      list.forEach((el) => {
        if (!looseVisible(el)) return;
        const t = (text(el) || attr(el, 'value') || '').replace(/\s+/g, '');
        if (!/^(确定|确认|提交|继续|是|OK|好的|确认提交)$/i.test(t)) return;
        const box = el.closest('#popok,#confirmSubWin,.AlertCon02,.popSetDiv,.popDiv,.layui-layer,.modal,.dialog,[role="dialog"],[class*="popup"],[class*="dialog"],[class*="mask"],[class*="Modal"]');
        // 只点弹窗/遮罩内的按钮，避免误点页面上的“提交”
        if (!box) return;
        const bt = text(box);
        if (!/提交|确认|确定|继续|作业|测验|答案/.test(bt)) return;
        out.push({ el: el, box: box, text: t, boxText: bt });
      });
    });
    return out;
  }

  async function handleSubmitDialogs(doc) {
    const clicked = new Set();
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const cands = submitDialogButtons(doc);
      for (let j = 0; j < cands.length; j++) {
        const c = cands[j];
        if (clicked.has(c.el)) continue;
        const bt = c.boxText;
        if (/验证码|人脸|滑块|拖动/.test(bt)) return 'blocked';
        if (/未作答|未完成|还有\s*\d*\s*(道)?题|剩余\s*\d*\s*次|重做|考试/.test(bt) &&
            !/确认提交|确定提交/.test(c.text)) {
          const cancel = $$('a,button', c.box).find((x) => /^(取消|否|再想想|返回)$/.test(text(x).replace(/\s+/g, '')));
          if (cancel) clickEl(cancel);
          return 'incomplete';
        }
        log('点击提交确认：' + c.text);
        clicked.add(c.el);
        clickEl(c.el);
        await sleep(700);
        // 点击后弹窗应消失；仍在则继续找别的“确定”
        if (!looseVisible(c.box)) return 'confirmed';
      }
    }
    return 'none';
  }

  // 提交按钮候选：学习通作业页真实按钮是 a.Btn_blue_1.marleft10[onclick="btnBlueSubmit();"]，
  // 旧版只认 .btnSubmit/#submitbtn，导致答完题后永远找不到提交按钮（用户必须手点）。
  const SUBMIT_BTN_SEL = ['.btnSubmit', '#submitbtn', '.completeBtn', 'a.btnSubmit',
    'a[onclick*="btnBlueSubmit"]', 'a[onclick*="submitTest"]', 'a[onclick*="btnSubmit"]',
    '.Btn_blue_1', '.workBtnIndex', 'button', 'input[type="button"]', 'input[type="submit"]', 'a'].join(',');
  const SUBMIT_WORDS = /^(提交|提交作业|提交答案|提交试卷|提交测试|交卷|交卷并退出)$/;
  function findSubmitButton(doc) {
    let list = [];
    try { list = $$(SUBMIT_BTN_SEL, doc); } catch (e) { list = []; }
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!looseVisible(b)) continue;
      const t = ((text(b) || attr(b, 'value') || '') + '').replace(/\s+/g, '');
      if (!t || t.length > 12) continue;
      if (/保存|暂存/.test(t)) continue;
      if (!SUBMIT_WORDS.test(t)) continue;
      return b;
    }
    return null;
  }

  async function submitQuizPage(doc) {
    const btn = findSubmitButton(doc);
    if (!btn) return { ok: false, reason: 'no-submit-button' };
    clickEl(btn);
    await sleep(600);
    const dl = await handleSubmitDialogs(doc);
    if (dl === 'incomplete') return { ok: false, reason: 'incomplete' };
    if (dl === 'blocked') return { ok: false, reason: 'blocked' };
    if (dl === 'cancelled') return { ok: false, reason: 'cancelled' };
    let ok = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const t = text(doc.body);
      if (/已提交|待批阅|提交成功|成绩|得分|已完成/.test(t) && !/未提交|尚未提交/.test(t)) { ok = true; break; }
      // 关闭提交成功提示
      const okBtn = $$('[role="dialog"] a,[role="dialog"] button,.layui-layer-btn a', doc).filter(looseVisible)
        .find((x) => /^(确定|知道了|好的)$/.test(text(x).replace(/\s+/g, '')));
      if (okBtn) clickEl(okBtn);
    }
    if (!ok) {
      // 弹窗还开着 = 确认没点成功，绝不能当作已提交
      const stillDialog = submitDialogButtons(doc).length > 0;
      const btnStill = !!findSubmitButton(doc);
      if (!stillDialog && !btnStill) ok = true;
    }
    return { ok: ok, reason: ok ? '' : 'no-result' };
  }

  /**
   * 答一整页题目。
   * @returns {{status:'done'|'skipped'|'error'|'waiting'|'filled', reason?:string, detail?:string, count?:number}}
   */
  async function solveQuizPage(doc, opts) {
    opts = opts || {};
    try {
      if (isQuizSubmitted(doc)) return { status: 'done', reason: 'already-submitted' };
      if (CFG.skipAnswer) {
        return { status: 'skipped', reason: 'no-answer-mode', detail: '已开启“不作答”，跳过本页题目' };
      }
      await ensureSecretFontMap();
      const questions = collectQuestions(doc);
      if (!questions.length) return { status: 'waiting', reason: 'no-questions' };
      if (questionsNeedDecode(questions)) {
        let left = 0;
        questions.forEach((q) => {
          left += secretUnknownCount(q.stem);
          (q.options || []).forEach((o) => { left += secretUnknownCount(o.text); });
        });
        warn('题目里有 ' + left + ' 个字形没解出来（字体是没收录的版本），这些字保持原样，整页题目照常发给模型');
      }
      if (isExamDoc(doc) && !CFG.answerExam) {
        return { status: 'skipped', reason: 'exam-disabled' };
      }
      if (!apiConfigured()) {
        return { status: 'skipped', reason: 'no-api', detail: '未配置 DeepSeek API，按设置跳过答题' };
      }
      log('识别到 ' + questions.length + ' 道题，正在请求 DeepSeek 作答…');
      log('题目字体映射：' + (SECRET_FONT_MAP ? SECRET_FONT_INFO : '内置对照表' + (SECRET_FONT_INFO ? '（' + SECRET_FONT_INFO + '）' : '')));
      log('题目示例：' + truncate(questions[0].stem, 40) + (questions.length > 1 ? ' …' : ''));
      const answerMap = new Map();
      const absorb = (res, batch) => {
        (res.answers || []).forEach((a, ai) => {
          const no = Number(a && a.no);
          const target = batch.find((q) => q.no === no) || batch[ai];
          if (target && !answerMap.has(target.no)) answerMap.set(target.no, a);
        });
      };
      const batchSize = 6;
      for (let i = 0; i < questions.length; i += batchSize) {
        const batch = questions.slice(i, i + batchSize);
        const res = await queueApi(() => askQuizBatch(batch, opts.courseName || S.course.name));
        absorb(res, batch);
        log('已获得第 ' + (i + 1) + '–' + Math.min(i + batch.length, questions.length) + ' 题答案（' + Math.round(res.ms / 1000) + ' 秒）');
        if (i + batchSize < questions.length) await sleep(rand(600, 1200));
      }
      // 模型漏题时补问一次，避免整页因缺答案而放弃提交
      let missing = questions.filter((q) => !answerMap.has(q.no));
      if (missing.length) {
        warn('有 ' + missing.length + ' 题未返回答案，正在补问…');
        try {
          const r2 = await queueApi(() => askQuizBatch(missing, opts.courseName || S.course.name));
          absorb(r2, missing);
        } catch (e) {
          warn('补问失败：' + redact(e && e.message || e));
        }
        missing = questions.filter((q) => !answerMap.has(q.no));
        if (missing.length) warn('仍有 ' + missing.length + ' 题没有答案，将跳过并放弃提交');
      }
      const byNo = answerMap;

      let answered = 0, unresolved = 0;
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const ans = byNo.get(q.no);
        if (!ans) {
          unresolved++;
          warn('第 ' + q.no + ' 题没有可用答案，已跳过（' + truncate(q.stem, 60) + '）');
          continue;
        }
        const mapped = resolveAnswer(q, ans);
        // 模型给了答案但对不上选项：单独重问一次，避免直接跳过这题
        if (q.type !== 'fill' && q.type !== 'essay' && !mapped.choices.length) {
          warn('第 ' + q.no + ' 题答案无法对应选项，正在单独重问…');
          try {
            const rr = await queueApi(() => askQuizBatch([q], opts.courseName || S.course.name));
            const a2 = (rr.answers || [])[0];
            if (a2) {
              const m2 = resolveAnswer(q, a2);
              if (m2.choices.length) {
                mapped.choices = m2.choices;
                warn('第 ' + q.no + ' 题重问成功：' + m2.choices.join(','));
              }
            }
          } catch (e) {
            warn('第 ' + q.no + ' 题重问失败：' + redact(e && e.message || e));
          }
        }
        let r = { ok: false };
        if (q.type === 'fill') {
          const vals = (mapped.blanks && mapped.blanks.length) ? mapped.blanks : (mapped.text ? [mapped.text] : []);
          r = await fillQuestionFields(q, vals);
        } else if (q.type === 'essay') {
          r = await fillQuestionFields(q, [mapped.text || (mapped.blanks || []).join('\n')]);
        } else {
          r = await chooseOptions(q, mapped.choices);
        }
        if (r.ok) {
          answered++;
          if (ans && ans.confidence < 0.45) warn('第 ' + q.no + ' 题置信度较低（' + Math.round(ans.confidence * 100) + '%），已按模型答案填写');
        } else {
          unresolved++;
          warn('第 ' + q.no + ' 题填写失败：' + (r.reason || 'unknown') + '（' + truncate(q.stem, 60) + '）');
        }
        await sleep(rand(num(CFG.answerGapMin, 2), Math.max(num(CFG.answerGapMin, 2) + 1, num(CFG.answerGapMax, 5))) * 1000);
      }
      log('作答完成：成功 ' + answered + ' 题，失败 ' + unresolved + ' 题');
      if (unresolved > 0) {
        return { status: 'error', reason: 'unanswered', detail: '有 ' + unresolved + ' 题未能填写，已放弃提交' };
      }
      if (!CFG.autoSubmit) {
        warn('“答完自动提交”已关闭：' + answered + ' 题已填好，请手动点击提交（设置页可重新开启）');
        return { status: 'filled', reason: 'manual-submit', count: answered };
      }
      log('正在提交答案…');
      const sub = await submitQuizPage(doc);
      if (sub.ok) {
        success('提交成功，共 ' + answered + ' 题');
        return { status: 'done', reason: 'submitted', count: answered };
      }
      if (sub.reason === 'blocked') return { status: 'error', reason: 'blocked', detail: '提交时出现验证/风控提示' };
      if (sub.reason === 'incomplete') return { status: 'error', reason: 'incomplete', detail: '页面提示存在未作答题目' };
      warn('提交结果未确认：' + sub.reason);
      return { status: 'error', reason: 'submit-unconfirmed', detail: '提交后未看到成功提示，可能确认弹窗未点或页面未响应' };
    } catch (e) {
      return { status: 'error', reason: 'exception', detail: redact(e && e.message || e) };
    }
  }

  // 视频弹窗题（.ans-videoquiz）
  function findVideoPopup(doc) {
    const submits = $$('#videoquiz-submit,.videoquiz-submit', doc).filter(looseVisible);
    for (let i = 0; i < submits.length; i++) {
      const s = submits[i];
      let box = s;
      for (let d = 0; d < 6 && box; d++) {
        if ($('.ans-videoquiz-opt,.tkTopic_title', box)) break;
        box = box.parentElement;
      }
      if (!box) box = s.parentElement;
      const opts = $$('.ans-videoquiz-opt', box).filter(looseVisible);
      if (opts.length) return { box: box, submit: s, opts: opts };
    }
    return null;
  }

  async function solveVideoPopup(doc) {
    const pop = findVideoPopup(doc);
    if (!pop) return null;
    if (CFG.skipAnswer) {
      // 不作答模式：视频弹窗题必须选一项才能继续播放，这里只盲选，不调用 API
      try {
        const first = pop.opts && pop.opts[0];
        if (first) clickEl(first);
        await sleep(400);
        clickEl(pop.submit);
        await sleep(1000);
        log('不作答模式：视频弹窗题已盲选一项以继续播放');
      } catch (e) {}
      return { status: 'skipped', reason: 'no-answer-mode' };
    }
    if (!apiConfigured()) return { status: 'skipped', reason: 'no-api' };
    const stem = decodeSecret(text($('.tkTopic_title', pop.box))) || '视频弹窗题目';
    const options = pop.opts.map((el, i) => {
      const inp = el.querySelector('input');
      let label = optionLabel(el, i);
      const t = decodeSecret(optionText(el) || text(el));
      return { label: label, text: t, el: el, input: inp };
    }).filter((o) => o.text);
    if (!options.length) return { status: 'error', reason: 'no-options' };
    const q = { no: 1, type: options.length === 2 && /判断/.test(stem) ? 'judge' : 'single', stem: stem, options: options, fields: [], blankCount: 0, root: pop.box };
    try {
      const res = await queueApi(() => askQuizBatch([q], S.course.name));
      const ans = res.answers[0];
      const mapped = resolveAnswer(q, ans);
      const r = await chooseOptions(q, mapped.choices);
      if (!r.ok) return { status: 'error', reason: r.reason };
      await sleep(rand(300, 600));
      clickEl(pop.submit);
      await sleep(1200);
      let feedback = '';
      for (let i = 0; i < 12; i++) {
        const has = $('.ans-videoquiz-opt .ans-videoquiz-right,.ans-videoquiz-right,#spanHas', pop.box);
        const not = $('.ans-videoquiz-opt .ans-videoquiz-wrong,.ans-videoquiz-wrong,#spanNot', pop.box);
        if (has && looseVisible(has)) { feedback = 'right'; break; }
        if (not && looseVisible(not)) { feedback = 'wrong'; break; }
        await sleep(700);
      }
      if (feedback === 'wrong') warn('视频弹窗题答错，将尝试继续播放');
      else if (feedback === 'right') success('视频弹窗题已答对');
      return { status: feedback === 'wrong' ? 'wrong' : 'done', reason: feedback };
    } catch (e) {
      return { status: 'error', reason: 'exception', detail: redact(e.message || e) };
    }
  }

  // ---------------------------------------------------------------- 视频 / 音频 / 文档
  const mediaState = new WeakMap();
  function mediaCtx(doc) {
    let c = mediaState.get(doc);
    if (!c) {
      c = {
        lastTime: -1,
        lastMoveAt: now(),
        lastPlayTry: 0,
        playBlocked: 0,
        popupBusy: false,
        popupTries: 0,
        endedSince: 0,
        startAt: 0,
        lastRateWarn: 0
      };
      mediaState.set(doc, c);
    }
    return c;
  }

  function videoScore(v) {
    let s = 0;
    try {
      const r = v.getBoundingClientRect();
      s = Math.min(2000, r.width) * Math.min(2000, r.height);
      if (v.duration > 0) s += 1000;
      if (!v.paused) s += 500;
      if (v.ended) s -= 300;
    } catch (e) {}
    return s;
  }

  function findMainVideo(doc) {
    const vids = findVideos(doc).filter((v) => {
      try {
        if (!v.isConnected) return false;
        const r = v.getBoundingClientRect();
        return (r.width > 40 && r.height > 20) || v.duration > 0 || !v.paused;
      } catch (e) { return false; }
    });
    if (!vids.length) return null;
    const alive = vids.filter((v) => !v.ended);
    const pool = alive.length ? alive : vids;
    pool.sort((a, b) => videoScore(b) - videoScore(a));
    return pool[0];
  }

  function findMainAudio(doc) {
    const list = queryAllDocs('audio', doc).filter((a) => a.isConnected);
    if (!list.length) return null;
    list.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    return list[0];
  }

  function tryPlay(media, ctx, label) {
    if (!media.paused) return true;
    const t = now();
    if (t - ctx.lastPlayTry < 2500) return false;
    ctx.lastPlayTry = t;
    try {
      media.muted = !!CFG.muted;
      const p = media.play();
      if (p && typeof p.catch === 'function') {
        p.catch((e) => {
          const name = e && e.name;
          if (name === 'NotAllowedError') {
            if (ctx.playBlocked < 3) {
              ctx.playBlocked++;
              warn('浏览器阻止了自动播放，请点击控制台「开始刷课」或页面空白处一次以授权播放');
              sendUp('event', { event: 'need-gesture', kind: label || 'media' });
            }
          } else if (name === 'AbortError') {
            // 播放被页面暂停，稍后重试
          } else {
            warn('播放失败：' + (e && e.message || e));
          }
        });
      }
      return true;
    } catch (e) {
      warn('调用播放失败：' + (e && e.message || e));
      return false;
    }
  }

  async function driveVideo(doc) {
    const ctx = mediaCtx(doc);
    if (!ctx.startAt) ctx.startAt = now();
    const v = findMainVideo(doc);
    if (!v) return { state: 'loading', reason: 'no-video' };

    if (CFG.forceNormalSpeed && Math.abs(v.playbackRate - 1) > 0.01) {
      try {
        v.playbackRate = 1;
        if (now() - ctx.lastRateWarn > 60000) {
          ctx.lastRateWarn = now();
          log('已将播放速度重置为 1 倍速（当前 ' + v.playbackRate + 'x）');
        }
      } catch (e) {}
    }
    if (CFG.muted && !v.muted) {
      try { v.muted = true; } catch (e) { try { v.volume = 0; } catch (e2) {} }
    }

    // 视频弹窗题
    const pop = findVideoPopup(doc);
    if (pop) {
      if (CFG.skipAnswer) {
        if (!ctx.popupBusy) {
          ctx.popupBusy = true;
          try {
            const r = await solveVideoPopup(doc);
            log('视频弹窗题处理结果：' + (r && r.status || 'unknown'));
          } catch (e) {
            warn('视频弹窗题处理失败：' + (e && e.message || e));
          } finally {
            ctx.popupBusy = false;
          }
        }
        return { state: 'popup', reason: 'solving' };
      }
      if (!CFG.answerVideoQuiz || !apiConfigured()) {
        if (ctx.popupTries < 3) {
          ctx.popupTries++;
          warn('视频中出现弹窗题目，未配置 API 或已关闭自动作答，请手动选择后继续');
          sendUp('event', { event: 'blocked', reason: 'video-popup' });
        }
        return { state: 'blocked', reason: 'video-popup' };
      }
      if (!ctx.popupBusy) {
        ctx.popupBusy = true;
        try {
          const r = await solveVideoPopup(doc);
          log('视频弹窗题处理结果：' + (r && r.status || 'unknown'));
        } catch (e) {
          warn('视频弹窗题处理失败：' + (e && e.message || e));
        } finally {
          ctx.popupBusy = false;
        }
      }
      return { state: 'popup', reason: 'solving' };
    }

    if (v.ended || (v.duration > 0 && v.currentTime >= v.duration - 0.35 && v.paused)) {
      if (!ctx.endedSince) ctx.endedSince = now();
      return { state: 'ended', t: v.currentTime, d: v.duration, since: ctx.endedSince };
    }
    ctx.endedSince = 0;

    if (v.paused) {
      // 有些播放器 preload=none，初始 readyState 为 0，必须先调用 play() 触发加载
      tryPlay(v, ctx, 'video');
      await sleep(300);
      if (v.paused && v.readyState === 0 && now() - ctx.startAt < 12000) {
        return { state: 'loading', reason: 'buffering', t: v.currentTime || 0, d: v.duration || 0 };
      }
    }

    const t = v.currentTime || 0;
    if (Math.abs(t - ctx.lastTime) > 0.3) {
      ctx.lastTime = t;
      ctx.lastMoveAt = now();
    } else if (!v.paused && now() - ctx.lastMoveAt > 90000) {
      return { state: 'stalled', t: t, d: v.duration, stalledFor: now() - ctx.lastMoveAt };
    }
    return {
      state: v.paused ? 'paused' : 'playing',
      t: t,
      d: v.duration || 0,
      rate: v.playbackRate,
      paused: v.paused
    };
  }

  async function driveAudio(doc) {
    const ctx = mediaCtx(doc);
    const a = findMainAudio(doc);
    if (!a) return { state: 'loading', reason: 'no-audio' };
    if (CFG.forceNormalSpeed && Math.abs(a.playbackRate - 1) > 0.01) {
      try { a.playbackRate = 1; } catch (e) {}
    }
    if (a.ended || (a.duration > 0 && a.currentTime >= a.duration - 0.35 && a.paused)) {
      if (!ctx.endedSince) ctx.endedSince = now();
      return { state: 'ended', t: a.currentTime, d: a.duration, since: ctx.endedSince };
    }
    ctx.endedSince = 0;
    if (a.paused) { tryPlay(a, ctx, 'audio'); await sleep(250); }
    const t = a.currentTime || 0;
    if (Math.abs(t - ctx.lastTime) > 0.3) { ctx.lastTime = t; ctx.lastMoveAt = now(); }
    return { state: a.paused ? 'paused' : 'playing', t: t, d: a.duration || 0 };
  }

  function scoreScroll(el) {
    try {
      const win = el.ownerDocument.defaultView;
      const st = win.getComputedStyle(el);
      const oy = st.overflowY;
      if (!/auto|scroll|overlay/.test(oy)) return 0;
      const diff = el.scrollHeight - el.clientHeight;
      if (diff < 60 || el.clientHeight < 80) return 0;
      return diff + (el.clientHeight > 300 ? 1000 : 0);
    } catch (e) { return 0; }
  }

  function findScrollContainer(doc) {
    const preferred = ['#viewerContainer', '.pdfViewer', '#mainText', '.readContent', '#content', '.ans-attach', '.doc-content', '.ppt-content', '#panView', '.textContent'];
    for (let i = 0; i < preferred.length; i++) {
      const el = $(preferred[i], doc);
      if (el && scoreScroll(el) > 0) return el;
    }
    let best = null, bestScore = 0;
    const all = $$('div,section,article,main', doc);
    for (let i = 0; i < all.length && i < 3000; i++) {
      const s = scoreScroll(all[i]);
      if (s > bestScore) { bestScore = s; best = all[i]; }
    }
    if (best) return best;
    const se = doc.scrollingElement || doc.documentElement;
    if (se && se.scrollHeight - se.clientHeight > 60) return se;
    return null;
  }

  const docState = new WeakMap();
  function docCtx(doc) {
    let c = docState.get(doc);
    if (!c) {
      c = { lastScrollAt: 0, bottomSince: 0, clicks: 0, lastNextAt: 0, maxPct: 0, startAt: 0 };
      docState.set(doc, c);
    }
    if (!c.startAt) c.startAt = now();
    return c;
  }

  function findNextButton(doc) {
    const sels = ['#nextPage', '.nextPage', 'a[title="下一页"]', '[title="下一页"]', '.swiper-button-next', '[aria-label="下一页"]', '.pdf-next', '.next-page', '.pageNext'];
    for (let i = 0; i < sels.length; i++) {
      const list = $$(sels[i], doc).filter(looseVisible);
      for (let j = 0; j < list.length; j++) {
        const b = list[j];
        const cls = (b.className || '') + '';
        if (/disabled|ban/i.test(cls) || attr(b, 'aria-disabled') === 'true') continue;
        return b;
      }
    }
    return null;
  }

  async function driveDocument(doc) {
    const ctx = docCtx(doc);
    const box = findScrollContainer(doc);
    if (!box) {
      const next = findNextButton(doc);
      if (next) {
        if (now() - ctx.lastNextAt > 3500) {
          ctx.lastNextAt = now();
          clickEl(next);
          ctx.clicks++;
          log('文档翻页：第 ' + ctx.clicks + ' 页');
        }
        return { state: 'paging', pct: 0, clicks: ctx.clicks };
      }
      return { state: 'loading', reason: 'no-scroll-container' };
    }
    const total = Math.max(1, box.scrollHeight - box.clientHeight);
    const pct = clamp((box.scrollTop || 0) / total, 0, 1);
    ctx.maxPct = Math.max(ctx.maxPct, pct);

    if (now() - ctx.lastScrollAt > 2200) {
      ctx.lastScrollAt = now();
      const step = Math.max(220, Math.floor(box.clientHeight * 0.72));
      const nextTop = Math.min(total, (box.scrollTop || 0) + step);
      try { box.scrollTo({ top: nextTop, behavior: 'smooth' }); }
      catch (e) { try { box.scrollTop = nextTop; } catch (_) {} }
    }

    if (pct >= 0.995) {
      if (!ctx.bottomSince) {
        ctx.bottomSince = now();
        log('文档已到末尾，等待任务点完成标记…');
      }
      const next = findNextButton(doc);
      if (next && now() - ctx.lastNextAt > 4000) {
        ctx.lastNextAt = now();
        clickEl(next);
        ctx.clicks++;
        ctx.bottomSince = 0;
        return { state: 'paging', pct: pct, clicks: ctx.clicks };
      }
      return { state: 'bottom', pct: pct, since: ctx.bottomSince, clicks: ctx.clicks };
    }
    ctx.bottomSince = 0;
    return { state: 'scrolling', pct: pct, top: box.scrollTop, total: total };
  }

  function docPageInfo(doc) {
    const t = text(doc.body).slice(0, 300);
    const m = t.match(/(\d+)\s*\/\s*(\d+)/);
    if (m) return m[1] + '/' + m[2];
    return '';
  }

  // ---------------------------------------------------------------- cards 任务点引擎
  const cardsRuntime = new WeakMap();
  function cardsCtx(doc) {
    let c = cardsRuntime.get(doc);
    if (!c) {
      c = {
        busy: false,
        tickCount: 0,
        lastAdvanceAt: 0,
        moduleKey: '',
        moduleStartAt: 0,
        endedAt: 0,
        bottomAt: 0,
        quizDoneAt: 0,
        forceDone: {},
        lastState: null
      };
      cardsRuntime.set(doc, c);
    }
    return c;
  }

  function cardTabs(doc) {
    const raw = $$('[id^="dct"][cardid], [id^="dct"][card], .prev_ul > li[id^="dct"]', doc);
    const seen = {};
    const out = [];
    raw.forEach((el, i) => {
      const id = attr(el, 'cardid') || attr(el, 'card') || el.id.replace(/^dct/, '') || ('idx' + i);
      if (seen[id]) return;
      seen[id] = true;
      out.push(el);
    });
    return out;
  }

  function isTabActive(tab) {
    if (!tab) return false;
    if (tab.classList.contains('active')) return true;
    if (attr(tab, 'aria-selected') === 'true') return true;
    const cls = attr(tab, 'class');
    if (/\bactive\b|\bon\b|\bcur\b/.test(cls)) return true;
    return false;
  }

  function iconDoneText(el) {
    if (!el) return false;
    const label = [attr(el, 'aria-label'), attr(el, 'title'), text(el)].join(' ');
    if (/未完成|未开始|未学/.test(label)) return false;
    if (/任务点已完成|已完成|完成/.test(label)) return true;
    if (el.classList && (el.classList.contains('ans-job-finished') || el.classList.contains('job-finished'))) return true;
    return false;
  }

  function attachmentDone(el) {
    if (!el) return false;
    if (el.classList && el.classList.contains('ans-job-finished')) return true;
    const icons = $$('.ans-job-icon,[class*="job-icon"]', el);
    for (let i = 0; i < icons.length; i++) {
      if (iconDoneText(icons[i])) return true;
    }
    const t = text(el);
    if (/任务点已完成/.test(t)) return true;
    return false;
  }

  function attachmentIframe(el) {
    return $('iframe', el) || null;
  }

  function attachmentSrc(el) {
    const f = attachmentIframe(el);
    return f ? (attr(f, 'src') || '') : '';
  }

  function classifySrc(src) {
    const s = String(src || '').toLowerCase();
    if (/\/video\//.test(s)) return 'video';
    if (/\/audio\//.test(s)) return 'audio';
    if (/\/work\/|dohomework|homework/.test(s)) return 'quiz';
    if (/\/exam\//.test(s)) return 'exam';
    if (/\/read\/|\/zt\/|ztnodedetail/.test(s)) return 'read';
    if (/\/pdf\/|\/ppt\/|\/pptx\/|\/doc\/|\/docx\/|\/office\/|\/image\/|\/png\/|\/jpg\//.test(s)) return 'document';
    if (/\/ananas\/modules\//.test(s)) return 'generic';
    return 'unknown';
  }

  function guessTabType(tab, attachments, index) {
    const cls = attr(tab, 'class') + ' ' + attr(tab, 'title');
    const t = text(tab);
    const blob = cls + ' ' + t;
    if (/视频|video/i.test(blob)) return 'video';
    if (/音频|audio/i.test(blob)) return 'audio';
    if (/测验|作业|习题|练习|考试|quiz|work/i.test(blob)) return 'quiz';
    if (/阅读|read/i.test(blob)) return 'read';
    if (/文档|ppt|pdf|课件|资料|doc/i.test(blob)) return 'document';
    for (let i = 0; i < attachments.length; i++) {
      const k = classifySrc(attachmentSrc(attachments[i]));
      if (k !== 'unknown') return k;
    }
    return 'unknown';
  }

  function localDoneKey(courseId, cardId, sub) {
    return sub == null ? String(cardId) : String(cardId) + '#' + sub;
  }
  function isLocalDone(courseId, key) {
    if (!courseId) return false;
    const p = courseProgress(courseId);
    return p.doneCards.indexOf(key) >= 0;
  }
  function markLocalDone(courseId, key) {
    if (!courseId) return;
    const p = courseProgress(courseId);
    if (p.doneCards.indexOf(key) < 0) p.doneCards.push(key);
    p.skippedCards = p.skippedCards.filter((x) => x !== key);
    saveProgress();
  }
  function markLocalSkipped(courseId, key) {
    if (!courseId) return;
    const p = courseProgress(courseId);
    if (p.skippedCards.indexOf(key) < 0) p.skippedCards.push(key);
    saveProgress();
  }
  function isLocalSkipped(courseId, key) {
    if (!courseId) return false;
    return courseProgress(courseId).skippedCards.indexOf(key) >= 0;
  }

  function isCardLocalDone(courseId, cardId) {
    if (!courseId) return false;
    const p = courseProgress(courseId);
    return p.doneCards.some((k) => k === cardId || k.indexOf(cardId + '#') === 0);
  }
  function isCardLocalSkipped(courseId, cardId) {
    if (!courseId) return false;
    const p = courseProgress(courseId);
    return p.skippedCards.some((k) => k === cardId || k.indexOf(cardId + '#') === 0);
  }

  function listCards(doc, courseId) {
    const tabs = cardTabs(doc);
    const allAttach = $$('.ans-attach-ct', doc);
    const items = tabs.map((tab, i) => {
      const id = attr(tab, 'cardid') || attr(tab, 'card') || tab.id.replace(/^dct/, '') || ('idx' + i);
      let attach = null;
      if (allAttach.length === tabs.length) attach = allAttach[i];
      else {
        attach = allAttach.find((a) => attr(a, 'cardid') === id) || null;
        if (!attach && isTabActive(tab)) attach = allAttach.find((a) => attachmentIframe(a)) || null;
      }
      const attachments = attach ? [attach] : [];
      const done = (attach && attachmentDone(attach)) || isCardLocalDone(courseId, id) || (!attach && iconDoneText(tab));
      const type = guessTabType(tab, attachments, i);
      return {
        id: id,
        index: i,
        title: (text(tab).replace(/^\s*\d+[、.．]?\s*/, '') || ('任务点 ' + (i + 1))).slice(0, 60),
        active: isTabActive(tab),
        done: !!done,
        skipped: isCardLocalSkipped(courseId, id),
        type: type,
        hasAttach: !!attach
      };
    });
    return items;
  }

  function activeCardItem(items) {
    return items.find((x) => x.active) || null;
  }

  function activeAttachments(doc) {
    const all = $$('.ans-attach-ct', doc);
    const tabs = cardTabs(doc);
    if (!tabs.length) return all.filter((a) => attachmentIframe(a));
    const idx = tabs.findIndex((t) => isTabActive(t));
    if (idx >= 0 && all.length === tabs.length) return [all[idx]].filter(Boolean);
    const act = tabs[idx >= 0 ? idx : 0];
    const id = act ? (attr(act, 'cardid') || attr(act, 'card')) : '';
    const byId = all.filter((a) => attr(a, 'cardid') === id);
    if (byId.length) return byId;
    return all.filter((a) => attachmentIframe(a) && !attachmentDone(a));
  }

  async function clickCardTab(doc, id) {
    const tabs = cardTabs(doc);
    const tab = tabs.find((t) => (attr(t, 'cardid') || t.id.replace(/^dct/, '')) === String(id));
    if (!tab) return { ok: false, reason: 'tab-not-found' };
    if (isTabActive(tab)) return { ok: true, already: true };
    clickEl(tab);
    const inner = $('a,span,div', tab);
    if (inner) {
      await sleep(rand(120, 260));
      clickEl(inner);
    }
    const ok = await waitFor(() => isTabActive(tab), 6000, 250);
    await sleep(rand(600, 1200));
    return { ok: !!ok, reason: ok ? '' : 'not-activated' };
  }

  async function advanceCard(doc, courseId) {
    const items = listCards(doc, courseId);
    const idx = items.findIndex((x) => x.active);
    for (let i = idx + 1; i < items.length; i++) {
      if (!items[i].done) {
        const r = await clickCardTab(doc, items[i].id);
        if (r.ok) return { ok: true, next: items[i] };
      }
    }
    for (let i = 0; i < idx; i++) {
      if (!items[i].done) {
        const r = await clickCardTab(doc, items[i].id);
        if (r.ok) return { ok: true, next: items[i] };
      }
    }
    return { ok: false, reason: 'no-more-cards' };
  }

  function moduleDocOf(attach) {
    const f = attachmentIframe(attach);
    if (!f) return null;
    let d = null;
    try { d = f.contentDocument; } catch (e) { d = null; }
    return d;
  }

  function attachmentKey(courseId, cardId, i) {
    return localDoneKey(courseId, cardId, i);
  }

  // 小节内分页（概览 / 视频 / 测验 各占一页）：#prev_tab / .prev_ul / #prevTabBox
  function pagerTopDoc(doc) {
    try {
      const w = doc && doc.defaultView;
      if (w && w.top && w.top.document) return w.top.document;
    } catch (e) {}
    return doc;
  }

  function pagerTabsIn(pd) {
    const sels = ['#prev_tab > li', '.prev_ul > li', '#prevTabBox > li'];
    for (let i = 0; i < sels.length; i++) {
      // 优先可见的一组：切节后旧页签可能残留在 DOM 里但已隐藏，不能拿来判断 hasNext
      const all = $$(sels[i], pd).filter((el) => el && el.isConnected);
      const vis = all.filter(looseVisible);
      const cand = vis.length >= 2 ? vis : all;
      if (cand.length >= 2 && cand.some((el) => isTabActive(el))) return cand;
    }
    return [];
  }

  function pagerInfo(doc) {
    let pd = doc;
    let tabs = pagerTabsIn(pd);
    if (tabs.length < 2) {
      pd = pagerTopDoc(doc);
      tabs = pagerTabsIn(pd);
    }
    if (tabs.length < 2) return null;
    let idx = tabs.findIndex((t) => isTabActive(t));
    if (idx < 0) idx = 0;
    const root = doc === pd ? ($('#mainid', pd) || pd.body) : doc;
    const nextBtns = $$('#mainid > .prev_next.next,#mainid .prev_next.next,.prev_next.next', pd).filter(looseVisible);
    const nextBtn = nextBtns.find((b) => {
      const cls = attr(b, 'class');
      return !/(^|\s)(disabled|ban|forbid)(\s|$)/.test(cls) && attr(b, 'aria-disabled') !== 'true';
    }) || null;
    return {
      pd: pd,
      tabs: tabs,
      idx: idx,
      root: root,
      nextBtn: nextBtn,
      hasNext: idx < tabs.length - 1,
      key: 'pager:' + idx + ':' + truncate(text(tabs[idx]), 40)
    };
  }

  function pagedScope(pager) {
    let cid = '';
    try { cid = new URL(location.href).searchParams.get('chapterId') || ''; } catch (e) {}
    let head = '';
    try {
      const el = $('h1,.chapterTitle,.chapter_title,.prev_title', pager.root) || $('h1,.chapterTitle,.chapter_title', document);
      head = el ? norm(text(el)) : '';
    } catch (e) {}
    if (!head) head = truncate(norm(String(document.title || '')), 80);
    return cid + '|' + head;
  }

  function pagedItems(pager, courseId) {
    const scope = pagedScope(pager);
    return pager.tabs.map((t, i) => {
      const id = 'page-' + (i + 1);
      const scoped = scope + '#' + id;
      return {
        id: id,
        index: i,
        title: (text(t).replace(/\s+/g, ' ') || ('第 ' + (i + 1) + ' 页')).slice(0, 40),
        active: i === pager.idx,
        done: isLocalDone(courseId, scoped),
        skipped: isLocalSkipped(courseId, scoped),
        type: 'page',
        hasAttach: true
      };
    });
  }

  async function advancePaged(doc, pager, items) {
    const from = pager.idx;
    if (pager.hasNext) {
      const target = pager.tabs[from + 1];
      if (target) {
        clickEl(target);
        // 学习通页签的点击事件绑在内部 a/span 上，li 本身可能不响应
        try {
          $$('a,span,div', target).forEach((e) => clickEl(e));
        } catch (e) {}
      }
    }
    let ok = false;
    for (let i = 0; i < 30; i++) {
      await sleep(400);
      let st = null;
      try { st = pagerInfo(doc); } catch (e) { st = null; }
      if (st && st.idx !== from) { ok = true; break; }
    }
    if (!ok && pager.nextBtn) {
      clickEl(pager.nextBtn);
      for (let i = 0; i < 30; i++) {
        await sleep(400);
        let st = null;
        try { st = pagerInfo(doc); } catch (e) { st = null; }
        if (st && st.idx !== from) { ok = true; break; }
      }
    }
    if (!ok) return { state: 'page-stuck', page: from + 1, total: pager.tabs.length, items: items };
    await sleep(rand(700, 1400));
    return { state: 'page-next', page: from + 2, total: pager.tabs.length, items: items };
  }

  async function tickPaged(doc, pager, ctx, opts) {
    const courseId = opts.courseId || S.course.id || '';
    const pageId = 'page-' + (pager.idx + 1);
    const pageKey = pagedScope(pager) + '#' + pageId;
    const items = pagedItems(pager, courseId);
    if (opts.onCard) {
      try { opts.onCard(items[pager.idx] || items[0], items); } catch (e) {}
    }
    const sig = pager.key + '|' + truncate(text(pager.root).replace(/\s+/g, ' ').slice(0, 120), 120);
    if (ctx.pageKey !== sig) {
      ctx.pageKey = sig;
      ctx.pageSeenAt = now();
    }
    // ---- 结构解剖：先把本页所有任务点（视频+文档+测验…）识别出来，再逐个完成 ----
    let anat = null;
    try {
      anat = await anatTick(doc, { courseId: courseId, items: items });
    } catch (e) {
      warn('页面结构识别失败，回退到逐页处理：' + (e && e.message || e));
      anat = null;
    }
    if (anat && anat.handled) {
      const base = {
        paged: true, card: { id: pageId, key: pageKey }, items: items,
        anatomy: anat.rows || [], page: pager.idx + 1, total: pager.tabs.length
      };
      if (anat.state === 'page-complete') {
        markLocalDone(courseId, pageKey);
        if (!pager.hasNext) return Object.assign({ state: 'section-page-last' }, base);
        return Object.assign(await advancePaged(doc, pager, items), base);
      }
      return Object.assign({}, base, anat, { card: { id: pageId, key: pageKey } });
    }

    const atts = $$('.ans-attach-ct', pager.root).filter(looseVisible);
    const pageDocs = docsFrom(pager.root, 4);
    const pageVids = findVideos(pager.root).filter(looseVisible);
    const quizDoc = pageDocs.find((d) => questionRoots(d).length) || null;
    const moduleFrame = $$('iframe', pager.root).filter(looseVisible).map((f) => ({ f: f, src: attr(f, 'src') || '' }))
      .find((o) => /\/ananas\/modules\/(video|audio|pdf|ppt|doc|office|work|read)|\/mooc2\/work\/|\/knowledge\/cards/i.test(o.src)) || null;
    if (ctx.diagKey !== sig) {
      ctx.diagKey = sig;
      log('小节页：' + pager.tabs.length + ' 页，附件 ' + atts.length + '，视频 ' + pageVids.length +
        '，题目块 ' + (quizDoc ? questionRoots(quizDoc).length : 0) + '，iframe ' + (moduleFrame ? '有' : '无'));
    }
    for (let i = 0; i < atts.length; i++) {
      const at = atts[i];
      const key = pageKey + '#' + i;
      if (attachmentDone(at) || isLocalDone(courseId, key) || isLocalSkipped(courseId, key)) continue;
      const src = attachmentSrc(at);
      const type = classifySrc(src);
      const md = moduleDocOf(at);
      if (!md) {
        return { state: 'cross-origin', paged: true, card: { id: pageId, key: pageKey }, type: type, src: src, index: i, items: items, frame: attachmentIframe(at) };
      }
      const r = await driveModule(md, type, {
        courseId: courseId,
        cardId: pageId,
        index: i,
        key: key,
        ctx: ctx,
        src: src,
        attach: at
      });
      if (r.state === 'skipped') {
        markLocalSkipped(courseId, key);
        return Object.assign({ paged: true, card: { id: pageId, key: pageKey }, items: items }, r);
      }
      return Object.assign({ paged: true, card: { id: pageId, key: pageKey }, items: items, moduleIndex: i, moduleType: type }, r);
    }

    // 整页已跳过（例如未配置 API 的章节测验）：直接翻到下一页，避免原地循环
    if (isLocalSkipped(courseId, pageKey) && !pager.hasNext) {
      return { state: 'section-page-last', paged: true, page: pager.idx + 1, total: pager.tabs.length, items: items };
    }
    if (isLocalSkipped(courseId, pageKey)) {
      return await advancePaged(doc, pager, items);
    }

    // 页面顶部已有“任务点已完成”图标：不要重复播视频，直接进入下一页
    if (!isLocalDone(courseId, pageKey)) {
      try {
        const iconDocs = [document].concat(pageDocs || []);
        let icons = [];
        iconDocs.forEach((d) => {
          try { $$('.ans-job-icon,[class*="job-icon"]', d).forEach((e) => { if (looseVisible(e)) icons.push(e); }); } catch (e) {}
        });
        // 视频页只认视频任务图标（class 常带 ans-job-video），避免混入其它页签的待完成图标
        if (pageVids.length) {
          const vIcons = icons.filter((e) => /video/i.test(String(e.className || '')));
          if (vIcons.length) icons = vIcons;
        }
        if (icons.length) {
          const labels = icons.map((e) => (e.getAttribute('aria-label') || text(e) || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
          if (ctx.iconLogKey !== pageId) {
            ctx.iconLogKey = pageId;
            log('任务图标：' + labels.join(' / '));
          }
          if (icons.every((e) => iconDoneText(e))) {
            markLocalDone(courseId, pageKey);
            // 已完成页不再依赖本地进度，直接翻页/结束本节，避免重复播放
            if (!pager.hasNext) {
              return { state: 'section-page-last', paged: true, page: pager.idx + 1, total: pager.tabs.length, items: items };
            }
            return await advancePaged(doc, pager, items);
          }
        }
      } catch (e) {}
    }
    if (isLocalDone(courseId, pageKey)) {
      if (!pager.hasNext) {
        return { state: 'section-page-last', paged: true, page: pager.idx + 1, total: pager.tabs.length, items: items };
      }
      return await advancePaged(doc, pager, items);
    }

    const vids = atts.length ? [] : pageVids;
    if (vids.length && !isLocalDone(courseId, pageKey)) {
      const r = await driveVideo(pager.root);
      if (r.state === 'ended') {
        markLocalDone(courseId, pageKey);
        return { state: 'module-done', module: 'video', paged: true, card: { id: pageId, key: pageKey }, items: items, detail: r };
      }
      if (r.state === 'blocked') return { state: 'blocked', module: 'video', reason: r.reason, paged: true, card: { id: pageId, key: pageKey }, items: items };
      return { state: r.state, module: 'video', paged: true, card: { id: pageId, key: pageKey }, items: items, detail: r };
    }

    if (!atts.length && !isLocalDone(courseId, pageKey) && quizDoc) {
      const r = await solveQuizPage(quizDocFor(quizDoc), { courseName: S.course.name });
      if (r.status === 'done' || r.status === 'filled') {
        markLocalDone(courseId, pageKey);
        return { state: 'module-done', module: 'quiz', paged: true, card: { id: pageId, key: pageKey }, items: items, detail: r };
      }
      if (r.status === 'skipped') {
        markLocalSkipped(courseId, pageKey);
        return { state: 'skipped', module: 'quiz', reason: r.reason, paged: true, card: { id: pageId, key: pageKey }, items: items, detail: r };
      }
      if (r.status === 'waiting') return { state: 'waiting', module: 'quiz', paged: true, card: { id: pageId, key: pageKey }, items: items, detail: r };
      return { state: 'error', module: 'quiz', reason: r.reason, paged: true, card: { id: pageId, key: pageKey }, items: items, detail: r };
    }

    // 新版 studentstudy 把视频/作业放在跨域 iframe 里：交给该 iframe 内的 agent 驱动
    // 注意：概览页可能残留空 iframe（src 无法识别），此时不能一直等 agent，应按普通页翻页
    if (!atts.length && !isLocalDone(courseId, pageKey) && !vids.length && !quizDoc && moduleFrame) {
      const src = moduleFrame.src;
      const mt = classifySrc(src);
      if (mt !== 'unknown' && mt !== 'generic') {
        return {
          state: 'cross-origin', paged: true, card: { id: pageId, key: pageKey }, items: items,
          type: mt, src: src, frame: moduleFrame.f, index: 0
        };
      }
    }

    // 概览页 / 纯文字页：停留几秒模拟阅读，再翻页
    const tabTitle = norm(text(pager.tabs[pager.idx] || ''));
    const taskLike = /视频|测验|作业|考试|文档|PPT|阅读|音频|任务点/i.test(tabTitle);
    if (taskLike) {
      // 标题明确是任务点，却没有识别到视频/题目/模块：绝不当作概览页跳过
      const waited = now() - ctx.pageSeenAt;
      if (waited < 20000) {
        return { state: 'page-reading', paged: true, remain: Math.max(1, Math.ceil((20000 - waited) / 1000)), items: items };
      }
      return {
        state: 'blocked', module: 'page', reason: 'page-not-ready',
        paged: true, card: { id: pageId, key: pageKey }, items: items,
        detail: { tab: tabTitle, vids: pageVids.length, quiz: !!quizDoc, frame: !!moduleFrame }
      };
    }
    const dwell = rand(3200, 6500);
    if (now() - ctx.pageSeenAt < dwell) {
      return { state: 'page-reading', paged: true, remain: Math.max(1, Math.ceil((dwell - (now() - ctx.pageSeenAt)) / 1000)), items: items };
    }
    if (!pager.hasNext) {
      return { state: 'section-page-last', paged: true, page: pager.idx + 1, total: pager.tabs.length, items: items };
    }
    return await advancePaged(doc, pager, items);
  }

  async function tickCards(doc, opts) {
    opts = opts || {};
    const courseId = opts.courseId || S.course.id || '';
    const ctx = cardsCtx(doc);
    if (ctx.busy) return { state: 'busy' };
    ctx.busy = true;
    ctx.tickCount++;
    try {
      // 新版 studentstudy：.prev_ul 是任务点页签，优先按“分页小节”处理，
      // 否则会被上面的 cardTabs 误判成普通卡片（附件其实在 iframe 里）
      const pagerFirst = pagerInfo(doc);
      if (pagerFirst) return await tickPaged(doc, pagerFirst, ctx, opts);
      if (!cardTabs(doc).length) {
        const pager = pagerInfo(doc);
        if (pager) return await tickPaged(doc, pager, ctx, opts);
      }
      const items = listCards(doc, courseId);
      if (!items.length) {
        // 新版 mooc-ans 布局：一个知识点页把任务点放在 iframe 里，没有 #dct 页签，
        // listCards 得到空数组。旧逻辑在这里判“no-cards”并跳下一节，用户看到的就是
        // “刚看一眼视频/文档就跳走”。先交给解剖引擎把本页任务点逐个做完再离开。
        const pageAtts = $$('.ans-attach-ct', doc).filter(looseVisible);
        if (pageAtts.length) {
          let anat = null;
          try {
            anat = await anatTick(doc, { courseId: courseId });
          } catch (e) {
            warn('本页结构识别失败，按附件逐个处理：' + (e && e.message || e));
            anat = null;
          }
          if (anat && anat.handled) {
            const unitCard = {
              id: 'page-' + (S.currentChapterId || 'cur'),
              key: 'page#' + (S.currentChapterId || 'cur')
            };
            if (anat.state === 'page-complete') {
              markLocalDone(courseId, unitCard.key);
              // 本页所有任务点都已完成：走“任务点完成”出口，交给 advanceOrWait 切到下一个任务点/小节
              return { state: 'card-done', card: unitCard, items: [], anatomy: anat.rows || [] };
            }
            return Object.assign({ card: unitCard, items: [] }, anat);
          }
        }
        return { state: 'no-cards', items: items };
      }
      let card = activeCardItem(items);
      if (!card) {
        const first = items.find((x) => !x.done) || items[0];
        if (first) await clickCardTab(doc, first.id);
        return { state: 'activated', card: first || null, items: items };
      }
      const attaches = activeAttachments(doc);
      if (opts.onCard) {
        try { opts.onCard(card, listCards(doc, courseId)); } catch (e) {}
      }
      if (isCardLocalSkipped(courseId, card.id)) {
        return { state: 'card-skipped', card: card, items: items };
      }
      if (!attaches.length) {
        // 没有附件：可能是纯章节页，直接算完成
        return { state: 'no-attachments', card: card, items: items };
      }
      for (let i = 0; i < attaches.length; i++) {
        const at = attaches[i];
        const key = attachmentKey(courseId, card.id, i);
        if (attachmentDone(at) || isLocalDone(courseId, key)) continue;
        if (isLocalSkipped(courseId, key)) continue;
        const src = attachmentSrc(at);
        const type = classifySrc(src);
        const win = at.ownerDocument && at.ownerDocument.defaultView;
        const md = moduleDocOf(at);
        if (!md) {
          return { state: 'cross-origin', card: card, type: type, src: src, index: i, items: items, frame: attachmentIframe(at) };
        }
        const r = await driveModule(md, type, {
          courseId: courseId,
          cardId: card.id,
          index: i,
          key: key,
          ctx: ctx,
          src: src,
          attach: at
        });
        return Object.assign({ card: card, items: items, moduleIndex: i, moduleType: type, src: src }, r);
      }
      // 所有附件均完成
      return { state: 'card-done', card: card, items: items };
    } finally {
      ctx.busy = false;
    }
  }

  async function driveModule(md, type, info) {
    const ctx = info.ctx;
    const key = info.key;
    const nowTs = now();
    if (ctx.moduleKey !== key) {
      ctx.moduleKey = key;
      ctx.moduleStartAt = nowTs;
      ctx.endedAt = 0;
      ctx.bottomAt = 0;
      ctx.quizDoneAt = 0;
    }
    if (type === 'read') {
      return { state: 'skipped', reason: 'reading-task' };
    }
    if (type === 'video' || (!type || type === 'generic') && findVideos(md).length) {
      const r = await driveVideo(md);
      if (r.state === 'ended') {
        if (!ctx.endedAt) ctx.endedAt = nowTs;
        const at = info.attach;
        const done = at && attachmentDone(at);
        if (done) return { state: 'module-done', module: 'video', detail: r };
        if (nowTs - ctx.endedAt > 30000) {
          markLocalDone(info.courseId, key);
          return { state: 'module-done', module: 'video', forced: true, detail: r };
        }
        return { state: 'ended', module: 'video', detail: r, waitDone: true };
      }
      if (r.state === 'blocked') return { state: 'blocked', module: 'video', reason: r.reason, detail: r };
      if (r.state === 'stalled') return { state: 'stalled', module: 'video', detail: r };
      return { state: r.state, module: 'video', detail: r };
    }
    if (type === 'audio') {
      const r = await driveAudio(md);
      if (r.state === 'ended') {
        if (!ctx.endedAt) ctx.endedAt = nowTs;
        const at = info.attach;
        if ((at && attachmentDone(at)) || nowTs - ctx.endedAt > 30000) {
          markLocalDone(info.courseId, key);
          return { state: 'module-done', module: 'audio', detail: r };
        }
        return { state: 'ended', module: 'audio', detail: r };
      }
      return { state: r.state, module: 'audio', detail: r };
    }
    if (type === 'quiz' || type === 'exam' || (!type || type === 'generic') && $$('.TiMu,.questionLi', md).length) {
      if (type === 'exam' && !CFG.answerExam) return { state: 'skipped', reason: 'exam-disabled', module: 'quiz' };
      const r = await solveQuizPage(quizDocFor(md), { courseName: S.course.name });
      if (r.status === 'done' || r.status === 'filled') {
        await sleep(1200);
        markLocalDone(info.courseId, key);
        return { state: 'module-done', module: 'quiz', detail: r };
      }
      if (r.status === 'skipped') {
        markLocalSkipped(info.courseId, key);
        return { state: 'skipped', module: 'quiz', reason: r.reason, detail: r };
      }
      if (r.status === 'waiting') return { state: 'waiting', module: 'quiz', detail: r };
      return { state: 'error', module: 'quiz', reason: r.reason, detail: r };
    }
    if (type === 'document' || type === 'generic') {
      const r = await driveDocument(md);
      if (r.state === 'bottom') {
        if (!ctx.bottomAt) ctx.bottomAt = nowTs;
        const at = info.attach;
        const done = at && attachmentDone(at);
        if (done) return { state: 'module-done', module: 'document', detail: r };
        if (nowTs - ctx.bottomAt > 15000) {
          markLocalDone(info.courseId, key);
          return { state: 'module-done', module: 'document', forced: true, detail: r };
        }
        return { state: 'bottom', module: 'document', detail: r, waitDone: true };
      }
      return { state: r.state, module: 'document', detail: r };
    }
    return { state: 'unsupported', module: type, src: info.src };
  }

  // ---------------------------------------------------------------- 页面结构解剖（智能识别本页任务点）
  /* #region cxh-anatomy */
  /**
   * 旧逻辑假设“一个页面 = 一个任务点”：视频一播完就把整页当成完成，于是立刻跳下一节。
   * 新版页面里「课程要求 / 视频 / 文档(PPT) / 测验」常常同页，必须先看清结构再动手。
   *
   * 三层识别（可靠性从高到低）：
   *   L1 数据层：cards 页内联脚本 `mArg` 里的 attachments（job / isPassed / type / objectid），最准；
   *   L2 目录层：`#prev_tab li / .prev_ul li` 页签 + `[class*=ans-job-icon]` 任务点图标 + 附件 iframe；
   *   L3 媒体层：只回答“播到哪 / 翻到哪”，**不**回答“是否完成”。
   * 完成状态一律回读标记（图标 aria-label / ans-job-finished / mArg.isPassed），
   * 只有本页所有任务点都回读为已完成（或确认无法完成）才允许离开本页。
   */
  const ANAT_LABEL = {
    video: '视频', audio: '音频', document: '文档/PPT', book: '图书阅读',
    quiz: '测验/作业', exam: '考试', read: '阅读', discussion: '讨论', live: '直播',
    hyperlink: '链接', microCourse: '微课', page: '小节页', unknown: '未识别模块'
  };
  const ANAT_MIN_MEDIA_SEC = 5;      // 小于该时长的音视频视为装饰/占位，不算任务点
  const ANAT_MEDIA_CONFIRM = 30000;  // 媒体播完到服务端标记出现，最多等这么久
  const ANAT_DOC_BOTTOM_KEEP = 3;    // 文档连续 3 个 tick 到底，才允许本地记完成
  const ANAT_READ_TICKS = 10;        // 无标记的纯阅读页停留这么多 tick 视为读完
  const ANAT_UNIT_TRIES = 4;
  const ANAT_LOAD_TRIES = 30;   // 真媒体（视频/音频）允许等更久
  // 单任务点无进展重试次数，超过即提示人工

  const anatRuntime = new WeakMap(); // 元素的运行状态
  const anatMArgCache = new WeakMap();
  const ANAT = { last: null, at: 0, sig: '', shownKey: '' };

  function anatCtx(el) {
    let c = anatRuntime.get(el);
    if (!c) {
      c = {
        maxRatio: 0, lastT: 0, watched: 0, endedAt: 0, seenEnded: false,
        bottomTicks: 0, maxPage: 0, pageTotal: 0, ticks: 0,
        tries: 0, lastState: '', lastActionAt: 0, doneAt: 0
      };
      anatRuntime.set(el, c);
    }
    return c;
  }

  function anatLabel(kind) { return ANAT_LABEL[kind] || kind || '任务点'; }

  function anatSrcTail(src) {
    const s = String(src || '');
    const m = s.match(/^(?:[a-z]+:)?\/\/([^/]+)\//i);
    const host = m ? m[1].replace(/^www\./, '') : '';
    const file = s.split('?')[0].split('#')[0].split('/').filter(Boolean).slice(-1)[0] || '';
    const tail = [host, file].filter(Boolean).join('/');
    return truncate(tail, 60);
  }

  function anatFrameDoc(f) {
    try { return (f && f.contentDocument) || null; } catch (e) { return null; }
  }

  function anatFrameWin(f) {
    try { return (f && f.contentWindow) || null; } catch (e) { return null; }
  }

  function anatObjectId(src) {
    const s = String(src || '');
    const m = s.match(/[?&](?:objectid|objectId)=([0-9a-zA-Z]+)/i)
      || s.match(/\/(?:download|status|object)\/([0-9a-zA-Z]{6,})/i);
    return m ? m[1] : '';
  }

  function anatKindFromText(t) {
    const s = String(t || '');
    if (/视频|录像|微课|video/i.test(s)) return 'video';
    if (/音频|听力|audio/i.test(s)) return 'audio';
    if (/测验|作业|习题|练习|测试|quiz|homework/i.test(s)) return 'quiz';
    if (/考试|exam/i.test(s)) return 'exam';
    if (/讨论|discussion|bbscircle/i.test(s)) return 'discussion';
    if (/直播|live/i.test(s)) return 'live';
    if (/图书|阅读|innerbook|readbook/i.test(s)) return 'book';
    if (/文档|ppt|pdf|课件|资料|讲义|教材|doc/i.test(s)) return 'document';
    return '';
  }

  // 从 iframe src / 容器文案判断任务点类型（数据层 type 优先，这里是 DOM 兜底）
  function anatKindFromSrc(src, hint) {
    const s = String(src || '');
    let k = classifySrc(s);
    if (k === 'unknown' || k === 'generic') {
      k = '';
      if (/\/modules\/video\//i.test(s) || /\/ananas\/video\//i.test(s)) k = 'video';
      else if (/\/modules\/audio\//i.test(s)) k = 'audio';
      else if (/\/modules\/innerbook\//i.test(s) || /\/modules\/book\//i.test(s)) k = 'book';
      else if (/\/modules\/(pdf|ppt|pptx|doc|docx|office|image)\//i.test(s)) k = 'document';
      else if (/\/modules\/work\//i.test(s) || /\/work\/doHomeWork/i.test(s)) k = 'quiz';
      else if (/\/ananas\/live\//i.test(s) || /liveinfo/i.test(s)) k = 'live';
      else if (/bbscircle/i.test(s)) k = 'discussion';
      else if (/\/modules\/read\//i.test(s)) k = 'read';
      else if (/hyperlink/i.test(s)) k = 'hyperlink';
    }
    if (!k || k === 'unknown' || k === 'generic') {
      k = anatKindFromText(hint) || '';
    }
    if (k === 'read') k = 'book';
    return k || 'unknown';
  }

  function anatTypeFromData(type, name) {
    const t = String(type || '').toLowerCase();
    if (t === 'video') return 'video';
    if (t === 'audio') return 'audio';
    if (t === 'document') return 'document';
    if (t === 'book') return 'book';
    if (t === 'work' || t === 'workid') return 'quiz';
    if (t === 'live') return 'live';
    if (t === 'microcourse') return 'microCourse';
    if (t === 'hyperlink') return 'hyperlink';
    return anatKindFromText(name) || '';
  }

  // ---- L1 数据层：解析 cards 页内联 mArg（attachments / defaults） ----
  function anatParseMArg(doc) {
    if (!doc) return null;
    const t = now();
    const cached = anatMArgCache.get(doc);
    if (cached && t - cached.at < 3000) return cached.val;
    let val = null;
    try {
      const scripts = $$('script', doc);
      for (let i = 0; i < scripts.length; i++) {
        const src = scripts[i].textContent || '';
        const at = src.indexOf('mArg');
        if (at < 0) continue;
        const eq = src.indexOf('=', at);
        if (eq < 0) continue;
        // 值可能是一个很长的 JS 字符串字面量，里面含 ; 和转义引号：按引号逐字符扫描，
        // 不能用“截到第一个分号”的办法（会截断 mArg 直接导致解析失败）。
        let body = src.slice(eq + 1);
        while (body && /\s/.test(body[0])) body = body.slice(1);
        const q = body[0];
        if (q !== '"' && q !== "'") continue;
        let raw = '';
        let closed = false;
        for (let i = 1; i < body.length; i++) {
          const ch = body[i];
          if (ch === '\\') { raw += ch + body[i + 1]; i++; continue; }
          if (ch === q) { closed = true; break; }
          raw += ch;
        }
        if (!closed || !/\{/.test(raw)) continue;
        let str = raw;
        if (q === '"') {
          try { str = JSON.parse('"' + raw + '"'); } catch (e) {}
        } else {
          str = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        try { val = JSON.parse(str); } catch (e) { val = null; }
        if (!val) {
          try { val = JSON.parse(str.replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } catch (e) { val = null; }
        }
        if (val) break;
      }
    } catch (e) { val = null; }
    anatMArgCache.set(doc, { at: t, val: val });
    return val;
  }

  function anatDataAttachments(mArg) {
    if (!mArg || !mArg.attachments || !mArg.attachments.length) return [];
    const out = [];
    mArg.attachments.forEach((a) => {
      if (!a) return;
      const property = a.property || {};
      const objectid = property.objectid || a.objectid || '';
      const name = property.name || a.name || '';
      const type = anatTypeFromData(property.module || a.type || a.attachmentType, name);
      const job = a.job === true || a.job === 'true' || a.job === 1;
      out.push({
        objectid: String(objectid),
        name: name,
        type: type || 'unknown',
        job: job,
        passed: !!(a.isPassed === true || a.isPassed === 'true' || a.isPassed === 1),
        raw: a
      });
    });
    return out;
  }

  function anatPassedByData(list, objectid) {
    if (!list || !list.length || !objectid) return null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].objectid && String(list[i].objectid) === String(objectid)) {
        return list[i].job ? list[i].passed : null;
      }
    }
    return null;
  }

  function anatKindByData(list, objectid) {
    if (!list || !list.length || !objectid) return '';
    for (let i = 0; i < list.length; i++) {
      if (String(list[i].objectid) === String(objectid)) return list[i].type;
    }
    return '';
  }

  // ---- L2 目录层：页签 / 任务点图标 / 附件容器 ----
  function anatIconOf(el, root) {
    // 任务点图标通常就在附件 iframe 前面（同一容器内），向后找兄弟节点
    try {
      let cur = el;
      for (let depth = 0; depth < 4 && cur && cur !== root; depth++) {
        let sib = cur.previousElementSibling;
        for (let k = 0; k < 6 && sib; k++) {
          if (sib.className && /ans-job-icon|job-icon|jobIcon/.test(String(sib.className))) return sib;
          const inner = $('[class*="ans-job-icon"]', sib);
          if (inner) return inner;
          sib = sib.previousElementSibling;
        }
        cur = cur.parentElement;
      }
    } catch (e) {}
    return null;
  }

  function anatIconState(icon, el) {
    if (!icon && !el) return '';
    try {
      const box = icon || el;
      const label = [attr(box, 'aria-label'), attr(box, 'title'), attr(box, 'data-status'), text(box)]
        .join(' ').replace(/\s+/g, ' ');
      if (/未完成|未开始|未学|待完成|任务点未完成/.test(label)) return 'undone';
      if (/任务点已完成|已完成|已学完|已通过/.test(label)) return 'done';
      const cls = String((box.className || '') + ' ' + (el && el.className || ''));
      if (/ans-job-finished|job-finished|icon_Completed/.test(cls)) return 'done';
      // 注意：ans-job-icon-clear 只是样式类，与完成无关，不能用来判断
    } catch (e) {}
    return '';
  }

  function anatSrvState(unit) {
    // 四套标记取并集：任意一套说“已完成”就是已完成；全部明确说“未完成”才判未完成
    try {
      if (unit.dataPassed === true) return 'done';
      const iconSt = anatIconState(unit.icon, unit.orderEl);
      if (iconSt === 'done') return 'done';
      if (unit.orderEl && unit.orderEl.className && /ans-job-finished/.test(String(unit.orderEl.className))) return 'done';
      if (unit.wrap && unit.wrap.className && /ans-job-finished/.test(String(unit.wrap.className))) return 'done';
      let wrapped = '';
      if (unit.wrap) {
        const icons = $$('[class*="ans-job-icon"]', unit.wrap);
        for (let i = 0; i < icons.length; i++) {
          const s = anatIconState(icons[i], unit.wrap);
          if (s === 'done') return 'done';
          if (s && !wrapped) wrapped = s;
        }
      }
      // 只有唯一任务点时，才允许用页面级图标兜底
      if (unit.onlyUnitOnPage) {
        const pageIcons = $$('[class*="ans-job-icon"]', unit.root || unit.orderEl.ownerDocument || document)
          .filter((e) => looseVisible(e));
        if (pageIcons.length === 1) {
          const s = anatIconState(pageIcons[0], pageIcons[0]);
          if (s === 'done') return 'done';
          if (s && !wrapped) wrapped = s;
        }
      }
      if (unit.dataPassed === false) return 'undone';
      if (iconSt === 'undone') return 'undone';
      if (wrapped) return wrapped;
    } catch (e) {}
    return '';
  }

  // ---- 作用域：当前小节页（可能包含多个页签） ----
  function anatFindCardsDoc() {
    try {
      const docs = docsFrom(document, 4);
      for (let i = 0; i < docs.length; i++) {
        const d = docs[i];
        try {
          if ($$('#prev_tab > li, .prev_ul > li', d).length) return d;
          if ($$('[id^="dct"][cardid], .ans-attach-ct', d).length) return d;
        } catch (e) {}
      }
      for (let i = 0; i < docs.length; i++) {
        const d = docs[i];
        if (anatParseMArg(d)) return d;
      }
    } catch (e) {}
    return document;
  }

  function anatScope(doc) {
    const base = doc || document;
    let cardsD = base;
    let pager = null;
    try { pager = pagerInfo(base); } catch (e) { pager = null; }
    if (!pager) {
      const cd = anatFindCardsDoc();
      if (cd && cd !== base) {
        cardsD = cd;
        try { pager = pagerInfo(cd); } catch (e) { pager = null; }
      }
    }
    let mArg = anatParseMArg(cardsD);
    if (!mArg) {
      try {
        const ds = anatScanDocs(cardsD);
        for (let i = 0; i < ds.length && !mArg; i++) mArg = anatParseMArg(ds[i]);
      } catch (e) {}
    }
    const defaults = (mArg && mArg.defaults) || {};
    if (pager && pager.tabs && pager.tabs.length >= 2) {
      return {
        kind: 'paged', doc: cardsD, root: pager.root || cardsD.body || cardsD.documentElement,
        pager: pager, mArg: mArg, defaults: defaults,
        key: 'page|' + pagedScope(pager) + '#' + (pager.idx + 1),
        title: (norm(text(pager.tabs[pager.idx] || '')) || ('第 ' + (pager.idx + 1) + ' 页')).slice(0, 50)
      };
    }
    const tabs = cardTabs(cardsD);
    if (tabs.length) {
      const act = tabs.find((t) => isTabActive(t)) || tabs[0];
      const id = attr(act, 'cardid') || attr(act, 'card') || act.id.replace(/^dct/, '') || '0';
      return {
        kind: 'card', doc: cardsD, root: cardsD.body || cardsD.documentElement,
        tabs: tabs, activeTab: act, cardId: id, mArg: mArg, defaults: defaults,
        key: 'card|' + id,
        title: (text(act).replace(/^\s*\d+[、.．]?\s*/, '').replace(/\s+/g, ' ') || ('任务点 ' + id)).slice(0, 50)
      };
    }
    return {
      kind: 'solo', doc: cardsD, root: cardsD.body || cardsD.documentElement,
      mArg: mArg, defaults: defaults,
      key: 'solo|' + truncate(String((location && location.href) || ''), 100),
      title: '当前页'
    };
  }

  function anatMediaUnits(scope) {
    const out = [];
    const root = scope.root || scope.doc;
    let vids = [];
    try { vids = $$('video', root); } catch (e) { vids = []; }
    vids = vids.filter((v) => {
      try {
        if (!v.isConnected || !looseVisible(v)) return false;
        const d = Number(v.duration || 0);
        const inModule = !!v.closest('iframe');
        return d >= ANAT_MIN_MEDIA_SEC || !v.paused || inModule === false && d > 0;
      } catch (e) { return false; }
    });
    if (vids.length > 1) {
      // 取“主视频”：容器 id=video 的最优先，其次时长/面积最大
      vids.sort((a, b) => {
        const score = (v) => {
          let s = 0;
          if (v.id === 'video') s += 100000;
          if (v.closest && v.closest('#video')) s += 50000;
          s += Math.min(2000, Math.round(Number(v.duration || 0)));
          try { const r = v.getBoundingClientRect(); s += r.width * r.height / 1000; } catch (e) {}
          return s;
        };
        return score(b) - score(a);
      });
      vids = vids.slice(0, 1);
    }
    vids.forEach((v) => out.push({
      kind: 'video', mediaEl: v, doc: v.ownerDocument, orderEl: v,
      detail: '内嵌视频 ' + Math.round(Number(v.duration || 0)) + 's'
    }));
    let auds = [];
    try { auds = $$('audio', root); } catch (e) { auds = []; }
    auds = auds.filter((a) => {
      try { return a.isConnected && looseVisible(a) && (Number(a.duration || 0) >= ANAT_MIN_MEDIA_SEC || !a.paused); } catch (e) { return false; }
    }).slice(0, 1);
    auds.forEach((a) => out.push({
      kind: 'audio', mediaEl: a, doc: a.ownerDocument, orderEl: a,
      detail: '内嵌音频 ' + Math.round(Number(a.duration || 0)) + 's'
    }));
    return out;
  }

  function anatDomOrder(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 0;
    try {
      const r = a.compareDocumentPosition(b);
      if (r & 4) return -1;
      if (r & 2) return 1;
    } catch (e) {}
    return 0;
  }

  /**
   * 扫描当前页面的任务点单元。
   * 单元字段：kind（video/document/quiz/...）、orderEl（用于排序与事件）、doc、frame、icon、wrap、
   *          objectid、dataPassed（true/false/null）、src、detail、scope
   */
  // 模块页（ananas/work/bbscircle）内部不再展开，避免把播放器内层 iframe 当成新任务点
  function anatIsModuleDoc(d) {
    try {
      const u = String((d && d.URL) || '');
      return /\/ananas\/modules\//i.test(u) || /\/mooc2\/work\//i.test(u) || /\/work\/dohomework/i.test(u) || /bbscircle/i.test(u);
    } catch (e) { return false; }
  }

  function anatScanDocs(baseDoc) {
    let docs = [];
    try { docs = docsFrom(baseDoc || document, 3); } catch (e) { docs = [baseDoc || document]; }
    return docs.filter((d) => !anatIsModuleDoc(d));
  }

  function anatFindMArg(docs) {
    for (let i = 0; i < docs.length; i++) {
      const v = anatParseMArg(docs[i]);
      if (v) return v;
    }
    return null;
  }

  function anatCollect(scope, courseId) {
    const doc = scope.doc || document;
    const root = scope.root || doc.body || doc.documentElement;
    const baseDoc = root.ownerDocument || doc;
    const docs = anatScanDocs(baseDoc);
    const dataList = anatDataAttachments(scope.mArg || anatFindMArg(docs));
    const units = [];
    const seenFrames = new Set();

    const push = (u) => {
      if (!u || !u.orderEl) return;
      if (u.kind === 'unknown' && !u.frame && !u.mediaEl && !u.doc) return;
      for (let i = 0; i < units.length; i++) {
        if (units[i].orderEl === u.orderEl) return;
      }
      units.push(u);
    };

    // 1) 附件容器 .ans-attach-ct（含图标 + iframe）
    let attaches = [];
    docs.forEach((d) => {
      try { $$('.ans-attach-ct', d).forEach((el) => attaches.push(el)); } catch (e) {}
    });
    if (!attaches.length) {
      docs.forEach((d) => {
        try { $$('.ans-attach, .attach-ct, [data-attach-url], iframe.ans-attach-online', d).forEach((el) => attaches.push(el)); } catch (e) {}
      });
    }
    if (attaches.length) {
      attaches.filter((el) => looseVisible(el)).forEach((at, i) => {
        const f = attachmentIframe(at) || (at.tagName === 'IFRAME' ? at : null);
        const src = f ? (attr(f, 'src') || '') : (attr(at, 'data-attach-url') || attachmentSrc(at));
        if (!f && !src) return;
        if (f) seenFrames.add(f);
        const icon = $('[class*="ans-job-icon"]', at) || anatIconOf(at, at.ownerDocument);
        const oid = anatObjectId(src);
        const kind = (oid && anatKindByData(dataList, oid)) || anatKindFromSrc(src, text(at)) || 'unknown';
        push({
          kind: kind, orderEl: at, wrap: at, frame: f, doc: anatFrameDoc(f), src: src,
          objectid: oid, icon: icon, detail: anatSrcTail(src), scope: scope,
          dataPassed: oid ? anatPassedByData(dataList, oid) : null, tag: 'a' + i
        });
      });
    }

    // 2) 散落的附件 iframe（不在 .ans-attach-ct 里）
    try {
      const frameCandidates = [];
      docs.forEach((d) => { try { $$('iframe', d).forEach((f) => frameCandidates.push(f)); } catch (e) {} });
      frameCandidates.filter((f) => looseVisible(f)).forEach((f, i) => {
        if (seenFrames.has(f)) return;
        const src = attr(f, 'src') || '';
        if (!src || /^about:blank|javascript:/i.test(src)) return;
        const oid = anatObjectId(src);
        const kind = (oid && anatKindByData(dataList, oid)) || anatKindFromSrc(src, '');
        if (kind === 'unknown') return;
        if (!/video|audio|document|book|quiz|exam|live|discussion|read|hyperlink/i.test(kind) &&
            !/ananas|mooc-ans|mooc2|work|pdf|ppt|video/i.test(src)) return;
        seenFrames.add(f);
        push({
          kind: kind, orderEl: f, frame: f, doc: anatFrameDoc(f), src: src,
          objectid: oid, icon: anatIconOf(f, f.ownerDocument), detail: anatSrcTail(src), scope: scope,
          dataPassed: oid ? anatPassedByData(dataList, oid) : null, tag: 'f' + i
        });
      });
    } catch (e) {}

    // 3) 页内音视频（同文档，例如旧版页面把播放器直接放正文）
    anatMediaUnits(scope).forEach((u) => push(Object.assign(u, { scope: scope })));

    // 4) 页内题目（没有 work iframe 的页面）
    let hasQuizUnit = units.some((u) => u.kind === 'quiz' || u.kind === 'exam');
    if (!hasQuizUnit) {
      try {
        const qs = questionRoots(root);
        if (qs.length) {
          push({
            kind: 'quiz', orderEl: qs[0], doc: doc, scope: scope,
            detail: qs.length + ' 道题', icon: null, dataPassed: null, tag: 'q'
          });
        }
      } catch (e) {}
    }

    // 5) 内嵌文档/PPT 阅读器容器（无 iframe 时）
    try {
      const holder = $('#panView, .pptPlayer, .pdfViewer, #viewerContainer, .innerbook', root);
      if (holder && looseVisible(holder) && !units.some((u) => u.orderEl === holder)) {
        push({ kind: 'document', orderEl: holder, doc: doc, scope: scope, detail: '内嵌阅读器', icon: null, dataPassed: null, tag: 'd' });
      }
    } catch (e) {}

    // 清理：链接/微课这类不需要处理的类型直接不纳入
    const skipKinds = { hyperlink: true, microCourse: true };
    const list = units.filter((u) => !skipKinds[u.kind]);
    list.sort((a, b) => anatDomOrder(a.orderEl, b.orderEl));
    list.forEach((u, i) => {
      u.index = i;
      u.label = anatLabel(u.kind);
      u.onlyUnitOnPage = list.length === 1;
      u.key = scope.key + '#' + u.kind + '#' + (u.objectid || (u.tag || i));
      // 讨论 / 直播：没有安全的全自动方案，明确列为“跳过”
      u.manual = u.kind === 'discussion' || u.kind === 'live';
    });
    return list;
  }

  function anatMediaOf(unit) {
    if (!unit) return null;
    if (unit.mediaEl && unit.mediaEl.isConnected) return unit.mediaEl;
    const doc = unit.doc;
    if (!doc) return null;
    try {
      if (unit.kind === 'audio') return findMainAudio(doc);
      return findMainVideo(doc);
    } catch (e) { return null; }
  }

  function anatSample(unit, driveState) {
    if (!unit) return;
    const c = anatCtx(unit.orderEl);
    c.ticks++;
    if (driveState) c.lastState = driveState;
    if (unit.kind === 'video' || unit.kind === 'audio') {
      const m = anatMediaOf(unit);
      if (!m) return;
      const d = Number(m.duration || 0);
      const t = Number(m.currentTime || 0);
      if (d >= ANAT_MIN_MEDIA_SEC) {
        c.duration = d;
        const ratio = clamp(t / d, 0, 1);
        c.maxRatio = Math.max(c.maxRatio, ratio);
        if (!m.paused) {
          const dt = t - c.lastT;
          if (dt > 0 && dt < 5) c.watched += dt;
        }
        c.lastT = t;
        if (m.ended) {
          c.seenEnded = true;
          if (!c.endedAt) c.endedAt = now();
        }
      }
      return;
    }
    if (unit.kind === 'document' || unit.kind === 'book') {
      const info = anatPageNumbers(unit.doc || (unit.orderEl && unit.orderEl.ownerDocument));
      if (info) {
        c.pageTotal = info.total || c.pageTotal;
        c.maxPage = Math.max(c.maxPage, info.cur || 0);
        if (c.pageTotal > 1 && c.maxPage >= c.pageTotal) c.sawLastPage = true;
      }
      if (driveState === 'bottom') c.bottomTicks++;
      else if (driveState) c.bottomTicks = 0;
      return;
    }
    if (unit.kind === 'quiz' || unit.kind === 'exam') {
      if (driveState === 'done' || driveState === 'filled') c.lastQuiz = driveState;
    }
  }

  // 文档页码：优先隐藏 input/页码元素，其次 body 文本里的 “3 / 20”“第3页 共20页”
  function anatPageNumbers(doc) {
    if (!doc || !doc.body) return null;
    try {
      let cur = 0, total = 0;
      const inputs = $$('input', doc);
      for (let i = 0; i < inputs.length && i < 80; i++) {
        const el = inputs[i];
        const sig = String(el.className || '') + ' ' + String(el.id || '') + ' ' + String(el.getAttribute && el.getAttribute('title') || '');
        if (!/page|pager|pagenum|jump/i.test(sig)) continue;
        const v = String(el.value || '').trim();
        if (/^\d{1,4}$/.test(v)) { cur = Number(v); break; }
      }
      const bodyText = text(doc.body).slice(0, 3000);
      let m = bodyText.match(/(\d{1,4})\s*\/\s*(\d{1,4})(?!\d)/);
      if (!m) m = bodyText.match(/第\s*(\d{1,4})\s*页[^\d]{0,10}?共\s*(\d{1,4})\s*页/);
      if (m) {
        if (!cur) cur = Number(m[1]);
        total = Number(m[2]);
      }
      if (!total) {
        const mm = bodyText.match(/共\s*(\d{1,4})\s*页/);
        if (mm) total = Number(mm[1]);
      }
      if (cur > 0 && total >= cur) return { cur: cur, total: total };
      return null;
    } catch (e) { return null; }
  }

  // 完成判定：数据层/图标标记优先，媒体进度只在“没有任何标记”时兜底
  function anatUnitState(unit, courseId) {
    if (!unit) return 'done';
    if (isLocalSkipped(courseId, unit.key)) return 'skipped';
    if (isLocalDone(courseId, unit.key)) return 'done';
    if (unit.manual) return 'manual';
    const srv = anatSrvState(unit);
    if (srv === 'done') return 'done';
    const c = anatCtx(unit.orderEl);
    if (unit.kind === 'quiz' || unit.kind === 'exam') {
      try { if (unit.doc && isQuizSubmitted(quizDocFor(unit.doc))) return 'done'; } catch (e) {}
      if (c.lastQuiz === 'done') return 'done';
    }
    if (srv === 'undone') {
      // 标记明确说没完成：只接受“本地已确认完成”的兜底，绝不按进度猜
      return 'pending';
    }
    if (unit.kind === 'video' || unit.kind === 'audio') {
      const d = Number(c.duration || 0);
      if (c.maxRatio >= 0.97 || (c.seenEnded && d >= ANAT_MIN_MEDIA_SEC && c.maxRatio >= 0.9)) return 'done';
      return 'pending';
    }
    if (unit.kind === 'document' || unit.kind === 'book') {
      if (c.sawLastPage) return 'done';
      if (c.bottomTicks >= ANAT_DOC_BOTTOM_KEEP) return 'done';
      return 'pending';
    }
    if (unit.kind === 'read') return c.ticks >= ANAT_READ_TICKS ? 'done' : 'pending';
    if (unit.kind === 'unknown') return 'pending';
    return 'pending';
  }

  function anatRows(units, courseId) {
    return units.map((u) => {
      let state = 'pending';
      try { state = anatUnitState(u, courseId); } catch (e) { state = 'pending'; }
      return {
        key: u.key, kind: u.kind, label: u.label, state: state,
        done: state === 'done' || state === 'manual',
        detail: u.detail || '',
        src: u.src || '',
        reason: state === 'manual' ? '需要手动完成' : ''
      };
    });
  }

  function anatPublish(scope, rows) {
    const sig = scope.kind + '|' + scope.key + '|' + rows.map((r) => r.kind + ':' + r.state).join(',');
    ANAT.at = now();
    ANAT.last = { scope: scope, rows: rows, at: ANAT.at, sig: sig };
    const pending = rows.filter((r) => !r.done);
    S.anatomy = {
      title: scope.title || '',
      kind: scope.kind,
      at: ANAT.at,
      total: rows.length,
      pending: pending.length,
      rows: rows.map((r) => ({ label: r.label, state: r.state, detail: r.detail }))
    };
    if (sig !== ANAT.shownKey) {
      ANAT.shownKey = sig;
      if (rows.length) {
        const desc = rows.map((r) => r.label + '（' + (r.state === 'done' ? '已完成' : r.state === 'manual' ? '需手动' : r.state === 'skipped' ? '已跳过' : '待完成') + '）').join('、');
        log('本页识别到 ' + rows.length + ' 个任务点：' + desc);
        setMessage('本页任务点：' + (rows.length - pending.length) + ' / ' + rows.length + ' 已完成');
      }
    }
    if (IS_TOP) emit('state');
    return ANAT.last;
  }

  function anatPendingCount(scope, courseId) {
    try {
      const units = anatCollect(scope, courseId);
      const rows = anatRows(units, courseId);
      // 已跳过（skipped）的单元不再算“待完成”，否则结构守卫会一直拦住翻页
      return rows.filter((r) => !r.done && r.state !== 'skipped').length;
    } catch (e) { return 0; }
  }

  // 切页/切任务点前的结构守卫：本页还有未完成任务点就原地等；连续多轮无进展则熔断放行
  function anatAdvanceGuard(doc, courseId) {
    let left = 0;
    let scope = null;
    try {
      scope = anatScope(doc || document);
      left = anatPendingCount(scope, courseId);
    } catch (e) { return 0; }
    if (!left) { ANAT.guardKey = ''; ANAT.guardStrikes = 0; return 0; }
    if (ANAT.guardKey !== scope.key) { ANAT.guardKey = scope.key; ANAT.guardStrikes = 0; }
    ANAT.guardStrikes++;
    if (ANAT.guardStrikes > 20) {
      if (ANAT.guardStrikes === 21) warn('本页任务点长时间无进展，先按既有进度继续（可能仍有未完成项）');
      return 0;
    }
    setMessage('本页还有 ' + left + ' 个任务点未完成，继续处理本页…');
    return left;
  }

  // 供其它流程调用：本页是否还有未完成任务点（防止“看一眼视频就跳下一节”）
  function anatPagePending(doc, courseId) {
    try {
      const scope = anatScope(doc || document);
      return anatPendingCount(scope, courseId);
    } catch (e) { return 0; }
  }

  // ---- 页签切换：优先调用页面自带的 changeDisplayContent，合成点击常常无效 ----
  function anatFindGlobalFn(names) {
    let docs = [];
    try { docs = docsFrom(document, 4); } catch (e) { docs = [document]; }
    for (let i = 0; i < docs.length; i++) {
      const w = docs[i].defaultView;
      if (!w) continue;
      for (let j = 0; j < names.length; j++) {
        try {
          if (typeof w[names[j]] === 'function') return { win: w, fn: w[names[j]], name: names[j], doc: docs[i] };
        } catch (e) {}
      }
    }
    return null;
  }

  function anatDisplayCtx(scope) {
    const d = (scope && scope.defaults) || {};
    const q = pageQuery();
    return {
      courseId: d.courseId || q.courseId || S.course.id || '',
      clazzId: d.clazzId || d.clazzid || q.clazzId || '',
      chapterId: d.knowledgeid || d.chapterId || q.chapterId || ''
    };
  }

  async function anatSwitchTab(scope, targetIdx) {
    const tabs = (scope && (scope.tabs || (scope.pager && scope.pager.tabs))) || [];
    if (!tabs.length || targetIdx < 0 || targetIdx >= tabs.length) return { ok: false, reason: 'tab-out-of-range' };
    const tab = tabs[targetIdx];
    const ctx = anatDisplayCtx(scope);
    const before = anatTabSignature(scope);
    const fn = anatFindGlobalFn(['changeDisplayContent']);
    if (fn && ctx.chapterId) {
      try {
        fn.fn.call(fn.win, targetIdx + 1, tabs.length, ctx.chapterId, ctx.courseId, ctx.clazzId, '');
        const ok1 = await waitFor(() => anatTabSignature(scope) !== before, 6000, 300);
        if (ok1) { await sleep(rand(400, 900)); return { ok: true, via: 'changeDisplayContent' }; }
      } catch (e) {}
    }
    // 兜底：真实点击页签及其内部元素
    try {
      clickEl(tab);
      $$('a,span,div', tab).forEach((e) => clickEl(e));
    } catch (e) {}
    const ok2 = await waitFor(() => anatTabSignature(scope) !== before, 6000, 300);
    await sleep(rand(500, 1100));
    return { ok: !!ok2, via: ok2 ? 'click' : '' };
  }

  function anatTabSignature(scope) {
    try {
      if (scope.kind === 'paged') {
        const p = pagerInfo(scope.doc) || scope.pager;
        return 'p' + (p ? p.idx : -1);
      }
      const card = $('input#cardId, #cardId', scope.doc);
      if (card && card.value) return 'c' + card.value;
      const tabs = scope.tabs || cardTabs(scope.doc);
      const idx = tabs.findIndex((t) => isTabActive(t));
      return 't' + idx;
    } catch (e) { return ''; }
  }

  // 找到“完成文档/PPT”所需的页面接口：外壳窗口上的 finishJob / onchangepage
  function anatFinishDoc(unit) {
    const win = anatFrameWin(unit.frame);
    const tries = [];
    if (win) {
      try { if (typeof win.finishJob === 'function') tries.push({ fn: win.finishJob, win: win, name: 'finishJob' }); } catch (e) {}
      try {
        const attr = win.getFrameAttr;
        if (typeof win.onchangepage === 'function' && typeof attr === 'function') {
          tries.push({ fn: function () { return win.onchangepage(attr('end')); }, win: win, name: 'onchangepage' });
        }
      } catch (e) {}
    }
    for (let i = 0; i < tries.length; i++) {
      try {
        const r = tries[i].fn.call(tries[i].win);
        log('已调用 ' + tries[i].name + '() 上报文档任务点' + (r === false ? '（返回 false）' : ''));
        return { ok: true, via: tries[i].name };
      } catch (e) {}
    }
    return { ok: false };
  }

  // ---- 驱动单个单元（媒体/文档/测验），返回内部状态 ----
  const ANAT_STATE_MAP = {
    loading: 'loading', playing: 'playing', paused: 'paused', popup: 'popup',
    ended: 'ended', stalled: 'stalled', blocked: 'blocked',
    scrolling: 'scrolling', paging: 'paging', bottom: 'bottom',
    done: 'done', filled: 'filled', skipped: 'skipped', waiting: 'waiting',
    error: 'error', unsupported: 'unsupported'
  };

  async function anatDrive(unit, courseId) {
    const c = anatCtx(unit.orderEl);
    c.tries++;
    // 跨域 iframe 读不到 document：本页只负责“知道它存在”，驱动交给各模块自己的 agent
    if (unit.frame && !unit.doc) {
      return { state: 'cross-origin', frame: unit.frame, src: unit.src, type: unit.kind };
    }
    if (unit.kind === 'video' || unit.kind === 'audio') {
      const m = anatMediaOf(unit);
      if (!m) return { state: 'loading', reason: 'media-not-ready' };
      const r = unit.kind === 'video' ? await driveVideo(unit.doc || document) : await driveAudio(unit.doc || document);
      return r;
    }
    if (unit.kind === 'document' || unit.kind === 'book') {
      const fin = anatFinishDoc(unit);
      if (fin.ok) {
        await sleep(rand(500, 900));
        const srv = anatSrvState(unit);
        if (srv === 'done') return { state: 'done', via: fin.via };
      }
      const r = await driveDocument(unit.doc || document);
      return r;
    }
    if (unit.kind === 'quiz' || unit.kind === 'exam') {
      if (unit.kind === 'exam' && !CFG.answerExam) return { state: 'skipped', reason: 'exam-disabled' };
      const qd = quizDocFor(unit.doc || document);
      const r = await solveQuizPage(qd, { courseName: S.course.name || CFG.courseName });
      return { state: r.status, reason: r.reason, detail: r.detail, count: r.count, quizDoc: qd };
    }
    if (unit.kind === 'read') {
      await sleep(rand(800, 1400));
      return { state: 'reading' };
    }
    if (unit.frame) {
      const same = !!unit.doc;
      if (same) return { state: 'waiting', reason: 'module-loading' };
      return { state: 'cross-origin', frame: unit.frame, src: unit.src, type: unit.kind };
    }
    return { state: 'unsupported' };
  }

  /**
   * 解剖 + 驱动一次。返回值给 handleCardsResult 使用。
   * handled=false 表示本页没有可识别的任务点（例如纯文字“课程要求”页），交给旧逻辑翻页。
   */
  async function anatTick(doc, opts) {
    opts = opts || {};
    const courseId = opts.courseId || S.course.id || '';
    const scope = anatScope(doc);
    let units = anatCollect(scope, courseId);
    units.forEach((u) => anatSample(u, u.lastDriveState));
    let rows = anatRows(units, courseId);
    anatPublish(scope, rows);
    const base = {
      handled: true, scope: scope, paged: scope.kind === 'paged',
      card: { id: scope.key, key: scope.key }, items: opts.items || [],
      rows: rows, pageTitle: scope.title
    };
    if (!rows.length) return { handled: false, scope: scope, rows: rows };
    const pendingRows = rows.filter((r) => !r.done && r.state !== 'skipped');
    if (!pendingRows.length) {
      try { markLocalDone(courseId, scope.key); } catch (e) {}
      return Object.assign({}, base, {
        state: scope.kind === 'paged' ? 'page-complete' : 'page-complete',
        module: rows[0].kind, label: '本页任务点'
      });
    }
    const row = pendingRows[0];
    const unit = units[rows.indexOf(row)];
    if (!unit) return { handled: false, scope: scope, rows: rows };
    if (unit.manual) {
      return Object.assign({}, base, { state: 'need-manual', module: unit.kind, label: unit.label, reason: 'manual-task' });
    }
    // 讨论区 / 直播 / 论坛这类本来就没有“可自动完成”入口的模块，直接当不认识处理
    if (unit.kind === 'discussion' || unit.kind === 'live'
      || (unit.kind === 'unknown' && /discuss|bbs|forum|live|zhibo|chat/i.test(String(unit.src || '') + ' ' + String(unit.label || '')))) {
      return Object.assign({}, base, {
        state: 'need-manual', module: unit.kind, label: unit.label || '讨论',
        reason: 'unsupported-kind', unitRow: row
      });
    }
    const r = await anatDrive(unit, courseId);
    const st = (r && r.state) || 'unknown';
    unit.lastDriveState = st;
    anatSample(unit, st);
    rows = anatRows(units, courseId);
    const after = { scope: scope, rows: rows, at: now(), sig: scope.kind + '|' + scope.key + '|' + rows.map((x) => x.kind + ':' + x.state).join(',') };
    ANAT.at = after.at;
    ANAT.last = after;
    anatPublish(scope, rows);
    const meta = Object.assign({}, base, {
      rows: rows, module: unit.kind, label: unit.label,
      unitRow: rows[rows.indexOf(row)] || null
    });
    if (st === 'cross-origin') {
      return Object.assign({}, meta, {
        state: 'cross-origin', type: unit.kind, src: unit.src,
        frame: unit.frame, index: unit.index, unitKey: unit.key
      });
    }
    const myRow = rows.filter((x) => x.key === unit.key)[0] || null;
    if (myRow && myRow.done) {
      return Object.assign({}, meta, { state: 'unit-done', unitKey: unit.key });
    }
    if (st === 'blocked') return Object.assign({}, meta, { state: 'blocked', reason: r.reason || '' });
    if (unit.kind === 'quiz' || unit.kind === 'exam') {
      if (st === 'skipped') {
        markLocalSkipped(courseId, unit.key);
        return Object.assign({}, meta, { state: 'skipped', reason: r.reason || 'quiz-skipped' });
      }
      if (st === 'waiting') return Object.assign({}, meta, { state: 'waiting', reason: 'quiz-waiting' });
      if (st === 'error') return Object.assign({}, meta, { state: 'error', reason: r.reason || r.detail || 'quiz-error' });
      return Object.assign({}, meta, { state: 'unit-progress', detail: r });
    }
    if (st === 'unsupported' || st === 'unknown') {
      const c = anatCtx(unit.orderEl);
      if (c.tries >= ANAT_UNIT_TRIES) return Object.assign({}, meta, { state: 'need-manual', reason: 'unsupported' });
      return Object.assign({}, meta, { state: 'unit-progress', detail: r });
    }
    // 不认识的模块（讨论 / 直播 / 第三方插件等）常见表现：iframe 一直“加载中”，拿不到任何进度。
    // 真媒体（视频/音频）多等一会儿，其余情况几次拿不到进度就跳过，不要让整门课卡在这里。
    if (st === 'waiting' || st === 'loading') {
      const c2 = anatCtx(unit.orderEl);
      const looksMedia = !!(anatMediaOf(unit) || /video|audio/i.test(String(unit.src || '')) || unit.kind === 'video' || unit.kind === 'audio');
      const limit = looksMedia ? ANAT_LOAD_TRIES : ANAT_UNIT_TRIES;
      if (c2.tries >= limit) {
        warn('「' + (unit.label || unit.kind) + '」加载不出可识别的内容，按“不认识的环节”跳过');
        return Object.assign({}, meta, { state: 'need-manual', reason: 'load-timeout' });
      }
      return Object.assign({}, meta, { state: 'unit-progress', detail: r });
    }
    return Object.assign({}, meta, { state: 'unit-progress', detail: r });
  }

  /**
   * 服务端标记确认：媒体/文档结束时，同页还有别的任务点时不能急着走，
   * 先等“已完成”标记出现；等太久才本地记完成并警告。
   */
  function anatConfirmUnit(unit, courseId) {
    if (!unit) return { done: false };
    const srv = anatSrvState(unit);
    if (srv === 'done') { markLocalDone(courseId, unit.key); return { done: true, via: 'marker' }; }
    const c = anatCtx(unit.orderEl);
    if (!c.endedAt) c.endedAt = now();
    if (now() - c.endedAt >= ANAT_MEDIA_CONFIRM) {
      markLocalDone(courseId, unit.key);
      return { done: true, via: 'local', warn: '任务点未出现“已完成”标记，已按本地记录继续' };
    }
    return { done: false, remain: Math.ceil((ANAT_MEDIA_CONFIRM - (now() - c.endedAt)) / 1000) };
  }

  function anatFindUnitByKey(doc, courseId, key) {
    try {
      const scope = anatScope(doc);
      const units = anatCollect(scope, courseId);
      return units.filter((u) => u.key === key)[0] || null;
    } catch (e) { return null; }
  }

  function anatSummaryText(rows) {
    if (!rows || !rows.length) return '';
    return rows.map((r) => r.label + (r.done ? '✓' : '·')).join(' ');
  }
  /* #endregion cxh-anatomy */

  // ---------------------------------------------------------------- 跨帧桥接
  const TAB_ID = (() => {
    try {
      let v = sessionStorage.getItem('cxh.tab.id');
      if (!v) { v = uuid(); sessionStorage.setItem('cxh.tab.id', v); }
      return v;
    } catch (e) { return uuid(); }
  })();

  function acquireLock() {
    try {
      const cur = store.get(LOCK_KEY, null);
      if (cur && cur.owner && cur.owner !== TAB_ID && now() - Number(cur.at || 0) < 120000) {
        return { ok: false, owner: cur.owner };
      }
      store.set(LOCK_KEY, { owner: TAB_ID, at: now() });
      return { ok: true };
    } catch (e) { return { ok: true }; }
  }
  function lockBeat() {
    try { store.set(LOCK_KEY, { owner: TAB_ID, at: now() }); } catch (e) {}
  }
  function releaseLock() {
    try {
      const cur = store.get(LOCK_KEY, null);
      if (!cur || cur.owner === TAB_ID) store.del(LOCK_KEY);
    } catch (e) {}
  }

  // ============================== TOP 端 ==============================
  const TOP_BRIDGE = {
    agents: new Map(),
    pending: new Map(),
    seq: 0,
    lastProbe: 0
  };

  function topBridgeInit() {
    window.addEventListener('message', onTopMessage);
    setInterval(() => {
      if (S.running && now() - TOP_BRIDGE.lastProbe > 6000) probeAgents();
    }, 3000);
    setInterval(() => {
      // 清理长时间未响应的子页面
      const t = now();
      TOP_BRIDGE.agents.forEach((a, id) => {
        if (t - a.lastSeen > 45000) TOP_BRIDGE.agents.delete(id);
      });
    }, 15000);
  }

  function probeAgents() {
    TOP_BRIDGE.lastProbe = now();
    sendDownToChildren('probe', { want: 'hello' }, 4);
  }

  function registerAgent(payload, via) {
    if (!payload || !payload.frameId) return;
    if (payload.frameId === FRAME_ID) return;
    const old = TOP_BRIDGE.agents.get(payload.frameId) || {};
    TOP_BRIDGE.agents.set(payload.frameId, {
      frameId: payload.frameId,
      kind: payload.kind || old.kind || 'other',
      url: payload.url || old.url || '',
      title: payload.title || old.title || '',
      ready: !!payload.ready,
      hasVideo: !!payload.hasVideo,
      hasQuiz: !!payload.hasQuiz,
      lastSeen: now()
    });
    emit('agents');
  }

  function pickAgent(kind, src) {
    const t = now();
    let list = [];
    TOP_BRIDGE.agents.forEach((a) => {
      if (t - a.lastSeen > 45000) return;
      if (kind && a.kind !== kind) return;
      list.push(a);
    });
    if (!list.length) return null;
    if (src) {
      const s = String(src).toLowerCase();
      const matched = list.filter((a) => {
        try {
          const p = new URL(a.url).pathname.toLowerCase();
          return s.indexOf(p) >= 0 || p.indexOf(s.split('?')[0]) >= 0;
        } catch (e) { return false; }
      });
      if (matched.length) list = matched;
    }
    list.sort((a, b) => b.lastSeen - a.lastSeen);
    return list[0];
  }

  function rpcAgent(agent, cmd, payload, timeout) {
    const id = 'r' + (++TOP_BRIDGE.seq) + '_' + Date.now().toString(36);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        TOP_BRIDGE.pending.delete(id);
        reject(new Error('子页面响应超时（' + cmd + '）'));
      }, timeout || 20000);
      TOP_BRIDGE.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      const ttl = 4;
      sendDownToChildren('cmd', { cmd: cmd, payload: payload || null }, ttl, {
        id: id,
        toFrame: agent ? agent.frameId : '',
        targetKind: agent ? '' : (cmd === 'cards.tick' || cmd === 'cards.list' || cmd === 'cards.advance' || cmd === 'cards.click' ? 'cards' : '')
      });
    });
  }

  function onTopMessage(ev) {
    const d = ev.data;
    if (!isBridgeMsg(d) || d.dir !== 'up') return;
    if (d.type === 'hello') {
      registerAgent(d.payload, ev.source);
      return;
    }
    if (d.type === 'log') {
      const p = d.payload || {};
      const item = {
        id: uuid(), t: Number(p.at) || now(), level: p.level || 'info',
        msg: String(p.msg || ''), data: { from: d.from, reasoning: p.reasoning || null }
      };
      LOGS.push(item);
      if (LOGS.length > LOG_MAX) LOGS.shift();
      try { if (onLogHook) onLogHook(item); } catch (e) {}
      return;
    }
    if (d.type === 'event') {
      const p = d.payload || {};
      if (p.event === 'need-gesture') {
        S.phase = 'need-gesture';
        S.message = '需要一次点击以允许播放';
        emit('state');
      } else if (p.event === 'blocked') {
        S.blocked = true;
        S.blockReason = p.reason || 'blocked';
        emit('state');
      }
      return;
    }
    if (d.type === 'reply') {
      const p = TOP_BRIDGE.pending.get(d.re);
      if (!p) return;
      TOP_BRIDGE.pending.delete(d.re);
      clearTimeout(p.timer);
      const payload = d.payload || {};
      if (payload.ok === false) p.reject(new Error(payload.error || '子页面执行失败'));
      else p.resolve(payload.result);
      return;
    }
  }

  function broadcastConfig() {
    sendDownToChildren('config', CFG, 4);
  }

  function broadcastStop() {
    sendDownToChildren('stop', {}, 4);
  }

  // ============================== 子帧端 ==============================
  const AGENT = { kind: 'other', lastHello: 0, started: false };

  function detectAgentKind() {
    let kind = classifyPage();
    if (kind === 'other' || kind === 'module') {
      try {
        if (document.querySelector('.ans-attach-ct,[id^="dct"][cardid]')) kind = 'cards';
        else if (document.querySelector('video')) kind = 'video';
        else if (document.querySelector('audio')) kind = 'audio';
        else if (document.querySelector('.TiMu,.questionLi')) kind = 'work';
      } catch (e) {}
    }
    return kind;
  }

  function sendHello(force) {
    const t = now();
    if (!force && t - AGENT.lastHello < 2500) return;
    AGENT.lastHello = t;
    let hasVideo = false, hasQuiz = false;
    try {
      hasVideo = !!document.querySelector('video');
      hasQuiz = !!document.querySelector('.TiMu,.questionLi');
    } catch (e) {}
    sendUp('hello', {
      frameId: FRAME_ID,
      kind: AGENT.kind,
      url: location.href,
      title: document.title || '',
      ready: document.readyState === 'complete' || document.readyState === 'interactive',
      hasVideo: hasVideo,
      hasQuiz: hasQuiz
    });
  }

  function agentInit() {
    AGENT.kind = detectAgentKind();
    S.pageKind = AGENT.kind;
    window.addEventListener('message', onAgentMessage);
    sendHello(true);
    setInterval(() => sendHello(false), 12000);
  }

  function onAgentMessage(ev) {
    const d = ev.data;
    if (!isBridgeMsg(d)) return;
    if (d.dir === 'up') {
      // 转发子帧的上行消息
      if (!IS_TOP && d.from !== FRAME_ID) {
        try { window.parent.postMessage(d, '*'); } catch (e) {}
      }
      return;
    }
    if (d.dir !== 'down') return;

    const addressedToMe = (!d.toFrame || d.toFrame === FRAME_ID);
    const kindOk = (!d.targetKind || d.targetKind === AGENT.kind);

    if (d.type === 'probe') {
      if (kindOk) sendHello(true);
    } else if (d.type === 'config') {
      if (d.payload && typeof d.payload === 'object') {
        CFG = deepMerge(CFG, d.payload);
      }
    } else if (d.type === 'stop') {
      S.running = false;
      try { if (typeof apiAbort === 'function') apiAbort(); } catch (e) {}
    } else if (d.type === 'cmd' && addressedToMe && kindOk) {
      handleAgentCommand(d);
    }

    // 继续向下转发（目标不是本帧，或本来就是广播）
    if (d.ttl > 0) {
      sendDownToChildrenRaw(d);
    }
  }

  function sendDownToChildrenRaw(d) {
    const kids = childWindows();
    kids.forEach((w) => {
      try {
        w.postMessage(Object.assign({}, d, { ttl: d.ttl - 1 }), '*');
      } catch (e) {}
    });
  }

  async function handleAgentCommand(d) {
    const cmd = d.cmd;
    const p = d.payload || {};
    const id = d.id;
    const reply = (result, ok, error) => {
      sendUp('reply', { ok: ok !== false, result: result, error: error || '' }, { re: id });
    };
    try {
      if (cmd === 'cards.list') {
        const items = listCards(document, p.courseId || S.course.id);
        reply({ ready: !!items.length, items: items, active: activeCardItem(items) });
        return;
      }
      if (cmd === 'cards.click') {
        const r = await clickCardTab(document, p.id);
        reply(r);
        return;
      }
      if (cmd === 'cards.advance') {
        const r = await advanceCard(document, p.courseId || S.course.id);
        reply(r);
        return;
      }
      if (cmd === 'cards.tick') {
        const r = await tickCards(document, { courseId: p.courseId || S.course.id });
        reply(r);
        return;
      }
      if (cmd === 'module.tick') {
        const kind = AGENT.kind;
        if (kind === 'video') {
          const r = await driveVideo(document);
          reply(r);
        } else if (kind === 'audio') {
          const r = await driveAudio(document);
          reply(r);
        } else if (kind === 'document') {
          const r = await driveDocument(document);
          reply(r);
        } else if (kind === 'work') {
          const r = await solveQuizPage(document, { courseName: S.course.name });
          reply(r);
        } else {
          reply({ state: 'unsupported', kind: kind });
        }
        return;
      }
      if (cmd === 'status') {
        reply({ kind: AGENT.kind, url: location.href, running: S.running });
        return;
      }
      reply(null, false, 'unknown-command:' + cmd);
    } catch (e) {
      reply(null, false, redact(e && e.message || e));
    }
  }

  // ---------------------------------------------------------------- 顶层编排
  const TOP = {
    ticking: false,
    lastTickAt: 0,
    notBefore: 0,
    cross: { key: '', endedAt: 0, last: '', tries: 0 },
    lastOpenAt: 0,
    lastScanAt: 0,
    lastNoAgentLog: 0,
    lastListLog: 0,
    reloads: 0,
    lastReloadAt: 0,
    errors: 0,
    stuck: 0,
    chapterSwitches: 0,
    notifiedDone: false,
    loopTimer: 0,
    soloCards: false,
    quizBusy: false,
    quizDone: false
  };

  const MODULE_LABEL = { video: '视频', audio: '音频', document: '文档/PPT', quiz: '测验/作业', read: '阅读', page: '小节页' };

  function firstMatch(strs, re) {
    for (let i = 0; i < strs.length; i++) {
      const m = String(strs[i] || '').match(re);
      if (m) return m[1] || '';
    }
    return '';
  }

  function refreshCourse() {
    const q = pageQuery();
    const urls = [location.href];
    try {
      $$('iframe', document).forEach((f) => urls.push(attr(f, 'src') || ''));
    } catch (e) {}
    const courseId = q.courseId || firstMatch(urls, /courseId=(\d+)/i) || firstMatch(urls, /courseid=(\d+)/i);
    const clazzId = q.clazzId || firstMatch(urls, /clazzid=([\w-]+)/i) || firstMatch(urls, /classId=([\w-]+)/i);
    const enc = q.enc || firstMatch(urls, /enc=([\w-]+)/i);
    if (courseId) S.course.id = courseId;
    if (clazzId) S.course.clazzId = clazzId;
    if (enc) S.course.enc = enc;
    if (!S.course.name) {
      let name = '';
      try {
        const nm = $('.courseName,.course-name,#courseName,[class*="courseName"]', document);
        name = nm ? text(nm) : '';
      } catch (e) {}
      if (!name) {
        name = String(document.title || '').split(/[-_|–—]/)[0].replace(/\s+/g, ' ').trim();
      }
      if (name && name.length < 60 && !/学习通|超星|登录/.test(name)) S.course.name = name;
    }
    S.pageKind = classifyPage();
  }

  // ------------------------------ 课程目录
  function catalogueNodes() {
    const groups = [
      '#content1 .posCatalog_name',
      '#content1 [onclick*="getTeacherAjax"]',
      '#coursetree .posCatalog_name',
      '.posCatalog_level .posCatalog_name',
      '#mainid .posCatalog_name',
      '[onclick*="getTeacherAjax"]'
    ];
    for (let i = 0; i < groups.length; i++) {
      let list = [];
      try { list = $$(groups[i], document); } catch (e) { list = []; }
      list = list.filter((el) => !el.closest('#cxh-host'));
      if (list.length) {
        const seen = {};
        const out = [];
        list.forEach((el) => {
          const holder = el.closest('[id^="cur"]') || el.closest('li') || el.parentElement;
          const key = (holder && holder.id) ? holder.id : (text(el) + '|' + el.getBoundingClientRect().top);
          if (seen[key]) return;
          seen[key] = true;
          out.push(el);
        });
        return out;
      }
    }
    return [];
  }

  function chapterItem(el, i) {
    const holder = el.closest('[id^="cur"]') || el.closest('li') || el.parentElement;
    let id = holder && holder.id ? String(holder.id).replace(/^cur/, '') : '';
    if (!id) {
      const onclick = attr(el, 'onclick') + ' ' + attr(holder, 'onclick');
      const m = onclick.match(/(?:chapterId|chapterid|knowledgeid|knowledgeId)['"\s:=]+(\d+)/i);
      if (m) id = m[1];
    }
    if (!id) id = attr(el, 'data-id') || attr(holder, 'data-id') || ('idx_' + i);
    const titleEl = $('.posCatalog_title,.catalog_title,.title', el) || el;
    let title = attr(el, 'title') || text(titleEl) || text(el) || ('章节 ' + (i + 1));
    title = title.replace(/\s+/g, ' ').trim().slice(0, 80);
    const holderActive = !!(holder && holder.classList &&
      (holder.classList.contains('posCatalog_active') || holder.classList.contains('active') || holder.classList.contains('cur')));
    const active = holderActive || !!($('.posCatalog_active,.active,.cur', holder) || el.classList.contains('posCatalog_active'));
    const doneIcon = holder ? $('.icon_Completed,.icon_completed,[class*="Completed"],[class*="completed"]', holder) : null;
    const remainEl = holder ? $('.orangeNew,.icon_New,[class*="orangeNew"]', holder) : null;
    const remainTxt = remainEl ? text(remainEl).replace(/[^\d]/g, '') : '';
    const remain = remainTxt === '' ? null : parseInt(remainTxt, 10);
    let complete = !!doneIcon;
    if (!complete && remain === null && holder) complete = /已完成/.test(text(holder));
    if (remain !== null && remain > 0) complete = false;
    return {
      id: id,
      i: i,
      title: title,
      el: el,
      holder: holder,
      active: active,
      complete: !!complete,
      remain: remain
    };
  }

  function scanChapters() {
    const nodes = catalogueNodes();
    S.chapters = nodes.map(chapterItem);
    // 页面图标可能滞后，合并本地已完成的章节标记
    S.chapters.forEach((c) => { if (!c.complete && isChapterDone(c.id)) c.complete = true; });
    emit('state');
    return S.chapters;
  }

  function isChapterDone(id) {
    if (!id) return false;
    const p = courseProgress(S.course.id);
    return p.doneChapters.indexOf(String(id)) >= 0;
  }

  function markChapterDone(id) {
    if (!id || !S.course.id) return;
    const p = courseProgress(S.course.id);
    if (p.doneChapters.indexOf(String(id)) < 0) {
      p.doneChapters.push(String(id));
      saveProgress();
    }
  }

  function pageHeading() {
    return norm(text($('h1, .chapterTitle, .chapter_title, .prev_title, #mainid h1', document)));
  }

  // 新版学生的“当前章节”经常不带 .active/.posCatalog_active，用页面标题回查
  function currentChapter() {
    const byClass = S.chapters.find((c) => c.active);
    if (byClass) return byClass;
    const h = pageHeading();
    if (!h) return null;
    return S.chapters.find((c) => {
      const t = norm(c.title);
      return t && (t === h || h.indexOf(t) >= 0 || t.indexOf(h) >= 0);
    }) || null;
  }

  function pickNextChapter(afterId) {
    const items = S.chapters;
    if (!items.length) return null;
    const start = afterId ? items.findIndex((x) => x.id === afterId) : -1;
    for (let k = 1; k <= items.length; k++) {
      const it = items[(start + k) % items.length];
      if (!it || it.id === afterId) continue;
      if (it.complete || isChapterDone(it.id)) continue;
      return it;
    }
    return null;
  }

  async function openChapter(ch) {
    if (!ch) return false;
    TOP.lastOpenAt = now();
    setPhase('chapter', '正在进入章节：' + ch.title);
    log('进入章节：' + ch.title);
    if (!ch.el || !ch.el.isConnected) {
      const fresh = scanChapters().find((x) => x.id === ch.id);
      if (fresh) ch = fresh;
    }
    const prevDoc = cardsDoc();
    const prevHeading = pageHeading();
    clickEl(ch.el);
    await sleep(rand(900, 1500));
    let ok = false;
    for (let i = 0; i < 12; i++) {
      const d = cardsDoc();
      // 必须确认拿到的是新章节的文档，避免继续驱动旧章节卡片
      if (d && d !== prevDoc && ($$('[id^="dct"][cardid]', d).length || $$('.ans-attach-ct', d).length)) { ok = true; break; }
      if (!d && !prevDoc && pickAgent('cards')) { ok = true; break; }
      // 新版 studentstudy 是 AJAX 换内容，直接看标题是否已变
      if (prevHeading && pageHeading() && pageHeading() !== prevHeading) { ok = true; break; }
      const active = scanChapters().find((x) => x.active);
      if (active && String(active.id) === String(ch.id)) { ok = true; break; }
      if (i === 3) {
        const fresh = scanChapters().find((x) => x.id === ch.id);
        if (fresh) clickEl(fresh.el);
      }
      await sleep(1000);
    }
    if (!ok) warn('章节打开超时，将继续尝试：' + ch.title);
    S.currentChapterId = ch.id;
    scanChapters();
    TOP.lastScanAt = now();
    S.notBefore = now() + rand(900, 1600);
    return ok;
  }

  // ------------------------------ 任务点执行
  function cardsDoc() {
    const docs = docsFrom(document);
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      if (d === document) continue;
      try {
        if ($$('[id^="dct"][cardid]', d).length || $$('.ans-attach-ct', d).length) return d;
      } catch (e) {}
    }
    return null;
  }

  function isQuizTopPage() {
    const k = classifyPage();
    if (k === 'work' || k === 'exam') return true;
    if (k === 'cards' || k === 'course') return false;
    try {
      return !!$('.TiMu,.questionLi', document) && !cardsDoc();
    } catch (e) { return false; }
  }

  async function tickCardsTop(courseId) {
    // 小节内分页：概览/视频/测验各占一页，tab 在顶层文档
    if (pagerTabsIn(document).length >= 2) {
      const markPage = (card, items) => {
        if (items) { S.cards = items; S.cardsReady = true; }
        if (!card) return;
        if (S.activeCardId !== card.id) {
          S.activeCardId = card.id;
          S.taskStartedAt = now();
        }
        S.activeCard = card.id;
        emit('state');
      };
      const r = await tickCards(document, { courseId: courseId, onCard: markPage });
      if (r && r.items) markPage(null, r.items);
      return { r: r, doc: document, agent: null };
    }
    const doc = cardsDoc();
    if (doc) {
      const markActive = (card, items) => {
        if (items) { S.cards = items; S.cardsReady = true; }
        if (!card) return;
        if (S.activeCardId !== card.id) {
          S.activeCardId = card.id;
          S.taskStartedAt = now();
        }
        S.activeCard = card.id;
        emit('state');
      };
      const r = await tickCards(doc, { courseId: courseId, onCard: markActive });
      if (r && r.items) markActive(null, r.items);
      return { r: r, doc: doc, agent: null };
    }
    const agent = pickAgent('cards');
    if (!agent) {
      if (now() - TOP.lastNoAgentLog > 20000) {
        TOP.lastNoAgentLog = now();
        log('等待课程任务页面加载…');
      }
      return { r: { state: 'no-agent' }, doc: null, agent: null };
    }
    const r = await rpcAgent(agent, 'cards.tick', { courseId: courseId }, 180000);
    if (r && r.items) {
      S.cards = r.items;
      S.cardsReady = true;
      const act = r.items.find((x) => x.active);
      if (act) {
        if (S.activeCardId !== act.id) {
          S.activeCardId = act.id;
          S.taskStartedAt = now();
        }
        S.activeCard = act.id;
      }
      emit('state');
    }
    return { r: r || { state: 'no-agent' }, doc: null, agent: agent };
  }

  async function advanceNow(courseId, doc, agent) {
    // 结构守卫：本页还有未完成任务点时不许切走（防止“看一眼视频就跳下一节”）
    try {
      const left = anatAdvanceGuard(doc || cardsDoc() || document, courseId);
      if (left > 0) return { ok: false, pending: left };
    } catch (e) {}
    try {
      if (doc) return await advanceCard(doc, courseId);
      if (agent) return await rpcAgent(agent, 'cards.advance', { courseId: courseId }, 40000);
    } catch (e) {
      warn('切换任务点失败：' + (e && e.message || e));
    }
    return { ok: false };
  }

  // 推进到下一个任务点；本页仍有未完成任务点时原地等待，绝不跳章节
  async function advanceOrWait(courseId, doc, agent) {
    const adv = await advanceNow(courseId, doc, agent);
    if (adv && adv.pending) {
      setMessage('本页还有 ' + adv.pending + ' 个任务点未完成，继续处理本页…');
      S.notBefore = now() + rand(1200, 2000);
      return { ok: true, pending: adv.pending };
    }
    if (!adv || !adv.ok) {
      await nextSectionOrChapter();
      return { ok: false };
    }
    setMessage('进入下一个任务点…');
    S.notBefore = now() + rand(900, 1600);
    return { ok: true };
  }

  function updateFromMedia(r) {
    if (!r) return;
    if (r.state === 'playing' || r.state === 'paused') {
      const d = Number(r.d || 0);
      const t = Number(r.t || 0);
      S.taskProgress = d > 0 ? duration(t) + ' / ' + duration(d) + '（' + Math.floor(t / d * 100) + '%）' : duration(t);
      setMessage((r.state === 'playing' ? '正在播放：' : '已暂停，正在恢复：') + S.taskProgress);
      if (r.state === 'playing') TOP.stuck = 0;
    } else if (r.state === 'loading') {
      setMessage('正在加载媒体…');
    } else if (r.state === 'popup') {
      setMessage('正在处理视频弹窗题目…');
    }
  }

  function topPageSignature() {
    const frame = $('#iframe', document);
    const active = $('.posCatalog_active', document);
    // 新版 studentstudy 是 AJAX 切小节：URL 常常不变，必须把当前标题/正文纳入签名
    const heading = text($('h1, .chapterTitle, .chapter_title, .prev_title, #mainid h1', document))
      .replace(/\s+/g, ' ').trim();
    return [
      (location && location.href) || '',
      frame ? attr(frame, 'src') : '',
      truncate(heading, 120),
      truncate(text($('#mainid', document)).replace(/\s+/g, ' '), 140),
      active ? (active.id || text(active).slice(0, 30)) : ''
    ].join('|');
  }

  function nextSectionBtn() {
    const docs = docsFrom(document, 3);
    const sels = ['#prevNextFocusNext', 'a.prev_next.next', '.prev_next.next', 'a.prev_next', '.prev_next'];
    for (let di = 0; di < docs.length; di++) {
      const d = docs[di];
      for (let si = 0; si < sels.length; si++) {
        let list = [];
        try { list = $$(sels[si], d).filter(visible); } catch (e) { list = []; }
        const hit = list.find((b) => {
          const cls = attr(b, 'class');
          if (/(^|\s)(disabled|ban|forbid)(\s|$)/.test(cls) || attr(b, 'aria-disabled') === 'true') return false;
          return !/上一节|上一章/.test(text(b));
        });
        if (hit) return hit;
      }
      // 文本兜底：新版页面底部按钮可能没有稳定 id/class，只显示“下一节”
      let texts = [];
      try {
        texts = $$('a,button,span,div,li', d).filter(visible).filter((el) => {
          const t = text(el).replace(/\s+/g, '');
          if (!/^(下一节|下一节›|下一节>|下一节▶|下一个)$/.test(t)) return false;
          const inner = $$('a,button', el).filter((c) => /下一节/.test(text(c)));
          return !inner.length;
        });
      } catch (e) { texts = []; }
      if (texts.length) {
        texts.sort((a, b) => {
          const ra = a.getBoundingClientRect ? a.getBoundingClientRect() : { width: 999, height: 999 };
          const rb = b.getBoundingClientRect ? b.getBoundingClientRect() : { width: 999, height: 999 };
          return ra.width * ra.height - rb.width * rb.height;
        });
        return texts[0];
      }
    }
    return null;
  }

  // 学习通拦截框：本节还有任务点未完成时，点“下一节”会弹 #jobFinishTip，
  // 需要再点一次它里面的「下一节」才会真的走。这里把它找出来。
  function findLeaveTip() {
    const docs = [document].concat(docsFrom(document, 3) || []);
    for (let di = 0; di < docs.length; di++) {
      const d = docs[di];
      let tips = [];
      try { tips = $$('#jobFinishTip, .AlertCon02', d).filter(looseVisible); } catch (e) { tips = []; }
      for (let ti = 0; ti < tips.length; ti++) {
        const tip = tips[ti];
        const body = text(tip);
        if (!/未完成|是否去完成|是否继续|还有.*任务点|确定要离开/.test(body)) continue;
        let btn = null;
        try {
          btn = $$('a,button,span', tip).filter(looseVisible).find((b) => /^(下一节|继续下一节|下一节›|下一节>)$/.test(text(b).replace(/\s+/g, '')));
        } catch (e) { btn = null; }
        if (btn) return btn;
      }
    }
    return null;
  }

  // 先点“下一节”，只有确实没有下一节时才切换到下一个章节目录
  async function goNextSection() {
    const btn = nextSectionBtn();
    if (!btn) return false;
    const before = topPageSignature();
    clickEl(btn);
    // 等页面跳转；若期间弹出“本章还有任务点未完成”，自动点弹窗里的「下一节」
    const deadline = now() + 15000;
    let moved = false;
    let tipHandled = false;
    while (now() < deadline) {
      if (topPageSignature() !== before) { moved = true; break; }
      if (!tipHandled) {
        const tipBtn = findLeaveTip();
        if (tipBtn) {
          tipHandled = true;
          logOnceState('leave-tip', '检测到“本章还有任务点未完成”确认框，已自动点「下一节」继续');
          clickEl(tipBtn);
        }
      }
      await sleep(400);
    }
    if (!moved) return false;
    S.cards = [];
    S.activeCardId = '';
    S.activeCard = '';
    S.taskStartedAt = now();
    S.notBefore = now() + rand(1500, 3000);
    scanChapters();
    TOP.lastScanAt = now();
    success('已切换到下一节');
    setMessage('已进入下一节，正在识别任务点…');
    return true;
  }

  async function nextSectionOrChapter() {
    const moved = await goNextSection();
    if (!moved) await chapterFinished();
  }

  async function chapterFinished() {
    const cur = currentChapter();
    if (cur) markChapterDone(cur.id);
    TOP.chapterSwitches++;
    S.notBefore = now() + rand(2500, 5000);
    await sleep(rand(600, 1200));
    scanChapters();
    const next = pickNextChapter(cur ? cur.id : null);
    if (next) {
      if (TOP.chapterSwitches > 200) {
        warn('章节切换次数过多，已暂停以避免异常');
        pauseAutomation('章节切换异常');
        return;
      }
      await openChapter(next);
      return;
    }
    if (S.chapters.length && S.chapters.every((c) => c.complete || isChapterDone(c.id))) {
      finishAll('课程全部任务点已完成');
      return;
    }
    if (!S.chapters.length) {
      setPhase('done', '当前章节任务点已全部完成');
      S.running = false;
      return;
    }
    // 仍有章节未完成但无法定位：稍后重试
    setPhase('waiting', '等待下一章节可进入…');
  }

  function finishAll(msg) {
    if (TOP.notifiedDone) return;
    TOP.notifiedDone = true;
    S.running = false;
    setPhase('done', msg || '全部任务点已完成 🎉');
    success(msg || '全部任务点已完成 🎉');
    broadcastStop();
    playChime();
  }

  async function crossOriginTick(r, courseId, cardsAgent) {
    let type = r.type || 'generic';
    const src = r.src || '';
    if (type === 'generic' || type === 'unknown') {
      const guess = classifySrc(src);
      if (guess !== 'unknown') type = guess;
      else if (findVideos(document).length) type = 'video';
    }
    if (type === 'read') {
      markLocalSkipped(courseId, r.card.id + '#' + (r.moduleIndex || 0));
      setMessage('阅读任务已跳过');
      return;
    }
    const kindMap = { video: 'video', audio: 'audio', document: 'document', quiz: 'work', exam: 'work' };
    const kind = kindMap[type] || '';
    const agent = (kind && pickAgent(kind, src)) || (kind && pickAgent(kind)) || null;
    if (!agent) {
      if (now() - TOP.lastNoAgentLog > 20000) {
        TOP.lastNoAgentLog = now();
        setMessage('等待任务页面加载（' + (MODULE_LABEL[type] || type) + '）…');
      }
      return;
    }
    const key = (r && r.unitKey) || (r.card.id + '#' + (r.moduleIndex || 0));
    if (TOP.cross.key !== key) {
      TOP.cross = { key: key, endedAt: 0, last: '', tries: 0, unitKey: (r && r.unitKey) || '' };
    }
    TOP.cross.tries++;

    const res = await rpcAgent(agent, 'module.tick', { courseId: courseId }, 150000);
    const st = res && (res.state || res.status);
    TOP.cross.last = st || '';
    logOnceState(st, type, res);

    if (st === 'done' || st === 'filled') {
      markLocalDone(courseId, key);
      if (TOP.cross.unitKey) markLocalDone(courseId, TOP.cross.unitKey);
      markLocalDone(courseId, r.card.id);
      success('答题任务已完成');
      await nextAfterModule(courseId, cardsAgent);
      return;
    }
    if (st === 'skipped') {
      markLocalSkipped(courseId, key);
      markLocalSkipped(courseId, r.card.id);
      const skipWhy = (res.reason === 'no-answer-mode') ? '已开启不作答'
        : (res.reason === 'no-api' ? '未配置 API' : (res.reason || '按设置跳过'));
      setMessage('答题任务已跳过（' + skipWhy + '）');
      await nextAfterModule(courseId, cardsAgent);
      return;
    }
    if (st === 'ended' || st === 'bottom') {
      if (!TOP.cross.endedAt) TOP.cross.endedAt = now();
      const waitName = st === 'ended' ? '视频已播完' : '文档已翻到末尾';
      let conf = null;
      if (TOP.cross.unitKey) {
        const unit = anatFindUnitByKey(cardsDoc() || document, courseId, TOP.cross.unitKey);
        if (unit) conf = anatConfirmUnit(unit, courseId);
      }
      if (conf && conf.done) {
        if (conf.warn) warn(conf.warn);
        markLocalDone(courseId, key);
        markLocalDone(courseId, TOP.cross.unitKey);
        if (r.card) markLocalDone(courseId, r.card.key || r.card.id);
        await nextAfterModule(courseId, cardsAgent);
        return;
      }
      const remain = (conf && conf.remain) ? conf.remain
        : Math.max(1, Math.ceil((30000 - (now() - TOP.cross.endedAt)) / 1000));
      setMessage(waitName + '，等待任务点“已完成”标记（约 ' + remain + ' 秒）…');
      if (!conf && now() - TOP.cross.endedAt > 30000) {
        warn('任务点未出现“已完成”标记，已按本地记录继续');
        markLocalDone(courseId, key);
        if (r.card) markLocalDone(courseId, r.card.key || r.card.id);
        await nextAfterModule(courseId, cardsAgent);
      }
      return;
    }
    if (st === 'playing' || st === 'paused' || st === 'loading' || st === 'popup' || st === 'waiting') {
      if (st === 'playing') TOP.cross.endedAt = 0;
      updateFromMedia(res);
      if (st === 'waiting') setMessage('答题页面尚未就绪…');
      return;
    }
    if (st === 'blocked') {
      pauseAutomation('任务页面需要人工处理：' + (res.reason || ''));
      return;
    }
    if (st === 'stalled') {
      TOP.stuck++;
      setMessage('任务页面长时间无进展…');
      if (TOP.stuck >= 4) recoverPage();
      return;
    }
    if (st === 'error' || st === 'unsupported') {
      TOP.errors++;
      warn('任务处理失败：' + (res.reason || st));
      if (TOP.errors >= 3) {
        TOP.errors = 0;
        markLocalSkipped(courseId, key);
        await nextAfterModule(courseId, cardsAgent);
      }
      return;
    }
    setMessage('等待任务页面响应…');
  }

  let lastStateLog = { sig: '', at: 0 };
  function logOnceState(st, type, res) {
    const sig = st + '|' + type;
    if (lastStateLog.sig === sig && now() - lastStateLog.at < 30000) return;
    lastStateLog = { sig: sig, at: now() };
    if (st === 'playing') log('开始播放' + (MODULE_LABEL[type] || '') + '（1 倍速）');
    else if (st === 'error') warn('答题/任务异常：' + (res && (res.reason || res.detail) || ''));
    else if (st === 'waiting') log('答题页面加载中…');
  }

  async function nextAfterModule(courseId, cardsAgent) {
    S.notBefore = now() + rand(CFG.taskDelayMin, CFG.taskDelayMax) * 1000;
    const adv = await advanceNow(courseId, cardsDoc(), cardsAgent);
    if (adv && adv.pending) {
      setMessage('本页还有 ' + adv.pending + ' 个任务点未完成，继续处理本页…');
      S.notBefore = now() + rand(900, 1500);
      return;
    }
    if (!adv || !adv.ok) {
      await nextSectionOrChapter();
    } else {
      setMessage('进入下一个任务点…');
    }
  }

  async function handleCardsResult(r, courseId, doc, agent) {
    const st = r && r.state;
    if (!st) return;
    if (st === 'busy') return;
    if (st === 'no-agent') {
      setMessage('等待课程页面加载…');
      return;
    }
    if (st === 'playing' || st === 'paused' || st === 'loading' || st === 'popup') {
      updateFromMedia(r);
      return;
    }
    if (st === 'scrolling') {
      const pct = r.detail && typeof r.detail.pct === 'number' ? Math.round(r.detail.pct * 100) : null;
      setMessage(pct == null ? '正在浏览文档…' : '正在浏览文档：' + pct + '%');
      if (pct != null) S.taskProgress = pct + '%';
      return;
    }
    if (st === 'ended') { setMessage('视频已播放完，等待任务点完成标记…'); return; }
    if (st === 'bottom') { setMessage('文档已浏览到底，等待任务点完成标记…'); return; }
    if (st === 'waiting') { setMessage('答题页面尚未就绪…'); return; }
    if (st === 'page-reading') {
      setMessage('正在浏览本节内容…' + (r.remain ? '（约 ' + r.remain + ' 秒后翻页）' : ''));
      S.notBefore = now() + rand(800, 1500);
      return;
    }
    if (st === 'page-next') {
      success('已翻到本节第 ' + (r.page || '?') + ' 页（共 ' + (r.total || '?') + ' 页）');
      setMessage('正在识别本页任务点…');
      S.notBefore = now() + rand(1200, 2200);
      return;
    }
    if (st === 'page-stuck') {
      TOP.stuck++;
      warn('小节翻页没有生效，正在重试…');
      setMessage('翻页未生效，稍后重试');
      S.notBefore = now() + rand(2500, 4500);
      if (TOP.stuck >= 3) recoverPage();
      return;
    }
    if (st === 'section-page-last') {
      // 分页小节的最后一页 = 本节所有任务点已处理完，直接切下一个章节目录。
      // 不能再点底部“下一节”，该按钮在本版页面只会在本节页签之间循环。
      await chapterFinished();
      return;
    }
    if (st === 'activated' || st === 'no-attachments') {
      setMessage(st === 'activated' ? '切换任务点…' : '当前任务点没有可执行内容，跳过…');
      S.notBefore = now() + rand(700, 1400);
      if (st === 'no-attachments') {
        if (r && r.card) markLocalSkipped(courseId, r.card.id);
        await advanceOrWait(courseId, doc, agent);
      }
      return;
    }
    if (st === 'card-skipped') {
      setMessage('已跳过任务点，切换下一个任务点…');
      await advanceOrWait(courseId, doc, agent);
      return;
    }
    if (st === 'module-done') {
      const label = MODULE_LABEL[r.module] || '任务点';
      success(label + '已完成' + (r.forced ? '（本地记录）' : ''));
      S.doneTasks++;
      TOP.errors = 0;
      S.stuck = 0;
      if (r.card) markLocalDone(courseId, r.card.key || r.card.id);
      S.notBefore = now() + rand(CFG.taskDelayMin, CFG.taskDelayMax) * 1000;
      setMessage('等待切换下一个任务点…');
      return;
    }
    if (st === 'card-done') {
      if (r.card) markLocalDone(courseId, r.card.key || r.card.id);
      await advanceOrWait(courseId, doc, agent);
      return;
    }
    if (st === 'unit-done') {
      const label = r.label || MODULE_LABEL[r.module] || '任务点';
      success('本页' + label + '已完成');
      S.doneTasks++;
      TOP.errors = 0;
      TOP.stuck = 0;
      if (r.unitRow && r.unitRow.key) markLocalDone(courseId, r.unitRow.key);
      S.notBefore = now() + rand(600, 1200);
      setMessage('本页还有任务点，继续处理…');
      return;
    }
    if (st === 'unit-progress') {
      const d = r.detail || {};
      if (d.state === 'playing' || d.state === 'paused' || d.state === 'scrolling' || d.state === 'paging') {
        updateFromMedia(d);
        if (d.state === 'scrolling' || d.state === 'paging') setMessage('正在浏览文档…');
      } else if (d.state === 'bottom' || d.state === 'ended') {
        setMessage('已处理完，等待任务点标记确认…');
      } else if (d.state === 'waiting') {
        setMessage('任务页面加载中…');
      } else {
        setMessage('正在处理本页任务点…');
      }
      S.notBefore = now() + rand(700, 1300);
      return;
    }
    if (st === 'page-complete') {
      success('本页任务点全部完成');
      S.notBefore = now() + rand(400, 900);
      return;
    }
    if (st === 'need-manual') {
      const label = r.label || MODULE_LABEL[r.module] || '任务点';
      const why = r.reason === 'load-timeout' ? '页面加载不出可识别内容'
        : (r.reason === 'manual-task' ? '需要人工完成' : (r.reason || '不认识的任务类型'));
      warn('跳过「' + label + '」（' + why + '），继续下一个环节');
      if (r.unitRow && r.unitRow.key) markLocalSkipped(courseId, r.unitRow.key);
      S.notBefore = now() + rand(600, 1100);
      return;
    }
    if (st === 'skipped') {
      if (r.card) {
        if (r.paged) markLocalSkipped(courseId, r.card.key || r.card.id);
        markLocalSkipped(courseId, (r.card.key || r.card.id) + '#' + (r.moduleIndex || 0));
      }
      const why = r.reason === 'no-answer-mode' ? '已开启不作答'
        : (r.reason === 'no-api' ? '未配置 API' : (r.reason || '按设置跳过'));
      log('跳过任务点（' + why + '）');
      S.notBefore = now() + (r.paged ? rand(400, 900) : rand(800, 1600));
      return;
    }
    if (st === 'cross-origin') {
      await crossOriginTick(r, courseId, agent);
      return;
    }
    if (st === 'blocked') {
      pauseAutomation('任务页面需要人工处理：' + (r.reason || ''));
      return;
    }
    if (st === 'stalled') {
      TOP.stuck++;
      setMessage('播放长时间没有进度，正在尝试恢复…');
      if (TOP.stuck >= 3) recoverPage();
      return;
    }
    if (st === 'error' || st === 'unsupported') {
      TOP.errors++;
      warn('任务处理失败：' + (r.reason || st));
      if (r.reason === 'submit-unconfirmed') {
        pauseAutomation('提交未确认：请先手动点确认，再继续');
        return;
      }
      if (r.reason === 'unanswered') {
        pauseAutomation('有题目未能作答：已暂停，不会直接跳过，请查看日志手动补答');
        return;
      }
      if (TOP.errors >= 4) {
        TOP.errors = 0;
        if (r.card) markLocalSkipped(courseId, r.card.key || r.card.id);
        await advanceOrWait(courseId, doc, agent);
      }
      return;
    }
    if (st === 'no-cards') {
      // 页面可能还在加载，先等一会儿，避免把“未加载”误判成“本节已完成”
      if (now() - (S.taskStartedAt || 0) < 6000) {
        setMessage('正在等待本节任务点加载…');
        S.notBefore = now() + 1200;
        return;
      }
      // 识别不到卡片时，也要先确认本页确实没有未完成任务点，再谈离开
      const cd = doc || cardsDoc();
      const pend = cd ? anatPagePending(cd, courseId) : 0;
      if (pend > 0) {
        setMessage('本页还有 ' + pend + ' 个任务点未完成，继续处理本页…');
        S.notBefore = now() + rand(1200, 2000);
        return;
      }
      // 统一出口：带结构守卫，切不动任务点才考虑下一节
      await advanceOrWait(courseId, cd, agent);
      return;
    }
    setMessage('任务状态：' + st);
  }

  // ------------------------------ 主循环
  async function courseTick() {
    refreshCourse();
    if (now() - TOP.lastScanAt > 5000) {
      scanChapters();
      TOP.lastScanAt = now();
    }
    if (!S.chapters.length) {
      if (cardsDoc() || pickAgent('cards')) {
        const rr = await tickCardsTop(S.course.id);
        await handleCardsResult(rr.r, S.course.id, rr.doc, rr.agent);
        return;
      }
      setPhase('waiting', '未找到课程目录，若在课程页请稍候…');
      return;
    }
    let active = S.chapters.find((c) => c.active) || null;
    if (!active) {
      if (cardsDoc() || pickAgent('cards')) {
        active = { id: S.currentChapterId || 'current', title: '当前章节', active: true, complete: false };
      } else {
        const next = pickNextChapter(null);
        if (next) { await openChapter(next); return; }
        setPhase('waiting', '课程目录里没有未完成章节');
        return;
      }
    }
    S.currentChapterId = active.id;
    if ((active.complete || isChapterDone(active.id)) && S.chapters.length > 1) {
      const next = pickNextChapter(active.id);
      if (next) { await openChapter(next); return; }
      if (S.chapters.every((c) => c.complete || isChapterDone(c.id))) {
        finishAll('课程全部任务点已完成');
        return;
      }
    }
    const rr = await tickCardsTop(S.course.id);
    await handleCardsResult(rr.r, S.course.id, rr.doc, rr.agent);
  }

  async function cardsSoloTick() {
    refreshCourse();
    TOP.soloCards = true;
    const r = await tickCards(document, { courseId: S.course.id });
    if (r && r.items) { S.cards = r.items; S.cardsReady = true; emit('state'); }
    if (r && r.state === 'card-done') {
      const adv = await advanceCard(document, S.course.id);
      if (!adv || !adv.ok) {
        S.running = false;
        setPhase('done', '本章任务点已全部完成');
        success('本章任务点已全部完成');
        playChime();
        return;
      }
      S.notBefore = now() + rand(900, 1600);
      return;
    }
    await handleCardsResult(r, S.course.id, document, null);
  }

  async function soloQuizTick() {
    if (TOP.quizBusy) return;
    if (TOP.quizDone) return;
    TOP.quizBusy = true;
    refreshCourse();
    try {
      setPhase('quiz', '正在处理答题页面…');
      const r = await solveQuizPage(document, { courseName: S.course.name || CFG.courseName });
      if (r.status === 'done' || r.status === 'filled') {
        TOP.quizDone = true;
        setPhase('done', r.reason === 'manual-submit' ? '答案已填写，请手动提交' : '答题已完成');
        success(r.reason === 'manual-submit' ? '答案已填写，等待你手动提交' : '答题完成');
        playChime();
      } else if (r.status === 'skipped') {
        TOP.quizDone = true;
        setPhase('done', r.reason === 'no-api' ? '未配置 API，已跳过答题' : '已跳过：' + (r.reason || ''));
        warn(r.detail || ('已跳过答题：' + (r.reason || '')));
      } else if (r.status === 'waiting') {
        setPhase('quiz', '答题页面尚未加载完成…');
      } else {
        setPhase('error', '答题失败：' + (r.detail || r.reason || '未知错误'));
        warn('答题失败：' + (r.detail || r.reason || '未知错误'));
      }
    } finally {
      TOP.quizBusy = false;
    }
  }

  function looksLikeCourseList() {
    const p = pathOf(location.href);
    if (/studentstudy|knowledge\/cards|work\/|exam\/|\/ananas\//i.test(p)) return false;
    if (classifyPage() === 'courselist') return true;
    try {
      return !!$('a[href*="studentstudy"],a[href*="mycourse/stu"],a[onclick*="studentstudy"]', document);
    } catch (e) { return false; }
  }

  async function courseListTick() {
    if (!CFG.autoOpenCourse) {
      setPhase('waiting', '已关闭「自动打开课程」');
      return;
    }
    if (now() - TOP.lastOpenAt < 15000) return;
    const name = String(CFG.courseName || '').trim();
    if (!name) return;
    let links = [];
    try {
      links = $$('a[href*="studentstudy"],a[href*="mycourse/stu"],a[href*="courseId="],a[onclick*="studentstudy"]', document)
        .filter((a) => !a.closest('#cxh-host'));
    } catch (e) { links = []; }
    let target = null;
    for (let i = 0; i < links.length; i++) {
      const a = links[i];
      const box = a.closest('li,.course-item,.course-info,.courseCard,.course-list > div') || a.parentElement;
      const blob = text(a) + ' ' + (box ? text(box).slice(0, 300) : '');
      if (blob.indexOf(name) >= 0) { target = a; break; }
    }
    if (!target) {
      if (now() - TOP.lastListLog > 25000) {
        TOP.lastListLog = now();
        log('未在课程列表中找到《' + name + '》，请确认课程名或手动进入课程');
      }
      setPhase('waiting', '等待找到课程《' + name + '》');
      return;
    }
    TOP.lastOpenAt = now();
    setPhase('opening', '正在打开课程：' + name);
    log('打开课程：' + name);
    clickEl(target);
    const box = target.closest('li,.course-item,.course-info,.courseCard');
    if (box) { await sleep(rand(300, 600)); clickEl(box); }
    await sleep(2500);
  }

  // ------------------------------ 风控检测
  function riskSignal() {
    if (!CFG.protectMode) return '';
    try {
      if ($('#fcqrimg,.chapterVideoFaceMaskDiv,.faceMask,.face-mask,[class*="faceMask"]', document)) return '人脸识别/扫码验证';
      const cands = queryAllDocs('[class*="mask"],[class*="verify"],[class*="face"],[class*="qrcode"],.popDiv,.AlertCon02,[role="dialog"]', document);
      for (let i = 0; i < cands.length; i++) {
        const el = cands[i];
        if (!visible(el)) continue;
        const t = text(el);
        if (!t || t.length > 240) continue;
        if (/人脸识别|请扫码|微信扫码|活体检测|安全验证|滑动验证/.test(t)) return truncate(t, 40);
      }
    } catch (e) {}
    return '';
  }

  function pauseAutomation(reason) {
    if (S.blocked && S.blockReason === reason) return;
    S.blocked = true;
    S.blockReason = reason || '需要人工处理';
    S.running = false;
    setPhase('blocked', '已暂停：' + S.blockReason);
    error('已暂停：' + S.blockReason + '。请人工处理后在控制台重新开始。');
    broadcastStop();
    playChime(true);
  }

  function recoverPage() {
    if (!CFG.reloadOnStuck) return;
    if (now() - TOP.lastReloadAt < 150000) return;
    TOP.lastReloadAt = now();
    TOP.reloads++;
    TOP.stuck = 0;
    warn('任务长时间无进展，刷新页面重试（第 ' + TOP.reloads + ' 次）');
    try { sessionStorage.setItem('cxh.resume', '1'); } catch (e) {}
    setTimeout(() => { try { location.reload(); } catch (e) {} }, 1500);
  }

  function playChime(alertTone) {
    if (!CFG.soundOnFinish) return;
    try {
      const AC = PAGE_WIN.AudioContext || PAGE_WIN.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const play = (freq, at, dur) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
        g.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
        o.connect(g); g.connect(ctx.destination);
        o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + dur + 0.05);
      };
      if (alertTone) { play(520, 0, 0.18); play(380, 0.2, 0.3); }
      else { play(660, 0, 0.14); play(880, 0.16, 0.2); }
      setTimeout(() => { try { ctx.close(); } catch (e) {} }, 1200);
    } catch (e) {}
  }

  function gestureKick() {
    try {
      findVideos(document).forEach((v) => {
        if (v.paused) {
          try {
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
          } catch (e) {}
        }
      });
    } catch (e) {}
  }

  // ------------------------------ 启动 / 停止
  function startAutomation() {
    if (!IS_TOP) return;
    if (S.running) return;
    S.running = true;
    S.blocked = false;
    S.blockReason = '';
    S.startedAt = now();
    S.notBefore = 0;
    S.lastTick = 0;
    TOP.stuck = 0;
    TOP.errors = 0;
    TOP.quizDone = false;
    TOP.notifiedDone = false;
    const lock = acquireLock();
    if (!lock.ok) warn('检测到另一个标签页也在运行，建议只保留一个课程页面');
    setPhase('running', '正在自动处理课程任务点…');
    log('开始运行｜课程：' + (S.course.name || CFG.courseName || '自动识别') + '｜' + (apiConfigured() ? ('模型：' + (CFG.api.model || '-') + (thinkingEnabled() ? '（思考模式）' : '（普通模式）')) : '未配置 DeepSeek'));
    if (thinkingEnabled()) log('思考模式已开启：思维链也计入输出 tokens，单题可能耗时 30–120 秒；可在「接口」页关闭流式或折叠思考过程');
    if (thinkingEnabled() && num(CFG.api.temperature, 0) > 0) log('提示：思考模型不接受 temperature 参数，已自动忽略（不生效）');
    if (!apiConfigured()) warn('未配置 DeepSeek API，答题类任务将按设置跳过');
    if (!CFG.forceNormalSpeed) warn('提示：已允许倍速；本脚本默认保持 1 倍速观看');
    broadcastConfig();
    gestureKick();
    setTimeout(() => { topTick(true); }, 300);
  }

  function stopAutomation() {
    if (!IS_TOP) return;
    S.running = false;
    S.notBefore = 0;
    setPhase('idle', '已暂停');
    log('已暂停自动刷课');
    broadcastStop();
  }

  async function skipCurrentTask() {
    if (!IS_TOP) return;
    const courseId = S.course.id;
    let cardId = S.activeCardId || '';
    const act = (S.cards || []).find((x) => x.active);
    if (act) cardId = act.id;
    if (cardId) {
      markLocalSkipped(courseId, cardId);
      log('已跳过当前任务点：' + cardId);
    }
    const adv = await advanceNow(courseId, cardsDoc(), pickAgent('cards'));
    if (!adv || !adv.ok) await chapterFinished();
    S.notBefore = 0;
  }

  function resetCourseProgress() {
    if (!S.course.id) return;
    PROGRESS.courses[S.course.id] = { doneChapters: [], doneCards: [], skippedCards: [] };
    saveProgress();
    S.cards = [];
    S.cardsReady = false;
    S.activeCardId = '';
    scanChapters();
    log('已清除本课程的本地进度记录');
    emit('state');
  }

  function checkTaskTimeout() {
    if (!S.activeCardId || !S.taskStartedAt) return false;
    const limit = Math.max(10, num(CFG.maxTaskMinutes, 240)) * 60000;
    if (now() - S.taskStartedAt < limit) return false;
    warn('任务点处理超过 ' + Math.round(limit / 60000) + ' 分钟，已跳过：' + S.activeCardId);
    markLocalSkipped(S.course.id, S.activeCardId);
    S.taskStartedAt = now();
    S.notBefore = 0;
    return true;
  }

  async function topTick(force) {
    if (!IS_TOP || !S.running || TOP.ticking) return;
    if (!force && now() < (S.notBefore || 0)) return;
    TOP.ticking = true;
    TOP.lastTickAt = now();
    S.lastTick = now();
    try {
      const risk = riskSignal();
      if (risk) { pauseAutomation('检测到安全验证：' + risk); return; }
      checkTaskTimeout();

      const kind = classifyPage();
      S.pageKind = kind;
      if (kind === 'login') {
        setPhase('login', '请先登录学习通，登录后会自动继续');
        return;
      }
      if (kind === 'work' || kind === 'exam' || isQuizTopPage()) {
        await soloQuizTick();
        return;
      }
      if (kind === 'cards') {
        await cardsSoloTick();
        return;
      }
      if (kind === 'course') {
        await courseTick();
        return;
      }
      if (looksLikeCourseList()) {
        await courseListTick();
        return;
      }
      if (cardsDoc() || pickAgent('cards')) {
        await courseTick();
        return;
      }
      if (kind === 'video' || kind === 'document' || kind === 'audio' || kind === 'module') {
        const r = kind === 'audio' ? await driveAudio(document) : kind === 'document' ? await driveDocument(document) : await driveVideo(document);
        await handleCardsResult(Object.assign({ state: r.state }, r), S.course.id, document, null);
        return;
      }
      setPhase('waiting', '当前页面不是课程学习页，等待进入课程…');
    } catch (e) {
      error('主循环异常：' + redact(e && e.stack || e && e.message || e));
    } finally {
      TOP.ticking = false;
    }
  }

  function topLoopStart() {
    if (!IS_TOP) return;
    if (TOP.loopTimer) clearInterval(TOP.loopTimer);
    TOP.loopTimer = setInterval(() => {
      if (!S.running) return;
      if (document.hidden) return;
      if (now() - TOP.lastTickAt < 1800) return;
      topTick(false);
    }, 1500);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && S.running) topTick(false);
    });
    window.addEventListener('online', () => {
      if (S.running) log('网络已恢复');
    });
  }

  // ---------------------------------------------------------------- 控制台 UI
  const UI = {
    host: null,
    root: null,
    tab: 'overview',
    collapsed: false,
    updateTimer: 0,
    toastTimer: 0,
    lastTasksSig: '',
    lastLogId: '',
    drag: null
  };

  const UI_CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.wrap{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:13px;line-height:1.5;color:#0f172a}',
    '.panel{width:386px;max-height:min(78vh,680px);display:flex;flex-direction:column;background:#fff;border:1px solid #e2e8f0;border-radius:14px;box-shadow:0 14px 44px rgba(15,23,42,.20);overflow:hidden}',
    '.head{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 12px;background:linear-gradient(135deg,#1e40af,#2563eb);color:#fff;cursor:move;user-select:none;touch-action:none}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#94a3b8;flex:0 0 auto;box-shadow:0 0 0 2px rgba(255,255,255,.28)}',
    '.dot.run{background:#22c55e}.dot.busy{background:#f59e0b}.dot.block{background:#ef4444}.dot.done{background:#38bdf8}',
    '.title{font-weight:600;letter-spacing:.2px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.ver{font-size:10px;opacity:.7}',
    '.hbtn{all:unset;cursor:pointer;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:6px;color:#fff;font-size:15px;line-height:1}',
    '.hbtn:hover{background:rgba(255,255,255,.18)}',
    '.status{padding:10px 12px 8px;border-bottom:1px solid #f1f5f9;background:#f8fafc}',
    '.phase{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;color:#1e293b}',
    '.phase .tag{margin-left:auto;font-weight:500;font-size:11px;color:#475569;background:#e2e8f0;border-radius:999px;padding:1px 8px}',
    '.msg{margin-top:3px;color:#64748b;font-size:12px;min-height:18px;word-break:break-all}',
    '.bar{margin-top:7px;height:5px;border-radius:99px;background:#e2e8f0;overflow:hidden}',
    '.bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#3b82f6,#22c55e);transition:width .4s ease}',
    '.bar.indet i{width:35%;animation:indet 1.3s ease-in-out infinite}',
    '@keyframes indet{0%{transform:translateX(-100%)}100%{transform:translateX(330%)}}',
    '.tabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid #e2e8f0;background:#fff;overflow-x:auto;scrollbar-width:none}',
    '.tabs::-webkit-scrollbar{display:none}',
    '.tab{all:unset;cursor:pointer;padding:6px 9px;font-size:12px;color:#64748b;border-radius:7px 7px 0 0;white-space:nowrap}',
    '.tab:hover{background:#f1f5f9;color:#334155}',
    '.tab.on{color:#1d4ed8;font-weight:600;background:#eff6ff;box-shadow:inset 0 -2px 0 #2563eb}',
    '.body{flex:1;overflow:auto;padding:11px 12px;min-height:140px;max-height:46vh}',
    '.body::-webkit-scrollbar{width:7px}.body::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:9px}',
    '.pane{display:none}.pane.on{display:block}',
    '.kv{display:flex;gap:10px;padding:4px 0;font-size:12px;border-bottom:1px dashed #f1f5f9}',
    '.kv span{color:#64748b;flex:0 0 54px}',
    '.kv b{font-weight:500;color:#1e293b;word-break:break-all}',
    '.hint{margin-top:8px;padding:7px 9px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;color:#92400e;font-size:11.5px}',
    '.hint.blue{background:#eff6ff;border-color:#bfdbfe;color:#1e40af}',
    '.sect{font-size:11px;font-weight:600;color:#94a3b8;letter-spacing:.4px;margin:10px 0 5px;text-transform:uppercase}',
    '.row{display:flex;gap:8px;align-items:center}.row.wrap{flex-wrap:wrap}',
    '.list{display:flex;flex-direction:column;gap:3px}',
    '.item{display:flex;align-items:center;gap:7px;padding:5px 7px;border-radius:7px;cursor:pointer;font-size:12px;color:#334155}',
    '.item:hover{background:#f1f5f9}',
    '.item.on{background:#eff6ff;color:#1d4ed8;font-weight:600}',
    '.item.done{color:#94a3b8}',
    '.item .ico{width:16px;flex:0 0 16px;text-align:center;font-size:11px}',
    '.item .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.item .st{font-size:10px;color:#94a3b8}',
    '.empty{color:#94a3b8;font-size:12px;text-align:center;padding:14px 0}',
    '.field{margin-bottom:8px}',
    '.field label{display:block;font-size:11.5px;color:#64748b;margin-bottom:3px}',
    'input[type=text],input[type=password],input[type=number],textarea,select{width:100%;padding:6px 8px;border:1px solid #cbd5e1;border-radius:7px;font-size:12px;color:#0f172a;background:#fff;outline:none;font-family:inherit}',
    'input:focus,textarea:focus,select:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}',
    'textarea{resize:vertical}',
    '.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}',
    'button{all:unset;cursor:pointer;padding:6px 11px;border-radius:8px;font-size:12px;text-align:center;background:#f1f5f9;color:#334155;border:1px solid #e2e8f0}',
    'button:hover{background:#e2e8f0}',
    'button.primary{background:#2563eb;color:#fff;border-color:#2563eb;font-weight:600}',
    'button.primary:hover{background:#1d4ed8}',
    'button.danger{background:#fef2f2;color:#b91c1c;border-color:#fecaca}',
    'button:disabled{opacity:.55;cursor:default}',
    '.foot{display:flex;gap:7px;padding:9px 12px;border-top:1px solid #e2e8f0;background:#f8fafc}',
    '.foot button{flex:1;padding:8px 6px}',
    '.logbox{display:flex;flex-direction:column;gap:2px;font-size:11.5px}',
    '.log{display:flex;gap:6px;flex-wrap:wrap;align-items:flex-start;padding:3px 5px;border-radius:5px;line-height:1.45}',
    '.log:hover{background:#f8fafc}',
    '.log time{color:#94a3b8;flex:0 0 54px;font-variant-numeric:tabular-nums}',
    '.log span{flex:1 1 auto;min-width:0;word-break:break-all;color:#334155}',
    '.log.warn span{color:#b45309}.log.error span{color:#b91c1c}.log.success span{color:#15803d}',
    '.toast{position:absolute;left:50%;bottom:62px;transform:translateX(-50%) translateY(6px);background:rgba(15,23,42,.92);color:#fff;padding:7px 12px;border-radius:8px;font-size:12px;opacity:0;pointer-events:none;transition:all .18s;max-width:88%;text-align:center}',
    '.toast.on{opacity:1;transform:translateX(-50%) translateY(0)}',
    '.ball{display:none;width:54px;height:54px;border-radius:50%;background:linear-gradient(135deg,#1e40af,#2563eb);color:#fff;box-shadow:0 8px 24px rgba(37,99,235,.45);align-items:center;justify-content:center;cursor:pointer;position:relative;font-weight:700;font-size:13px;user-select:none}',
    '.wrap.collapsed .panel{display:none}',
    '.wrap.collapsed .ball{display:flex}',
    '.ball .bdot{position:absolute;right:2px;top:2px;width:11px;height:11px;border-radius:50%;background:#94a3b8;border:2px solid #fff}',
    '.ball .bdot.run{background:#22c55e}.ball .bdot.block{background:#ef4444}.ball .bdot.busy{background:#f59e0b}',
    '.toggle{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;color:#334155;cursor:pointer}',
    '.switch{position:relative;width:34px;height:19px;border-radius:99px;background:#cbd5e1;transition:.18s;flex:0 0 34px}',
    '.switch::after{content:"";position:absolute;left:2px;top:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:.18s;box-shadow:0 1px 2px rgba(0,0,0,.2)}',
    '.toggle input{display:none}',
    '.toggle.tight{padding:2px 0;font-size:11.5px;gap:7px}',
    '.toggle.tight .switch{width:30px;height:17px;flex:0 0 30px}',
    '.toggle.tight .switch::after{width:13px;height:13px}',
    '.toggle.tight input:checked + .switch::after{transform:translateX(13px)}',
    '.toggle input:checked + .switch{background:#2563eb}',
    '.toggle input:checked + .switch::after{transform:translateX(15px)}',
    '.badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10.5px;font-weight:600}',
    '.badge.ok{background:#dcfce7;color:#15803d}.badge.no{background:#fee2e2;color:#b91c1c}.badge.wait{background:#fef3c7;color:#92400e}',
    '.log .think{flex:1 1 100%;margin:1px 0 0 60px;min-width:0}',
    '.log .think summary{cursor:pointer;color:#64748b;font-size:10.5px;user-select:none;list-style:none}',
    '.log .think summary::-webkit-details-marker{display:none}',
    '.log .think summary::before{content:"▸ ";color:#94a3b8}',
    '.log .think[open] summary::before{content:"▾ "}',
    '.log .think pre{margin:3px 0 0;padding:5px 7px;background:#f1f5f9;border-radius:6px;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-size:10.5px;line-height:1.5;color:#475569;font-family:inherit}'
  ].join('');

  function uiTemplate() {
    return [
      '<div class="wrap" data-ref="wrap">',
      '  <div class="panel" data-ref="panel">',
      '    <div class="head" data-ref="head">',
      '      <i class="dot" data-ref="dot"></i>',
      '      <span class="title">学习通课程助手</span>',
      '      <span class="ver">v' + VERSION + '</span>',
      '      <button class="hbtn" data-act="collapse" title="收起">—</button>',
      '    </div>',
      '    <div class="status">',
      '      <div class="phase"><span data-ref="phase">待机</span><span class="tag" data-ref="tag">未开始</span></div>',
      '      <div class="msg" data-ref="msg">打开课程页后点击「开始刷课」</div>',
      '      <div class="bar" data-ref="bar"><i data-ref="barFill"></i></div>',
      '    </div>',
      '    <div class="tabs" data-ref="tabs">',
      '      <button class="tab on" data-tab="overview">概览</button>',
      '      <button class="tab" data-tab="tasks">任务</button>',
      '      <button class="tab" data-tab="api">API</button>',
      '      <button class="tab" data-tab="logs">日志</button>',
      '      <button class="tab" data-tab="settings">设置</button>',
      '    </div>',
      '    <div class="body" data-ref="body">',
      '      <div class="pane on" data-pane="overview">',
      '        <div class="kv"><span>课程</span><b data-ref="vCourse">—</b></div>',
      '        <div class="kv"><span>章节</span><b data-ref="vChapter">—</b></div>',
      '        <div class="kv"><span>任务点</span><b data-ref="vCard">—</b></div>',
      '        <div class="kv"><span>进度</span><b data-ref="vProgress">—</b></div>',
      '        <div class="kv"><span>DeepSeek</span><b data-ref="vApi">未配置</b></div>',
      '        <div class="hint" data-ref="notice">未配置 API 时，脚本只刷视频/文档，答题任务会自动跳过。</div>',
      '        <div class="hint blue">视频按 1 倍速正常播放，不加速、不静音；可切到后台，但请保持标签页打开。</div>',
      '      </div>',
      '      <div class="pane" data-pane="tasks">',
      '        <div class="sect">章节</div>',
      '        <div class="list" data-ref="chapterList"><div class="empty">加载中…</div></div>',
      '        <div class="sect">当前章节任务点</div>',
      '        <div class="list" data-ref="cardList"><div class="empty">进入章节后显示</div></div>',
      '        <div class="sect">本页结构（自动识别）</div>',
      '        <div class="list" data-ref="anatomyList"><div class="empty">识别到本页任务点后显示</div></div>',
      '      </div>',
      '      <div class="pane" data-pane="api">',
      '        <div class="field"><label>API 地址</label><input type="text" data-cfg="api.baseUrl" placeholder="https://api.deepseek.com"></div>',
      '        <div class="field"><label>接口路径</label><input type="text" data-cfg="api.path" placeholder="/chat/completions"></div>',
      '        <div class="field"><label>模型名称</label><input type="text" data-cfg="api.model" placeholder="deepseek-chat / deepseek-reasoner" list="cxhModelList"><datalist id="cxhModelList"><option value="deepseek-chat"></option><option value="deepseek-reasoner"></option></datalist></div>',
      '        <label class="toggle tight"><input type="checkbox" data-cfg="api.thinking"><i class="switch"></i>思考模式（deepseek-reasoner，更慢更准）</label>',
      '        <label class="toggle tight"><input type="checkbox" data-cfg="api.stream"><i class="switch"></i>流式接收（实时显示思考进度，失败回退）</label>',
      '        <label class="toggle tight"><input type="checkbox" data-cfg="api.showReasoning"><i class="switch"></i>日志里折叠显示思考过程</label>',
      '        <div class="field"><label>API Key</label><div class="row"><input type="password" data-cfg="api.key" placeholder="sk-..."><button data-act="eye">显示</button></div></div>',
      '        <div class="grid2">',
      '          <div class="field"><label>温度（思考模型不生效）</label><input type="number" step="0.1" min="0" max="1.5" data-cfg="api.temperature"></div>',
      '          <div class="field"><label>最大 tokens（思考建议 ≥16384）</label><input type="number" step="128" min="256" max="65536" data-cfg="api.maxTokens"></div>',
      '        </div>',
      '        <div class="grid2">',
      '          <div class="field"><label>超时（秒）</label><input type="number" min="10" data-cfg="api.timeoutSec"></div>',
      '          <div class="field"><label>每题间隔（秒）</label><div class="grid2"><input type="number" step="0.5" data-cfg="answerGapMin"><input type="number" step="0.5" data-cfg="answerGapMax"></div></div>',
      '        </div>',
      '        <div class="field"><label>附加提示词（可选）</label><textarea rows="2" data-cfg="api.extraPrompt" placeholder="例如：这是大学生职业规划课程"></textarea></div>',
      '        <div class="row" style="margin-top:4px"><button class="primary" data-act="test">测试连接</button><button data-act="save">保存配置</button></div>',
      '        <div class="hint" data-ref="apiResult">Key 只保存在本机 Tampermonkey 存储，仅用于直连 DeepSeek。</div>',
      '      </div>',
      '      <div class="pane" data-pane="logs">',
      '        <div class="row" style="margin-bottom:6px"><button data-act="clearLogs">清空日志</button><span style="color:#94a3b8;font-size:11px" data-ref="logCount"></span></div>',
      '        <div class="logbox" data-ref="logList"></div>',
      '      </div>',
      '      <div class="pane" data-pane="settings">',
      '        <div class="field"><label>课程名（用于自动打开课程）</label><input type="text" data-cfg="courseName"></div>',
      '        <label class="toggle"><input type="checkbox" data-cfg="autoStart"><i class="switch"></i>打开课程页后自动开始</label>',
      '        <label class="toggle"><input type="checkbox" data-cfg="autoOpenCourse"><i class="switch"></i>在课程列表自动打开指定课程</label>',
      '        <label class="toggle"><input type="checkbox" data-cfg="forceNormalSpeed"><i class="switch"></i>强制 1 倍速（推荐）</label>',
      '        <label class="toggle"><input type="checkbox" data-cfg="autoSubmit"><i class="switch"></i>答完自动提交</label>',
      '        <label class="toggle"><input type="checkbox" data-cfg="skipAnswer"><i class="switch"></i>不作答（遇到题目直接跳过，不调用 API）</label>',
      '        <label class="toggle"><input type="checkbox" data-cfg="answerHomework"><i class="switch"></i>自动答章节测验/作业</label>',
      '        <label class="toggle"><input type="checkbox" data-cfg="answerVideoQuiz"><i class="switch"></i>自动答视频弹窗题</label>',
      '        <label class="toggle"><input type="checkbox" data-cfg="answerExam"><i class="switch"></i>自动答考试（默认关闭）</label>',
      '        <label class="toggle"><input type="checkbox" data-cfg="protectMode"><i class="switch"></i>检测验证码/人脸即暂停（推荐）</label>',
      '        <label class="toggle"><input type="checkbox" data-cfg="soundOnFinish"><i class="switch"></i>完成时提示音</label>',
      '        <div class="grid3" style="margin-top:8px">',
      '          <div class="field"><label>任务间隔最小</label><input type="number" step="0.5" min="0" data-cfg="taskDelayMin"></div>',
      '          <div class="field"><label>任务间隔最大</label><input type="number" step="0.5" min="0" data-cfg="taskDelayMax"></div>',
      '          <div class="field"><label>单任务上限（分）</label><input type="number" min="10" data-cfg="maxTaskMinutes"></div>',
      '        </div>',
      '        <div class="row" style="margin-top:6px"><button data-act="save">保存设置</button><button class="danger" data-act="reset">清除本课程进度</button></div>',
      '        <div class="hint">脚本不会修改课程数据，只模拟点击播放/翻页与答题；请遵守课程与学校规定。</div>',
      '      </div>',
      '    </div>',
      '    <div class="foot">',
      '      <button class="primary" data-act="start" data-ref="btnStart">开始刷课</button>',
      '      <button data-act="pause" data-ref="btnPause">暂停</button>',
      '      <button data-act="skip" data-ref="btnSkip">跳过当前</button>',
      '    </div>',
      '  </div>',
      '  <div class="ball" data-ref="ball" title="展开控制台"><span data-ref="ballTxt">学</span><i class="bdot" data-ref="ballDot"></i></div>',
      '  <div class="toast" data-ref="toast"></div>',
      '</div>'
    ].join('\n');
  }

  function uiQ(sel) {
    return UI.root ? UI.root.querySelector(sel) : null;
  }
  function uiRef(name) {
    return uiQ('[data-ref="' + name + '"]');
  }

  function mountUI() {
    if (!IS_TOP || UI.host) return;
    const host = document.createElement('div');
    host.id = 'cxh-host';
    host.style.cssText = 'position:fixed;z-index:2147483000;right:18px;bottom:18px;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    root.appendChild(style);
    const holder = document.createElement('div');
    holder.innerHTML = uiTemplate();
    root.appendChild(holder.firstElementChild);
    UI.host = host;
    UI.root = root;

    // 旧版本可能把面板拖到屏幕外或折叠成看不见的小球：启动时强制回到可见位置
    const savedX = Number(CFG.ui.x);
    const savedY = Number(CFG.ui.y);
    const xOk = isFinite(savedX) && savedX >= 0 && savedX <= innerWidth - 120;
    const yOk = isFinite(savedY) && savedY >= 0 && savedY <= innerHeight - 80;
    if (xOk && yOk) {
      host.style.left = clamp(savedX, 0, Math.max(0, innerWidth - 400)) + 'px';
      host.style.top = clamp(savedY, 0, Math.max(0, innerHeight - 260)) + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    } else {
      host.style.right = '18px';
      host.style.bottom = '18px';
      CFG.ui.x = null;
      CFG.ui.y = null;
    }
    if (CFG.ui.collapsed) {
      CFG.ui.collapsed = false;
      uiSetCollapsed(false, true);
    }

    root.addEventListener('click', onUiClick);
    root.addEventListener('change', onUiChange);
    root.addEventListener('keydown', (e) => { e.stopPropagation(); });
    UI.drag = null;
    const head = uiRef('head');
    if (head) {
      head.addEventListener('pointerdown', onDragStart);
      head.addEventListener('dblclick', () => uiSetCollapsed(!UI.collapsed));
    }
    const ball = uiRef('ball');
    if (ball) ball.addEventListener('click', () => uiSetCollapsed(false));

    onLogHook = (item) => uiAppendLog(item);
    uiSyncForm();
    if (CFG.ui && CFG.ui.tab) uiSetTab(CFG.ui.tab);
    uiRenderLogs();
    on('state', uiScheduleUpdate);
    uiUpdate(true);
  }

  function uiSetCollapsed(v, silent) {
    UI.collapsed = !!v;
    const wrap = uiRef('wrap');
    if (wrap) wrap.classList.toggle('collapsed', UI.collapsed);
    CFG.ui.collapsed = UI.collapsed;
    if (!silent) saveConfig();
    if (!UI.collapsed) uiUpdate(true);
  }

  function uiSetTab(tab) {
    UI.tab = tab || 'overview';
    CFG.ui.tab = UI.tab;
    saveConfig();
    $$('[data-tab]', UI.root).forEach((b) => b.classList.toggle('on', b.getAttribute('data-tab') === UI.tab));
    $$('[data-pane]', UI.root).forEach((p) => p.classList.toggle('on', p.getAttribute('data-pane') === UI.tab));
    if (UI.tab === 'tasks') uiRenderTasks(true);
    if (UI.tab === 'logs') uiRenderLogs();
    if (UI.tab === 'api') uiUpdateApiResult();
  }

  function uiScheduleUpdate() {
    if (UI.updateTimer) return;
    UI.updateTimer = setTimeout(() => {
      UI.updateTimer = 0;
      uiUpdate(false);
    }, 160);
  }

  const PHASE_TEXT = {
    idle: '待机',
    starting: '正在启动',
    running: '自动刷课',
    waiting: '等待中',
    chapter: '切换章节',
    opening: '打开课程',
    quiz: '答题中',
    blocked: '已暂停',
    done: '已完成',
    error: '出现异常',
    login: '未登录',
    need: '需要点击'
  };

  function uiUpdate(force) {
    if (!UI.root) return;
    const dot = uiRef('dot');
    const ballDot = uiRef('ballDot');
    let mode = 'idle';
    if (S.blocked) mode = 'block';
    else if (S.phase === 'done') mode = 'done';
    else if (S.running) mode = 'run';
    else if (S.phase === 'error') mode = 'block';
    [dot, ballDot].forEach((d) => {
      if (!d) return;
      d.className = (d === dot ? 'dot' : 'bdot') + ' ' + mode;
    });
    const phaseEl = uiRef('phase');
    if (phaseEl) phaseEl.textContent = (PHASE_TEXT[S.phase] || S.phase || '待机') + (S.running ? ' · 运行中' : '');
    const tag = uiRef('tag');
    if (tag) {
      tag.textContent = S.blocked ? '已暂停' : (S.running ? '运行中' : (S.phase === 'done' ? '已完成' : '未开始'));
    }
    const msg = uiRef('msg');
    if (msg) msg.textContent = S.message || '—';

    const bar = uiRef('bar');
    const fill = uiRef('barFill');
    const cards = Array.isArray(S.cards) ? S.cards : [];
    if (bar && fill) {
      const total = cards.length;
      const done = cards.filter((c) => c.done).length;
      if (total > 0) {
        bar.classList.remove('indet');
        const pct = Math.round(done / total * 100);
        fill.style.width = pct + '%';
        fill.style.transform = '';
      } else if (S.running) {
        bar.classList.add('indet');
        fill.style.width = '35%';
      } else {
        bar.classList.remove('indet');
        fill.style.width = '0%';
      }
    }

    const vCourse = uiRef('vCourse');
    if (vCourse) vCourse.textContent = S.course.name || CFG.courseName || '未识别';
    const vChapter = uiRef('vChapter');
    if (vChapter) {
      const act = S.chapters.find((c) => c.active);
      vChapter.textContent = act ? act.title : (S.currentChapterId ? ('章节 ' + S.currentChapterId) : '—');
    }
    const vCard = uiRef('vCard');
    if (vCard) {
      const act = cards.find((c) => c.active);
      vCard.textContent = act ? (act.title + (act.type ? '（' + (MODULE_LABEL[act.type] || act.type) + '）' : '')) : (S.activeCardId || '—');
    }
    const vProgress = uiRef('vProgress');
    if (vProgress) {
      const total = cards.length;
      const done = cards.filter((c) => c.done).length;
      vProgress.textContent = total ? (done + ' / ' + total + ' 个任务点') : (S.doneTasks ? ('本次已完成 ' + S.doneTasks + ' 个') : '—');
    }
    const apiEl = uiRef('vApi');
    if (apiEl) {
      const ok = apiConfigured();
      const think = ok && thinkingEnabled();
      apiEl.innerHTML = ok
        ? '<span class="badge ok">已配置</span> ' + esc(CFG.api.model || '') + (think ? ' <span class="badge wait">思考</span>' : '')
        : '<span class="badge no">未配置</span> 答题将跳过';
      if (S.apiState === 'fail') apiEl.innerHTML += ' <span class="badge no">连接失败</span>';
    }
    const notice = uiRef('notice');
    if (notice) {
      notice.style.display = apiConfigured() ? 'none' : 'block';
    }
    const btnStart = uiRef('btnStart');
    if (btnStart) {
      btnStart.textContent = S.running ? '运行中…' : (S.blocked ? '重新开始' : '开始刷课');
      btnStart.disabled = S.running;
    }
    const btnPause = uiRef('btnPause');
    if (btnPause) btnPause.disabled = !S.running;
    const btnSkip = uiRef('btnSkip');
    if (btnSkip) btnSkip.disabled = !S.running && !S.blocked;

    if (UI.tab === 'tasks') uiRenderTasks(force);
    if (UI.tab === 'logs') {
      const c = uiRef('logCount');
      if (c) c.textContent = LOGS.length + ' 条';
    }
    uiUpdateApiResult();
  }

  function uiUpdateApiResult() {
    const box = uiRef('apiResult');
    if (!box) return;
    if (S.apiState === 'testing') {
      box.textContent = '正在测试连接…';
      box.className = 'hint blue';
    } else if (S.apiState === 'ok') {
      box.textContent = '✅ ' + (S.apiInfo || '连接正常');
      box.className = 'hint blue';
      try { box.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    } else if (S.apiState === 'fail') {
      box.textContent = '❌ ' + (S.apiInfo || '连接失败');
      box.className = 'hint';
      try { box.scrollIntoView({ block: 'nearest' }); } catch (e) {}
    } else {
      box.textContent = 'Key 只保存在本机 Tampermonkey 存储，仅用于直连 DeepSeek。';
      box.className = 'hint';
    }
  }

  function uiRenderTasks(force) {
    if (UI.tab !== 'tasks' || !UI.root) return;
    const chapters = S.chapters || [];
    const cards = S.cards || [];
    const an = S.anatomy;
    const anatSig = an && an.rows ? an.rows.map((r) => r.state + ':' + r.label).join(',') : '';
    const sig = chapters.map((c) => c.id + ':' + (c.complete ? 1 : 0) + ':' + (c.active ? 1 : 0)).join('|') +
      '#' + cards.map((c) => c.id + ':' + (c.done ? 1 : 0) + ':' + (c.active ? 1 : 0)).join('|') +
      '#' + S.running + '#' + anatSig;
    if (!force && sig === UI.lastTasksSig) return;
    UI.lastTasksSig = sig;

    const cl = uiRef('chapterList');
    if (cl) {
      cl.textContent = '';
      if (!chapters.length) {
        cl.innerHTML = '<div class="empty">未识别到课程目录</div>';
      } else {
        chapters.forEach((c) => {
          const row = document.createElement('div');
          row.className = 'item' + (c.active ? ' on' : '') + (c.complete ? ' done' : '');
          row.setAttribute('data-chapter', c.id);
          const ico = document.createElement('span');
          ico.className = 'ico';
          ico.textContent = c.complete ? '✓' : (c.active ? '▶' : '○');
          const nm = document.createElement('span');
          nm.className = 'nm';
          nm.textContent = c.title;
          const st = document.createElement('span');
          st.className = 'st';
          st.textContent = c.complete ? '已完成' : (c.remain != null ? (c.remain + ' 个待完成') : '');
          row.appendChild(ico); row.appendChild(nm); row.appendChild(st);
          row.addEventListener('click', () => uiJumpChapter(c.id));
          cl.appendChild(row);
        });
      }
    }
    const kl = uiRef('cardList');
    if (kl) {
      kl.textContent = '';
      if (!cards.length) {
        kl.innerHTML = '<div class="empty">进入章节后显示任务点</div>';
      } else {
        cards.forEach((c) => {
          const row = document.createElement('div');
          row.className = 'item' + (c.active ? ' on' : '') + (c.done ? ' done' : '');
          row.setAttribute('data-card', c.id);
          const ico = document.createElement('span');
          ico.className = 'ico';
          ico.textContent = c.done ? '✓' : (c.type === 'video' ? '▶' : c.type === 'quiz' ? '?' : c.type === 'document' ? '≡' : '○');
          const nm = document.createElement('span');
          nm.className = 'nm';
          nm.textContent = c.title;
          const st = document.createElement('span');
          st.className = 'st';
          st.textContent = c.done ? '完成' : (c.skipped ? '跳过' : (MODULE_LABEL[c.type] || ''));
          row.appendChild(ico); row.appendChild(nm); row.appendChild(st);
          row.addEventListener('click', () => uiJumpCard(c.id));
          kl.appendChild(row);
        });
      }
    }
    const al = uiRef('anatomyList');
    if (al) {
      al.textContent = '';
      const anatState = S.anatomy;
      if (!anatState || !anatState.rows || !anatState.rows.length) {
        al.innerHTML = '<div class="empty">本页任务点识别中…</div>';
      } else {
        const head = document.createElement('div');
        head.className = 'empty';
        head.textContent = '本页：' + (anatState.title || '') + '（' + (anatState.total - anatState.pending) + ' / ' + anatState.total + '）';
        al.appendChild(head);
        anatState.rows.forEach((r) => {
          const row = document.createElement('div');
          row.className = 'item' + (r.state === 'done' ? ' done' : '');
          const ico = document.createElement('span');
          ico.className = 'ico';
          ico.textContent = r.state === 'done' ? '✓' : (r.state === 'manual' ? '!' : '○');
          const nm = document.createElement('span');
          nm.className = 'nm';
          nm.textContent = r.label + (r.detail ? '（' + r.detail + '）' : '');
          const st = document.createElement('span');
          st.className = 'st';
          st.textContent = r.state === 'done' ? '完成' : (r.state === 'manual' ? '需手动' : (r.state === 'skipped' ? '跳过' : '待完成'));
          row.appendChild(ico); row.appendChild(nm); row.appendChild(st);
          al.appendChild(row);
        });
      }
    }
  }

  async function uiJumpChapter(id) {
    const ch = (S.chapters || []).find((x) => String(x.id) === String(id));
    if (!ch) return;
    if (!S.running) startAutomation();
    await openChapter(ch);
    topTick(true);
  }

  async function uiJumpCard(id) {
    const doc = cardsDoc();
    if (doc) {
      const r = await clickCardTab(doc, id);
      if (!r.ok) warn('切换任务点失败：' + r.reason);
    } else {
      const ag = pickAgent('cards');
      if (ag) {
        try { await rpcAgent(ag, 'cards.click', { id: id }, 20000); } catch (e) { warn(e.message); }
      }
    }
    if (!S.running) startAutomation();
  }

  function appendLogThink(row, item) {
    if (!CFG.api.showReasoning) return;
    const rc = item && item.data && item.data.reasoning;
    if (!rc) return;
    const d = document.createElement('details');
    d.className = 'think';
    const sm = document.createElement('summary');
    sm.textContent = '思考过程（' + String(rc).length + ' 字）';
    const pre = document.createElement('pre');
    pre.textContent = String(rc);
    d.appendChild(sm); d.appendChild(pre);
    row.appendChild(d);
  }

  function buildLogRow(item) {
    const row = document.createElement('div');
    row.className = 'log ' + (item.level || 'info');
    const t = document.createElement('time');
    t.textContent = clock(item.t);
    const s = document.createElement('span');
    s.textContent = item.msg;
    row.appendChild(t); row.appendChild(s);
    appendLogThink(row, item);
    return row;
  }

  function uiAppendLog(item) {
    if (!UI.root || !item) return;
    const box = uiRef('logList');
    if (!box) return;
    const row = buildLogRow(item);
    box.appendChild(row);
    while (box.childElementCount > 220) box.removeChild(box.firstElementChild);
    box.scrollTop = box.scrollHeight;
    if (UI.tab === 'logs') {
      const c = uiRef('logCount');
      if (c) c.textContent = LOGS.length + ' 条';
    }
  }

  function uiRenderLogs() {
    if (!UI.root) return;
    const box = uiRef('logList');
    if (!box) return;
    box.textContent = '';
    LOGS.slice(-200).forEach((it) => {
      box.appendChild(buildLogRow(it));
    });
    box.scrollTop = box.scrollHeight;
    const c = uiRef('logCount');
    if (c) c.textContent = LOGS.length + ' 条';
  }

  function uiToast(msg) {
    const el = uiRef('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(UI.toastTimer);
    UI.toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
  }

  // ------------------------------ 表单
  function setCfgPath(path, value) {
    const parts = String(path).split('.');
    let o = CFG;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = value;
  }

  // 思考模式与模型名保持一致：模型名带 reasoner/r1/thinking 时自动进入思考模式；
  // 勾选思考模式但模型留空时自动填 deepseek-reasoner；用户显式写了 deepseek-chat 则以模型名为准（关掉开关）。
  // 自定义思考模型名（如 qwen-plus）既不覆盖模型名，也不清掉开关。
  function normalizeApiCfg() {
    if (!CFG.api) CFG.api = {};
    const model = String(CFG.api.model || '').trim();
    const rsn = isReasonerName(model);
    if (rsn) {
      CFG.api.thinking = true;
    } else if (CFG.api.thinking && (!model || /^deepseek[\s._-]*chat$/i.test(model))) {
      if (!model) CFG.api.model = 'deepseek-reasoner';
      else CFG.api.thinking = false;
    }
    CFG.api.maxTokens = clamp(Math.round(num(CFG.api.maxTokens, 4096)) || 4096, 256, 65536);
    CFG.api.timeoutSec = clamp(Math.round(num(CFG.api.timeoutSec, 120)) || 120, 10, 1800);
  }

  function readUiForm() {
    if (!UI.root) return;
    $$('[data-cfg]', UI.root).forEach((el) => {
      const path = el.getAttribute('data-cfg');
      let v;
      if (el.type === 'checkbox') v = !!el.checked;
      else if (el.type === 'number') v = num(el.value, 0);
      else v = el.value;
      setCfgPath(path, v);
    });
    if (num(CFG.taskDelayMax, 0) < num(CFG.taskDelayMin, 0)) CFG.taskDelayMax = CFG.taskDelayMin;
    if (num(CFG.answerGapMax, 0) < num(CFG.answerGapMin, 0)) CFG.answerGapMax = CFG.answerGapMin;
    normalizeApiCfg();
    saveConfig();
    broadcastConfig();
  }

  function uiSyncForm() {
    if (!UI.root) return;
    normalizeApiCfg();
    $$('[data-cfg]', UI.root).forEach((el) => {
      const path = el.getAttribute('data-cfg');
      const parts = path.split('.');
      let v = CFG;
      for (let i = 0; i < parts.length; i++) v = (v == null) ? undefined : v[parts[i]];
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = (v == null ? '' : v);
    });
  }

  async function uiTestApi() {
    readUiForm();
    const box = uiRef('apiResult');
    if (box) { box.textContent = '正在连接 DeepSeek…'; box.className = 'hint blue'; }
    if (!apiConfigured()) {
      if (box) { box.textContent = '请先填写 API Key 与模型名称'; box.className = 'hint'; }
      return;
    }
    try {
      const info = await testApiConnection();
      uiToast('连接成功');
      if (box) { box.textContent = '✅ ' + info; box.className = 'hint blue'; }
    } catch (e) {
      const msg = redact(e && e.message || e);
      uiToast('连接失败：' + truncate(msg, 60));
      if (box) { box.textContent = '❌ ' + msg; box.className = 'hint'; }
    }
    uiUpdate(true);
  }

  // ------------------------------ 事件
  function onUiClick(e) {
    const tabBtn = e.target.closest ? e.target.closest('[data-tab]') : null;
    if (tabBtn) { uiSetTab(tabBtn.getAttribute('data-tab')); return; }
    const actBtn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!actBtn) return;
    const act = actBtn.getAttribute('data-act');
    if (act === 'start') {
      readUiForm();
      if (!apiConfigured() && CFG.answerHomework) {
        uiToast('未配置 API：答题任务将跳过');
      }
      startAutomation();
    } else if (act === 'pause') {
      stopAutomation();
    } else if (act === 'skip') {
      skipCurrentTask();
    } else if (act === 'collapse') {
      uiSetCollapsed(true);
    } else if (act === 'save') {
      readUiForm();
      uiToast('配置已保存');
    } else if (act === 'test') {
      uiTestApi();
    } else if (act === 'eye') {
      const inp = uiQ('input[data-cfg="api.key"]');
      if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
    } else if (act === 'clearLogs') {
      LOGS.length = 0;
      uiRenderLogs();
      uiToast('日志已清空');
    } else if (act === 'reset') {
      if (PAGE_WIN.confirm('确定清除本课程在脚本里的进度记录？（不会影响学习通服务器数据）')) {
        resetCourseProgress();
        uiToast('已清除本地进度');
      }
    }
  }

  function onUiChange(e) {
    const el = e.target;
    if (!el || !el.getAttribute || !el.getAttribute('data-cfg')) return;
    const path = el.getAttribute('data-cfg') || '';
    readUiForm();
    if (path === 'api.thinking') {
      // 开关是权威：勾选即用 reasoner，取消即切回 chat，避免与模型名互相拉扯
      CFG.api.thinking = !!el.checked;
      if (CFG.api.thinking) {
        const m = String(CFG.api.model || '').trim();
        // 只在模型为空或本就是普通 chat 时替换；用户填的自定义思考模型名保持不变
        if (!m || /^deepseek[\s._-]*chat$/i.test(m)) CFG.api.model = 'deepseek-reasoner';
      } else if (isReasonerName(CFG.api.model)) {
        CFG.api.model = 'deepseek-chat';
      }
      saveConfig();
      broadcastConfig();
      uiSyncForm();
    } else if (path.indexOf('api.') === 0) {
      // 模型/数值字段改完统一回写一次，避免 clamp 后的值（如 tokens 上限、超时下限）与输入框显示不一致
      uiSyncForm();
    }
    uiUpdate(true);
  }

  function onDragStart(e) {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest('button')) return;
    const host = UI.host;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
    host.style.left = rect.left + 'px';
    host.style.top = rect.top + 'px';
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
    const move = (ev) => {
      const x = clamp(ev.clientX - ox, 0, Math.max(0, innerWidth - 60));
      const y = clamp(ev.clientY - oy, 0, Math.max(0, innerHeight - 40));
      host.style.left = x + 'px';
      host.style.top = y + 'px';
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      CFG.ui.x = parseInt(host.style.left, 10) || 0;
      CFG.ui.y = parseInt(host.style.top, 10) || 0;
      saveConfig();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  }

  // ---------------------------------------------------------------- 启动
  function pageHasCardsFrame() {
    try {
      return !!cardsDoc() || !!pickAgent('cards');
    } catch (e) { return false; }
  }

  function shouldAutoStart() {
    if (!CFG.autoStart) return false;
    const k = classifyPage();
    if (k === 'login') return false;
    if (k === 'course' || k === 'cards' || k === 'work' || k === 'exam') return true;
    if (k === 'courselist') return !!CFG.autoOpenCourse;
    if (k === 'video' || k === 'document' || k === 'audio' || k === 'module') return true;
    return pageHasCardsFrame();
  }

  function bootTop() {
    refreshCourse();
    topBridgeInit();
    mountUI();
    topLoopStart();
    broadcastConfig();

    // 首次用户手势后，重试被浏览器拦截的播放
    document.addEventListener('pointerdown', () => {
      if (S.running && (S.phase === 'need-gesture' || S.phase === 'waiting')) {
        setTimeout(() => topTick(true), 400);
      }
    }, true);

    // 单页应用/哈希切换时重置页面级缓存
    let lastHref = location.href;
    setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      S.cards = [];
      S.cardsReady = false;
      S.activeCardId = '';
      S.activeCard = null;
      TOP.cross = { key: '', endedAt: 0, last: '', tries: 0 };
      TOP.lastScanAt = 0;
      TOP.stuck = 0;
      TOP.errors = 0;
      TOP.quizDone = false;
      log('页面已切换：' + truncate(location.pathname, 60));
      uiUpdate(true);
      if (S.running) setTimeout(() => topTick(true), 800);
    }, 1500);

    let resume = false;
    try {
      resume = sessionStorage.getItem('cxh.resume') === '1';
      if (resume) sessionStorage.removeItem('cxh.resume');
    } catch (e) {}

    if (CFG.autoStart) {
      const k = classifyPage();
      if (k === 'login') {
        setPhase('login', '请先登录学习通，登录后会自动开始');
        log('检测到登录页，请先完成登录');
        return;
      }
      if (resume) {
        log('页面刷新后自动恢复运行');
        setTimeout(() => startAutomation(), 900);
        return;
      }
      if (shouldAutoStart()) {
        setTimeout(() => {
          if (!S.running) startAutomation();
        }, 1300);
      } else {
        setPhase('idle', '等待进入课程…');
      }
    } else {
      setPhase('idle', '自动开始已关闭，请点击「开始刷课」');
    }
  }

  function bootChild() {
    try {
      agentInit();
    } catch (e) {
      try { console.warn('[学习通助手] 子页面初始化失败', e); } catch (_) {}
    }
  }

  try {
    if (IS_TOP) bootTop();
    else bootChild();
  } catch (e) {
    try { console.error('[学习通助手] 启动失败', e); } catch (_) {}
  }

  // 暴露少量调试接口（只读/手动操作）
  if (IS_TOP) {
    try {
      window.__CXH_HELPER__ = {
        version: VERSION,
        state: S,
        config: CFG,
        logs: LOGS,
        start: startAutomation,
        stop: stopAutomation,
        skip: skipCurrentTask,
        openChapter: openChapter,
        scanChapters: scanChapters,
        tick: () => topTick(true)
      };
    } catch (e) {}
  }
})();

