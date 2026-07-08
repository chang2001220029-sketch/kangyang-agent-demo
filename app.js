/* =====================================================================
 * 乐颐 · 康养 Agent 演示   app.js
 * 复用「音视频识别.html」的 Emotion / API / ASR / TTS 能力，扩展为：
 * 数字人 + 7 Agent 能力条 + 决策面板 + 三大演示场景。
 * ===================================================================== */

/* ========== 1. 本地情绪识别（face-api.js，浏览器本地，无需 key） ========== */
var Emotion = (function () {
  "use strict";
  var MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/";
  var MAP = {
    happy: { t: "开心", e: "\uD83D\uDE04" }, sad: { t: "难过", e: "\uD83D\uDE22" }, angry: { t: "生气", e: "\uD83D\uDE20" },
    surprised: { t: "惊讶", e: "\uD83D\uDE32" }, fearful: { t: "紧张", e: "\uD83D\uDE28" }, disgusted: { t: "不适", e: "\uD83D\uDE16" }, neutral: { t: "平静", e: "\uD83D\uDE42" }
  };
  var loaded = false, running = false, timer = null,
      cur = { key: "neutral", text: "平静", emoji: "\uD83D\uDE42", conf: 0.6, scores: {} }, video, canvas, cb;
  function load() {
    if (loaded) return Promise.resolve();
    if (typeof faceapi === "undefined") return Promise.reject(new Error("face-api 未加载"));
    return Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL)
    ]).then(function () { loaded = true; });
  }
  function start(v, c, f) { video = v; canvas = c; cb = f; return load().then(function () { running = true; loop(); }); }
  function stop() { running = false; if (timer) { clearTimeout(timer); timer = null; } clear(); }
  function clear() { if (canvas) { var x = canvas.getContext("2d"); if (x) x.clearRect(0, 0, canvas.width, canvas.height); } }
  function loop() { if (!running) return; once().catch(function () {}).then(function () { if (running) timer = setTimeout(loop, 600); }); }
  function once() {
    if (!video || video.readyState < 2) return Promise.resolve();
    return faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
      .withFaceExpressions().then(function (r) {
        sync(); clear(); if (!r) return;
        var ex = r.expressions, bk = "neutral", bv = 0;
        Object.keys(ex).forEach(function (k) { if (ex[k] > bv) { bv = ex[k]; bk = k; } });
        var m = MAP[bk] || MAP.neutral;
        cur = { key: bk, text: m.t, emoji: m.e, conf: bv, scores: ex };
        box(r.detection.box); if (cb) cb(cur);
      });
  }
  function sync() { if (!canvas || !video) return; var w = video.videoWidth, h = video.videoHeight; if (w && h && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; } }
  function box(b) {
    var x = canvas.getContext("2d"); x.strokeStyle = "rgba(103,214,179,0.9)"; x.lineWidth = Math.max(2, canvas.width / 200);
    var r = 10, X = b.x, Y = b.y, W = b.width, H = b.height; x.beginPath(); x.moveTo(X + r, Y);
    x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r); x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.stroke();
  }
  return { start: start, stop: stop, getCurrent: function () { return cur; }, isReady: function () { return loaded && running; } };
})();

/* ========== 2. API：OpenAI 兼容流式 + 视觉调用（默认 Pollinations 免费） ========== */
var API = (function () {
  "use strict";
  function applyProxy(url, proxy) {
    if (proxy && proxy.trim()) return url.replace(/^https?:\/\/[^/]+/, proxy.trim().replace(/\/+$/, ""));
    return url;
  }
  function buildUserMessage(text, imageBase64) {
    if (!imageBase64) return { role: "user", content: text };
    return { role: "user", content: [
      { type: "text", text: text || "" },
      { type: "image_url", image_url: { url: imageBase64 } }
    ] };
  }
  function streamChat(opts) {
    var url = applyProxy(opts.apiUrl, opts.proxy);
    var headers = { "Content-Type": "application/json" };
    if (opts.apiKey && opts.apiKey.trim()) headers["Authorization"] = "Bearer " + opts.apiKey.trim();
    var payload = { model: opts.model, messages: opts.messages, stream: true };
    if (typeof opts.maxTokens === "number") payload.max_tokens = opts.maxTokens;
    if (typeof opts.temperature === "number") payload.temperature = opts.temperature;
    var body = JSON.stringify(payload);
    var retriesLeft = (typeof opts.maxRetries === "number") ? opts.maxRetries : 1;
    function attempt() {
      var ctrl = new AbortController(), timedOut = false, timer = null;
      if (opts.signal) opts.signal.addEventListener("abort", function () { try { ctrl.abort(); } catch (e) {} }, { once: true });
      if (opts.timeoutMs) timer = setTimeout(function () { timedOut = true; try { ctrl.abort(); } catch (e) {} }, opts.timeoutMs);
      var full = "";
      return fetch(url, { method: "POST", headers: headers, body: body, signal: ctrl.signal })
        .then(function (resp) {
          if (!resp.ok) return resp.text().then(function (t) { var e = new Error("HTTP " + resp.status + " " + t.slice(0, 300)); e.httpStatus = resp.status; throw e; });
          return readSSE(resp, function (piece, f) { full = f; if (opts.onDelta) opts.onDelta(piece, f); });
        })
        .then(function () { if (timer) clearTimeout(timer); if (opts.onDone) opts.onDone(full); })
        .catch(function (err) {
          if (timer) clearTimeout(timer);
          if (err && err.name === "AbortError" && !timedOut) return;
          if (timedOut) err = new Error("请求超时：" + (opts.timeoutMs / 1000) + " 秒内未完成");
          var retryable = !err.httpStatus || err.httpStatus >= 500;
          if (retriesLeft > 0 && retryable) { retriesLeft--; return new Promise(function (r) { setTimeout(r, 700); }).then(attempt); }
          if (opts.onError) opts.onError(err);
        });
    }
    return attempt();
  }
  /* 非流式：一次性拿到内容（视觉识别用） */
  function chat(opts) {
    var url = applyProxy(opts.apiUrl, opts.proxy);
    var headers = { "Content-Type": "application/json" };
    if (opts.apiKey && opts.apiKey.trim()) headers["Authorization"] = "Bearer " + opts.apiKey.trim();
    var payload = { model: opts.model, messages: opts.messages, stream: false };
    if (typeof opts.maxTokens === "number") payload.max_tokens = opts.maxTokens;
    if (typeof opts.temperature === "number") payload.temperature = opts.temperature;
    var body = JSON.stringify(payload);
    var ctrl = new AbortController(), timedOut = false, timer = null;
    if (opts.signal) opts.signal.addEventListener("abort", function () { try { ctrl.abort(); } catch (e) {} }, { once: true });
    if (opts.timeoutMs) timer = setTimeout(function () { timedOut = true; try { ctrl.abort(); } catch (e) {} }, opts.timeoutMs);
    return fetch(url, { method: "POST", headers: headers, body: body, signal: ctrl.signal })
      .then(function (resp) { if (!resp.ok) return resp.text().then(function (t) { throw new Error("HTTP " + resp.status + " " + t.slice(0, 200)); }); return resp.json(); })
      .then(function (j) { if (timer) clearTimeout(timer); return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || ""; })
      .catch(function (err) { if (timer) clearTimeout(timer); if (timedOut) throw new Error("请求超时：" + (opts.timeoutMs / 1000) + " 秒内未完成"); throw err; });
  }
  function readSSE(resp, onDelta) {
    var reader = resp.body.getReader(), decoder = new TextDecoder("utf-8"), buffer = "", full = "";
    function pump() {
      return reader.read().then(function (res) {
        if (res.done) return;
        buffer += decoder.decode(res.value, { stream: true });
        var lines = buffer.split("\n"); buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line || line.indexOf("data:") !== 0) continue;
          var data = line.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            var json = JSON.parse(data);
            var delta = json.choices && json.choices[0] && json.choices[0].delta;
            var piece = delta && delta.content;
            if (piece) { full += piece; onDelta(piece, full); }
          } catch (e) {}
        }
        return pump();
      });
    }
    return pump();
  }
  return { buildUserMessage: buildUserMessage, streamChat: streamChat, chat: chat };
})();

