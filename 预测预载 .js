// ==UserScript==
// @name         预测预载·五环版 PredictPreload
// @namespace    hark.predict-preload
// @version      0.4.2
// @description  链接当向量，套五环：L1 按下兜底→L2 相似亮灯→L3 否决→L4 记账打分→自学习（命中加权、落空降权、门槛自调）。高分整页后台渲染，其余预取。安卓优先，按站分键，日志汇总，菜单导出（只删已导行并留备份），经验库可备份复原。
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
            if (/^\d+$/.test(s) || (s.length >= 12 && /\d/.test(s) && /^[\w-]+$/.test(s))) return ':id';
            if (/\d{4,}/.test(s)) return s.replace(/\d+/g, ':n');
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
    // 每一维的相似度 0..1
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
        db.th = db.th || { prerender: 0.35, prefetch: 0.12 };   // 门槛，自学习会调
        db.hist = db.hist || { hit: 0, miss: 0 };
        this.db = db; this.now = now; this.hl = hl;
    }
    Brain.prototype.pageView = function () { this.db.pages = add(this.db.pages, this.now(), this.hl); };

    // L4 亮度＝U×P(+探索)，U=点击/页数，P=(确认+1)/(确认+纠错+2)
    Brain.prototype.bright = function (e) {
        var t = this.now(), pages = Math.max(1, dec(this.db.pages, t, this.hl));
        var U = Math.min(1, dec(e.clicks, t, this.hl) / pages);
        var P = (e.confirm + 1) / (e.confirm + e.correct + 2);
        var b = U * P + (e.n < CFG.EXPLORE_N ? 0.2 * U : 0);
        return b;
    };
    Brain.prototype.tier = function (e, b) {
        if (e.ban) return '拉黑';
        if (b >= 0.8 && e.confirm >= 10) return '核心';
        if (b >= 0.6 && e.confirm >= 3) return '常用';
        return '候选';
    };

    // L2 亮灯 + L4 打分：对一个可见链接，找最相似的库条目
    Brain.prototype.judge = function (v, href) {
        var best = null, W = this.db.W, E = this.db.E;
        for (var k in E) {
            var e = E[k];
            if (e.ban) continue;
            var ds = dimSim(v, e.v), sim = weighted(ds, W);
            if (sim < CFG.LIGHT_MIN) continue;                       // 不亮灯
            var anchor = e.urls && e.urls[href] ? 0.5 : 0;
            var b = this.bright(e);
            var score = Math.min(1, sim + anchor) * b;
            if (!best || score > best.score) best = { key: k, sim: sim, ds: ds, b: b, score: score, tier: this.tier(e, b) };
        }
        return best;
    };

    // 记点击：入库/加权
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

    // 自学习：一次预测的结局
    //   hit=true  确认：条目 confirm+1，命中的维度加权（相似越高加越多）
    //   hit=false 纠错：条目 correct+1，命中的维度降权；同来源页的兄弟条目跟着轻降（纠错扩散）
    //   门槛：按近期命中率自调（命中率高→放宽，低→收紧）
    Brain.prototype.learn = function (pred, hit) {
        var e = this.db.E[pred.key];
        if (!e) return;
        var W = this.db.W, H = this.db.hist;
        if (hit) { e.confirm++; H.hit++; } else { e.correct++; H.miss++; }
        // 只学“区分度”：比平均更像的维度，命中则升、落空则降；各维一样像时不动
        var avg = DIMS.reduce(function (s, d) { return s + pred.ds[d]; }, 0) / DIMS.length;
        DIMS.forEach(function (d) {
            var g = (pred.ds[d] - avg) * (hit ? 1 : -1);
            W[d] = Math.min(0.7, Math.max(0.03, W[d] * Math.exp(CFG.LR * 4 * g)));
        });
        var z = DIMS.reduce(function (s, d) { return s + W[d]; }, 0);
        DIMS.forEach(function (d) { W[d] = +(W[d] / z).toFixed(4); });
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
            H.hit *= 0.9; H.miss *= 0.9;   // 只看近期
        }
    };

    // 降级与清理：<0.2 且纠错多→退；久未用→拆；超量砍最暗
    Brain.prototype.prune = function () {
        var self = this, E = this.db.E, t = this.now();
        Object.keys(E).forEach(function (k) {
            var e = E[k];
            if (e.correct >= 8 && e.confirm === 0) e.ban = true;             // 只落空从不命中：拉黑
            if (t - (e.last || e.first) > 60 * 864e5) delete E[k];           // 60 天没碰：拆回
        });
        var keys = Object.keys(E);
        if (keys.length > CFG.MAX_ENTRIES) {
            var scored = keys.map(function (k) { return [k, self.bright(E[k])]; });
            scored.sort(function (a, b) { return a[1] - b[1]; });            // 先算亮度再排，避免重复衰减
            scored.slice(0, keys.length - CFG.MAX_ENTRIES).forEach(function (p) { delete E[p[0]]; });
        }
    };

    // 反馈记录：写进内存 db.log，由 save 统一并入全局日志键
    Brain.prototype.logOutcome = function (pred, hit, href) {
        var L = this.db.log = this.db.log || [];
        L.push({ id: uid(), t: this.now(), href: href, key: pred.key, ds: pred.ds, sim: +pred.sim.toFixed(3), b: +pred.b.toFixed(3), score: +pred.score.toFixed(3), tier: pred.tier, hit: hit, W: copy(this.db.W), th: copy(this.db.th) });
    };

    /* ---- 经验库合并：换机导入时按条目取优，避免覆盖丢失 ---- */
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
        var main = wb > wa ? B : A;                 // 学得更多的这方提供权重/门槛
        var out = {
            W: fullW(main.W),
            th: fullTh(main.th),
            pages: maxRec(A.pages, B.pages),
            hist: { hit: Math.max(num(ha.hit), num(hb.hit)), miss: Math.max(num(ha.miss), num(hb.miss)) },
            E: {},
        };
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
    // 学习库/权重：按站分键
    function load(host) { var db = gmGet(siteKey(host), {}); return (db && typeof db === 'object') ? db : {}; }
    function save(db, host) {
        var rows = db.log || [];
        delete db.log;
        gmSet(siteKey(host), db);                 // 本站库（不含日志）
        registerSite(host);
        if (rows.length) appendLog(rows);         // 日志并入全局键
    }
    // 反馈日志：所有站同一个键
    function appendLog(rows) {
        var all = gmGet(CFG.LOGKEY, []);
        if (!Array.isArray(all)) all = [];
        all = all.concat(rows);
        if (all.length > CFG.LOG_MAX) all = all.slice(all.length - CFG.LOG_MAX);
        gmSet(CFG.LOGKEY, all);
    }
    function getLog() { var a = gmGet(CFG.LOGKEY, []); return Array.isArray(a) ? a : []; }
    function withBrain(fn) { var host = location.host, db = load(host), b = new Brain(db, Date.now, HL); var r = fn(b); save(db, host); return r; }
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
    // L3 否决
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

    var stats = { prerendered: {}, prefetched: {}, tapped: {}, served: false };
    var preds = {};               // href → 预测（待结算）
    var settled = {};             // href → 1（本路由已结算，避免重复判负/确认）
    var clickedHref = null;
    var SID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);   // 本页会话

    // 挂起区：按站分键
    function loadP() { var a = gmGet(pkey(location.host), []); return Array.isArray(a) ? a : []; }
    function saveP(items) { gmSet(pkey(location.host), items); }

    // 设备与网络画像（安卓优先）
    var UA = (navigator.userAgent || '');
    var MOB = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(UA) ||
        !!(navigator.userAgentData && navigator.userAgentData.mobile);
    var MEM = navigator.deviceMemory || 0;
    var LOW_MEM = MEM > 0 && MEM <= 3;
    var conn = navigator.connection || {};
    var saveData = !!(conn.saveData || /(^|-)2g|slow-2g/.test(conn.effectiveType || ''));
    var slowNet = saveData || /(^|-)3g/.test(conn.effectiveType || '');

    // 来时检查：本页是不是被预渲染/预取命中的
    try {
        var nav = performance.getEntriesByType('navigation')[0];
        stats.served = !!(nav && (nav.activationStart > 0 || nav.deliveryType === 'navigational-prefetch'));
    } catch (e) { /* ignore */ }
    function onReady() { view(); recoverPending(); }
    if (document.prerendering) document.addEventListener('prerenderingchange', onReady, { once: true });
    else onReady();

    // 预测被“用掉”：命中记分并销账
    function consume(b, href) {
        if (!preds[href]) return;
        b.learn(preds[href], true); b.logOutcome(preds[href], true, href);
        delete preds[href]; settled[href] = 1;
    }
    // 不确定是否算命中（长按菜单/右键）：中性移除，既不判命中也不判落空
    function neutral(href) { if (preds[href]) { delete preds[href]; settled[href] = 1; } }

    function onClick(e) {
        var a = e.target && e.target.closest && e.target.closest('a[href]');
        var u = linkURL(a);
        if (!u) return;
        var ctrl = e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
        if ((e.type === 'auxclick' && e.button === 1) || (e.type === 'click' && ctrl)) {
            // 中键/修饰键在新标签打开：用到了这条预测，算命中，本页不离开
            var v2 = vecOf(a, u);
            withBrain(function (b) { b.click(v2, u.href); consume(b, u.href); });
            return;
        }
        if (e.type === 'auxclick') { neutral(u.href); return; }   // 右键等：中性
        clickedHref = u.href;
        var v = vecOf(a, u);
        withBrain(function (b) { b.click(v, u.href); consume(b, u.href); });
    }
    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', onClick, true);
    // 长按/右键链接（可能是“在新标签打开”）：中性销账，避免被当成猜错
    document.addEventListener('contextmenu', function (e) {
        var u = linkURL(e.target && e.target.closest && e.target.closest('a[href]'));
        if (u) neutral(u.href);
    }, true);

    // 明确离开/换页：预测了却没点的 → 纠错。只结算一次，写 settled 防重复
    function settle() {
        var miss = Object.keys(preds).filter(function (h) { return h !== clickedHref; });
        if (miss.length) withBrain(function (b) {
            miss.forEach(function (h) { settled[h] = 1; b.learn(preds[h], false); b.logOutcome(preds[h], false, h); });
        });
        Object.keys(preds).forEach(function (h) { settled[h] = 1; delete preds[h]; });
        clickedHref = null;
    }
    // 切后台：挂起到本站，不立刻判落空（看一眼通知回来还能恢复）
    function suspend() {
        var items = loadP(), t = Date.now(), n = 0;
        Object.keys(preds).forEach(function (h) {
            items.push({ href: h, p: preds[h], at: t, sid: SID });
            delete preds[h]; n++;
        });
        clickedHref = null;
        if (n) { if (items.length > 60) items = items.slice(items.length - 60); saveP(items); }
    }
    // 回到前台：30 秒内恢复为待结算，超时的判落空
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
    // 打开站点时：把本站挂起超过 30 秒的旧预测补判落空（进程被杀/标签页没回来）
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
    // 清掉本页残留挂起项
    function dropMine() {
        var items = loadP(), keep = items.filter(function (it) { return it.sid !== SID; });
        if (keep.length !== items.length) saveP(keep);
    }

    window.addEventListener('pagehide', function () { settle(); dropMine(); });
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') suspend();
        else { resume(); schedule(); }
    });

    // SPA 换页：结算旧预测，重置本轮记账
    var lastPath = location.pathname + location.search;
    function onRoute() {
        var p = location.pathname + location.search;
        if (p === lastPath) return;
        lastPath = p;
        settle(); dropMine();
        settled = {};
        view();
        stats.prerendered = {}; stats.prefetched = {}; stats.tapped = {};
        specState.prefetch = []; specState.prerender = [];
        syncSpec();
        visible.forEach(function (a) { if (!a.isConnected) visible.delete(a); });
        watchAll(document);
        schedule();
    }
    ['pushState', 'replaceState'].forEach(function (m) {
        var o = history[m];
        history[m] = function () { var r = o.apply(this, arguments); setTimeout(onRoute, 0); return r; };
    });
    window.addEventListener('popstate', function () { setTimeout(onRoute, 0); });

    var canSpec = !!(window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules'));
    // 预载上限：安卓只留 1 个 prerender（内存敏感），低内存/3G/省流直接只 prefetch
    var LIMITS = { prerender: CFG.PRERENDER_MAX, prefetch: CFG.PREFETCH_MAX };
    if (MOB) { LIMITS.prerender = LOW_MEM ? 0 : 1; LIMITS.prefetch = 6; }
    if (slowNet || !canSpec) LIMITS.prerender = 0;

    // 复用单个 speculationrules 节点：每次整体重写，避免脚本堆积
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
    // l1=true 表示手指按下兜底：单独记账，不占模型预测的预取名额
    function prefetch(href, l1) {
        if (stats.prefetched[href] || stats.prerendered[href] || stats.tapped[href]) return false;
        if (l1) {
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
        visible.forEach(function (a) {
            var u = linkURL(a);
            if (!u || seen[u.href]) return;
            seen[u.href] = 1;
            var j = b.judge(vecOf(a, u), u.href);
            if (j && j.score >= db.th.prefetch) ranked.push({ href: u.href, j: j });
        });
        ranked.sort(function (x, y) { return y.j.score - x.j.score; });
        var pr = Object.keys(stats.prerendered).length, pf = Object.keys(stats.prefetched).length;
        var budget = LIMITS.prerender + LIMITS.prefetch;   // 本页待结算预测上限
        ranked.forEach(function (r) {
            var href = r.href;
            if (preds[href] || settled[href]) return;
            var hot = r.j.score >= db.th.prerender && r.j.tier !== '候选';
            if (hot && LIMITS.prerender > 0 && pr < LIMITS.prerender && !stats.prerendered[href]) {
                prerender(href); pr++; preds[href] = r.j;
            } else if (pf < LIMITS.prefetch && !stats.prefetched[href] && !stats.prerendered[href]) {
                prefetch(href); pf++; preds[href] = r.j;
            } else if ((stats.prerendered[href] || stats.prefetched[href] || stats.tapped[href]) && Object.keys(preds).length < budget) {
                preds[href] = r.j;   // 已预载过但尚未结算：补记，供后续点击确认
            }
        });
    }

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
        var p = tapPoint;                        // 还在 120ms 内：快速轻点，补一次兜底
        if (p) { var u = linkURL(p.a); if (u) prefetch(u.href, true); }
        tapClear();
    }
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
    document.addEventListener('touchend', onTouchEnd, true);
    document.addEventListener('touchcancel', tapClear, true);
    if (!MOB) {
        // 桌面鼠标：按下即兜底预取（安卓触摸会派发 mousedown，故只在非移动端启用）
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
    // 本地日期，避免 UTC 早上 8 点前写成昨天
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

    // 备份：所有站的学习库/权重/门槛（不含训练日志，日志走每日导出）
    function backupAll() {
        var hosts = gmGet(CFG.SITESKEY, []);
        if (!Array.isArray(hosts)) hosts = [];
        hosts = hosts.slice();
        if (hosts.indexOf(location.host) < 0) hosts.push(location.host);
        var out = { format: 'pp5-backup', version: 1, exportedAt: new Date().toISOString(), sites: {} };
        hosts.forEach(function (h) {
            if (!h || !safeKey(h)) return;
            var db = load(h);
            if (!db || !db.E || !Object.keys(db.E).length) return;
            out.sites[h] = db;
        });
        return JSON.stringify(out);
    }

    // 恢复：按条目取优合并，换机不清空、不覆盖更强的本地经验
    function importBackup(text) {
        var data;
        try { data = JSON.parse(String(text)); } catch (e) { return { ok: false, error: 'JSON 解析失败' }; }
        if (!data || data.format !== 'pp5-backup' || !data.sites || typeof data.sites !== 'object') {
            return { ok: false, error: '不是有效的经验库备份' };
        }
        var hosts = Object.keys(data.sites).filter(function (h) { return h && safeKey(h); });
        var entries = 0;
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

    // 导出：快照写成当天一个文件，先留备份，再只删本次导出的行（不清整键）
    function exportLog() {
        var all = getLog();
        if (!all.length) { alert('暂无反馈日志'); return 0; }
        var rows = all.slice();                       // 本次导出快照
        var ids = {};
        rows.forEach(function (r) { if (r.id) ids[r.id] = 1; });
        var day = localDay();
        var lines = rows.map(function (r) {
            var host = '', path = r.href;
            try { var u = new URL(r.href); host = u.host; path = u.pathname + u.search; } catch (e) { /* ignore */ }
            return JSON.stringify({ date: new Date(r.t).toISOString(), sentence: host + ' ' + path, situation: '预载', base: r.tier + ' ' + r.score, base_src: '行为', ring: 'L4', layer: 'L4', same: null, verdict: r.hit ? '胜' : '负', filter: '不触发：行为日志', logic: null, site: host, vec: r.key, ds: r.ds, sim: r.sim, bright: r.b, W: r.W, th: r.th });
        });
        gmSet(CFG.LASTKEY, { at: Date.now(), day: day, rows: rows });   // 先留一份，下载失败可恢复
        downloadText(lines.join('\n') + '\n', 'pp5-' + day + '.jsonl', 'application/x-ndjson');
        // 只删本次导出的行：有 id 按 id 精确删；旧格式无 id 按“前 N 行”兜底
        var cur = getLog(), keep = [], dropped = 0;
        cur.forEach(function (r, i) {
            if (r.id) { if (ids[r.id]) { dropped++; return; } }
            else if (i < rows.length) { dropped++; return; }
            keep.push(r);
        });
        gmSet(CFG.LOGKEY, keep);
        return dropped;
    }

    // 恢复上次导出的快照（下载失败或误删时合并回日志，按 id 去重）
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
        var text = backupAll();
        downloadText(text, 'pp5-exp-' + localDay() + '.json', 'application/json');
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

    // 控制台 + 油猴菜单
    window.__pp = {
        speculation: canSpec, mobile: MOB, limits: LIMITS, stats: stats, preds: preds,
        report: function () {
            var db = load(location.host), b = new Brain(db, Date.now, HL);
            var top = Object.keys(db.E).map(function (k) { var e = db.E[k], br = b.bright(e); return [k, +br.toFixed(2), b.tier(e, br), 'C' + e.confirm + '/X' + (+e.correct.toFixed(1))]; })
                .sort(function (x, y) { return y[1] - x[1]; }).slice(0, 10);
            var sites = gmGet(CFG.SITESKEY, []);
            return { 站点: location.host, 已登记站点: Array.isArray(sites) ? sites.length : 0, 本页命中预载: stats.served, 移动端: MOB, 预载上限: LIMITS, 轻触预取: Object.keys(stats.tapped).length, 待恢复: loadP().length, 维度权重: db.W, 门槛: db.th, 近期: db.hist, 日志行: getLog().length, 库前十: top };
        },
        reset: function () { gmSet(siteKey(location.host), {}); gmSet(pkey(location.host), []); },
        clearLog: function () { gmSet(CFG.LOGKEY, []); },
        exportLog: exportLog,
        restoreLastExport: restoreLastExport,
        backup: backupAll,
        importBackup: importBackup,
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
            GM_registerMenuCommand('重置本站学习库', function () { window.__pp.reset(); alert('已重置 ' + location.host); });
        }
    } catch (e) { /* ignore */ }
})();