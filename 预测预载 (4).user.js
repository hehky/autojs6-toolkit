// ==UserScript==
// @name         预测预载·五环版 PredictPreload
// @namespace    hark.predict-preload
// @version      0.7.1
// @description  链接当向量，套五环：L1 按下兜底→L2 相似亮灯→L3 否决→L4 记账打分→自学习。高分整页后台渲染，其余预取。安卓优先，按站分键，日志汇总，菜单导出，经验库/热区/情景可备份复原。双模式：流程链接学习，一次性内容滚动预取。v0.7.1 修 task 中心、情景不改全局 prerender、列数恢复宽阈值、导入登记站点、传感器可暂停/可授权；辅助：托底手舒适区（中心+同侧上部）、费力下拉与随后返回/退出登记。
// @match        *://*/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @noframes
// ==/UserScript==

(function () {
    'use strict';
    if (typeof window !== 'undefined' && window.__pp) return;

    /* =====================================================================
     * 向量：一个链接 = [来源页, 区域, 路径型, 文字, 位次]，顺序敏感
     *   from   当前页的路径型（在哪类页面上点的）
     *   region nav/header/main/article/aside/footer/list…
     *   pat    目标网址路径型（数字/哈希段→:id，查询只留参数名）
     *   words  链接文字词元（英文词＋中文二字组）
     *   rank   该链接在同区域中的位次段（前3/前10/更后）
     * 锚点 = 精确网址（命中额外 +0.5，同 vec.py）
     * ===================================================================== */
    var DIMS = ['from', 'region', 'pat', 'words', 'rank'];

    var CFG = {
        KEY: '__pp5_v2',              // 学习库按站分键：KEY::<host>
        LOGKEY: '__pp5_v2_log',       // 反馈日志：所有站汇总到同一个键
        LASTKEY: '__pp5_v2_log_last', // 上次导出的快照，下载失败可恢复
        SITESKEY: '__pp5_v2_sites',   // 已登记站点清单（用于备份遍历）
        LOG_MAX: 2000,
        HALF_LIFE_DAYS: 7,
        MAX_ENTRIES: 200,
        LIGHT_MIN: 0.45,              // L2：相似度低于此不亮灯
        PRERENDER_MAX: 2,
        PREFETCH_MAX: 5,
        EXPLORE_N: 5,                 // 前 5 次 +0.2 探索
        LR: 0.08,                     // 自学习：维度权重学习率
        TAP_MAX: 12,                  // L1 触摸兜底最多预取几条，不占模型名额
        PENDING_TTL_MS: 30000,        // 切后台挂起超此时长，下次回来/打开时才判落空
        // L3 否决（硬核）：有副作用的链接
        BAN: /logout|log-out|signout|sign-out|\bdelete\b|\bremove\b|unsubscribe|\bcart\b|checkout|\bpay\b|\bbuy\b|\border\b|\bdownload\b|token=|action=|退出|注销|删除|取消|支付|购买|下单/i,
        TICK_MS: 400,
        // 双模式
        FLOW_DAYS: 2,                 // 同一网址在不同的几天被点过 → 流程链接
        URL_MAX: 600,                 // 每站最多记多少个网址的点击日期
        SCROLL_IDLE_MS: 300,          // 滚动停下多久判定为“在看”
        SCROLL_PICK: 2,               // 滚动模式每次预取几条（低内存/慢网 1 条）
        SCROLL_MAX: 24,               // 滚动模式每页最多预取几条
        WORDS_CAP: 0.35,              // 文字维度权重上限（防止过拟合链接标题）
        ANCHOR_BOOST: 1.25,           // 精确 URL 行中的独立加分乘子（不与 sim 混加）
        HEATKEY: '__pp5_v2_heat',     // 点击热区登记，按站分键；只记录不参与预取
        CTXKEY: '__pp5_v2_ctx',       // v0.7 情景层，按站分键
        CTX_WARM_DAYS: 7,             // 情景层先只记几天，之后才做 A/B 对照
        CTX_BROWSE: 0.6,              // 刷手机概率 ≥ 此值 → 中心挪到正中偏右中
        CTX_TASK: 0.4,                // ≤ 此值 → 用手机：正中、本页不整页渲染
        CTX_TIRED_MS: 5000,           // 费力下拉后多久内的返回/退出算“费力后行为”
    };

    /* ---------------- 纯核心（无 DOM，可单测） ---------------- */
    var LN2 = Math.log(2);
    function dec(rec, t, hl) { return rec ? rec.s * Math.exp(-LN2 * (t - rec.t) / hl) : 0; }
    function add(rec, t, hl, x) { return { s: dec(rec, t, hl) + (x || 1), t: t }; }
    function copy(o) { var r = {}, k; for (k in o) r[k] = o[k]; return r; }
    var UID = 0;
    function uid() { return Date.now().toString(36) + '-' + (++UID).toString(36) + '-' + Math.random().toString(36).slice(2, 6); }
    function num(x) { return (typeof x === 'number' && isFinite(x)) ? x : 0; }
    function safeKey(k) { return k !== '__proto__' && k !== 'constructor' && k !== 'prototype'; }
    function copyObj(o) { var r = {}, k; for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; return r; }

    function pattern(u) {
        var segs = u.pathname.split('/').map(function (s) {
            if (!s) return s;
            if (/^\d+$/.test(s)) return ':id';                                  // 纯数字
            var ext = (s.match(/\.(?:html?|php|aspx?)$/i) || [''])[0];
            var core = ext ? s.slice(0, s.length - ext.length) : s;
            if (!core) return s;
            if (/^[0-9a-f]{8,}$/i.test(core.replace(/[-_.]/g, ''))) return ':id' + ext;   // 长哈希
            // 收紧：只把“明显像 ID”的段归一化，避免 web3 / page2 / h264 / v1-2 被吃掉
            if (/\d/.test(core) && /^[\w.-]+$/.test(core) && core.length >= 5) {
                var digits = (core.match(/\d/g) || []).length;
                var idLike = /^[A-Za-z]{1,4}\d[A-Za-z0-9]{2,}$/.test(core) ||   // BV1xx / abc12
                    /^[A-Za-z]{1,6}\d{2,}$/.test(core);                        // video123
                if (digits / core.length >= 0.4 || /\d{4,}/.test(core) || /[-_.]\d{2,}$/.test(core) || idLike) return ':id' + ext;
            }
            return s;
        });
        var q = [];
        u.searchParams.forEach(function (v, k) { if (q.indexOf(k) < 0) q.push(k); });
        q.sort();
        return segs.join('/') + (q.length ? '?' + q.join('&') : '');
    }
    function words(text) {
        text = (text || '').replace(/\s+/g, ' ').trim().slice(0, 40).toLowerCase();
        var out = text.match(/[a-z]{2,}/g) || [];
        var cjk = text.replace(/[^\u4e00-\u9fff]/g, '');
        for (var i = 0; i + 1 < cjk.length; i++) out.push(cjk.substr(i, 2));
        if (cjk.length === 1) out.push(cjk);
        return out.filter(function (w, i, a) { return a.indexOf(w) === i; }).slice(0, 12);
    }
    function rankBand(i) { return i < 3 ? 'top3' : i < 10 ? 'top10' : 'later'; }
    function vecKey(v) { return [v.from, v.region, v.pat, v.rank].join(' ▸ '); }
    function jacc(a, b) {
        if (!a.length && !b.length) return 1;
        var hit = 0;
        a.forEach(function (x) { if (b.indexOf(x) >= 0) hit++; });
        return hit / (a.length + b.length - hit);
    }
    function dimSim(a, b) {
        return {
            from: a.from === b.from ? 1 : 0,
            region: a.region === b.region ? 1 : 0,
            pat: a.pat === b.pat ? 1 : (a.pat.split('/')[1] === b.pat.split('/')[1] ? 0.4 : 0),
            words: jacc(a.words, b.words),
            rank: a.rank === b.rank ? 1 : 0,
        };
    }
    function weighted(ds, W) {
        var s = 0, z = 0;
        DIMS.forEach(function (d) { s += W[d] * ds[d]; z += W[d]; });
        return s / z;
    }

    function Brain(db, now, hl) {
        db.W = db.W || { from: 0.15, region: 0.15, pat: 0.4, words: 0.2, rank: 0.1 };
        db.E = db.E || {};                 // 库：key → 条目
        db.pages = db.pages || null;       // 打开过的页数（衰减）
        db.th = db.th || { prerender: 0.35, prefetch: 0.12 };
        db.hist = db.hist || { hit: 0, miss: 0 };
        db.U = db.U || {};                 // 网址 → 被点过的日期（最多记 FLOW_DAYS 个不同日）
        db.S = db.S || { pre: 0, hit: 0, click: 0 };   // 滚动模式统计
        if (db.ver !== 5) {
            db.th = { prerender: 0.35, prefetch: 0.12 }; db.hist = { hit: 0, miss: 0 };
            if (db.W && db.W.words > CFG.WORDS_CAP) db.W.words = CFG.WORDS_CAP;
            db.ver = 5;
        }
        this.db = db; this.now = now; this.hl = hl;
    }
    Brain.prototype.pageView = function () { this.db.pages = add(this.db.pages, this.now(), this.hl); };
    Brain.prototype.seen = function (href, day) {
        var U = this.db.U, r = U[href];
        if (!r) r = U[href] = { d: [], t: 0 };
        if (r.d.indexOf(day) < 0) { r.d.push(day); if (r.d.length > CFG.FLOW_DAYS) r.d = r.d.slice(-CFG.FLOW_DAYS); }
        r.t = this.now();
        var ks = Object.keys(U);
        if (ks.length > CFG.URL_MAX) ks.sort(function (a, b) { return U[a].t - U[b].t; }).slice(0, ks.length - CFG.URL_MAX).forEach(function (k) { delete U[k]; });
        return r.d.length >= CFG.FLOW_DAYS;
    };
    Brain.prototype.isFlow = function (href) { var r = this.db.U[href]; return !!(r && r.d.length >= CFG.FLOW_DAYS); };
    Brain.prototype.hasFlow = function () {
        var U = this.db.U;
        for (var k in U) { var d = U[k] && U[k].d; if (d && d.length >= CFG.FLOW_DAYS) return true; }
        return false;
    };

    Brain.prototype.bright = function (e) {
        var t = this.now(), pages = Math.max(1, dec(this.db.pages, t, this.hl));
        var U = Math.min(1, dec(e.clicks, t, this.hl) / pages);
        var P = (e.confirm + 1) / (e.confirm + e.correct + 2);
        return U * P + (e.n < CFG.EXPLORE_N ? 0.2 * U : 0);
    };
    Brain.prototype.tier = function (e, b) {
        if (e.ban) return '拉黑';
        if (b >= 0.8 && e.confirm >= 10) return '核心';
        if (b >= 0.6 && e.confirm >= 3) return '常用';
        return '候选';
    };

    Brain.prototype.judge = function (v, href) {
        var best = null, W = this.db.W, E = this.db.E;
        for (var k in E) {
            var e = E[k];
            if (e.ban) continue;
            var ds = dimSim(v, e.v), sim = weighted(ds, W);
            if (sim < CFG.LIGHT_MIN) continue;
            var anchorHit = !!(e.urls && e.urls[href]);
            var b = this.bright(e);
            // 精确 URL 命中用独立乘子，避免与 sim 混加后截断、抹平 sim 梯度
            var score = sim * b * (anchorHit ? CFG.ANCHOR_BOOST : 1);
            if (score > 1) score = 1;
            if (!best || score > best.score) best = { key: k, sim: sim, ds: ds, b: b, score: score, tier: this.tier(e, b) };
        }
        return best;
    };

    Brain.prototype.click = function (v, href) {
        var t = this.now(), k = vecKey(v), e = this.db.E[k];
        if (!e) e = this.db.E[k] = { v: v, clicks: null, confirm: 0, correct: 0, n: 0, urls: {}, first: t };
        v.words.forEach(function (w) { if (e.v.words.indexOf(w) < 0) e.v.words.push(w); });
        if (e.v.words.length > 16) e.v.words = e.v.words.slice(-16);
        e.clicks = add(e.clicks, t, this.hl);
        e.n++; e.last = t;
        e.urls[href] = (e.urls[href] || 0) + 1;
        var us = Object.keys(e.urls);
        if (us.length > 20) us.sort(function (a, b) { return e.urls[a] - e.urls[b]; }).slice(0, us.length - 20).forEach(function (u) { delete e.urls[u]; });
        this.prune();
    };

    // 滚动模式结局：只记命中统计；未预取的点击只计 click，不写日志（避免淹没训练集）
    Brain.prototype.logScroll = function (href, hit) {
        var S = this.db.S; S.click++; if (hit) S.hit++;
        if (!hit) return;
        var L = this.db.log = this.db.log || [];
        L.push({ id: uid(), t: this.now(), href: href, mode: 'scroll', hit: true, pre: S.pre });
    };

    Brain.prototype.learn = function (pred, hit) {
        var e = this.db.E[pred.key];
        if (!e) return;
        var W = this.db.W, H = this.db.hist;
        if (hit) { e.confirm++; H.hit++; } else { e.correct++; H.miss++; }
        var avg = DIMS.reduce(function (s, d) { return s + pred.ds[d]; }, 0) / DIMS.length;
        DIMS.forEach(function (d) {
            var g = (pred.ds[d] - avg) * (hit ? 1 : -1);
            W[d] = Math.min(0.7, Math.max(0.03, W[d] * Math.exp(CFG.LR * 4 * g)));
        });
        var z = DIMS.reduce(function (s, d) { return s + W[d]; }, 0);
        DIMS.forEach(function (d) { W[d] = +(W[d] / z).toFixed(4); });
        if (W.words > CFG.WORDS_CAP) {
            // 文字维封顶：多出的按比例分给其他维，再 clamp + 再归一，最后严格封顶
            var extra = W.words - CFG.WORDS_CAP, rest = 1 - W.words;
            W.words = CFG.WORDS_CAP;
            if (rest > 1e-6) DIMS.forEach(function (d) { if (d !== 'words') W[d] = W[d] + extra * W[d] / rest; });
            DIMS.forEach(function (d) { W[d] = Math.min(0.7, Math.max(0.03, W[d])); });
            var z2 = DIMS.reduce(function (s, d) { return s + W[d]; }, 0);
            if (z2 > 0) DIMS.forEach(function (d) { W[d] = +(W[d] / z2).toFixed(4); });
            if (W.words > CFG.WORDS_CAP) W.words = CFG.WORDS_CAP;
        }
        if (!hit) {
            for (var k in this.db.E) {
                var s = this.db.E[k];
                if (k !== pred.key && s.v.from === e.v.from && s.v.region === e.v.region) s.correct += 0.25;
            }
        }
        var tot = H.hit + H.miss;
        if (tot >= 10) {
            var rate = H.hit / tot, th = this.db.th;
            if (rate > 0.6) { th.prerender = Math.max(0.2, th.prerender - 0.02); th.prefetch = Math.max(0.06, th.prefetch - 0.01); }
            if (rate < 0.3) { th.prerender = Math.min(0.7, th.prerender + 0.03); th.prefetch = Math.min(0.4, th.prefetch + 0.02); }
            H.hit *= 0.9; H.miss *= 0.9;
        }
    };

    Brain.prototype.prune = function () {
        var self = this, E = this.db.E, t = this.now();
        Object.keys(E).forEach(function (k) {
            var e = E[k];
            if (e.correct >= 8 && e.confirm === 0) e.ban = true;
            if (t - (e.last || e.first) > 60 * 864e5) delete E[k];
        });
        var keys = Object.keys(E);
        if (keys.length > CFG.MAX_ENTRIES) {
            var scored = keys.map(function (k) { return [k, self.bright(E[k])]; });
            scored.sort(function (a, b) { return a[1] - b[1]; });
            scored.slice(0, keys.length - CFG.MAX_ENTRIES).forEach(function (p) { delete E[p[0]]; });
        }
    };

    Brain.prototype.logOutcome = function (pred, hit, href) {
        var L = this.db.log = this.db.log || [];
        L.push({ id: uid(), t: this.now(), href: href, key: pred.key, ds: pred.ds, sim: +pred.sim.toFixed(3), b: +pred.b.toFixed(3), score: +pred.score.toFixed(3), tier: pred.tier, hit: hit, mode: 'flow', W: copy(this.db.W), th: copy(this.db.th) });
    };

    function mergeEntry(a, b) {
        if (!a) return b;
        if (!b) return a;
        var va = a.v || {}, vb = b.v || {};
        var ws = (va.words || []).slice();
        (vb.words || []).forEach(function (w) { if (ws.indexOf(w) < 0) ws.push(w); });
        var urls = {};
        [a.urls, b.urls].forEach(function (m) {
            if (!m) return;
            Object.keys(m).forEach(function (h) {
                if (!safeKey(h)) return;
                urls[h] = Math.max(urls[h] || 0, num(m[h]));
            });
        });
        var ca = a.clicks, cb = b.clicks;
        var clicks = num(ca && ca.s) >= num(cb && cb.s)
            ? (ca ? { s: num(ca.s), t: num(ca.t) } : null)
            : (cb ? { s: num(cb.s), t: num(cb.t) } : null);
        var fa = num(a.first), fb = num(b.first);
        var la = num(a.last), lb = num(b.last);
        return {
            v: { from: va.from || vb.from || '', region: va.region || vb.region || '', pat: va.pat || vb.pat || '', rank: va.rank || vb.rank || '', words: ws.slice(0, 16) },
            clicks: clicks,
            confirm: Math.max(num(a.confirm), num(b.confirm)),
            correct: Math.min(num(a.correct), num(b.correct)),
            n: Math.max(num(a.n), num(b.n)),
            urls: urls,
            first: fa && fb ? Math.min(fa, fb) : (fa || fb || 0),
            last: Math.max(la, lb),
            ban: !!(a.ban || b.ban),
        };
    }
    function maxRec(a, b) {
        var sa = num(a && a.s), sb = num(b && b.s);
        if (!a && !b) return null;
        if (!a) return { s: sb, t: num(b.t) };
        if (!b) return { s: sa, t: num(a.t) };
        return sa >= sb ? { s: sa, t: num(a.t) } : { s: sb, t: num(b.t) };
    }
    function fullW(w) {
        var d = { from: 0.15, region: 0.15, pat: 0.4, words: 0.2, rank: 0.1 }, r = {}, k;
        for (k in d) r[k] = num(w && w[k]) || d[k];
        return r;
    }
    function fullTh(th) {
        return { prerender: num(th && th.prerender) || 0.35, prefetch: num(th && th.prefetch) || 0.12 };
    }
    function mergeDb(a, b) {
        var A = (a && typeof a === 'object') ? a : {};
        var B = (b && typeof b === 'object') ? b : {};
        var ha = A.hist || {}, hb = B.hist || {};
        var wa = num(ha.hit) + num(ha.miss), wb = num(hb.hit) + num(hb.miss);
        var main = wb > wa ? B : A;
        var sa = A.S || {}, sb = B.S || {};
        var Smain = num(sb.click) > num(sa.click) ? sb : sa;   // 取更活跃一方的整组，保证 pre/hit/click 自洽
        var out = {
            W: fullW(main.W),
            th: fullTh(main.th),
            pages: maxRec(A.pages, B.pages),
            hist: { hit: Math.max(num(ha.hit), num(hb.hit)), miss: Math.max(num(ha.miss), num(hb.miss)) },
            E: {},
            U: {},
            S: { pre: num(Smain.pre), hit: num(Smain.hit), click: num(Smain.click) },
            ver: 5,
        };
        [A.U || {}, B.U || {}].forEach(function (m) {
            Object.keys(m).forEach(function (h) {
                if (!safeKey(h) || !m[h] || !Array.isArray(m[h].d)) return;
                var o = out.U[h] || (out.U[h] = { d: [], t: 0 });
                m[h].d.forEach(function (d) { if (o.d.indexOf(d) < 0) o.d.push(d); });
                o.d = o.d.sort().slice(-CFG.FLOW_DAYS); o.t = Math.max(o.t, num(m[h].t));
            });
        });
        var keys = Object.keys(A.E || {}).concat(Object.keys(B.E || {}));
        var seen = {};
        keys.forEach(function (k) {
            if (!safeKey(k) || seen[k]) return;
            seen[k] = 1;
            var m = mergeEntry((A.E || {})[k], (B.E || {})[k]);
            if (m) out.E[k] = m;
        });
        return out;
    }

    var CORE = { Brain: Brain, pattern: pattern, words: words, rankBand: rankBand, vecKey: vecKey, dimSim: dimSim, weighted: weighted, copy: copy, mergeDb: mergeDb, mergeEntry: mergeEntry, CFG: CFG };
    if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') { module.exports = CORE; return; }

    /* ---------------- GM 存储（油猴） ---------------- */
    function gmGet(k, dflt) {
        try {
            if (typeof GM_getValue === 'function') {
                var v = GM_getValue(k, null);
                if (v !== null && v !== undefined) {
                    if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return dflt; } }
                    return v;
                }
                return dflt;
            }
        } catch (e) { /* ignore */ }
        try { var s = localStorage.getItem(k); return s === null ? dflt : JSON.parse(s); } catch (e2) { return dflt; }
    }
    function gmSet(k, v) {
        try {
            if (typeof GM_setValue === 'function') { GM_setValue(k, v); return; }
        } catch (e) { /* ignore */ }
        try { localStorage.setItem(k, JSON.stringify(v)); } catch (e2) { /* ignore */ }
    }
    function siteKey(host) { return CFG.KEY + '::' + host; }
    function pkey(host) { return CFG.KEY + '_p::' + host; }

    var siteCache = null;
    function registerSite(host) {
        if (!host || !safeKey(host)) return;
        if (siteCache === null) { var a = gmGet(CFG.SITESKEY, []); siteCache = Array.isArray(a) ? a : []; }
        if (siteCache.indexOf(host) < 0) { siteCache.push(host); gmSet(CFG.SITESKEY, siteCache); }
    }

    var HL = CFG.HALF_LIFE_DAYS * 864e5;
    function load(host) { var db = gmGet(siteKey(host), {}); return (db && typeof db === 'object') ? db : {}; }
    function save(db, host) {
        var rows = db.log || [];
        delete db.log;
        gmSet(siteKey(host), db);
        registerSite(host);
        if (rows.length) appendLog(rows);
    }
    function appendLog(rows) {
        var all = gmGet(CFG.LOGKEY, []);
        if (!Array.isArray(all)) all = [];
        all = all.concat(rows);
        if (all.length > CFG.LOG_MAX) all = all.slice(all.length - CFG.LOG_MAX);
        gmSet(CFG.LOGKEY, all);
    }
    function getLog() { var a = gmGet(CFG.LOGKEY, []); return Array.isArray(a) ? a : []; }
    // 旧库首次升级：迁移前留一份原样快照
    function withBrain(fn) {
        var host = location.host, db = load(host);
        if (db && db.ver !== 5 && ((db.E && Object.keys(db.E).length) || db.pages)) {
            try { gmSet(siteKey(host) + '::legacy', copy(db)); } catch (e) { /* ignore */ }
        }
        var b = new Brain(db, Date.now, HL), r = fn(b);
        save(db, host);
        return r;
    }
    function view() { withBrain(function (b) { b.pageView(); }); }

    function FROM() { return pattern(new URL(location.href)); }
    function region(a) {
        var r = a.closest('nav,header,footer,aside,article,main,[role=navigation],[role=main],ul,ol,table');
        if (!r) return 'body';
        var role = r.getAttribute('role');
        return role ? role : r.tagName.toLowerCase();
    }
    function rankOf(a) {
        var box = a.closest('nav,header,footer,aside,article,main,ul,ol,table') || document.body;
        var list = box.querySelectorAll('a[href]');
        for (var i = 0; i < list.length && i < 50; i++) if (list[i] === a) return rankBand(i);
        return 'later';
    }
    function linkURL(a) {
        if (!a || !a.href || a.hasAttribute('download')) return null;
        var tgt = (a.getAttribute('target') || '').toLowerCase();
        if (tgt && tgt !== '_self') return null;
        var u;
        try { u = new URL(a.href, location.href); } catch (e) { return null; }
        if (u.origin !== location.origin) return null;
        if (u.pathname === location.pathname && u.search === location.search) return null;
        if (CFG.BAN.test(u.href) || CFG.BAN.test(a.textContent || '')) return null;
        return u;
    }
    function vecOf(a, u) {
        return { from: FROM(), region: region(a), pat: pattern(u), words: words(a.textContent || a.getAttribute('aria-label') || ''), rank: rankOf(a) };
    }

    var stats = { prerendered: {}, prefetched: {}, tapped: {}, scrolled: {}, cold: {}, served: false };
    var preds = {};
    var settled = {};
    var clickedHref = null;
    var SID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

    function loadP() { var a = gmGet(pkey(location.host), []); return Array.isArray(a) ? a : []; }
    function saveP(items) { gmSet(pkey(location.host), items); }

    var UA = (navigator.userAgent || '');
    var MOB = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(UA) ||
        !!(navigator.userAgentData && navigator.userAgentData.mobile);
    var MEM = navigator.deviceMemory || 0;
    var LOW_MEM = MEM > 0 && MEM <= 3;
    var conn = navigator.connection || {};
    var saveData = !!(conn.saveData || /(^|-)2g|slow-2g/.test(conn.effectiveType || ''));
    var slowNet = saveData || /(^|-)3g/.test(conn.effectiveType || '');

    try {
        var nav = performance.getEntriesByType('navigation')[0];
        stats.served = !!(nav && (nav.activationStart > 0 || nav.deliveryType === 'navigational-prefetch'));
    } catch (e) { /* ignore */ }
    function onReady() { view(); recoverPending(); }
    if (document.prerendering) document.addEventListener('prerenderingchange', onReady, { once: true });
    else onReady();

    function consume(b, href) {
        if (!preds[href]) return;
        b.learn(preds[href], true); b.logOutcome(preds[href], true, href);
        delete preds[href]; settled[href] = 1;
    }
    function neutral(href) { if (preds[href]) { delete preds[href]; settled[href] = 1; } }

    function onClick(e) {
        recordHeat(e);   // 热区登记：只统计点击位置，不影响预取
        ctxOnClick(e);   // v0.7 情景层登记
        var a = e.target && e.target.closest && e.target.closest('a[href]');
        var u = linkURL(a);
        if (!u) return;
        var ctrl = e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
        if ((e.type === 'auxclick' && e.button === 1) || (e.type === 'click' && ctrl)) {
            hitClick(a, u);
            return;
        }
        if (e.type === 'auxclick') { neutral(u.href); return; }
        clickedHref = u.href;
        hitClick(a, u);
    }
    function hitClick(a, u) {
        var v = vecOf(a, u), day = localDay();
        withBrain(function (b) {
            var flow = b.seen(u.href, day);
            if (flow) { b.click(v, u.href); consume(b, u.href); }
            else {
                if (preds[u.href]) consume(b, u.href);
                // 冷启动预取的点击不计入滚动口径，避免覆盖率被拉低
                if (!stats.cold[u.href]) {
                    var sh = !!(scrollPre && scrollPre[u.href]);
                    b.logScroll(u.href, sh);
                    ctxStat({ click: 1, hit: sh ? 1 : 0 });
                }
            }
        });
    }

    /* ---------------- v0.7 情景层：独立小容器，判握姿与环境，输出概率 ---------------- */
    var sens = { beta: [], gamma: [], acc: [], ori: false, mot: false, lastO: 0, lastM: 0, on: false };
    var tapX = [], tapY = [], pageStart = Date.now();
    function pushCap(a, v, n) { a.push(v); if (a.length > n) a.shift(); }
    function recentVals(a, ms) { var t = Date.now() - ms, out = [], i; for (i = 0; i < a.length; i++) if (a[i].t >= t) out.push(a[i].v); return out; }
    function mean(a) { var s = 0, i; for (i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }
    function sd(a) { var m = mean(a), s = 0, i; for (i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m); return a.length ? Math.sqrt(s / a.length) : 0; }
    function onOri(e) {
        if (e.beta === null || e.beta === undefined) return;
        var t = Date.now(); if (t - sens.lastO < 200) return; sens.lastO = t; sens.ori = true;
        pushCap(sens.beta, { t: t, v: e.beta }, 30); pushCap(sens.gamma, { t: t, v: e.gamma || 0 }, 30);
    }
    function onMot(e) {
        var g = e.accelerationIncludingGravity;
        if (!g || g.x === null || g.x === undefined) return;
        var t = Date.now(); if (t - sens.lastM < 50) return; sens.lastM = t; sens.mot = true;
        pushCap(sens.acc, { t: t, v: Math.sqrt(g.x * g.x + g.y * g.y + g.z * g.z) }, 60);
    }
    function startSensors() {
        if (sens.on) return;
        sens.on = true;
        try { window.addEventListener('deviceorientation', onOri, { passive: true }); } catch (e) { /* 无传感器 */ }
        try { window.addEventListener('devicemotion', onMot, { passive: true }); } catch (e) { /* 无传感器 */ }
    }
    function stopSensors() {
        if (!sens.on) return;
        sens.on = false;
        try { window.removeEventListener('deviceorientation', onOri); } catch (e) { /* ignore */ }
        try { window.removeEventListener('devicemotion', onMot); } catch (e) { /* ignore */ }
    }
    // 传感器是可选增强：很多浏览器没有方向权限，点击热度始终兜底
    function requestSensors() {
        var ask = function (C) {
            return new Promise(function (res) {
                try {
                    if (C && typeof C.requestPermission === 'function') C.requestPermission().then(res).catch(function () { res('denied'); });
                    else res('granted');
                } catch (e) { res('denied'); }
            });
        };
        Promise.all([ask(window.DeviceOrientationEvent), ask(window.DeviceMotionEvent)]).then(function (r) {
            startSensors();
            alert('传感器：' + r.join(' / ') + '（无权限时用点击热度兜底）');
        });
    }
    startSensors();   // 默认尝试，无权限则静默；点击热度始终采集

function ctxDefault() {
        var arm = function () { return { pre: 0, hit: 0, click: 0 }; };
        return { cv: 1, since: Date.now(), W: arm(), A: arm(), B: arm(), pred: { browse: 0, task: 0 }, pose: { lie: 0, sit: 0, walk: 0 }, hand: { l: 0, r: 0, both: 0 }, hold: { l: 0, r: 0, '?': 0 }, sensor: { ori: 0, mot: 0, none: 0 }, tired: 0, afterTired: 0, tiredAt: 0, tags: [], agree: { n: 0, ok: 0 } };
    }
    function loadCtx() {
        var c = gmGet(CFG.CTXKEY + '::' + location.host, null);
        if (!c || typeof c !== 'object' || c.cv !== 1) return ctxDefault();
        var d = ctxDefault();
        if (!c.hold) c.hold = d.hold;
        if (!c.pose) c.pose = d.pose;
        if (!c.hand) c.hand = d.hand;
        if (!c.sensor) c.sensor = d.sensor;
        if (typeof c.tired !== 'number') c.tired = 0;
        if (typeof c.afterTired !== 'number') c.afterTired = 0;
        if (typeof c.tiredAt !== 'number') c.tiredAt = 0;
        if (!Array.isArray(c.tags)) c.tags = [];
        if (!c.agree) c.agree = d.agree;
        return c;
    }
    function saveCtx(c) { try { gmSet(CFG.CTXKEY + '::' + location.host, c); } catch (e) { /* ignore */ } }
    // 本页分组：前 7 天 W（只记），之后按会话单双 A（用情景）/ B（不用）
    var ARM = (function () {
        var c = loadCtx();
        if (Date.now() - c.since < CFG.CTX_WARM_DAYS * 864e5) return 'W';
        return parseInt(SID.slice(-1), 36) % 2 ? 'A' : 'B';
    })();
    function ctxStat(d) {
        var c = loadCtx(), g = c[ARM] || (c[ARM] = { pre: 0, hit: 0, click: 0 });
        g.pre += d.pre || 0; g.hit += d.hit || 0; g.click += d.click || 0;
        saveCtx(c);
    }
    function argmax(o) { var k, best = null; for (k in o) if (best === null || o[k] > o[best]) best = k; return best; }
    // 托底手：样本够时看点击横向偏侧；明显靠下（费力下拉）不据此判托底
    function inferHold() {
        if (tapX.length < 5) return '?';
        var mx = mean(tapX), my = tapY.length ? mean(tapY) : 0.5;
        if (my > 0.78) return '?';
        if (mx < 0.45) return 'l';
        if (mx > 0.55) return 'r';
        return '?';
    }
    function inferCtx() {
        var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
        var betas = recentVals(sens.beta, 5000), gammas = recentVals(sens.gamma, 5000), accs = recentVals(sens.acc, 2000);
        var beta = betas.length ? mean(betas.map(Math.abs)) : null, gamma = gammas.length ? mean(gammas.map(Math.abs)) : null;
        var accSd = accs.length >= 10 ? sd(accs) : null;
        // 姿势：抖得厉害=走；平放或侧躺=躺；30~75 度竖握=坐/站
        var pose = { lie: 0.33, sit: 0.34, walk: 0.33 };
        if (accSd !== null && accSd > 1.2) pose = { lie: 0.05, sit: 0.15, walk: 0.8 };
        else if (beta !== null) {
            if (beta < 25 || (gamma !== null && gamma > 60 && vh > vw)) pose = { lie: 0.7, sit: 0.25, walk: 0.05 };
            else if (beta <= 75) pose = { lie: 0.2, sit: 0.75, walk: 0.05 };
            else pose = { lie: 0.35, sit: 0.55, walk: 0.1 };
        }
        // 手：近 20 次点击的横向均值，样本少时向均匀收缩
        var hand = { l: 0.33, r: 0.33, both: 0.34 };
        if (tapX.length >= 5) {
            var m = mean(tapX), w = Math.min(1, tapX.length / 20);
            var h0 = m > 0.58 ? { l: 0.1, r: 0.7, both: 0.2 } : (m < 0.42 ? { l: 0.7, r: 0.1, both: 0.2 } : { l: 0.2, r: 0.3, both: 0.5 });
            hand = { l: +(h0.l * w + 0.33 * (1 - w)).toFixed(2), r: +(h0.r * w + 0.33 * (1 - w)).toFixed(2), both: +(h0.both * w + 0.34 * (1 - w)).toFixed(2) };
        }
        // 刷/用：各信号加减分 → 概率
        var now = Date.now(), recent = 0, i;
        for (i = 0; i < (scrollRecent || []).length; i++) if (now - scrollRecent[i] <= 10000) recent++;
        var kind = pageKind(), net = netType(), hr = new Date().getHours(), s = 0;
        if (kind === 'video' || kind === 'game') s += 1.5;
        if (kind === 'pay' || kind === 'search' || kind === 'shop') s -= 1.2;
        if (recent >= 3) s += 0.8;
        if (now - pageStart > 60000) s += 0.5;
        if (net === 'wifi') s += 0.4; else if (net === 'cell') s -= 0.8;
        if (hr >= 22 || hr < 6) s += 0.6; else if (hr >= 18) s += 0.3;
        if (vw > vh) s += 0.8;
        s += pose.lie * 1.2 - pose.walk * 1.5;
        var ae = document.activeElement;
        if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) s -= 1.0;
        var p = 1 / (1 + Math.exp(-s));
        return { browse: +p.toFixed(2), hand: hand, pose: pose, hold: inferHold(), src: { ori: sens.ori, mot: sens.mot, taps: tapX.length } };
    }
    function ctxOnClick(e) {
        try {
            if (!e || typeof e.clientX !== 'number') return;
            var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
            var x0 = Math.max(0, Math.min(1, e.clientX / vw));
            var y0 = Math.max(0, Math.min(1, e.clientY / vh));
            pushCap(tapX, x0, 20); pushCap(tapY, y0, 20);
            var now = Date.now(), ry = 0, n = 0, i;
            for (i = 0; i < tapY.length - 1; i++) { ry += tapY[i]; n++; }   // 不含本次
            ry = n ? ry / n : y0;
            var tired = (tapY.length >= 6 && y0 > ry + 0.15);   // 费力下拉：明显低于近期均值
            var x = inferCtx(), c = loadCtx();
            c.pred[x.browse >= 0.5 ? 'browse' : 'task']++;
            c.pose[argmax(x.pose)]++;
            c.hand[argmax(x.hand)]++;
            c.hold[x.hold] = (c.hold[x.hold] || 0) + 1;
            if (sens.ori) c.sensor.ori++;
            if (sens.mot) c.sensor.mot++;
            if (!sens.ori && !sens.mot) c.sensor.none++;
            if (tired) { c.tired++; c.tiredAt = now; }
            saveCtx(c);
        } catch (err) { /* 采集失败不影响主流程 */ }
    }
    // 费力下拉之后的返回/退出/切后台：只登记，作为意图信号
    function ctxAfterTired() {
        try {
            var c = loadCtx(), now = Date.now();
            if (c.tiredAt && now - c.tiredAt <= CFG.CTX_TIRED_MS) { c.afterTired++; c.tiredAt = 0; saveCtx(c); }
        } catch (e) { /* ignore */ }
    }
    function ctxTag(label) {
        var x = inferCtx(), c = loadCtx();
        c.tags.push({ t: Date.now(), label: label, browse: x.browse, pose: argmax(x.pose), hand: argmax(x.hand), hold: x.hold, src: x.src });
        if (c.tags.length > 200) c.tags = c.tags.slice(-200);
        c.agree.n++;
        if ((label === 'browse') === (x.browse >= 0.5)) c.agree.ok++;
        saveCtx(c);
        return x;
    }
    function ctxReport() {
        var c = loadCtx(), rate = function (g) { return { 预取: g.pre, 点击: g.click, 命中: g.hit, 预取命中率: g.pre ? +(g.hit / g.pre).toFixed(2) : null, 点击覆盖率: g.click ? +(g.hit / g.click).toFixed(2) : null }; };
        return {
            阶段: ARM === 'W' ? '只记（前 ' + CFG.CTX_WARM_DAYS + ' 天）' : 'A/B 对照', 本页分组: ARM, 当前判断: inferCtx(),
            传感器: c.sensor, 点击时判断: { 刷用: c.pred, 姿势: c.pose, 手: c.hand, 托底手: c.hold }, 费力: { 下拉: c.tired, 之后返回或退出: c.afterTired },
            只记期: rate(c.W), A组用情景: rate(c.A), B组不用: rate(c.B),
            手动标注: { 条数: c.agree.n, 一致率: c.agree.n ? +(c.agree.ok / c.agree.n).toFixed(2) : null },
        };
    }

    /* ---------------- 点击热区登记（只记录，不参与预取/打分） ---------------- */
    function zeros(n) { var a = [], i; for (i = 0; i < n; i++) a.push(0); return a; }
    function heatCtxDefault() {
        return {
            portrait: 0, landscape: 0, day: 0, evening: 0, night: 0,
            wifi: 0, cell: 0, unknownNet: 0, s0: 0, s1: 0, s2: 0, atBottom: 0,
            kind: { video: 0, game: 0, pay: 0, search: 0, shop: 0, article: 0 },
        };
    }
    function heatModeDefault() { return { n: 0, grid: zeros(16), side: [0, 0, 0], ex: { top: 0, bottom: 0, land: 0, noLink: 0 } }; }
    function heatDefault() {
        return { hv: 2, n: 0, grid: zeros(16), colN: {}, col: [0, 0, 0, 0], side: [0, 0, 0], ex: { top: 0, bottom: 0, land: 0, noLink: 0 }, ctx: heatCtxDefault(), mode: { task: heatModeDefault(), leisure: heatModeDefault() }, since: Date.now() };
    }
    function loadHeat() {
        var h = gmGet(CFG.HEATKEY + '::' + location.host, null);
        if (!h || typeof h !== 'object') return null;
        var d = heatDefault();
        if (!Array.isArray(h.grid) || h.grid.length !== 16) h.grid = d.grid;
        if (!h.colN || typeof h.colN !== 'object') h.colN = {};
        if (!Array.isArray(h.col)) h.col = d.col;
        if (!Array.isArray(h.side)) h.side = d.side;
        if (!h.ex || typeof h.ex !== 'object') h.ex = d.ex;
        if (typeof h.n !== 'number') h.n = 0;
        if (h.hv !== 2) { h.hv = 2; h.ctx = d.ctx; h.mode = d.mode; }   // 旧登记只保留主统计，状态从零开始
        return h;
    }
    // 站点类型：只用于给点击打“用手机/刷手机”的粗标签，后续成品再用数据校准
    function pageKind() {
        var s = (location.host + ' ' + location.pathname).toLowerCase();
        if (/video|bilibili|youtube|iqiyi|youku|douyin|tiktok|netflix|v\.qq/.test(s)) return 'video';
        if (/game|steam|taptap|4399/.test(s)) return 'game';
        if (/pay|checkout|cart|wallet|alipay|wechatpay/.test(s)) return 'pay';
        if (/search|baidu|bing|google|query/.test(s)) return 'search';
        if (/shop|mall|taobao|tmall|jd\.|pinduoduo|amazon/.test(s)) return 'shop';
        return 'article';
    }
    function netType() {
        var c = navigator.connection || {}, t = (c.type || '').toLowerCase();
        if (t === 'wifi' || t === 'ethernet') return 'wifi';
        if (t === 'cellular') return 'cell';
        return 'unknownNet';
    }
    // 用手机（外面/任务）vs 刷手机（家里/休闲）：临时启发式，仅登记，不参与预取
    function inferMode(kind, net, recent) {
        if (kind === 'video' || kind === 'game') return 'leisure';
        if (kind === 'pay' || kind === 'search' || kind === 'shop') return 'task';
        if (recent >= 3) return 'leisure';                 // 连续刷动
        var hr = new Date().getHours();
        if (net === 'cell') return 'task';                 // 移动网络更可能是外出
        if (hr >= 22 || hr < 6) return 'leisure';          // 夜间长看
        return 'task';
    }
    // 简单列检测：只统计“列级宽度”的链接（≥视口 28%），避免单列卡片里头像/标题/作者被读成多列
    function detectCols(vw, vh, a) {
        var list = document.querySelectorAll('a[href]'), buckets = [], seen = {}, i, r;
        var minW = vw * 0.28, gap = vw * 0.2;
        for (i = 0; i < list.length && i < 80; i++) {
            r = list[i].getBoundingClientRect();
            if (r.width < minW || r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > vh) continue;
            var b = Math.round(r.left / 8) * 8;
            if (!seen[b]) { seen[b] = 1; buckets.push(b); }
        }
        buckets.sort(function (x, y) { return x - y; });
        var cols = [];
        buckets.forEach(function (b) {
            if (!cols.length || b - cols[cols.length - 1].right > gap) cols.push({ left: b, right: b });
            else cols[cols.length - 1].right = b;
        });
        if (!cols.length || cols.length > 4) cols = [{ left: 0, right: 0 }];
        var ci = 0;
        if (a && a.getBoundingClientRect) {
            var ar = a.getBoundingClientRect(), best = 1e9;
            cols.forEach(function (c, idx) { var dd = Math.abs(ar.left - c.left); if (dd < best) { best = dd; ci = idx; } });
        }
        return { n: cols.length, ci: ci };
    }
    function recordHeat(e) {
        try {
            if (!e || typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return;
            var vw = window.innerWidth || document.documentElement.clientWidth || 1;
            var vh = window.innerHeight || document.documentElement.clientHeight || 1;
            if (!vw || !vh) return;
            var x = Math.max(0, Math.min(1, e.clientX / vw));
            var y = Math.max(0, Math.min(1, e.clientY / vh));
            var a = e.target && e.target.closest && e.target.closest('a[href]');
            var cols = detectCols(vw, vh, a);
            var h = loadHeat() || heatDefault();
            var now = Date.now(), recent = 0, i;
            for (i = 0; i < (scrollRecent || []).length; i++) if (now - scrollRecent[i] <= 10000) recent++;
            var kind = pageKind(), net = netType(), mode = inferMode(kind, net, recent);
            var ori = vw > vh ? 'landscape' : 'portrait';
            var hr = new Date().getHours();
            var tod = (hr >= 22 || hr < 6) ? 'night' : (hr >= 18 ? 'evening' : 'day');
            var band = recent >= 3 ? 's2' : (recent >= 1 ? 's1' : 's0');
            var sh = (document.body && document.body.scrollHeight) || (document.documentElement && document.documentElement.scrollHeight) || 0;
            var atBottom = sh > 0 && ((window.scrollY || 0) + vh >= sh - 8);
            var gi = Math.min(3, Math.floor(y * 4)) * 4 + Math.min(3, Math.floor(x * 4));
            var si = x < 0.34 ? 0 : (x < 0.67 ? 1 : 2);

            h.n++;
            h.grid[gi]++;
            var ck = '' + cols.n;
            h.colN[ck] = (h.colN[ck] || 0) + 1;
            if (cols.ci >= 0 && cols.ci < 4) h.col[cols.ci]++;
            h.side[si]++;
            if (y < 0.2) h.ex.top++;
            if (y > 0.85) h.ex.bottom++;
            if (vw > vh) h.ex.land++;
            if (!a) h.ex.noLink++;

            h.ctx[ori]++; h.ctx[tod]++; h.ctx[net]++; h.ctx[band]++;
            if (atBottom) h.ctx.atBottom++;
            if (!h.ctx.kind) h.ctx.kind = {};
            h.ctx.kind[kind] = (h.ctx.kind[kind] || 0) + 1;

            var m = h.mode[mode];
            m.n++; m.grid[gi]++; m.side[si]++;
            if (y < 0.2) m.ex.top++;
            if (y > 0.85) m.ex.bottom++;
            if (vw > vh) m.ex.land++;
            if (!a) m.ex.noLink++;

            h.last = now;
            gmSet(CFG.HEATKEY + '::' + location.host, h);
        } catch (err) { /* 采集失败不影响主流程 */ }
    }

    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', onClick, true);
    document.addEventListener('contextmenu', function (e) {
        var u = linkURL(e.target && e.target.closest && e.target.closest('a[href]'));
        if (u) neutral(u.href);
    }, true);

    function settle() {
        var miss = Object.keys(preds).filter(function (h) { return h !== clickedHref; });
        if (miss.length) withBrain(function (b) {
            miss.forEach(function (h) { settled[h] = 1; b.learn(preds[h], false); b.logOutcome(preds[h], false, h); });
        });
        Object.keys(preds).forEach(function (h) { settled[h] = 1; delete preds[h]; });
        clickedHref = null;
    }
    function suspend() {
        var items = loadP(), t = Date.now(), n = 0;
        Object.keys(preds).forEach(function (h) {
            items.push({ href: h, p: preds[h], at: t, sid: SID });
            delete preds[h]; n++;
        });
        clickedHref = null;
        if (n) { if (items.length > 60) items = items.slice(items.length - 60); saveP(items); }
    }
    function resume() {
        var items = loadP(), t = Date.now();
        if (!items.length) return;
        var keep = [], mine = [];
        items.forEach(function (it) { if (it.sid === SID) mine.push(it); else keep.push(it); });
        if (!mine.length) return;
        var expired = [], alive = [];
        mine.forEach(function (it) {
            if (settled[it.href]) return;
            if (t - it.at >= CFG.PENDING_TTL_MS) expired.push(it); else alive.push(it);
        });
        if (expired.length || alive.length) withBrain(function (b) {
            expired.forEach(function (it) { settled[it.href] = 1; b.learn(it.p, false); b.logOutcome(it.p, false, it.href); });
            alive.forEach(function (it) { if (!settled[it.href]) preds[it.href] = it.p; });
        });
        saveP(keep);
    }
    function recoverPending() {
        var items = loadP(), t = Date.now();
        if (!items.length) return;
        var expired = [], keep = [];
        items.forEach(function (it) { if (t - it.at > CFG.PENDING_TTL_MS) expired.push(it); else keep.push(it); });
        if (!expired.length) return;
        withBrain(function (b) {
            expired.forEach(function (it) { b.learn(it.p, false); b.logOutcome(it.p, false, it.href); });
        });
        saveP(keep);
    }
    function dropMine() {
        var items = loadP(), keep = items.filter(function (it) { return it.sid !== SID; });
        if (keep.length !== items.length) saveP(keep);
    }

    window.addEventListener('pagehide', function () { ctxAfterTired(); settle(); dropMine(); });
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') { ctxAfterTired(); stopSensors(); suspend(); }
        else { startSensors(); resume(); schedule(); }
    });

    var lastPath = location.pathname + location.search;
    function onRoute() {
        var p = location.pathname + location.search;
        if (p === lastPath) return;
        lastPath = p;
        settle(); dropMine();
        settled = {};
        view();
        stats.prerendered = {}; stats.prefetched = {}; stats.tapped = {}; stats.scrolled = {}; stats.cold = {};
        scrollPre = {}; scrollN = 0; scrollRecent = []; pageNoPrerender = false;
        specState.prefetch = []; specState.prerender = [];
        syncSpec();
        visible.forEach(function (a) { if (!a.isConnected) visible.delete(a); });
        watchAll(document);
        schedule();
        setTimeout(scrollPick, 800);   // v0.5.1：SPA 换页也补一次首屏滚动预取
    }
    ['pushState', 'replaceState'].forEach(function (m) {
        var o = history[m];
        history[m] = function () { var r = o.apply(this, arguments); setTimeout(onRoute, 0); return r; };
    });
    window.addEventListener('popstate', function () { ctxAfterTired(); setTimeout(onRoute, 0); });

    var canSpec = !!(window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules'));
    var LIMITS = { prerender: CFG.PRERENDER_MAX, prefetch: CFG.PREFETCH_MAX };
    if (MOB) { LIMITS.prerender = LOW_MEM ? 0 : 1; LIMITS.prefetch = 6; }
    if (slowNet || !canSpec) LIMITS.prerender = 0;

    var specEl = null;
    var specState = { prefetch: [], prerender: [] };
    function syncSpec() {
        if (!canSpec || !document.head) return;
        if (specEl && specEl.parentNode) specEl.parentNode.removeChild(specEl);
        specEl = document.createElement('script');
        specEl.type = 'speculationrules';
        var o = {};
        if (specState.prefetch.length) o.prefetch = [{ source: 'list', urls: specState.prefetch.slice(-30) }];
        if (specState.prerender.length) o.prerender = [{ source: 'list', urls: specState.prerender.slice(-4), eagerness: 'immediate' }];
        specEl.textContent = JSON.stringify(o);
        document.head.appendChild(specEl);
    }
    var syncTimer = 0;
    function syncSoon() {
        if (syncTimer) return;
        syncTimer = setTimeout(function () { syncTimer = 0; syncSpec(); }, 0);
    }
    function prefetch(href, l1, scroll) {
        if (stats.prefetched[href] || stats.prerendered[href] || stats.tapped[href] || (stats.scrolled && stats.scrolled[href])) return false;
        if (scroll) {
            stats.scrolled = stats.scrolled || {}; stats.scrolled[href] = 1;
        } else if (l1) {
            if (Object.keys(stats.tapped).length >= CFG.TAP_MAX) return false;
            stats.tapped[href] = 1;
        } else {
            stats.prefetched[href] = 1;
        }
        if (canSpec) { specState.prefetch.push(href); syncSoon(); }
        else { var l = document.createElement('link'); l.rel = 'prefetch'; l.href = href; document.head.appendChild(l); }
        return true;
    }
    function prerender(href) {
        if (stats.prerendered[href]) return;
        if (!canSpec) return prefetch(href);
        stats.prerendered[href] = 1;
        specState.prerender.push(href); syncSoon();
    }

    var visible = new Set();
    var io = new IntersectionObserver(function (ents) {
        ents.forEach(function (en) { if (en.isIntersecting) visible.add(en.target); else visible.delete(en.target); });
        schedule();
    }, { rootMargin: '100px' });
    var watched = new WeakSet();
    function watchAll(root) {
        var list = root.querySelectorAll('a[href]');
        for (var i = 0; i < list.length; i++) if (!watched.has(list[i])) { watched.add(list[i]); io.observe(list[i]); }
    }
    var timer = 0;
    function schedule() {
        if (timer) return;
        timer = setTimeout(function () { timer = 0; (window.requestIdleCallback || function (f) { setTimeout(f, 0); })(decide); }, CFG.TICK_MS);
    }

    function decide() {
        if (saveData || document.prerendering || document.visibilityState !== 'visible') return;
        var db = load(location.host), b = new Brain(db, Date.now, HL), seen = {}, ranked = [];
        var cold = !b.hasFlow();                       // v0.5.1：冷启动仍有预载，但不建学习账
        visible.forEach(function (a) {
            var u = linkURL(a);
            if (!u || seen[u.href]) return;
            seen[u.href] = 1;
            var flow = b.isFlow(u.href);
            if (!flow && !cold) return;
            var j = b.judge(vecOf(a, u), u.href);
            if (j && j.score >= db.th.prefetch) ranked.push({ href: u.href, j: j, cold: !flow });
        });
        ranked.sort(function (x, y) { return y.j.score - x.j.score; });
        var pr = Object.keys(stats.prerendered).length, pf = Object.keys(stats.prefetched).length;
        var prMax = pageNoPrerender ? 0 : LIMITS.prerender;   // 本页任务态只关本页整页渲染，不改全局
        var budget = LIMITS.prerender + LIMITS.prefetch;
        ranked.forEach(function (r) {
            var href = r.href;
            if (preds[href] || settled[href]) return;
            var hot = r.j.score >= db.th.prerender && r.j.tier !== '候选';
            if (r.cold) {
                // 冷启动：只预取不整页渲染，跳过滚动/L1 已取的；不写 preds、不学习
                if (pf < LIMITS.prefetch && prefetch(href)) { pf++; stats.cold[href] = 1; }
                return;
            }
            if (hot && prMax > 0 && pr < prMax && !stats.prerendered[href]) {
                prerender(href); pr++; preds[href] = r.j;
            } else if (pf < LIMITS.prefetch && !stats.prefetched[href] && !stats.prerendered[href]) {
                prefetch(href); pf++; preds[href] = r.j;
            } else if ((stats.prerendered[href] || stats.prefetched[href] || stats.tapped[href]) && Object.keys(preds).length < budget) {
                preds[href] = r.j;
            }
        });
    }

    // 滚动模式：停滚 300ms 后，取屏幕中央沿滚动方向最近的 N 条非流程链接预取
    var scrollPre = {}, scrollN = 0, lastY = window.scrollY || 0, dir = 1, idleTimer = 0, scrollRecent = [], pageNoPrerender = false;
    var PICK = (LOW_MEM || slowNet) ? 1 : CFG.SCROLL_PICK;
    function onScroll() {
        var y = window.scrollY || 0;
        if (Math.abs(y - lastY) > 4) { dir = y > lastY ? 1 : -1; lastY = y; }
        scrollRecent.push(Date.now());
        if (scrollRecent.length > 80) scrollRecent = scrollRecent.slice(-80);
        clearTimeout(idleTimer);
        idleTimer = setTimeout(scrollPick, CFG.SCROLL_IDLE_MS);
    }
    function scrollPick() {
        if (saveData || document.prerendering || document.visibilityState !== 'visible') return;
        if (scrollN >= CFG.SCROLL_MAX) return;
        var vh = window.innerHeight || document.documentElement.clientHeight, target = vh * (0.5 + 0.15 * dir);
        var vw = window.innerWidth || document.documentElement.clientWidth || 1, tx = null, band = false;
        if (ARM === 'A') {   // v0.7：只有 A 组用情景
            var cx = inferCtx();
            if (cx.browse >= CFG.CTX_BROWSE) {
                var hold = cx.hold;
                tx = vw * (hold === 'l' ? 0.35 : hold === 'r' ? 0.6 : 0.5);
                target = vh * (0.42 + 0.05 * dir);   // 托底手舒适区：中心偏上 + 同侧
                band = true;
                pageNoPrerender = false;
            } else if (cx.browse <= CFG.CTX_TASK) {
                tx = vw * 0.5;
                target = vh * 0.5;                  // 用手机：正中
                pageNoPrerender = true;             // 本页不整页渲染（局部，不改全局）
            }
        }
        var db = load(location.host), b = new Brain(db, Date.now, HL), cand = [], seen = {};
        visible.forEach(function (a) {
            var u = linkURL(a);
            if (!u || seen[u.href] || scrollPre[u.href] || b.isFlow(u.href)) return;
            if (stats.prefetched[u.href] || stats.prerendered[u.href] || stats.tapped[u.href] || (stats.scrolled && stats.scrolled[u.href])) return;
            seen[u.href] = 1;
            var r = a.getBoundingClientRect();
            if (r.bottom < 0 || r.top > vh || r.width < 8 || r.height < 8) return;
            var cy = (r.top + r.bottom) / 2;
            if (band && (cy < vh * 0.15 || cy > vh * 0.85)) return;
            var dy = Math.abs(cy - target), dx = tx === null ? 0 : Math.abs((r.left + r.right) / 2 - tx);
            cand.push({ href: u.href, d: Math.sqrt(dy * dy + 0.36 * dx * dx) });
        });
        cand.sort(function (x, y) { return x.d - y.d; });
        var got = 0;
        for (var i = 0; i < cand.length && got < PICK && scrollN < CFG.SCROLL_MAX; i++) {
            var h = cand[i].href;
            if (prefetch(h, true, true)) { scrollPre[h] = 1; got++; scrollN++; }   // v0.5.1：只在真正预取成功后才标记
        }
        if (got) { withBrain(function (b2) { b2.db.S.pre += got; }); ctxStat({ pre: got }); }
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    setTimeout(scrollPick, 800);

    // L1 兜底：手指按住链接不动 120ms 才预取；滑动取消；快速轻点在 touchend 补一次
    var tapTimer = 0, tapPoint = null;
    function tapClear() { clearTimeout(tapTimer); tapPoint = null; }
    function onTouchStart(e) {
        if (saveData) return;
        var t = e.touches && e.touches[0];
        var a = e.target && e.target.closest && e.target.closest('a[href]');
        if (!t || !a) return;
        tapPoint = { a: a, x: t.clientX, y: t.clientY };
        clearTimeout(tapTimer);
        tapTimer = setTimeout(function () {
            var p = tapPoint; tapPoint = null;
            if (!p) return;
            var u = linkURL(p.a);
            if (u) prefetch(u.href, true);
        }, 120);
    }
    function onTouchMove(e) {
        if (!tapPoint) return;
        var t = e.touches && e.touches[0];
        if (!t) return;
        if (Math.abs(t.clientX - tapPoint.x) > 12 || Math.abs(t.clientY - tapPoint.y) > 12) tapClear();
    }
    function onTouchEnd() {
        var p = tapPoint;
        if (p) { var u = linkURL(p.a); if (u) prefetch(u.href, true); }
        tapClear();
    }
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
    document.addEventListener('touchend', onTouchEnd, true);
    document.addEventListener('touchcancel', tapClear, true);
    if (!MOB) {
        document.addEventListener('mousedown', function (e) {
            if (saveData) return;
            var u = linkURL(e.target && e.target.closest && e.target.closest('a[href]'));
            if (u) prefetch(u.href, true);
        }, true);
    }

    watchAll(document);
    new MutationObserver(function (ms) {
        for (var i = 0; i < ms.length; i++) for (var j = 0; j < ms[i].addedNodes.length; j++) {
            var n = ms[i].addedNodes[j];
            if (n.nodeType !== 1) continue;
            if (n.matches && n.matches('a[href]')) { if (!watched.has(n)) { watched.add(n); io.observe(n); } }
            else if (n.querySelector && n.querySelector('a[href]')) watchAll(n);
        }
    }).observe(document.documentElement, { childList: true, subtree: true });

    /* ---------------- 文件导出 / 经验库备份恢复 ---------------- */
    function localDay(d) {
        d = d || new Date();
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    }
    function downloadText(text, name, type) {
        var blob = new Blob([text], { type: type || 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { try { URL.revokeObjectURL(a.href); } catch (e) { /* ignore */ } }, 1000);
    }

    // 备份：所有站点（有流程条目、有网址点击记录、或有滚动统计）都算有经验
    function backupAll() {
        var hosts = gmGet(CFG.SITESKEY, []);
        if (!Array.isArray(hosts)) hosts = [];
        hosts = hosts.slice();
        if (hosts.indexOf(location.host) < 0) hosts.push(location.host);
        var out = { format: 'pp5-backup', version: 3, exportedAt: new Date().toISOString(), sites: {}, heat: {}, ctx: {} };
        hosts.forEach(function (h) {
            if (!h || !safeKey(h)) return;
            var db = load(h);
            var hh = gmGet(CFG.HEATKEY + '::' + h, null), cc = gmGet(CFG.CTXKEY + '::' + h, null);
            if (hh && hh.n) out.heat[h] = hh;          // v0.7：热区与情景也进备份
            if (cc && cc.cv === 1) out.ctx[h] = cc;
            if (!db) return;
            var hasE = db.E && Object.keys(db.E).length;
            var hasU = db.U && Object.keys(db.U).length;
            var hasS = db.S && (num(db.S.pre) || num(db.S.click));
            if (!hasE && !hasU && !hasS) return;
            out.sites[h] = db;
        });
        return JSON.stringify(out);
    }

    function importBackup(text) {
        var data;
        try { data = JSON.parse(String(text)); } catch (e) { return { ok: false, error: 'JSON 解析失败' }; }
        if (!data || data.format !== 'pp5-backup' || !data.sites || typeof data.sites !== 'object') {
            return { ok: false, error: '不是有效的经验库备份' };
        }
        var hosts = Object.keys(data.sites).filter(function (h) { return h && safeKey(h); });
        var entries = 0;
        // v0.7：热区/情景按“样本多的一方”取整组，不拆开合并，保证自洽
        ['heat', 'ctx'].forEach(function (kind) {
            var src = data[kind];
            if (!src || typeof src !== 'object') return;
            var key = kind === 'heat' ? CFG.HEATKEY : CFG.CTXKEY;
            var size = function (o) { if (!o) return -1; return kind === 'heat' ? num(o.n) : num(o.W && o.W.click) + num(o.A && o.A.click) + num(o.B && o.B.click) + num(o.agree && o.agree.n); };
            Object.keys(src).forEach(function (h) {
                if (!h || !safeKey(h) || !src[h] || typeof src[h] !== 'object') return;
                var cur = gmGet(key + '::' + h, null);
                if (size(src[h]) > size(cur)) { gmSet(key + '::' + h, src[h]); registerSite(h); }
            });
        });
        hosts.forEach(function (h) {
            var inc = data.sites[h];
            if (!inc || typeof inc !== 'object') return;
            var merged = mergeDb(load(h), inc);
            gmSet(siteKey(h), merged);
            registerSite(h);
            entries += Object.keys(merged.E).length;
        });
        return { ok: true, sites: hosts.length, entries: entries };
    }

    // 导出：快照写成当天一个文件，先留备份，再只删本次导出的行
    function exportLog() {
        var all = getLog();
        if (!all.length) { alert('暂无反馈日志'); return 0; }
        var rows = all.slice();
        var ids = {};
        rows.forEach(function (r) { if (r.id) ids[r.id] = 1; });
        var day = localDay();
        var lines = rows.map(function (r) {
            var host = '', path = r.href;
            try { var u = new URL(r.href); host = u.host; path = u.pathname + u.search; } catch (e) { /* ignore */ }
            var mode = r.mode || 'flow';
            return JSON.stringify({
                id: r.id || null, date: new Date(r.t).toISOString(), sentence: host + ' ' + path, situation: '预载', mode: mode,
                base: mode === 'scroll' ? '滚动预取' : (r.tier + ' ' + r.score), base_src: '行为', ring: 'L4', layer: 'L4', same: null,
                verdict: r.hit ? '胜' : '负', filter: '不触发：行为日志', logic: null, site: host,
                vec: r.key || null, ds: r.ds || null, sim: r.sim === undefined ? null : r.sim,
                bright: r.b === undefined ? null : r.b, W: r.W || null, th: r.th || null,
                pre: r.pre === undefined ? null : r.pre,
            });
        });
        gmSet(CFG.LASTKEY, { at: Date.now(), day: day, rows: rows });
        downloadText(lines.join('\n') + '\n', 'pp5-' + day + '.jsonl', 'application/x-ndjson');
        var cur = getLog(), keep = [], dropped = 0;
        cur.forEach(function (r, i) {
            if (r.id) { if (ids[r.id]) { dropped++; return; } }
            else if (i < rows.length) { dropped++; return; }
            keep.push(r);
        });
        gmSet(CFG.LOGKEY, keep);
        return dropped;
    }

    function restoreLastExport() {
        var last = gmGet(CFG.LASTKEY, null);
        if (!last || !Array.isArray(last.rows) || !last.rows.length) return -1;
        var cur = getLog(), seen = {};
        cur.forEach(function (r) { if (r.id) seen[r.id] = 1; });
        var add = last.rows.filter(function (r) { return !r.id || !seen[r.id]; });
        if (!add.length) return 0;
        var merged = add.concat(cur);
        if (merged.length > CFG.LOG_MAX) merged = merged.slice(merged.length - CFG.LOG_MAX);
        gmSet(CFG.LOGKEY, merged);
        return add.length;
    }

    function backupMenu() {
        downloadText(backupAll(), 'pp5-exp-' + localDay() + '.json', 'application/json');
    }

    function importMenu() {
        var inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.json,application/json';
        inp.style.display = 'none';
        document.body.appendChild(inp);
        inp.addEventListener('change', function () {
            var f = inp.files && inp.files[0];
            if (!f) { inp.remove(); return; }
            var rd = new FileReader();
            rd.onload = function () {
                var r = importBackup(String(rd.result));
                alert(r.ok ? ('已恢复 ' + r.sites + ' 个站点，共 ' + r.entries + ' 条经验') : ('恢复失败：' + r.error));
                inp.remove();
            };
            rd.onerror = function () { alert('读取备份文件失败'); inp.remove(); };
            rd.readAsText(f);
        });
        inp.click();
    }

    window.__pp = {
        speculation: canSpec, mobile: MOB, limits: LIMITS, stats: stats, preds: preds,
        report: function () {
            var db = load(location.host), b = new Brain(db, Date.now, HL);
            var top = Object.keys(db.E).map(function (k) { var e = db.E[k], br = b.bright(e); return [k, +br.toFixed(2), b.tier(e, br), 'C' + e.confirm + '/X' + (+e.correct.toFixed(1))]; })
                .sort(function (x, y) { return y[1] - x[1]; }).slice(0, 10);
            var sites = gmGet(CFG.SITESKEY, []);
            return {
                站点: location.host, 已登记站点: Array.isArray(sites) ? sites.length : 0,
                本页命中预载: stats.served, 移动端: MOB, 预载上限: LIMITS,
                轻触预取: Object.keys(stats.tapped).length, 冷启动预取: Object.keys(stats.cold).length, 待恢复: loadP().length,
                流程网址: Object.keys(db.U || {}).filter(function (h) { return b.isFlow(h); }).length,
                滚动模式: {
                    本页预取: scrollN, 累计预取: db.S.pre, 点击: db.S.click, 命中: db.S.hit,
                    点击覆盖率: db.S.click ? +(db.S.hit / db.S.click).toFixed(2) : null,
                    预取命中率: db.S.pre ? +(db.S.hit / db.S.pre).toFixed(2) : null,
                },
                点击登记: (function (h) {
                    if (!h) return null;
                    var rows = function (g) { var out = [], r, c, s; for (r = 0; r < 4; r++) { s = 0; for (c = 0; c < 4; c++) s += g[r * 4 + c] || 0; out.push(s); } return out; };
                    return {
                        次数: h.n, 列数分布: h.colN, 列点击: h.col, 左右: h.side, 例外: h.ex, 网格行: rows(h.grid),
                        用手机: { 次数: h.mode.task.n, 网格行: rows(h.mode.task.grid), 例外: h.mode.task.ex },
                        刷手机: { 次数: h.mode.leisure.n, 网格行: rows(h.mode.leisure.grid), 例外: h.mode.leisure.ex },
                        上下文: h.ctx,
                    };
                })(loadHeat()),
                维度权重: db.W, 门槛: db.th, 近期: db.hist, 日志行: getLog().length, 库前十: top,
            };
        },
        reset: function () { gmSet(siteKey(location.host), {}); gmSet(pkey(location.host), []); },
        clearLog: function () { gmSet(CFG.LOGKEY, []); },
        exportLog: exportLog,
        restoreLastExport: restoreLastExport,
        backup: backupAll,
        importBackup: importBackup,
        heat: loadHeat,
        ctx: ctxReport,
        tag: ctxTag,
        sensors: requestSensors,
        clearHeat: function () { gmSet(CFG.HEATKEY + '::' + location.host, heatDefault()); },
    };
    try {
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('导出今日反馈（只删已导）', exportLog);
            GM_registerMenuCommand('恢复上次导出（合并回日志）', function () {
                var n = restoreLastExport();
                alert(n < 0 ? '没有上次导出备份' : (n === 0 ? '上次导出的行都还在日志里' : '已恢复 ' + n + ' 行到日志'));
            });
            GM_registerMenuCommand('备份经验库（换机复原）', backupMenu);
            GM_registerMenuCommand('恢复经验库（选备份文件）', importMenu);
            GM_registerMenuCommand('查看预载状态', function () { alert(JSON.stringify(window.__pp.report(), null, 2)); });
            GM_registerMenuCommand('查看情景层', function () { alert(JSON.stringify(window.__pp.ctx(), null, 2)); });
            GM_registerMenuCommand('启用传感器（可选）', requestSensors);
            GM_registerMenuCommand('标注：我在刷手机', function () { var x = ctxTag('browse'); alert('已记“刷”，此刻判断刷手机概率 ' + x.browse); });
            GM_registerMenuCommand('标注：我在用手机', function () { var x = ctxTag('task'); alert('已记“用”，此刻判断刷手机概率 ' + x.browse); });
            GM_registerMenuCommand('查看点击登记', function () { alert(JSON.stringify(window.__pp.heat() || '暂无登记', null, 2)); });
            GM_registerMenuCommand('重置本站学习库', function () { window.__pp.reset(); alert('已重置 ' + location.host); });
        }
    } catch (e) { /* ignore */ }
})();