/* ========== 3. 数字人「乐颐」SVG 组件（工厂，可多实例） ========== */
function createAvatar(hostEl, opts) {
  "use strict";
  opts = opts || {};
  var MOODS = {
    calm:    { brow: "M60 92 q18 -6 34 0 M146 92 q18 -6 34 0", mouth: "M96 150 q24 10 48 0", cheek: 0 },
    happy:   { brow: "M60 88 q18 -8 34 0 M146 88 q18 -8 34 0", mouth: "M92 146 q28 22 56 0", cheek: 0.5 },
    care:    { brow: "M60 90 q18 2 34 -2 M146 88 q18 -2 34 2", mouth: "M98 152 q22 6 44 0", cheek: 0.2 },
    serious: { brow: "M58 86 q18 6 34 2 M146 88 q18 -2 34 -6", mouth: "M100 154 q20 0 40 0", cheek: 0 },
    think:   { brow: "M60 86 q18 -4 34 2 M146 90 q18 -2 34 -4", mouth: "M104 152 q16 4 32 0", cheek: 0 }
  };
  var SVG =
    '<svg class="avatarSvg" id="avatarSvg" viewBox="0 0 240 300" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<linearGradient id="lyhair" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a4260"/><stop offset="1" stop-color="#242a40"/></linearGradient>' +
        '<linearGradient id="lycloth" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#48c69d"/><stop offset="1" stop-color="#0e7f68"/></linearGradient>' +
        '<radialGradient id="lyface" cx="0.5" cy="0.42" r="0.62"><stop offset="0" stop-color="#ffe5d0"/><stop offset="1" stop-color="#f4c9a8"/></radialGradient>' +
      '</defs>' +
      '<path d="M40 300 q0 -70 80 -70 q80 0 80 70 Z" fill="url(#lycloth)"/>' +
      '<path d="M120 232 l-16 22 16 14 16 -14 Z" fill="#ffffff" opacity="0.9"/>' +
      '<circle cx="120" cy="278" r="5" fill="#ffffff" opacity="0.85"/>' +
      '<rect x="104" y="196" width="32" height="42" rx="14" fill="#f4c9a8"/>' +
      '<path d="M54 120 q0 -84 66 -84 q66 0 66 84 q0 34 -12 54 l-14 -20 q6 -40 -40 -40 q-46 0 -40 40 l-14 20 q-12 -20 -12 -54 Z" fill="url(#lyhair)"/>' +
      '<ellipse cx="120" cy="118" rx="62" ry="70" fill="url(#lyface)"/>' +
      '<ellipse class="ly-cheekL" cx="82" cy="140" rx="12" ry="7" fill="#ff9d8a" opacity="0"/>' +
      '<ellipse class="ly-cheekR" cx="158" cy="140" rx="12" ry="7" fill="#ff9d8a" opacity="0"/>' +
      '<path class="ly-brows" d="M60 92 q18 -6 34 0 M146 92 q18 -6 34 0" stroke="#5b4636" stroke-width="4" fill="none" stroke-linecap="round"/>' +
      '<g class="ly-eyeL"><ellipse cx="90" cy="112" rx="11" ry="13" fill="#fff"/><circle cx="92" cy="114" r="6.5" fill="#3a2c22"/><circle cx="94" cy="111" r="2" fill="#fff"/></g>' +
      '<g class="ly-eyeR"><ellipse cx="150" cy="112" rx="11" ry="13" fill="#fff"/><circle cx="150" cy="114" r="6.5" fill="#3a2c22"/><circle cx="152" cy="111" r="2" fill="#fff"/></g>' +
      '<path d="M118 122 q-4 12 2 18" stroke="#e0a884" stroke-width="3" fill="none" stroke-linecap="round"/>' +
      '<path class="ly-mouth" d="M96 150 q24 10 48 0" stroke="#c25b5b" stroke-width="5" fill="#c25b5b" stroke-linejoin="round"/>' +
      '<path d="M58 96 q4 -60 62 -60 q58 0 62 60 q-30 -30 -62 -30 q-32 0 -62 30 Z" fill="url(#lyhair)"/>' +
    '</svg>';

  hostEl.innerHTML = SVG;
  var root = hostEl.querySelector(".avatarSvg");
  var mouth = hostEl.querySelector(".ly-mouth");
  var eyeL = hostEl.querySelector(".ly-eyeL"), eyeR = hostEl.querySelector(".ly-eyeR");
  var brows = hostEl.querySelector(".ly-brows");
  var cheekL = hostEl.querySelector(".ly-cheekL"), cheekR = hostEl.querySelector(".ly-cheekR");
  var mood = "calm", talking = false, mouthTimer = null, blinkTimer = null, breatheTimer = null;

  function setMood(m) {
    mood = m; var d = MOODS[m] || MOODS.calm;
    if (brows) brows.setAttribute("d", d.brow);
    if (mouth && !talking) mouth.setAttribute("d", d.mouth);
    if (cheekL) { cheekL.style.transition = cheekR.style.transition = "opacity .4s"; cheekL.style.opacity = cheekR.style.opacity = d.cheek; }
  }
  function blink() {
    if (!eyeL || !eyeR) return;
    eyeL.style.transition = eyeR.style.transition = "transform .09s";
    eyeL.style.transformOrigin = "90px 112px"; eyeR.style.transformOrigin = "150px 112px";
    eyeL.style.transform = eyeR.style.transform = "scaleY(0.1)";
    setTimeout(function () { if (eyeL) eyeL.style.transform = ""; if (eyeR) eyeR.style.transform = ""; }, 120);
  }
  function scheduleBlink() { blinkTimer = setTimeout(function () { blink(); scheduleBlink(); }, 2200 + Math.random() * 2600); }
  function breathe() {
    if (!root) return; root.style.transition = "transform 1.3s ease-in-out"; var up = false;
    breatheTimer = setInterval(function () { up = !up; root.style.transform = up ? "translateY(4px)" : "translateY(0)"; }, 1300);
  }
  function startTalk() {
    if (talking) return; talking = true; if (opts.wrap) opts.wrap.classList.add("speaking");
    var open = false;
    mouthTimer = setInterval(function () {
      open = !open; if (!mouth) return;
      if (open) mouth.setAttribute("d", "M98 148 q22 20 44 0 q-22 -6 -44 0");
      else mouth.setAttribute("d", (MOODS[mood] || MOODS.calm).mouth);
    }, 150);
  }
  function stopTalk() {
    talking = false; if (opts.wrap) opts.wrap.classList.remove("speaking");
    if (mouthTimer) { clearInterval(mouthTimer); mouthTimer = null; }
    if (mouth) mouth.setAttribute("d", (MOODS[mood] || MOODS.calm).mouth);
  }
  scheduleBlink(); breathe(); setMood("calm");
  return { setMood: setMood, startTalk: startTalk, stopTalk: stopTalk };
}

