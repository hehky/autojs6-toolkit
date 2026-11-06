/**
 * 通用定位点击器 v3（AutoJs6 · 任意 App）
 * 模式：
 *   ① 按文字/描述定位并点击（五级链）
 *   ② 坐标探测（点一下得坐标）
 *   ③ 录制（分步拾取）：点一步记一步 → 手动翻页 → 最后自动生成脚本代码
 * 录制产物：console 输出 + 脚本目录 recorded_<时间戳>.js
 */
(function () {
    var CONFIG = {
        text: "", desc: "", ids: [], neighborText: "", neighborDx: 160, neighborDy: 0,
        template: "", visionAsk: "", coord: null, autoTap: true, swipeFind: 0,
        texts: [],        // 同义组：["一键领取","查看更多","去领取"] 任一命中即可
        doneTexts: []     // 终态词：["已领取","明天再来","明日再来"] 命中即视为任务已完成，跳过点击
    };
    var VISION = { enabled: false, baseUrl: "", apiKey: "", model: "", timeoutMs: 15000 };
    var MAX_FAILS = 2;
    var MEM = {}, memPath = null;
    try { memPath = files.join(files.dirname(engines.myEngine().getSource()), ".apploc_mem.txt"); } catch (e) { }
    function loadMem() { try { if (memPath && files.exists(memPath)) MEM = JSON.parse(files.read(memPath)) || {}; } catch (e) { } }
    function saveMem() { try { if (memPath) files.write(memPath, JSON.stringify(MEM)); } catch (e) { } }
    function L(m) { console.log("[APP] " + m); }
    function toastS(m) { try { toast(m); } catch (e) { } }

    var cap = null;
    function ensureCapture() {
        if (cap === null) { try { cap = requestScreenCapture(false); } catch (e) { cap = false; } if (cap) sleep(400); }
        return cap === true;
    }

    // ================= 广告弹窗守卫 =================
    var SAFE_CLOSE = /^(关闭|关闭广告|跳过|跳过广告|略过|忽略|我知道了|知道了|以后再说|稍后再说|暂不|残忍拒绝|下次再说|不了|×|✕|X)$/;
    var DANGER = /(确定|确认|同意|允许|立即|马上|领取|开通|下载|安装|参与|抽奖|购买|去使用|立即使用|查看详情)/;
    var POPUP_BLACKLIST = {};   // 误触过的控件（id 或文本）永久拉黑
    var blPath = null;
    try { blPath = files.join(files.dirname(engines.myEngine().getSource()), ".popup_blacklist.txt"); } catch (e) { }
    function loadBL() { try { if (blPath && files.exists(blPath)) POPUP_BLACKLIST = JSON.parse(files.read(blPath)) || {}; } catch (e) { } }
    function saveBL() { try { if (blPath) files.write(blPath, JSON.stringify(POPUP_BLACKLIST)); } catch (e) { } }

    // 是否处于"弹窗态"：存在大面积可点层（遮罩）+ 其上有小控件
    function isPopupState() {
        var area = device.width * device.height;
        var cs = clickable(true).find();
        var hasMask = false, hasSmall = false;
        for (var i = 0; i < cs.length; i++) {
            try {
                var b = cs[i].bounds();
                var a = b.width() * b.height();
                if (a > area * 0.70) hasMask = true;
                if (a < area * 0.012 && a > 0) hasSmall = true;
                if (hasMask && hasSmall) return true;
            } catch (e) { }
        }
        // 无遮罩但有明确"跳过/关闭广告"字样也认（全屏广告常无遮罩）
        return !!(textMatches("^(跳过|跳过广告|关闭广告)$").findOnce() || descMatches("^(跳过|跳过广告|关闭广告)$").findOnce());
    }

    // 找一个"安全"的关闭钮；返回 UiObject 或 null
    function findCloseBtn() {
        var area = device.width * device.height;
        var cands = [];
        // 文本候选
        var ts = textMatches(".+").find();
        for (var i = 0; i < ts.length && i < 120; i++) cands.push(ts[i]);
        var ds = descMatches(".+").find();
        for (var j = 0; j < ds.length && j < 120; j++) cands.push(ds[j]);
        var best = null, bestScore = -1;
        for (var k = 0; k < cands.length; k++) {
            try {
                var w = cands[k];
                var tx = (w.text() || "") + "|" + (w.desc() || "");
                var idv = w.id() || "";
                var b = w.bounds();
                var a = b.width() * b.height();
                if (a <= 0 || a > area * 0.05) continue;          // 只认小控件
                if (POPUP_BLACKLIST[tx] || (idv && POPUP_BLACKLIST[idv])) continue;  // 黑名单
                if (DANGER.test(tx)) continue;                     // 危险词一律不点
                var isSafeText = SAFE_CLOSE.test((w.text() || w.desc() || "").trim());
                var isCloseId = /(close|dismiss|cancel|guanbi)/i.test(idv);
                if (!isSafeText && !isCloseId) continue;
                // 打分：安全文本 2 分；在四角 +1；id 命中 +1
                var score = 0;
                if (isSafeText) score += 2;
                if (isCloseId) score += 1;
                var cx = b.centerX(), cy = b.centerY();
                if (cx > device.width * 0.65 || cx < device.width * 0.35) score += 1;
                if (cy < device.height * 0.25 || cy > device.height * 0.75) score += 1;
                if (score > bestScore) { bestScore = score; best = w; }
            } catch (e) { }
        }
        return best;
    }

    // 误触检测：出现"确定关闭当前模块吗"→ 返回撤销 + 拉黑上次点的控件
    function rescueWrongClose(lastKey) {
        var w = textMatches(".*确定关闭.*|.*确认关闭.*").findOnce();
        if (w) {
            back();
            L("⚠ 误触模块关闭 → 已撤销");
            if (lastKey) { POPUP_BLACKLIST[lastKey] = 1; saveBL(); L("已拉黑: " + lastKey); }
            sleep(1200);
            return true;
        }
        return false;
    }

    // 主守卫：有弹窗就关，返回是否处理过
    function guardPopup(maxTry) {
        loadBL();
        var tries = maxTry || 2;
        for (var t = 0; t < tries; t++) {
            if (!isPopupState()) return false;
            var btn = findCloseBtn();
            if (btn) {
                var key = (btn.text() || "") + "|" + (btn.desc() || "") + "|" + (btn.id() || "");
                var b = btn.bounds();
                click(b.centerX(), b.centerY());
                L("关弹窗: " + key + " @" + Math.round(b.centerX()) + "," + Math.round(b.centerY()));
                sleep(1500);
                if (rescueWrongClose(key)) continue;
            } else {
                L("弹窗态但无安全关闭钮 → 按返回");
                back();
                sleep(1500);
                if (rescueWrongClose(null)) continue;
            }
            if (!isPopupState()) return true;
        }
        return true;
    }

    // ===== 五级定位 =====
    function lCoord(s) { return (s.coord && s.coord.length === 2) ? { x: s.coord[0], y: s.coord[1], by: "L-COORD" } : null; }
    function l0(s) {
        var w = null;
        // 同义组优先：任一别名命中即算命中
        var cands = (s.texts && s.texts.length) ? s.texts : (s.text ? [s.text] : []);
        for (var c = 0; c < cands.length && !w; c++) {
            w = textMatches(cands[c]).findOnce();
            if (!w) w = descMatches(cands[c]).findOnce();
        }
        if (!w && s.desc) { w = descMatches(s.desc).findOnce(); if (!w) w = textMatches(s.desc).findOnce(); }
        if (w) { var b = w.bounds(); return { x: b.centerX(), y: b.centerY(), by: "L0-text:" + (w.text() || w.desc()) }; }
        return null;
    }
    function l1(s) {
        if (s.ids) for (var i = 0; i < s.ids.length; i++) {
            var w = idMatches(s.ids[i]).findOnce();
            if (w) { var b = w.bounds(); return { x: b.centerX(), y: b.centerY(), by: "L1-id" }; }
        }
        return null;
    }
    function l2(s) {
        if (!s.neighborText) return null;
        var w = textMatches(s.neighborText).findOnce();
        if (!w) w = descMatches(s.neighborText).findOnce();
        if (!w) return null;
        var b = w.bounds();
        var x = b.right + (s.neighborDx || 0), y = b.centerY() + (s.neighborDy || 0);
        if (x < 0 || x > device.width || y < 0 || y > device.height) return null;
        return { x: x, y: y, by: "L2-neighbor" };
    }
    function l3(s) {
        if (!s.template || !files.exists(s.template)) return null;
        try {
            if (!ensureCapture()) return null;
            var scr = captureScreen(), tpl = images.read(s.template);
            var p = images.findImage(scr, tpl, { threshold: 0.8 });
            tpl.recycle(); scr.recycle();
            if (p) return { x: p.x, y: p.y, by: "L3-template" };
        } catch (e) { }
        return null;
    }
    function l4(s) {
        if (!VISION.enabled || !VISION.baseUrl || !s.visionAsk) return null;
        try {
            if (!ensureCapture()) return null;
            var img = captureScreen(), iw = img.getWidth(), ih = img.getHeight();
            var b64 = images.toBase64(img, "jpeg", 80); img.recycle();
            var res = http.postJson(VISION.baseUrl, {
                model: VISION.model,
                messages: [{ role: "user", content: [
                    { type: "text", text: "截图尺寸 " + iw + "x" + ih + "。找到【" + s.visionAsk + "】，只返回 JSON：{\"nx\":0到1,\"ny\":0到1,\"found\":true}，找不到返回{\"found\":false}。" },
                    { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64 } }
                ] }], max_tokens: 100
            }, { headers: { "Authorization": "Bearer " + VISION.apiKey, "Content-Type": "application/json" }, timeout: VISION.timeoutMs });
            if (res.statusCode !== 200) return null;
            var m = res.body.string().match(/\{[\s\S]*?found[\s\S]*?\}/);
            if (!m) return null;
            var o = JSON.parse(m[0]);
            if (o.found && o.nx != null) return { x: Math.round(o.nx * device.width), y: Math.round(o.ny * device.height), by: "L4-vision" };
        } catch (e) { }
        return null;
    }
    function locate(s) {
        loadMem();
        var key = "k_" + (s.name || s.text || s.desc || s.visionAsk || "t");
        var order = ["L-COORD", "L0", "L1", "L2", "L3", "L4"];
        var mem = MEM[key];
        if (typeof mem === "string") mem = { lv: mem, fails: 0 };
        if (mem && mem.lv && s.coord == null) {
            order = [mem.lv].concat(order.filter(function (v) { return v !== mem.lv; }));
            L("记忆: 优先 " + mem.lv + "（失手 " + mem.fails + "/" + MAX_FAILS + "）");
        }
        for (var i = 0; i < order.length; i++) {
            var r = null;
            if (order[i] === "L-COORD") r = lCoord(s);
            else if (order[i] === "L0") r = l0(s);
            else if (order[i] === "L1") r = l1(s);
            else if (order[i] === "L2") r = l2(s);
            else if (order[i] === "L3") r = l3(s);
            else if (order[i] === "L4") r = l4(s);
            if (r) {
                L("命中 " + r.by + " → " + Math.round(r.x) + "," + Math.round(r.y));
                MEM[key] = { lv: order[i], fails: 0 }; saveMem();
                return { ok: true, x: Math.round(r.x), y: Math.round(r.y), by: r.by };
            }
            if (mem && mem.lv === order[i]) {
                mem.fails++;
                L("记忆级 " + order[i] + " 失手 " + mem.fails + "/" + MAX_FAILS);
                if (mem.fails >= MAX_FAILS) { L("撤销记忆"); delete MEM[key]; mem = null; }
                saveMem();
            }
        }
        return { ok: false };
    }

    // ===== 坐标捕获（非阻塞版：UI 线程内绝不 sleep）=====
    // onGot(x, y) 在 UI 线程回调：只做轻活；重活由调用方扔子线程
    function captureOnceAsync(onGot) {
        var W = device.width, H = device.height, win;
        try {
            win = floaty.window(
                '<frame w="' + W + '" h="' + H + '" bg="#15000000"><text id="t" text="点一下目标" textColor="#FFFFFF" textSize="16sp" gravity="center" w="' + W + '" h="' + H + '"/></frame>'
            );
            win.setPosition(0, 0); win.setSize(W, H);
        } catch (e) { L("悬浮窗不可用"); return false; }
        var done = false;
        win.t.setOnTouchListener(function (v, e) {
            if (!done && e.getAction() === android.view.MotionEvent.ACTION_DOWN) {
                done = true;
                var x = Math.round(e.getRawX()), y = Math.round(e.getRawY());
                try { win.setSize(1, 1); win.setPosition(-200, -200); } catch (er) { }   // UI 操作，无 sleep
                setTimeout(function () { try { win.close(); } catch (er) { } }, 250);
                if (onGot) onGot(x, y);
            }
            return true;
        });
        return true;
    }

    // ===== 坐标反查控件身份 =====
    function infoAt(x, y) {
        var best = null, bestArea = 1e18;
        var pools = [clickable(true).find(), textMatches(".+").find(), descMatches(".+").find()];
        for (var p = 0; p < pools.length; p++) {
            var arr = pools[p];
            for (var i = 0; i < arr.length; i++) {
                try {
                    var b = arr[i].bounds();
                    if (b.width() <= 0 || b.height() <= 0) continue;
                    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
                        var a = b.width() * b.height();
                        if (a < bestArea) {
                            bestArea = a;
                            best = { text: arr[i].text() || "", desc: arr[i].desc() || "", id: arr[i].id() || "", cls: (arr[i].className() || "").split(".").pop() };
                        }
                    }
                } catch (e) { }
            }
        }
        return best;
    }

    // ===== 生成脚本代码（纯函数，便于测试）=====
    function genStepCode(step, idx) {
        var x = step.x, y = step.y, info = step.info || {};
        var t = "// 第" + (idx + 1) + "步";
        var body = "";
        if (info.text && info.text.length <= 20) {
            body = 'var w = textMatches("' + info.text.replace(/"/g, '\\"') + '").findOnce(); if (w) { var b = w.bounds(); click(b.centerX(), b.centerY()); } else { click(' + x + ',' + y + '); }';
        } else if (info.desc && info.desc.length <= 20) {
            body = 'var w = descMatches("' + info.desc.replace(/"/g, '\\"') + '").findOnce(); if (w) { var b = w.bounds(); click(b.centerX(), b.centerY()); } else { click(' + x + ',' + y + '); }';
        } else {
            body = 'click(' + x + ',' + y + ');   // 无文字锚点，坐标点击' + (info.cls ? " [" + info.cls + "]" : "");
        }
        return t + "\nsleep(2000);\n" + body + "\n";
    }
    function genCode(steps) {
        var head = "/**\n * 录制生成脚本（" + new Date().toLocaleString() + "）\n * 共 " + steps.length + " 步；文字锚优先，无文字退回坐标\n */\n(function () {\n    auto.waitFor();\n";
        var body = "";
        for (var i = 0; i < steps.length; i++) body += genStepCode(steps[i], i) + "\n";
        return head + body + "})();\n";
    }

    // ===== 模式③ 录制（点球记一步，长按结束；全程无对话框，不干扰页面操作）=====
    function recordMode() {
        var steps = [];
        var ball;
        try {
            ball = floaty.window(
                '<frame w="52" h="52"><text id="t" text="REC" textColor="#FFFFFF" textSize="12sp" gravity="center" bg="#CCE53935" w="52" h="52"/></frame>'
            );
        } catch (e) { L("悬浮窗不可用（需悬浮窗权限）: " + e); toastS("请开悬浮窗权限"); return; }
        ball.setPosition(device.width - 78, Math.round(device.height * 0.32));
        L("录制就绪：点 REC = 录一步；长按 REC = 结束并生成脚本");
        toastS("点REC录一步，长按REC结束");

        var downT = 0, lp = null, busy = false;

        function recordOne() {
            if (busy) return;
            busy = true;
            L("请点第 " + (steps.length + 1) + " 步目标");
            toastS("点第 " + (steps.length + 1) + " 步目标");
            var ok = captureOnceAsync(function (x, y) {
                threads.start(function () {          // 子线程：sleep / 读控件树都合法
                    sleep(400);
                    var info = infoAt(x, y);
                    steps.push({ x: x, y: y, info: info });
                    var nm = info ? (info.text || info.desc || ("[" + (info.cls || "无字") + "]")) : "[空]";
                    L("第" + steps.length + "步: " + x + "," + y + " 锚=" + nm);
                    toastS("已记第" + steps.length + "步: " + nm);
                    busy = false;
                });
            });
            if (!ok) busy = false;
        }

        function finish() {
            try { ball.close(); } catch (e) { }
            if (steps.length === 0) { L("未录到任何步骤"); exit(); }
            var code = genCode(steps);
            L("===== 生成代码 =====\n" + code);
            try {
                var out = files.join(files.dirname(engines.myEngine().getSource()), "recorded_" + new Date().getTime() + ".js");
                files.write(out, code);
                L("已保存: " + out);
                toastS("已保存 " + steps.length + " 步脚本");
            } catch (e) {
                L("保存失败（代码见 console）: " + e);
                toastS("保存失败，代码在 console");
            }
            exit();
        }

        ball.t.setOnTouchListener(function (v, e) {
            var act = e.getAction();
            if (act === android.view.MotionEvent.ACTION_DOWN) {
                downT = Date.now();
                lp = setTimeout(function () { lp = null; finish(); }, 1200);
                return true;
            }
            if (act === android.view.MotionEvent.ACTION_UP) {
                if (lp) { clearTimeout(lp); lp = null; }
                if (Date.now() - downT < 900) setTimeout(recordOne, 60);   // 短按=录一步（延迟出事件栈，避免在触摸事件里建窗）
                return true;
            }
            return false;
        });

        setInterval(function () { }, 1000);   // 保活
    }

    // ===== 入口 =====
    auto.waitFor();
    var mode = dialogs.select("选择模式", ["① 按文字/描述定位并点击", "② 坐标探测（记坐标）", "③ 录制（分步拾取→生成脚本）"]);
    if (mode === 1) {
        captureOnceAsync(function (x, y) {
            L("【探测坐标】 " + x + ", " + y);
            toastS("坐标: " + x + ", " + y);
        });
        setInterval(function () { }, 1000);   // 主线程保活
        return;
    }
    if (mode === 2) { recordMode(); return; }
    if (mode !== 0) { L("已取消"); return; }

    var spec = {
        text: CONFIG.text, texts: CONFIG.texts, desc: CONFIG.desc, ids: CONFIG.ids,
        neighborText: CONFIG.neighborText, neighborDx: CONFIG.neighborDx, neighborDy: CONFIG.neighborDy,
        template: CONFIG.template, visionAsk: CONFIG.visionAsk, coord: CONFIG.coord,
        name: CONFIG.text || (CONFIG.texts && CONFIG.texts.join("|")) || CONFIG.desc || "target"
    };
    if (!spec.text && !(spec.texts && spec.texts.length) && !spec.desc && !spec.neighborText && !spec.visionAsk && !spec.coord) {
        var q = dialogs.rawInput("要定位什么？（多个同义写法用 | 分隔，如：一键领取|查看更多）", "");
        if (!q) { L("未输入，退出"); exit(); }
        if (q.indexOf("|") >= 0) { spec.texts = q.split("|"); spec.text = ""; }
        else { spec.text = q; }
        spec.desc = q; spec.visionAsk = q.split("|")[0]; spec.name = q;
    }
    L("目标: " + spec.name + " | 界面: " + currentPackage());

    // ===== 幂等：先看是否已是完成态（终态词命中则跳过点击）=====
    var doneList = CONFIG.doneTexts || [];
    for (var di = 0; di < doneList.length; di++) {
        var dw = textMatches(doneList[di]).findOnce() || descMatches(doneList[di]).findOnce();
        if (dw) {
            L("已处于完成态（命中「" + doneList[di] + "」），跳过点击");
            toastS("已完成，无需操作");
            return;
        }
    }
    var res = { ok: false };
    var rounds = (CONFIG.swipeFind || 0) + 1;
    for (var k = 0; k < rounds; k++) {
        guardPopup(2);            // 每轮先清弹窗（无弹窗则立即返回）
        res = locate(spec);
        if (res.ok) break;
        if (k < rounds - 1) {
            L("未找到，下滑 " + (k + 1));
            swipe(device.width / 2, device.height * 0.75, device.width / 2, device.height * 0.30, 500);
            sleep(2000);
        }
    }
    guardPopup(1);                // 点击前再清一次（防点击瞬间弹窗遮挡）
    if (res.ok) {
        if (CONFIG.autoTap) { click(res.x, res.y); L("已点击 " + res.x + "," + res.y + "（" + res.by + "）"); }
        toastS("定位成功: " + res.x + ", " + res.y);
    } else {
        L("未找到目标: " + spec.name);
        toastS("未找到: " + spec.name);
    }
})();