/* ========== 4. 7 Agent 定义 ========== */
var AGENTS = [
  { id: "health",   name: "健康预警",   icon: "\u2764\uFE0F" },
  { id: "med",      name: "药事管理",   icon: "\uD83D\uDC8A" },
  { id: "emotion",  name: "情绪识别",   icon: "\uD83D\uDE42" },
  { id: "crisis",   name: "危机干预",   icon: "\uD83D\uDED1" },
  { id: "cognitive",name: "认知评估",   icon: "\uD83E\uDDE9" },
  { id: "dispatch", name: "服务调度",   icon: "\uD83D\uDE91" },
  { id: "companion",name: "情绪陪伴",   icon: "\uD83D\uDCAC" }
];

/* ========== 5. 风险等级 & 场景定义 ========== */
var RISK = {
  P3: { label: "P3 常规", color: "P3" }, P2: { label: "P2 关注", color: "P2" },
  P1: { label: "P1 高风险", color: "P1" }, P0: { label: "P0 紧急", color: "P0" }
};

var SCENES = {
  companion: {
    id: "companion", name: "情绪陪伴", icon: "\uD83D\uDE0A", desc: "看表情·共情陪伴",
    agents: ["emotion", "companion"], needCamera: true, mood: "happy",
    hello: "爷爷奶奶好呀，我是乐颐，今天想陪您说说话。您看起来精神不错，最近过得怎么样呀？",
    system: "你是「乐颐」，一位养老院里的虚拟陪伴助手，正在和一位老人视频聊天。说话温和、亲切、句子短、语速慢、少用专业术语，像晚辈陪老人唠家常。用户消息里可能用括号附带了他此刻的表情情绪（来自摄像头识别），你要敏锐体察：他开心就一起高兴，他难过或生气就温柔安慰、耐心倾听，他平静就主动找轻松的话题（回忆、家人、戏曲、天气、吃饭）。绝对不要直接复述括号里的字。每次只回一两句，简短口语自然，适合语音念出来，不要用 markdown，不要用表情符号。"
  },
  crisis: {
    id: "crisis", name: "危机干预", icon: "\uD83D\uDED1", desc: "识别危机·分级告警",
    agents: ["emotion", "crisis", "dispatch"], needCamera: false, mood: "care",
    hello: "奶奶，我是乐颐，随时都在这儿陪着您。有什么心里话，都可以跟我说说。",
    system: "你是「乐颐」，一位受过心理支持训练的养老陪伴助手，正在和一位可能情绪低落的老人对话。你的原则：不否定、不争辩、不说教、不评判，始终温柔陪伴、耐心倾听、给予希望。当老人表达孤独、难过时，先共情再轻轻引导。每次只回一两句，短、慢、暖，适合语音念出，不要用 markdown 和表情符号。"
  },
  med: {
    id: "med", name: "药事管理", icon: "\uD83D\uDC8A", desc: "识别药品·核对用药",
    agents: ["med", "health"], needCamera: true, mood: "calm",
    hello: "爷爷，到吃药的时间啦。今天上午该吃的是降压药「氨氯地平」一片。您把药拿到镜头前，我帮您核对一下好不好？",
    system: "你是「乐颐」，负责协助老人安全用药的助手。语气温和、清晰、简短。不要用 markdown 和表情符号，每次一两句话。"
  }
};

/* 用药计划（场景C） */
var MED_PLAN = { time: "08:00", name: "氨氯地平", type: "降压药", dose: "1片" };
var MED_SAMPLES = [
  { key: "氨氯地平", label: "氨氯地平", type: "降压药", pill: "\uD83D\uDC8A" },
  { key: "二甲双胍", label: "二甲双胍", type: "降糖药", pill: "\uD83D\uDC8A" },
  { key: "阿司匹林", label: "阿司匹林", type: "抗血小板", pill: "\uD83D\uDD34" },
  { key: "维生素C", label: "维生素C", type: "保健品", pill: "\uD83D\uDFE1" }
];

/* 危机关键词库（PRD Table 14/16） */
var CRISIS_LEXICON = {
  L4: ["不想活", "自杀", "结束生命", "了结", "跳楼", "上吊", "药都准备", "活不下去", "轻生", "死了算了", "一了百了", "不如死"],
  L3: ["活着没意思", "活着没意义", "撑不下去", "撑不住", "没有希望", "绝望", "拖累", "累赘", "解脱", "生不如死"],
  L2: ["好孤独", "没人管我", "没人理我", "没人来看我", "睡不着", "吃不下", "特别难受", "喘不过气", "很害怕", "好怕", "没意思", "提不起劲"],
  L1: ["孤单", "想家", "闷得慌", "无聊", "有点难受", "不开心", "委屈"]
};
var CRISIS_LEVEL_MAP = { L4: "P0", L3: "P1", L2: "P2", L1: "P3" };

/* ========== 6. 主流程 ========== */
(function () {
  "use strict";
  var S = { IDLE: "idle", LISTENING: "listening", THINKING: "thinking", SPEAKING: "speaking" };
  var LS_KEY = "leyi_kangyang_v3";
  var cfg = loadConfig();
  function loadConfig() {
    var def = {
      // 主：火山方舟 豆包（OpenAI 兼容）
      apiUrl: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
      apiKey: "",
      model: "doubao-seed-1-6-250615",
      vModel: "doubao-seed-1-6-250615",
      // 备：免费模型（豆包不可用时自动降级，保证现场不断）
      fbUrl: "https://text.pollinations.ai/openai", fbModel: "openai-large", fbVModel: "openai",
      proxy: "", rate: "1", voice: "", timeoutMs: 12000, maxTokens: 160
    };
    try { var s = JSON.parse(localStorage.getItem(LS_KEY)); if (s) Object.assign(def, s); } catch (e) {}
    return def;
  }
  function saveConfig() { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) {} }

  var $ = function (id) { return document.getElementById(id); };
  var localVideo = $("localVideo"), overlay = $("overlay"), pip = $("pip"), avatarWrap = $("avatarWrap");
  var captions = $("captions"), statusDot = $("statusDot"), statusText = $("statusText");
  var stageIndicator = $("stageIndicator"), indLabel = $("indLabel");
  var decBody = $("decBody"), agentBar = $("agentBar"), scenesEl = $("scenes");
  var muteBtn = $("muteBtn"), endBtn = $("endBtn"), kbBtn = $("kbBtn"), captureBtn = $("captureBtn"), volRing = $("volRing");
  var textBar = $("textBar"), textInput = $("textInput");
  var startMask = $("startMask"), startBtn = $("startBtn"), startNoCam = $("startNoCam");
  var medTray = $("medTray"), alertModal = $("alertModal"), alertBox = $("alertBox");

  var Avatar = null;
  var stream = null, inCall = false, micOn = true, useCamera = true, state = S.IDLE;
  var recognition = null, wantListening = false;
  var abortCtrl = null, aiCapEl = null, userInterimEl = null, history = [];
  var audioCtx = null, analyser = null, volRAF = null;
  var curScene = "companion";
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  /* ---------- Agent 能力条 & 场景 Tab ---------- */
  function renderAgentBar() {
    agentBar.innerHTML = "";
    AGENTS.forEach(function (a) {
      var d = document.createElement("div");
      d.className = "agent-chip"; d.id = "chip_" + a.id;
      d.innerHTML = '<span class="ci">' + a.icon + '</span>' + a.name;
      agentBar.appendChild(d);
    });
  }
  function highlightAgents(ids, pulseId) {
    AGENTS.forEach(function (a) {
      var c = $("chip_" + a.id); if (!c) return;
      c.classList.toggle("active", ids.indexOf(a.id) >= 0);
      c.classList.toggle("pulse", a.id === pulseId);
    });
  }
  function renderScenes() {
    scenesEl.innerHTML = "";
    Object.keys(SCENES).forEach(function (k) {
      var s = SCENES[k];
      var t = document.createElement("button");
      t.className = "scene-tab" + (k === curScene ? " active" : ""); t.dataset.scene = k;
      t.innerHTML = '<span class="st-ic">' + s.icon + '</span><b>' + s.name + '</b><small>' + s.desc + '</small>';
      t.addEventListener("click", function () { switchScene(k); });
      scenesEl.appendChild(t);
    });
  }

  /* ---------- 字幕 & 状态 ---------- */
  function addCap(role, text, interim) {
    var el = document.createElement("div");
    el.className = "cap " + role + (interim ? " interim" : "");
    el.textContent = text; captions.appendChild(el); captions.scrollTop = captions.scrollHeight; return el;
  }
  function trimCaps() { while (captions.children.length > 40) captions.removeChild(captions.firstChild); }
  function scrollCaps() { captions.scrollTop = captions.scrollHeight; }
  function toast(msg, ms) {
    var t = $("hintToast"); t.textContent = msg; t.classList.remove("hidden");
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.add("hidden"); }, ms || 4000);
  }
  function setState(s) {
    state = s; statusDot.className = "dot";
    if (s === S.IDLE) {
      stageIndicator.classList.remove("show"); if (Avatar) Avatar.stopTalk();
      statusText.textContent = inCall ? "已连接" : "未连接"; if (inCall) statusDot.classList.add("online"); return;
    }
    stageIndicator.classList.add("show");
    if (s === S.LISTENING) { statusDot.classList.add("online"); statusText.textContent = "聆听中"; indLabel.textContent = "聆听中"; if (Avatar) Avatar.stopTalk(); }
    else if (s === S.THINKING) { statusDot.classList.add("thinking"); statusText.textContent = "思考中"; indLabel.textContent = "思考中"; if (Avatar) { Avatar.setMood("think"); Avatar.stopTalk(); } }
    else if (s === S.SPEAKING) { statusDot.classList.add("speaking"); statusText.textContent = "说话中"; indLabel.textContent = "说话中"; if (Avatar) Avatar.startTalk(); }
  }

  /* ---------- 媒体 ---------- */
  function getMedia() {
    return navigator.mediaDevices.getUserMedia({
      video: useCamera ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  }
  function attachStream(s) {
    stream = s;
    if (useCamera) { localVideo.srcObject = s; pip.classList.remove("hidden"); }
    else { pip.classList.add("hidden"); }
    startVolumeMeter(s);
    return useCamera ? localVideo.play().catch(function () {}) : Promise.resolve();
  }
  function stopMedia() {
    stopVolumeMeter();
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    localVideo.srcObject = null;
  }
  function startEmotion() {
    if (!useCamera) return;
    Emotion.start(localVideo, overlay, function (e) {
      $("emotionTag").classList.add("show");
      $("emoEmoji").textContent = e.emoji; $("emoText").textContent = e.text;
    }).catch(function (err) { console.warn(err); toast("表情模型加载失败（可能网络），对话仍可正常使用。", 5000); });
  }

  function startVolumeMeter(s) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var src = audioCtx.createMediaStreamSource(s);
      analyser = audioCtx.createAnalyser(); analyser.fftSize = 512; src.connect(analyser);
      var data = new Uint8Array(analyser.frequencyBinCount), loud = 0;
      (function tick() {
        if (!analyser) return;
        analyser.getByteTimeDomainData(data);
        var sum = 0; for (var i = 0; i < data.length; i++) { var v = (data[i] - 128) / 128; sum += v * v; }
        var rms = Math.sqrt(sum / data.length), scale = 1 + Math.min(rms * 4, 1.2);
        volRing.style.setProperty("--vol", (micOn ? scale : 1).toFixed(2));
        volRing.style.setProperty("--vol-op", (micOn ? Math.min(rms * 6, 0.9) : 0).toFixed(2));
        if (state === S.SPEAKING && micOn && rms > 0.09) { if (++loud > 3) { loud = 0; interrupt(); } } else loud = 0;
        volRAF = requestAnimationFrame(tick);
      })();
    } catch (e) {}
  }
  function stopVolumeMeter() {
    if (volRAF) { cancelAnimationFrame(volRAF); volRAF = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
    analyser = null; volRing.style.setProperty("--vol-op", "0");
  }
  function interrupt() { if (state === S.SPEAKING) { stopSpeak(); resumeAfterTurn(); } }

  /* ---------- 语音识别 ---------- */
  function initRecognition() {
    if (!SR) { toast("当前浏览器不支持语音识别，建议 Chrome/Edge，或用键盘打字。", 6000); return; }
    recognition = new SR(); recognition.lang = "zh-CN"; recognition.continuous = true; recognition.interimResults = true;
    recognition.onresult = function (e) {
      if (state === S.THINKING) return;
      var interim = "", finalText = "";
      for (var i = e.resultIndex; i < e.results.length; i++) { var r = e.results[i]; if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript; }
      if (state === S.SPEAKING) { if (interim || finalText) interrupt(); else return; }
      if (interim) { if (!userInterimEl) userInterimEl = addCap("user", interim, true); else userInterimEl.textContent = interim; scrollCaps(); }
      if (finalText.trim()) { if (userInterimEl) { userInterimEl.remove(); userInterimEl = null; } sendTurn(finalText.trim()); }
    };
    recognition.onerror = function (e) { if (e.error === "not-allowed" || e.error === "service-not-allowed") { toast("麦克风权限被拒绝。", 5000); wantListening = false; } };
    recognition.onend = function () { if (wantListening && state !== S.THINKING) { try { recognition.start(); } catch (e) {} } };
  }
  function startListening() { if (!recognition) { setState(S.IDLE); return; } wantListening = true; try { recognition.start(); } catch (e) {} setState(S.LISTENING); }
  function pauseListening() { wantListening = false; if (recognition) { try { recognition.stop(); } catch (e) {} } }

  /* ---------- TTS ---------- */
  var voices = [];
  function loadVoices() {
    voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    var sel = $("cfgVoice"); if (!sel) return; sel.innerHTML = "";
    var zh = voices.filter(function (v) { return /zh|cmn|Chinese/i.test(v.lang + v.name); });
    (zh.length ? zh : voices).forEach(function (v) {
      var o = document.createElement("option"); o.value = v.name; o.textContent = v.name + " (" + v.lang + ")";
      if (v.name === cfg.voice) o.selected = true; sel.appendChild(o);
    });
  }
  if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
  function speak(text, onend) {
    if (!window.speechSynthesis || !text) { setState(S.SPEAKING); setTimeout(function () { onend && onend(); }, 400); return; }
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text); u.lang = "zh-CN"; u.rate = parseFloat(cfg.rate) || 1;
    var v = voices.filter(function (x) { return x.name === cfg.voice; })[0]; if (v) u.voice = v;
    u.onboundary = function () { if (Avatar) Avatar.pulse(); };
    u.onend = function () { onend && onend(); }; u.onerror = function () { onend && onend(); };
    setState(S.SPEAKING); speechSynthesis.speak(u);
  }
  function stopSpeak() { if (window.speechSynthesis) speechSynthesis.cancel(); }

  /* ---------- 决策面板渲染 ---------- */
  function clearDecisions() { decBody.innerHTML = ""; }
  function pushDecision(d) {
    var empty = decBody.querySelector(".dec-empty"); if (empty) empty.remove();
    var card = document.createElement("div"); card.className = "dec-card";
    var risk = RISK[d.risk] || RISK.P3;
    var html = '<div class="dc-top"><span class="dc-agent">' + esc(d.agent || "") + '</span>' +
      '<span class="risk-badge risk-' + risk.color + '">' + risk.label + '</span></div>';
    if (d.result) html += '<div class="dc-row"><span class="k">判断结果 result</span>' + esc(d.result) + '</div>';
    if (typeof d.confidence === "number") {
      html += '<div class="dc-row"><span class="k">置信度 confidence · ' + Math.round(d.confidence * 100) + '%</span>' +
        '<div class="conf-bar"><div class="conf-fill" style="width:' + Math.round(d.confidence * 100) + '%"></div></div></div>';
    }
    if (d.evidence && d.evidence.length) {
      html += '<div class="dc-row"><span class="k">证据 evidence</span><ul class="ev-list">' +
        d.evidence.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + '</ul></div>';
    }
    if (d.actions && d.actions.length) {
      html += '<div class="dc-row"><span class="k">建议动作 suggested_actions</span><ul class="act-list">' +
        d.actions.map(function (a) { return "<li>" + esc(a) + "</li>"; }).join("") + '</ul></div>';
    }
    if (d.needHuman) html += '<div class="hr-flag">&#9888;&#65039; need_human_review = true（需人工复核）</div>';
    var json = {
      agent_name: d.agent, status: d.needHuman ? "need_human_review" : "success",
      risk_level: d.risk, confidence: d.confidence, result: d.result,
      evidence: d.evidence || [], suggested_actions: d.actions || [], need_human_review: !!d.needHuman
    };
    html += '<details class="dc-json"><summary>查看结构化 JSON</summary><pre>' + esc(JSON.stringify(json, null, 2)) + '</pre></details>';
    card.innerHTML = html; decBody.insertBefore(card, decBody.firstChild);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  /* ---------- 对话核心 ---------- */
  function buildMessages(userText) {
    var sc = SCENES[curScene];
    var msgs = [{ role: "system", content: sc.system }];
    var hist = history.slice(-16);
    for (var i = 0; i < hist.length; i++) msgs.push(hist[i]);
    msgs.push({ role: "user", content: userText });
    return msgs;
  }
  function sendTurn(text) {
    addCap("user", text, false); trimCaps(); setState(S.THINKING);
    if (curScene === "companion") runEmotionAgent(text);
    if (curScene === "crisis") { runEmotionAgent(text); if (runCrisisAgent(text)) return; }
    var sendText = text;
    if (useCamera && Emotion.isReady()) { var emo = Emotion.getCurrent().text; if (emo) sendText += "（我现在的表情看起来：" + emo + "）"; }
    streamReply(sendText, text);
  }
  function streamReply(sendText, rawText) {
    var sc = SCENES[curScene];
    if (Avatar) Avatar.setMood(sc.mood || "calm");
    var messages = buildMessages(sendText);
    aiCapEl = addCap("ai", "", false); aiCapEl.classList.add("streaming");
    abortCtrl = new AbortController();
    var started = false, firstTokenMs = 0, reqStart = 0;
    function run(tier) {
      var hasArkKey = !!(cfg.apiKey && cfg.apiKey.trim());
      if (tier === 0 && !hasArkKey) return run(1);
      var isArk = tier === 0;
      var modelName = isArk ? cfg.model : cfg.fbModel;
      reqStart = performance.now(); started = false; firstTokenMs = 0;
      console.info("[乐颐大模型] request", { provider: isArk ? "volc-ark" : "fallback", model: modelName, timeoutMs: cfg.timeoutMs, maxTokens: cfg.maxTokens });
      API.streamChat({
        apiUrl: isArk ? cfg.apiUrl : cfg.fbUrl,
        apiKey: isArk ? cfg.apiKey : "",
        model: modelName,
        proxy: cfg.proxy, messages: messages, signal: abortCtrl.signal, maxRetries: isArk ? 0 : 1,
        timeoutMs: parseInt(cfg.timeoutMs, 10) || 12000,
        maxTokens: parseInt(cfg.maxTokens, 10) || 160,
        temperature: 0.55,
        onDelta: function (piece, full) {
          if (!started) {
            started = true; firstTokenMs = Math.round(performance.now() - reqStart);
            console.info("[乐颐大模型] first_token", { provider: isArk ? "volc-ark" : "fallback", model: modelName, ms: firstTokenMs });
          }
          if (aiCapEl) { aiCapEl.textContent = full; scrollCaps(); }
        },
        onDone: function (full) {
          console.info("[乐颐大模型] done", { provider: isArk ? "volc-ark" : "fallback", model: modelName, firstTokenMs: firstTokenMs, totalMs: Math.round(performance.now() - reqStart), chars: (full || "").length });
          if (isArk && (!full || !full.trim()) && !started) { return run(1); }
          finishReply(full, rawText);
        },
        onError: function (err) {
          console.warn("[乐颐大模型] error", { provider: isArk ? "volc-ark" : "fallback", model: modelName, ms: Math.round(performance.now() - reqStart), message: String(err && err.message || err) });
          if (isArk && !started) { toast("豆包接口暂不可用，已切换免费模型继续演示。", 3500); return run(1); }
          onReplyError(err);
        }
      });
    }
    run(0);
  }
  function finishReply(full, rawText) {
    if (aiCapEl) aiCapEl.classList.remove("streaming");
    if (full && full.trim()) {
      if (aiCapEl) aiCapEl.textContent = full;
      history.push({ role: "user", content: rawText }); history.push({ role: "assistant", content: full });
      trimCaps(); speak(full, resumeAfterTurn);
    } else { if (aiCapEl) aiCapEl.remove(); aiCapEl = null; resumeAfterTurn(); }
  }
  function onReplyError(err) {
    if (aiCapEl) { aiCapEl.remove(); aiCapEl = null; }
    var msg = String(err && err.message || err);
    if (/429|rate|too many/i.test(msg)) toast("请求太频繁（限速），歇几秒再说～", 5000);
    else if (/Failed to fetch|NetworkError|CORS|Load failed/i.test(msg)) toast("网络请求失败，请检查网络后重试。", 6000);
    else toast("调用失败：" + msg.slice(0, 140), 7000);
    resumeAfterTurn();
  }
  function resumeAfterTurn() { aiCapEl = null; if (inCall && micOn && recognition) startListening(); else setState(S.IDLE); }

  /* ---------- 情绪识别 Agent ---------- */
  function runEmotionAgent(text) {
    highlightAgents(SCENES[curScene].agents, "emotion");
    var faceEmo = (useCamera && Emotion.isReady()) ? Emotion.getCurrent() : null;
    var negWords = ["难受", "难过", "孤独", "孤单", "没人", "想家", "委屈", "害怕", "睡不着", "没意思", "闷", "无聊", "不开心", "累"];
    var posWords = ["开心", "高兴", "好呀", "不错", "谢谢", "喜欢", "哈哈", "挺好"];
    var neg = negWords.filter(function (w) { return text.indexOf(w) >= 0; });
    var pos = posWords.filter(function (w) { return text.indexOf(w) >= 0; });
    var label = "平静 neutral", risk = "P3", conf = 0.72, ev = [];
    if (neg.length) { label = (neg.indexOf("孤独") >= 0 || neg.indexOf("孤单") >= 0) ? "孤独 lonely" : "情绪低落 sad"; risk = "P2"; conf = 0.8; ev.push("文本负向关键词：" + neg.join("、")); }
    else if (pos.length) { label = "愉悦 happy"; conf = 0.82; ev.push("文本正向关键词：" + pos.join("、")); }
    else ev.push("文本情绪：中性");
    if (faceEmo) {
      ev.push("表情识别：" + faceEmo.text + "（置信度 " + Math.round((faceEmo.conf || 0.6) * 100) + "%）");
      if (["sad", "angry", "fearful"].indexOf(faceEmo.key) >= 0 && risk === "P3") { risk = "P2"; label = "情绪低落 sad"; }
      conf = Math.min(0.95, (conf + (faceEmo.conf || 0.6)) / 2 + 0.1);
    }
    pushDecision({
      agent: "情绪识别模型（多模态）", risk: risk, confidence: conf, result: "情绪标签：" + label, evidence: ev,
      actions: risk === "P2" ? ["由情绪陪伴 Agent 生成共情回应", "记录情绪，纳入趋势分析"] : ["生成日常陪伴回应"], needHuman: false
    });
  }

  /* ---------- 心理危机干预 Agent（本地规则兜底，现场必现） ---------- */
  function detectCrisisLevel(text) {
    var levels = ["L4", "L3", "L2", "L1"];
    for (var i = 0; i < levels.length; i++) {
      var lv = levels[i], words = CRISIS_LEXICON[lv];
      for (var j = 0; j < words.length; j++) { if (text.indexOf(words[j]) >= 0) return { level: lv, word: words[j] }; }
    }
    return null;
  }
  function runCrisisAgent(text) {
    var hit = detectCrisisLevel(text);
    if (!hit) return false;
    highlightAgents(SCENES.crisis.agents, "crisis");
    var risk = CRISIS_LEVEL_MAP[hit.level];
    var meta = {
      L4: { result: "识别到明确自伤意图/计划（关键词：" + hit.word + "）",
        actions: ["保持对话、稳定情绪，引导远离危险物品", "立即通知家属与值班护理员，要求现场介入", "同步上报机构负责人，启动危机 SOP", "记录危机事件（触发文本/等级/处置）"],
        say: "奶奶，我在这儿，别怕，我一直陪着您。您对我很重要，我特别希望您好好的。我这就请这边的工作人员马上过来陪您，好不好？" },
      L3: { result: "识别到强烈绝望表达（关键词：" + hit.word + "）",
        actions: ["生成稳定陪伴话术，不否定、不说教", "通知家属/护理员今日重点关怀", "记录事件并纳入持续监测"],
        say: "奶奶，听您这么说，我心里也很不好受。您愿意跟我多讲讲吗？我一直都在，会陪着您慢慢过这段日子。" },
      L2: { result: "识别到孤独/低落等负面情绪（关键词：" + hit.word + "）",
        actions: ["共情回应并轻轻引导表达", "建议护理员今日主动关怀", "记录情绪，纳入趋势分析"], say: "" },
      L1: { result: "识别到轻度负面情绪（关键词：" + hit.word + "）",
        actions: ["温和陪伴，推荐熟悉的内容转移注意", "记录情绪波动"], say: "" }
    }[hit.level];

    pushDecision({
      agent: "心理危机干预 Agent", risk: risk, confidence: hit.level === "L4" ? 0.96 : hit.level === "L3" ? 0.9 : 0.82,
      result: meta.result, evidence: ["对话文本命中危机词库（" + hit.level + "）：" + hit.word, "结合语气与上下文语义判断"],
      actions: meta.actions, needHuman: (hit.level === "L4" || hit.level === "L3")
    });

    if (hit.level === "L4" || hit.level === "L3") {
      aiCapEl = addCap("ai", meta.say, false);
      history.push({ role: "user", content: text }); history.push({ role: "assistant", content: meta.say });
      if (Avatar) Avatar.setMood("care");
      setTimeout(function () { runDispatchForCrisis(hit.level); }, 400);
      speak(meta.say, function () { showCrisisAlert(hit.level, hit.word); resumeAfterTurn(); });
      return true;
    }
    return false; // L1/L2 交给温柔陪伴模型
  }
  function runDispatchForCrisis(level) {
    highlightAgents(SCENES.crisis.agents, "dispatch");
    var isEmerg = level === "L4";
    pushDecision({
      agent: "服务调度推荐 Agent", risk: isEmerg ? "P0" : "P1", confidence: 0.93,
      result: isEmerg ? "生成紧急上门任务（P0）" : "生成重点关怀任务（P1）",
      evidence: ["事件来源：心理危机干预 Agent", "事件等级：" + level, "老人位置：颐养苑 3 号楼 302 房间"],
      actions: isEmerg
        ? ["匹配最近的值班护理员（张敏，距离 30 米）", "SLA：2 分钟内到达", "同步通知家属（女儿）与心理咨询师"]
        : ["安排今日重点关怀任务给责任护理员", "SLA：30 分钟内探视"],
      needHuman: true
    });
  }

  /* ---------- 危机告警弹窗 ---------- */
  function showCrisisAlert(level, word) {
    var isEmerg = level === "L4";
    var risk = isEmerg ? "P0 紧急" : "P1 高风险";
    alertBox.innerHTML =
      '<div class="alert-top"><span class="ic">' + (isEmerg ? "\uD83D\uDEA8" : "\u26A0\uFE0F") + '</span>' +
        '<div><b>' + (isEmerg ? "紧急心理危机预警" : "高风险心理预警") + '</b><div>心理危机干预 Agent · 已触发人工介入流程</div></div></div>' +
      '<div class="alert-body">' +
        '<div class="al-row"><span class="k">风险等级</span><b style="color:' + (isEmerg ? "#ff4d5e" : "#ff8a3d") + '">' + risk + '</b></div>' +
        '<div class="al-row"><span class="k">触发信号</span>对话中出现「' + esc(word) + '」</div>' +
        '<div class="al-row"><span class="k">老人</span>王秀兰 · 82岁 · 3号楼302</div>' +
        '<div class="al-row"><span class="k">处置</span>' + (isEmerg ? "保持陪伴 + 立即现场介入" : "重点关怀 + 家属知会") + '</div>' +
        '<div class="notify-list" id="notifyList"></div>' +
      '</div>' +
      '<div class="alert-foot"><button class="primary-btn" id="alertConfirm">已知悉，人工接管</button></div>';
    alertModal.classList.add("show");
    var targets = isEmerg
      ? [{ n: "值班护理员 · 张敏", d: "呼叫已接通" }, { n: "家属 · 女儿 李芳", d: "短信+电话已发" }, { n: "心理咨询师 · 王医生", d: "已通知" }]
      : [{ n: "责任护理员 · 张敏", d: "任务已下发" }, { n: "家属 · 女儿 李芳", d: "关怀提醒已发" }];
    fillNotify(targets);
    $("alertConfirm").addEventListener("click", function () { alertModal.classList.remove("show"); });
  }
  function fillNotify(targets) {
    var nl = $("notifyList");
    targets.forEach(function (t, i) {
      var el = document.createElement("div"); el.className = "notify-item";
      el.innerHTML = '<span>&#128100; ' + t.n + '</span><span class="st"><span class="spin"></span>发送中</span>';
      nl.appendChild(el);
      setTimeout(function () { el.querySelector(".st").innerHTML = "&#10003; " + t.d; }, 800 + i * 700);
    });
  }

  /* ---------- 药事管理 Agent ---------- */
  function renderMedTray() {
    medTray.innerHTML = '<div style="flex:none;align-self:center;font-size:11px;color:var(--text-soft);padding:0 4px;">模拟药品<br>(点击核对)</div>';
    MED_SAMPLES.forEach(function (m) {
      var c = document.createElement("div"); c.className = "med-card";
      c.innerHTML = '<div class="pill">' + m.pill + '</div><b>' + m.label + '</b><small>' + m.type + '</small>';
      c.addEventListener("click", function () { if (!inCall) { toast("请先点击开始演示。", 3000); return; } checkMedication(m.key, m.type, "点击模拟药品", c); });
      medTray.appendChild(c);
    });
  }
  function checkMedication(detectedName, detectedType, source, cardEl) {
    highlightAgents(SCENES.med.agents, "med");
    var match = detectedName === MED_PLAN.name;
    if (cardEl) { medTray.querySelectorAll(".med-card").forEach(function (x) { x.classList.remove("correct", "wrong"); }); cardEl.classList.add(match ? "correct" : "wrong"); }
    var say, risk, result, actions, needHuman;
    if (match) {
      risk = "P3"; result = "药品核对一致：" + MED_PLAN.name + "（" + MED_PLAN.type + "）";
      actions = ["确认为计划用药，提示按剂量服用（" + MED_PLAN.dose + "）", "记录服药完成，更新依从性报告"]; needHuman = false;
      say = "核对好啦，这个就是今天该吃的降压药氨氯地平，一次一片。您用温水慢慢服下就好，我看着您吃。";
      if (Avatar) Avatar.setMood("happy");
    } else {
      risk = "P1"; result = "药品不一致：计划为「" + MED_PLAN.name + "」，识别为「" + detectedName + "」";
      actions = ["立即语音阻断，请老人先不要服用", "通知护理员到场核实", "记录疑似错服事件，待人工确认"]; needHuman = true;
      say = "爷爷您先等一下，先别吃。这个好像不是今天该吃的降压药，我已经请护理员过来帮您再确认一下，咱们别急啊。";
      if (Avatar) Avatar.setMood("serious");
    }
    pushDecision({
      agent: "药事管理 Agent", risk: risk, confidence: match ? 0.94 : 0.9, result: result,
      evidence: ["用药计划：" + MED_PLAN.time + " " + MED_PLAN.name + " " + MED_PLAN.dose, source + "识别：" + detectedName + "（" + detectedType + "）", "计划匹配结果：" + (match ? "一致" : "不一致")],
      actions: actions, needHuman: needHuman
    });
    addCap("ai", say, false); history.push({ role: "assistant", content: say });
    if (!match) setTimeout(function () { showMedAlert(detectedName); }, 500);
    speak(say, resumeAfterTurn);
  }
  function showMedAlert(detectedName) {
    alertBox.innerHTML =
      '<div class="alert-top"><span class="ic">\u26A0\uFE0F</span><div><b>疑似错服药预警</b><div>药事管理 Agent · 已语音阻断</div></div></div>' +
      '<div class="alert-body">' +
        '<div class="al-row"><span class="k">风险等级</span><b style="color:#ff8a3d">P1 高风险</b></div>' +
        '<div class="al-row"><span class="k">计划用药</span>' + MED_PLAN.name + "（" + MED_PLAN.type + "）" + MED_PLAN.dose + '</div>' +
        '<div class="al-row"><span class="k">实际识别</span>' + esc(detectedName) + '</div>' +
        '<div class="al-row"><span class="k">老人</span>李建国 · 78岁 · 3号楼302</div>' +
        '<div class="notify-list" id="notifyList"></div>' +
      '</div>' +
      '<div class="alert-foot"><button class="primary-btn" id="alertConfirm">护理员已核实</button></div>';
    alertModal.classList.add("show");
    fillNotify([{ n: "责任护理员 · 张敏", d: "已下发核实任务" }]);
    $("alertConfirm").addEventListener("click", function () { alertModal.classList.remove("show"); });
  }

  /* ---------- 拍照识别药品（视觉模型） ---------- */
  function captureAndRecognize() {
    if (!useCamera || !stream) { toast("请先开启摄像头，或点击下方模拟药品卡片。", 4000); return; }
    var v = localVideo; if (!v.videoWidth) { toast("摄像头画面未就绪，请稍候。", 3000); return; }
    var cv = document.createElement("canvas");
    var w = 512, h = Math.round(w * v.videoHeight / v.videoWidth);
    cv.width = w; cv.height = h; cv.getContext("2d").drawImage(v, 0, 0, w, h);
    var b64 = cv.toDataURL("image/jpeg", 0.8);
    toast("正在识别药品…", 3000); setState(S.THINKING); highlightAgents(SCENES.med.agents, "med");
    var prompt = "你是药品识别助手。请判断这张图里出现的主要药品/药盒是下面哪一种，只回答其中一个名称，不要解释：氨氯地平、二甲双胍、阿司匹林、维生素C、其他。如果看不清或没有药品，回答：其他。";
    var messages = [API.buildUserMessage(prompt, b64)];
    function onResult(name) {
      name = (name || "").trim();
      var found = MED_SAMPLES.filter(function (m) { return name.indexOf(m.key) >= 0; })[0];
      if (found) checkMedication(found.key, found.type, "视觉模型", null);
      else {
        toast("没能识别清楚药品，请把药盒正对镜头，或点下方模拟卡片。", 5000);
        pushDecision({ agent: "药事管理 Agent", risk: "P2", confidence: 0.4, result: "药品识别置信度低：未能匹配计划药品",
          evidence: ["视觉模型返回：" + (name || "空"), "图像可能不清晰或无药品"], actions: ["请老人将药盒正对镜头重试", "转人工核对"], needHuman: true });
        resumeAfterTurn();
      }
    }
    // 主：豆包视觉；无 Key 或失败时直接降级免费视觉；再失败提示用卡片
    var hasArkKey = !!(cfg.apiKey && cfg.apiKey.trim());
    var visionStart = performance.now();
    console.info("[乐颐视觉模型] request", { provider: hasArkKey ? "volc-ark" : "fallback", model: hasArkKey ? cfg.vModel : cfg.fbVModel });
    (hasArkKey
      ? API.chat({ apiUrl: cfg.apiUrl, apiKey: cfg.apiKey, model: cfg.vModel, proxy: cfg.proxy, messages: messages, timeoutMs: 12000, maxTokens: 60, temperature: 0.2 })
      : Promise.reject(new Error("no ark key")))
      .catch(function (err) {
        if (hasArkKey) console.warn("豆包视觉识别失败，降级免费模型", err);
        return API.chat({ apiUrl: cfg.fbUrl, apiKey: "", model: cfg.fbVModel, proxy: cfg.proxy, messages: messages, timeoutMs: 12000, maxTokens: 60, temperature: 0.2 });
      })
      .then(function (name) {
        console.info("[乐颐视觉模型] done", { ms: Math.round(performance.now() - visionStart), result: name });
        onResult(name);
      })
      .catch(function (err) { toast("视觉识别失败：" + String(err.message || err).slice(0, 90) + "。请点下方模拟卡片演示。", 6000); resumeAfterTurn(); });
  }

  /* ---------- 场景切换 ---------- */
  function switchScene(k) {
    if (!SCENES[k]) return;
    curScene = k; history = [];
    renderScenes(); clearDecisions();
    decBody.innerHTML = '<div class="dec-empty">场景「' + SCENES[k].name + '」已就绪<br>' +
      (k === "med" ? "点击「识别药品」拍照，或点下方模拟药品卡片" : "对乐颐说话，或用键盘输入") + '</div>';
    highlightAgents(SCENES[k].agents, null);
    if (Avatar) Avatar.setMood(SCENES[k].mood || "calm");
    medTray.classList.toggle("show", k === "med");
    captureBtn.classList.toggle("hidden", !(k === "med" && useCamera && inCall));
    if (k === "med") renderMedTray();
    if (inCall) {
      stopSpeak(); captions.innerHTML = "";
      var hello = SCENES[k].hello;
      addCap("ai", hello, false); history.push({ role: "assistant", content: hello });
      speak(hello, resumeAfterTurn);
    }
  }

  /* ---------- 通话开关 ---------- */
  function startCall(withCam) {
    useCamera = withCam;
    getMedia().then(attachStream).then(function () {
      inCall = true; micOn = true;
      startMask.classList.add("hidden");
      if (!recognition) initRecognition();
      if (withCam) startEmotion();
      captureBtn.classList.toggle("hidden", !(curScene === "med" && useCamera));
      medTray.classList.toggle("show", curScene === "med");
      if (curScene === "med") renderMedTray();
      history = []; captions.innerHTML = ""; clearDecisions();
      decBody.innerHTML = '<div class="dec-empty">场景「' + SCENES[curScene].name + '」进行中<br>与乐颐交互后这里显示实时判断</div>';
      highlightAgents(SCENES[curScene].agents, null);
      if (Avatar) Avatar.setMood(SCENES[curScene].mood || "calm");
      var hello = SCENES[curScene].hello;
      addCap("ai", hello, false); history.push({ role: "assistant", content: hello });
      speak(hello, resumeAfterTurn);
    }).catch(function (err) {
      console.error(err);
      if (withCam) { toast("无法访问摄像头，改用仅语音模式。", 4000); startCall(false); }
      else toast("无法访问麦克风：" + (err && err.name || err), 6000);
    });
  }
  function endCall() {
    inCall = false; wantListening = false; stopSpeak();
    if (abortCtrl) { try { abortCtrl.abort(); } catch (e) {} abortCtrl = null; }
    if (recognition) { try { recognition.stop(); } catch (e) {} }
    Emotion.stop(); $("emotionTag").classList.remove("show");
    stopMedia(); startMask.classList.remove("hidden");
    setState(S.IDLE); statusText.textContent = "未连接"; statusDot.className = "dot";
    medTray.classList.remove("show"); captureBtn.classList.add("hidden");
    alertModal.classList.remove("show");
  }

  /* ---------- 事件绑定 ---------- */
  startBtn.addEventListener("click", function () { startCall(true); });
  startNoCam.addEventListener("click", function () { startCall(false); });
  $("openSettingsFromStart").addEventListener("click", openSettings);
  endBtn.addEventListener("click", endCall);
  captureBtn.addEventListener("click", captureAndRecognize);
  muteBtn.addEventListener("click", function () {
    if (!inCall) return;
    micOn = !micOn; muteBtn.classList.toggle("off", !micOn);
    if (stream) stream.getAudioTracks().forEach(function (t) { t.enabled = micOn; });
    if (micOn) { if (state !== S.THINKING && state !== S.SPEAKING) startListening(); } else pauseListening();
  });
  kbBtn.addEventListener("click", function () { textBar.classList.toggle("show"); if (textBar.classList.contains("show")) textInput.focus(); });
  textBar.addEventListener("submit", function (e) {
    e.preventDefault();
    var val = textInput.value.trim(); if (!val) return;
    if (!inCall) { toast("请先点击开始演示。", 3000); return; }
    if (state === S.THINKING) { toast("稍等，正在回复上一句…", 2500); return; }
    if (state === S.SPEAKING) stopSpeak();
    textInput.value = ""; sendTurn(val);
  });

  function openSettings() {
    $("cfgUrl").value = cfg.apiUrl; $("cfgKey").value = cfg.apiKey; $("cfgModel").value = cfg.model;
    $("cfgVModel").value = cfg.vModel; $("cfgTimeout").value = cfg.timeoutMs; $("cfgMaxTokens").value = cfg.maxTokens;
    $("cfgRate").value = cfg.rate; loadVoices();
    $("settingsOverlay").classList.remove("hidden"); $("settingsPanel").classList.remove("hidden");
  }
  function closeSettings() { $("settingsOverlay").classList.add("hidden"); $("settingsPanel").classList.add("hidden"); }
  $("settingsBtn").addEventListener("click", openSettings);
  $("closeSettings").addEventListener("click", closeSettings);
  $("settingsOverlay").addEventListener("click", closeSettings);
  $("saveSettings").addEventListener("click", function () {
    cfg.apiUrl = $("cfgUrl").value.trim() || cfg.apiUrl; cfg.apiKey = $("cfgKey").value.trim();
    cfg.model = $("cfgModel").value.trim() || cfg.model; cfg.vModel = $("cfgVModel").value.trim() || cfg.vModel;
    cfg.timeoutMs = Math.max(4000, Math.min(30000, parseInt($("cfgTimeout").value, 10) || 12000));
    cfg.maxTokens = Math.max(60, Math.min(400, parseInt($("cfgMaxTokens").value, 10) || 160));
    cfg.rate = $("cfgRate").value; cfg.voice = $("cfgVoice").value;
    saveConfig(); closeSettings(); toast("已保存设置", 2000);
  });

  /* ---------- 初始化 ---------- */
  renderAgentBar(); renderScenes();
  var svgAvatar = createAvatar($("avatarHost"), { wrap: avatarWrap });
  createAvatar($("startAvatar"), {});
  function a3d() { return (window.__leyi3d && window.__leyi3d.loaded) ? window.__leyi3d : null; }
  Avatar = {
    setMood: function (m) { var a = a3d(); if (a) a.setMood(m); else svgAvatar.setMood(m); },
    startTalk: function () { var a = a3d(); if (a) a.startTalk(); else svgAvatar.startTalk(); avatarWrap.classList.add("speaking"); },
    stopTalk: function () { var a = a3d(); if (a) a.stopTalk(); else svgAvatar.stopTalk(); avatarWrap.classList.remove("speaking"); },
    pulse: function () { var a = a3d(); if (a) a.pulse(); }
  };
  highlightAgents(SCENES[curScene].agents, null);
  if (!SR) toast("提示：你的浏览器可能不支持语音识别，建议 Chrome/Edge（仍可用键盘打字）。", 6000);
})();
