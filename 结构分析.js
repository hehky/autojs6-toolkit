/**
 * analyze_view.js — 全屏控件树导出器 v2（AutoJs6 / Rhino）
 *
 * 用法
 *   1. 手机装 AutoJs6，打开无障碍：设置 → 无障碍 → AutoJs6 → 开启。
 *   2. 本文件整段复制，在 AutoJs6 里新建脚本粘贴保存（或导入 .js）。
 *   3. 打开目标 App，停在要分析的界面，切回 AutoJs6 运行本脚本。
 *   4. 首次运行弹菜单，选采集模式，默认第 1 项（全屏 + 全部窗口 + 滚动采集）。
 *   5. 跑完看控制台：会打印环境头、前若干条节点、以及落盘路径。
 *      给 AI 就交 view_tree_<时间戳>.txt，给程序就交同名 .json。
 *
 * 权限
 *   必须：无障碍服务。没开时脚本不会静默失败，会输出「缺无障碍」的诊断文件并提示。
 *   可选：存储权限。没有就逐级降级：脚本目录 → /sdcard/ViewTreeDump →
 *         /sdcard/Download/ViewTreeDump → App 外部私有目录 → 全失败则打到控制台。
 *   不需要：悬浮窗、root、shell、任何第三方库。
 *
 * 菜单
 *   1 全屏 · 全部窗口 · 含滚动采集（推荐）
 *   2 全屏 · 全部窗口 · 不滚动（快，约 1 秒）
 *   3 全屏 · 仅活动窗口 · 含滚动
 *   4 全屏 · 全部窗口 · 含滚动 · 不跳过不可见节点
 *   5 同 1，另存一份 JSON（给程序用）
 *   6 关键词定位（当前屏按文字/描述/正则找按钮，直接给 tap 坐标）
 *   7 状态对比（快照 → 8 秒内做一次点击 → 自动 diff 新增/消失/移动）
 *   取消（返回键）= 按 1 跑
 *
 * 输出
 *   序号_时分秒_应用名.txt   一行一个节点的紧凑文本，给 AI 读，省 token
 *   默认每次只生成这一个文件；菜单选 5 才额外生成同名 .json
 *   目录自动清理：只保留最近 10 份输出（含旧版 view_tree_* 也会被清掉）
 *
 * 说明：坐标单位是像素，dp 由 density 换算；bounds 为屏幕绝对坐标，
 * 横竖屏切换后以输出里的 rotation 为准，不要跨 rotation 复用旧坐标。
 */

importClass(android.graphics.Rect);
importClass(android.graphics.Point);

var CFG = {
    VERSION: "2.0",
    MAX_NODES: 3000,          // 收录上限（超出即截断，但继续统计总数）
    MAX_VISIT: 20000,         // 遍历硬上限，防止异常树卡死
    MAX_TEXT: 160,            // 单节点 text 保留字符数
    MAX_DESC: 120,
    MAX_PAGES: 8,             // 单容器最多翻页次数
    MAX_SCROLL_CONTAINERS: 3,
    SCROLL_SETTLE_MS: 500,
    RESTORE_SCROLL: true,
    INCLUDE_INVISIBLE: true,
    SKIP_EMPTY_BOUNDS: true,
    DEDUPE_GLOBAL: false,
    MENU: true,
    CONSOLE_LINES: 60,
    WITH_JSON: false,        // 菜单选 5 才输出 JSON
    KEEP_FILES: 10           // 目录里最多保留最近 N 份 view_ 开头的输出，旧的自动删除
};

var RUN = {};   // 运行期状态

// 通用动作词表（中英文常见按钮文案），用于"伪可点"启发标记 act
var ACT_WORD_RE = new RegExp(
    "领取|查看|更多|立即|马上|一键|点击|进入|打开|详情|签到|兑换|换购|抢购?" +
    "|入口|前往|去[领看用逛买]|已?领取|完成|继续|确定|确认|同意|跳过|关闭|取消" +
    "|claim|view ?more|open|enter|get now|go to|skip|close|confirm|accept|check ?in", "i");

/* ============================ 基础工具 ============================ */

function L(m) { try { console.log(m); } catch (e) { } }

function nowMs() { return new Date().getTime(); }

function pad2(n) { return n < 10 ? "0" + n : "" + n; }

function fmtTime(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
        pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function fmtStamp(d) {
    return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "_" +
        pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

// 统一的安全取值：任何异常都降级成默认值，绝不中断采集
function safeGet(fn, dflt) {
    try {
        var v = fn();
        if (v === undefined || v === null) return dflt;
        return v;
    } catch (e) {
        return dflt;
    }
}

function S(v) {
    if (v === undefined || v === null) return "";
    try { return String(v); } catch (e) { return ""; }
}

function round2(v) {
    try { return Math.round(v * 100) / 100; } catch (e) { return 0; }
}

function cut(str, max) {
    if (!str) return "";
    str = S(str).replace(/\s+/g, " ").replace(/"/g, "'");
    if (str.length <= max) return str;
    return str.substring(0, max) + "…";
}

function shortClass(full) {
    if (!full) return "";
    var i = full.lastIndexOf(".");
    return i >= 0 ? full.substring(i + 1) : full;
}

function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) & 0x7fffffff;
    }
    return h;
}

function fx(v) { return (v === null || v === undefined || v < 0) ? "?" : String(v); }

function sleepSafe(ms) { try { sleep(ms); } catch (e) { } }

/* ============================ 前置检查 ============================ */

function checkAccessibility() {
    var a = { ok: false, waited: false, service: "", canRetrieveWindowContent: false, hint: "", error: "" };
    var svc = null;
    try { svc = auto.service; } catch (e) { a.error = String(e); }
    if (svc == null) {
        a.waited = true;
        try { toast("未检测到无障碍服务，等待开启…"); } catch (e) { }
        try { auto.waitFor(); } catch (e) { if (!a.error) a.error = String(e); }
        try { svc = auto.service; } catch (e) { }
    }
    if (svc == null) {
        a.ok = false;
        a.hint = "缺无障碍服务：设置 → 无障碍 → AutoJs6 打开后重新运行";
        return a;
    }
    a.ok = true;
    a.service = safeGet(function () {
        var si = svc.getServiceInfo();
        if (si == null) return "";
        return S(si.packageName) + "/" + S(si.name);
    }, "");
    a.canRetrieveWindowContent = safeGet(function () { return svc.canRetrieveWindowContent(); }, false);
    if (!a.canRetrieveWindowContent) {
        a.hint = "无障碍已开但无法读取窗口内容，节点可能为空";
    }
    // 诊断 FLAG_RETRIEVE_INTERACTIVE_WINDOWS(0x2)：缺失时 getWindows() 会漏掉/清空应用窗口
    a.flags = safeGet(function () {
        var si = svc.getServiceInfo();
        return si == null ? -1 : (si.flags >>> 0);
    }, -1);
    a.retrieveInteractiveWindows = (a.flags & 2) !== 0;
    if (a.flags >= 0 && !a.retrieveInteractiveWindows && !a.hint) {
        a.hint = "无障碍缺少 FLAG_RETRIEVE_INTERACTIVE_WINDOWS(0x2)，应用窗口可能读不到，需重新开启无障碍";
    }
    return a;
}

function checkFloaty() {
    var f = { available: false, granted: null, note: "本脚本不需要悬浮窗，仅记录状态" };
    try {
        if (typeof floaty !== "undefined" && floaty) {
            f.available = true;
            f.granted = safeGet(function () { return floaty.checkPermission(); }, null);
            if (f.granted === false) f.note = "悬浮窗未授权；本脚本不需要它，但 toolkit 里的取坐标/录制需要";
        }
    } catch (e) { }
    return f;
}

/* ============================ 环境信息 ============================ */

function collectEnvironment() {
    var e = {};
    e.autojsVersion = S(safeGet(function () { return app.autojs.versionName; }, "")) ||
        S(safeGet(function () { return app.versionName; }, ""));
    e.autojsVersionCode = safeGet(function () { return app.autojs.versionCode; }, -1);
    e.autojsPackage = S(safeGet(function () { return app.packageName; }, ""));
    e.androidRelease = S(safeGet(function () { return device.release; }, ""));
    e.sdkInt = safeGet(function () { return device.sdkInt; }, -1);
    e.brand = S(safeGet(function () { return device.brand; }, ""));
    e.model = S(safeGet(function () { return device.model; }, ""));
    e.product = S(safeGet(function () { return device.product; }, ""));
    e.hardware = S(safeGet(function () { return device.hardware; }, ""));
    e.rhino = S(safeGet(function () { return java.lang.System.getProperty("java.vm.version"); }, ""));
    return e;
}

function collectScreen() {
    var s = {
        density: 0, scaledDensity: 0, dpi: 0,
        appWidth: 0, appHeight: 0, realWidth: 0, realHeight: 0,
        deviceWidth: 0, deviceHeight: 0,
        rotation: -1, rotationDeg: -1, orientation: "",
        dpWidth: 0, dpHeight: 0, source: ""
    };
    s.deviceWidth = safeGet(function () { return device.width; }, 0);
    s.deviceHeight = safeGet(function () { return device.height; }, 0);

    try {
        var m = context.getResources().getDisplayMetrics();
        s.density = round2(m.density);
        s.scaledDensity = round2(m.scaledDensity);
        s.dpi = m.densityDpi;
        s.appWidth = m.widthPixels;
        s.appHeight = m.heightPixels;
        s.source = "DisplayMetrics";
    } catch (e) { }

    try {
        var wm = context.getSystemService("window");
        var disp = wm.getDefaultDisplay();
        var p1 = new Point();
        try { disp.getSize(p1); s.appWidth = p1.x; s.appHeight = p1.y; } catch (e2) { }
        if (safeGet(function () { return device.sdkInt; }, 0) >= 17) {
            var p2 = new Point();
            try { disp.getRealSize(p2); s.realWidth = p2.x; s.realHeight = p2.y; } catch (e3) { }
        }
        try { s.rotation = disp.getRotation(); } catch (e4) { }
    } catch (e) { }

    if (!s.appWidth) s.appWidth = s.deviceWidth;
    if (!s.appHeight) s.appHeight = s.deviceHeight;
    if (!s.realWidth) s.realWidth = s.appWidth;
    if (!s.realHeight) s.realHeight = s.appHeight;
    if (s.rotation >= 0) s.rotationDeg = s.rotation * 90;
    s.orientation = (s.appWidth > s.appHeight) ? "landscape" : "portrait";
    if (s.density > 0) {
        s.dpWidth = Math.round(s.appWidth / s.density);
        s.dpHeight = Math.round(s.appHeight / s.density);
    }
    return s;
}

function dimenPx(name) {
    return safeGet(function () {
        var res = context.getResources();
        var id = res.getIdentifier(name, "dimen", "android");
        if (!id || id <= 0) return -1;
        return res.getDimensionPixelSize(id);
    }, -1);
}

function collectBars(screen, windows) {
    var b = {
        statusBar: dimenPx("status_bar_height"),
        navBar: -1, navBarSource: "", navBarWidth: -1,
        ime: -1, imeSource: "", gestureNav: false
    };
    var navName = (screen.orientation === "landscape") ? "navigation_bar_height_landscape" : "navigation_bar_height";
    b.navBar = dimenPx(navName);
    if (b.navBar > 0) b.navBarSource = navName;
    if (b.navBar <= 0) {
        b.navBar = dimenPx("navigation_bar_height");
        if (b.navBar > 0) b.navBarSource = "navigation_bar_height";
    }
    b.navBarWidth = dimenPx("navigation_bar_width");
    if (b.navBar > 0 && b.navBar < 20) b.gestureNav = true;

    // 输入法高度优先取 IME 窗口本身的 bounds（最准）
    for (var i = 0; i < windows.length; i++) {
        if (windows[i].type === 2 && windows[i].bounds) {
            var h = windows[i].bounds[3] - windows[i].bounds[1];
            if (h > 0) {
                b.ime = h;
                b.imeSource = "IME 窗口 bounds";
                break;
            }
        }
    }
    if (b.ime < 0 && screen.realHeight > 0 && screen.appHeight > 0) {
        var est = screen.realHeight - screen.appHeight - (b.navBar > 0 ? b.navBar : 0);
        if (est > 0 && est < Math.round(screen.realHeight * 0.6)) {
            b.ime = est;
            b.imeSource = "估算（物理高 - 应用区 - 导航栏）";
        }
    }
    if (b.ime < 0) b.imeSource = "无键盘窗口，按 0 处理";
    return b;
}

/* ============================ 窗口枚举 ============================ */

function windowTypeName(t) {
    var map = {
        1: "APPLICATION",
        2: "INPUT_METHOD",
        3: "SYSTEM",
        4: "ACCESSIBILITY_OVERLAY",
        5: "SPLIT_SCREEN_DIVIDER",
        6: "MAGNIFICATION_OVERLAY"
    };
    if (t >= 1 && t <= 6) return map[t];
    return "TYPE_" + t;
}

function rawWindows() {
    var list = [];
    var svc = safeGet(function () { return auto.service; }, null);
    if (svc == null) return list;
    var wins = safeGet(function () { return svc.getWindows(); }, null);
    if (wins == null) return list;
    var n = safeGet(function () { return wins.size(); }, 0);
    for (var i = 0; i < n; i++) {
        var w = safeGet(function () { return wins.get(i); }, null);
        if (w != null) list.push(w);
    }
    return list;
}

function windowMeta(w, idx) {
    var m = {
        index: idx, id: -1, type: -1, typeName: "", layer: -1,
        active: false, focused: false, bounds: null,
        root: null, rootNull: true, pkg: "", title: "", synthetic: false
    };
    m.id = safeGet(function () { return w.getId(); }, -1);
    m.type = safeGet(function () { return w.getType(); }, -1);
    m.typeName = windowTypeName(m.type);
    m.layer = safeGet(function () { return w.getLayer(); }, -1);
    m.active = safeGet(function () { return w.isActive(); }, false);
    m.focused = safeGet(function () { return w.isFocused(); }, false);
    if (safeGet(function () { return device.sdkInt; }, 0) >= 24) {
        try {
            var r = new Rect();
            w.getBoundsInScreen(r);
            m.bounds = [r.left, r.top, r.right, r.bottom];
        } catch (e) { }
    }
    m.root = safeGet(function () { return w.getRoot(); }, null);
    m.rootNull = (m.root == null);
    if (m.root != null) {
        m.pkg = S(safeGet(function () { return m.root.getPackageName(); }, ""));
        m.title = S(safeGet(function () { return w.getTitle(); }, ""));
    }
    return m;
}

// 只读诊断 FLAG_RETRIEVE_INTERACTIVE_WINDOWS(0x2)。
// 注意：不再调用 setServiceInfo 写回——实测在 ColorOS 等设备上会打断无障碍连接，
// 导致后续所有探测为空、脚本卡在 auto.waitFor()。缺标志时请手动重开无障碍开关。
function forceInteractiveWindowsFlag() {
    var svc = safeGet(function () { return auto.service; }, null);
    if (svc == null) return;
    var si = safeGet(function () { return svc.getServiceInfo(); }, null);
    if (si == null) return;
    var before = safeGet(function () { return si.flags >>> 0; }, -1);
    if (before < 0 || (before & 2) !== 0) return;
    RUN.notes.push("无障碍缺少 FLAG_RETRIEVE_INTERACTIVE_WINDOWS(0x2)，应用窗口可能读不到；请手动关闭再打开 AutoJs6 无障碍开关（脚本不再自动写回，避免打断服务）");
}

function collectWindowMetas() {
    var list = [];
    forceInteractiveWindowsFlag();
    var raws = rawWindows();
    for (var i = 0; i < raws.length; i++) list.push(windowMeta(raws[i], i));

    // 某些机型/版本拿不到 getWindows()，退化到活动窗口
    if (list.length === 0) {
        var r = safeGet(function () { return auto.service.getRootInActiveWindow(); }, null);
        if (r != null) {
            list.push({
                index: 0, id: -1, type: 1, typeName: "APPLICATION(推定)", layer: -1,
                active: true, focused: true, bounds: null, root: r, rootNull: false,
                pkg: S(safeGet(function () { return r.getPackageName(); }, "")),
                title: "", synthetic: true
            });
            RUN.notes.push("getWindows() 不可用，已退化为 lookup 活动窗口");
        }
        return list;
    }

    // 兜底二：getWindows() 有结果，但当前应用窗口缺席、或 root 为空
    //（ColorOS 等常见：应用窗口列出来了但 getRoot() 返回 null），
    // 再用 getRootInActiveWindow() 单独取一次活动窗口的树
    var curPkg = S(safeGet(function () { return currentPackage(); }, ""));
    var appCovered = false;
    for (var j = 0; j < list.length; j++) {
        if (!list[j].rootNull && (!curPkg || list[j].pkg === curPkg)) { appCovered = true; break; }
    }
    if (!appCovered && curPkg) {
        // 标志位写回可能异步生效：稍等后重新枚举一次窗口
        sleep(600);
        var raws2 = rawWindows();
        if (raws2.length > 0) {
            var list2 = [];
            for (var t = 0; t < raws2.length; t++) list2.push(windowMeta(raws2[t], t));
            for (var u = 0; u < list2.length; u++) {
                if (!list2[u].rootNull && list2[u].pkg === curPkg) {
                    list = list2;
                    appCovered = true;
                    RUN.notes.push("重举窗口后已拿到应用窗口(" + curPkg + ")");
                    break;
                }
            }
        }
    }
    if (!appCovered && curPkg) {
        var r2 = safeGet(function () { return auto.service.getRootInActiveWindow(); }, null);
        if (r2 != null) {
            var p2 = S(safeGet(function () { return r2.getPackageName(); }, ""));
            var dup = false;
            for (var q = 0; q < list.length; q++) if (!list[q].rootNull && list[q].pkg === p2) dup = true;
            if (!dup) {
                list.push({
                    index: list.length, id: -1, type: 1, typeName: "APPLICATION(兜底)", layer: -1,
                    active: true, focused: true, bounds: null, root: r2, rootNull: false,
                    pkg: p2, title: "", synthetic: true
                });
                RUN.notes.push("getWindows() 未含当前应用窗口(" + curPkg + ")或其 root 为空，已用 getRootInActiveWindow() 兜底补采");
            }
        } else {
            RUN.notes.push("当前应用窗口(" + curPkg + ")root 为空且兜底失败：可能被 FLAG_SECURE 保护，或无障碍缺少 FLAG_RETRIEVE_INTERACTIVE_WINDOWS");
        }
    }
    return list;
}

/* ============================ 节点记录 ============================ */

var ACTION_BITS = {
    click: 16,
    longClick: 32,
    focus: 1,
    accessibilityFocus: 64,
    scrollForward: 4096,
    scrollBackward: 8192,
    expand: 262144,
    collapse: 524288,
    setText: 2097152
};

function nodeActions(node) {
    var acts = safeGet(function () { return node.getActions(); }, 0);
    var out = [];
    for (var k in ACTION_BITS) {
        if ((acts & ACTION_BITS[k]) !== 0) out.push(k);
    }
    return out;
}

function boundsOf(node) {
    var r = new Rect();
    try { node.getBoundsInScreen(r); return [r.left, r.top, r.right, r.bottom]; } catch (e) { }
    try { node.getBoundsInParent(r); return [r.left, r.top, r.right, r.bottom]; } catch (e2) { }
    return null;
}

function nodeRecord(node, depth, path, win, density) {
    var rec = {};
    rec.windowId = win.id;
    rec.windowIndex = win.index;
    rec.depth = depth;
    rec.path = path;

    var clsFull = S(safeGet(function () { return node.getClassName(); }, ""));
    rec.classNameFull = clsFull;
    rec.className = shortClass(clsFull);
    rec.packageName = S(safeGet(function () { return node.getPackageName(); }, ""));
    rec.id = S(safeGet(function () { return node.getViewIdResourceName(); }, ""));

    var rawText = S(safeGet(function () { return node.getText(); }, ""));
    var rawDesc = S(safeGet(function () { return node.getContentDescription(); }, ""));
    rec.text = cut(rawText, CFG.MAX_TEXT);
    rec.textLen = rawText.length;
    rec.desc = cut(rawDesc, CFG.MAX_DESC);
    rec.descLen = rawDesc.length;

    rec.bounds = boundsOf(node);
    if (rec.bounds) {
        var l = rec.bounds[0], t = rec.bounds[1], rr = rec.bounds[2], bb = rec.bounds[3];
        rec.size = [rr - l, bb - t];
        rec.center = [Math.round((l + rr) / 2), Math.round((t + bb) / 2)];
        if (density > 0) {
            rec.boundsDp = [Math.round(l / density), Math.round(t / density), Math.round(rr / density), Math.round(bb / density)];
            rec.centerDp = [Math.round(rec.center[0] / density), Math.round(rec.center[1] / density)];
        }
    } else {
        rec.size = null;
        rec.center = null;
        rec.boundsDp = null;
        rec.centerDp = null;
    }

    rec.clickable = safeGet(function () { return node.isClickable(); }, false);
    rec.longClickable = safeGet(function () { return node.isLongClickable(); }, false);
    rec.checkable = safeGet(function () { return node.isCheckable(); }, false);
    rec.checked = safeGet(function () { return node.isChecked(); }, false);
    rec.enabled = safeGet(function () { return node.isEnabled(); }, false);
    rec.selected = safeGet(function () { return node.isSelected(); }, false);
    rec.focused = safeGet(function () { return node.isFocused(); }, false);
    rec.focusable = safeGet(function () { return node.isFocusable(); }, false);
    rec.scrollable = safeGet(function () { return node.isScrollable(); }, false);
    rec.editable = safeGet(function () { return node.isEditable(); }, false);
    rec.visible = safeGet(function () { return node.isVisibleToUser(); }, true);
    rec.accessibilityFocused = safeGet(function () { return node.isAccessibilityFocused(); }, false);
    rec.childCount = safeGet(function () { return node.getChildCount(); }, 0);
    rec.actions = nodeActions(node);

    var lowCls = clsFull.toLowerCase();
    rec.webview = (lowCls.indexOf("webview") >= 0 || lowCls.indexOf("chromium") >= 0);
    rec.password = safeGet(function () { return node.isPassword(); }, false);
    rec.page = 1;

    // 通用"伪可点"启发：H5/自绘控件经常不带 clickable 标志，
    // 但文本/描述里含动作词。命中则标 act，供人工/AI 判断"大概率可点"。
    rec.actionHint = false;
    if (!rec.clickable && (rec.text || rec.desc)) {
        rec.actionHint = ACT_WORD_RE.test(rec.text + "|" + rec.desc);
    }
    return rec;
}

function dedupeKey(rec) {
    // 类名 + 边界 + 文本 + 描述；索引路径参与去重会让去重失效（路径本身唯一），
    // 所以只对「父子重复报同一控件」这种情况合并：见 walk() 里的祖先比对。
    var b = rec.bounds ? rec.bounds.join(",") : "nob";
    return rec.className + "|" + b + "|" + rec.text + "|" + rec.desc;
}

/* ============================ 树遍历 ============================ */

function newAcc() {
    return {
        nodes: [],
        total: 0,
        stored: 0,
        visit: 0,
        visitHit: false,
        truncated: false,
        dedupRemoved: 0,
        emptyBoundsSkipped: 0,
        invisibleSkipped: 0,
        webviewCount: 0,
        maxDepth: 0
    };
}

function walk(node, depth, path, win, acc, density, ancestorKeys) {
    if (acc.visit >= CFG.MAX_VISIT) { acc.visitHit = true; return; }
    acc.visit++;
    acc.total++;
    if (depth > acc.maxDepth) acc.maxDepth = depth;

    var rec = nodeRecord(node, depth, path, win, density);
    var keep = true;

    if (CFG.SKIP_EMPTY_BOUNDS && rec.bounds &&
        (rec.size[0] <= 0 || rec.size[1] <= 0)) {
        acc.emptyBoundsSkipped++;
        keep = false;
    }
    if (keep && !CFG.INCLUDE_INVISIBLE && rec.visible === false) {
        acc.invisibleSkipped++;
        keep = false;
    }

    var key = dedupeKey(rec);
    if (keep) {
        var dupAncestor = false;
        for (var ai = 0; ai < ancestorKeys.length; ai++) {
            if (ancestorKeys[ai] === key) { dupAncestor = true; break; }
        }
        if (dupAncestor) {
            acc.dedupRemoved++;
            keep = false;
        }
    }

    if (keep) {
        if (acc.stored < CFG.MAX_NODES) {
            if (rec.webview) acc.webviewCount++;
            acc.nodes.push(rec);
            acc.stored++;
        } else {
            acc.truncated = true;
        }
    }

    ancestorKeys.push(key);
    var cn = safeGet(function () { return node.getChildCount(); }, 0);
    for (var i = 0; i < cn; i++) {
        var c = safeGet(function () { return node.getChild(i); }, null);
        if (c == null) continue;
        var cp = (path === "" ? "" : path + ".") + i;
        walk(c, depth + 1, cp, win, acc, density, ancestorKeys);
    }
    ancestorKeys.pop();
}

function nodeByPath(root, pathStr) {
    if (!root) return null;
    if (pathStr === "") return root;
    var seg = pathStr.split(".");
    var cur = root;
    for (var i = 0; i < seg.length; i++) {
        var idx = parseInt(seg[i], 10);
        if (isNaN(idx)) return null;
        cur = safeGet(function () { return cur.getChild(idx); }, null);
        if (cur == null) return null;
    }
    return cur;
}

function freshRoot(winMeta) {
    var r = null;
    if (winMeta.active) {
        r = safeGet(function () { return auto.service.getRootInActiveWindow(); }, null);
    }
    if (r == null) {
        r = safeGet(function () { return winMeta.rawWindow ? winMeta.rawWindow.getRoot() : null; }, null);
    }
    if (r == null) r = winMeta.root;
    return r;
}

/* ============================ 滚动采集 ============================ */

function pageSignature(nodes, windowIndex) {
    var parts = [];
    for (var i = 0; i < nodes.length; i++) {
        var r = nodes[i];
        if (windowIndex !== undefined && r.windowIndex !== windowIndex) continue;
        parts.push(r.className + ":" + (r.bounds ? r.bounds.join(",") : "-") + ":" + r.text + ":" + (r.checked ? 1 : 0));
    }
    return hashStr(parts.join("|")) + "#" + parts.length;
}

function performScroll(node, action) {
    return safeGet(function () { return node.performAction(action); }, false);
}

function scrollMerge(acc, winMeta, density) {
    var res = {
        enabled: true, merged: false, containers: 0, containerTried: 0,
        pages: 1, addedNodes: 0, stopReason: "", restored: false,
        containersDetail: []
    };
    var cands = [];
    for (var i = 0; i < acc.nodes.length; i++) {
        var r = acc.nodes[i];
        if (r.windowIndex !== winMeta.index) continue;
        if (!r.scrollable) continue;
        if (r.visible === false) continue;
        cands.push(r);
    }
    if (cands.length === 0) {
        res.stopReason = "页面没有 scrollable 容器";
        return res;
    }
    cands.sort(function (a, b) {
        var sa = (a.size ? a.size[0] * a.size[1] : 0);
        var sb = (b.size ? b.size[0] * b.size[1] : 0);
        return sb - sa;
    });
    if (cands.length > CFG.MAX_SCROLL_CONTAINERS) cands = cands.slice(0, CFG.MAX_SCROLL_CONTAINERS);
    res.containers = cands.length;

    var seenKeys = {};
    for (var k = 0; k < acc.nodes.length; k++) {
        if (acc.nodes[k].windowIndex === winMeta.index) seenKeys[dedupeKey(acc.nodes[k])] = true;
    }

    for (var ci = 0; ci < cands.length; ci++) {
        var cand = cands[ci];
        var detail = { path: cand.path, className: cand.className, id: cand.id, pages: 1, added: 0, stop: "" };
        res.containerTried++;
        var prevSig = pageSignature(acc.nodes, winMeta.index);
        var pageNo = 1;
        var stop = "达到翻页上限 " + CFG.MAX_PAGES;

        for (var p = 2; p <= CFG.MAX_PAGES; p++) {
            var root = freshRoot(winMeta);
            if (root == null) { stop = "根节点丢失"; break; }
            var target = nodeByPath(root, cand.path);
            if (target == null) { stop = "容器路径失效（"+cand.path+"）"; break; }
            if (!performScroll(target, ACTION_BITS.scrollForward)) { stop = "scrollForward 返回 false"; break; }
            sleepSafe(CFG.SCROLL_SETTLE_MS);

            var pageAcc = newAcc();
            var root2 = freshRoot(winMeta);
            if (root2 == null) { stop = "翻页后根节点丢失"; break; }
            walk(root2, 0, "", winMeta, pageAcc, density, []);

            var sig = pageSignature(pageAcc.nodes, winMeta.index);
            if (sig === prevSig) { stop = "内容不再变化"; break; }

            pageNo = p;
            var added = 0;
            for (var n = 0; n < pageAcc.nodes.length; n++) {
                var nr = pageAcc.nodes[n];
                var key = dedupeKey(nr);
                if (seenKeys[key]) continue;
                seenKeys[key] = true;
                if (acc.stored >= CFG.MAX_NODES) { acc.truncated = true; continue; }
                nr.page = p;
                acc.nodes.push(nr);
                acc.stored++;
                acc.total++;
                added++;
            }
            detail.pages = p;
            detail.added += added;
            res.addedNodes += added;
            prevSig = sig;
            if (added === 0) { stop = "新内容全部重复"; break; }
        }
        detail.stop = stop;
        res.containersDetail.push(detail);
        if (pageNo > res.pages) res.pages = pageNo;

        // 回滚到顶部，尽量把界面还原成采集前的样子
        if (CFG.RESTORE_SCROLL && pageNo > 1) {
            for (var b = 0; b < pageNo; b++) {
                var rt = freshRoot(winMeta);
                if (rt == null) break;
                var tn = nodeByPath(rt, cand.path);
                if (tn == null) break;
                if (!performScroll(tn, ACTION_BITS.scrollBackward)) break;
                sleepSafe(200);
            }
            res.restored = true;
        }
    }

    res.merged = res.addedNodes > 0;
    if (!res.stopReason) {
        res.stopReason = res.merged ? "已合并滚动内容（各容器停止原因见 details）" : "滚动后无新增内容";
    }
    return res;
}

/* ============================ 空树判定 ============================ */

var RENDER_CLASS_HINTS = ["SurfaceView", "UnityPlayer", "FlutterView", "GLSurfaceView", "RenderSurface", "Canvas", "VideoView", "TextureView"];

function detectSpecial(report) {
    var e = {
        emptyTree: false, needScreenshot: false, textNodeCount: 0,
        hints: [], renderClasses: [], webviewNodes: report.stats.webview || 0
    };
    var seenRender = {};
    for (var i = 0; i < report.nodes.length; i++) {
        var r = report.nodes[i];
        if (r.text || r.desc) e.textNodeCount++;
        for (var h = 0; h < RENDER_CLASS_HINTS.length; h++) {
            if (r.classNameFull && r.classNameFull.indexOf(RENDER_CLASS_HINTS[h]) >= 0) {
                if (!seenRender[r.classNameFull]) {
                    seenRender[r.classNameFull] = true;
                    e.renderClasses.push(r.classNameFull);
                }
            }
        }
    }
    if (report.stats.stored < 5) {
        e.emptyTree = true;
        e.hints.push("控件树接近空（" + report.stats.stored + " 个节点）：可能是 Flutter / Unity / 纯 Canvas / 自绘界面，无障碍树不暴露内容");
    }
    if (report.stats.stored >= 5 && e.textNodeCount === 0) {
        e.emptyTree = true;
        e.hints.push("节点全部无文本：通常是自绘或游戏界面，只能靠截图");
    }
    if (e.renderClasses.length > 0) {
        e.hints.push("检测到渲染型容器：" + e.renderClasses.join(", ") + "；其内部子控件大概率拿不到");
    }
    if (e.webviewNodes > 0) {
        e.hints.push("WebView 节点 " + e.webviewNodes + " 个：无障碍一般只能拿到外框和少量可见文本，页面内部结构会截断");
    }
    if (report.screen.orientation === "landscape") {
        e.hints.push("当前横屏：所有 bounds 都是横屏坐标系，和竖屏截图对不上是正常的");
    }
    e.needScreenshot = e.emptyTree;
    return e;
}

/* ============================ 文本输出 ============================ */

function compactLine(rec, withWin) {
    var p = [];
    var pth = rec.path === "" ? "/" : rec.path;
    if (withWin) pth = "w" + rec.windowIndex + "/" + (rec.path === "" ? "" : rec.path);
    p.push(pth);
    p.push("d" + rec.depth);
    p.push(rec.className || "?");
    if (rec.id) p.push("id=" + rec.id);
    if (rec.text) p.push('T="' + rec.text + '"');
    if (rec.desc) p.push('D="' + rec.desc + '"');
    if (rec.bounds) {
        p.push("b=" + rec.bounds.join(","));
        p.push("c=" + rec.center.join(","));
        if (rec.boundsDp) p.push("dp=" + rec.boundsDp.join(","));
    } else {
        p.push("b=?");
    }
    var f = [];
    if (rec.clickable) f.push("click");
    if (rec.longClickable) f.push("long");
    if (rec.scrollable) f.push("scroll");
    if (rec.editable) f.push("edit");
    if (rec.checkable) f.push(rec.checked ? "check1" : "check0");
    if (rec.selected) f.push("sel");
    if (rec.focused) f.push("foc");
    if (rec.focusable) f.push("focz");
    if (rec.visible === false) f.push("inv");
    if (rec.enabled === false) f.push("off");
    if (rec.password) f.push("pwd");
    if (rec.webview) f.push("wv");
    if (rec.actionHint) f.push("act");
    if (rec.page && rec.page > 1) f.push("p" + rec.page);
    if (f.length) p.push("[" + f.join(" ") + "]");
    return p.join(" ");
}

function buildHeaderLines(report) {
    var o = [];
    o.push("# VIEW-TREE v2 | 全屏控件树 | AutoJs6");
    o.push("# 生成 " + report.generatedAt + "  stamp=" + report.stamp);
    o.push("# 设备 " + report.environment.brand + " " + report.environment.model +
        " | Android " + report.environment.androidRelease + " (SDK " + report.environment.sdkInt + ")" +
        " | AutoJs6 " + report.environment.autojsVersion);
    o.push("# 屏幕 " + report.screen.appWidth + "x" + report.screen.appHeight + "px" +
        " | dp " + report.screen.dpWidth + "x" + report.screen.dpHeight +
        " | density " + report.screen.density + " | dpi " + report.screen.dpi +
        " | rotation " + report.screen.rotation + "(" + report.screen.rotationDeg + "°)" +
        " | " + report.screen.orientation);
    o.push("# 物理 " + report.screen.realWidth + "x" + report.screen.realHeight + "px" +
        " | 状态栏 " + fx(report.bars.statusBar) +
        " | 导航栏 " + fx(report.bars.navBar) +
        " | 输入法 " + fx(report.bars.ime) + " " + report.bars.imeSource);
    o.push("# 当前 " + report.active.pkg + " / " + report.active.activity);
    var ws = [];
    for (var i = 0; i < report.windows.length; i++) {
        var w = report.windows[i];
        ws.push("[" + w.index + "]" + w.typeName + " " + (w.pkg || "?") +
            (w.bounds ? " " + w.bounds[0] + "," + w.bounds[1] + "-" + w.bounds[2] + "," + w.bounds[3] : "") +
            (w.active ? " ACTIVE" : "") + " n=" + w.nodeCount);
    }
    o.push("# 窗口数 " + report.windows.length + "  " + ws.join("  |  "));
    o.push("# 节点 总 " + report.stats.visited + " | 收录 " + report.stats.stored +
        " | 去重 " + report.stats.dedupRemoved +
        " | 空边界跳过 " + report.stats.emptyBoundsSkipped +
        " | 不可见跳过 " + report.stats.invisibleSkipped +
        " | 最大深度 " + report.stats.maxDepth +
        " | 截断 " + (report.stats.truncated ? "是" : "否"));
    if (report.stats.truncationNote) o.push("# " + report.stats.truncationNote);
    if (report.scroll && report.scroll.enabled) {
        o.push("# 滚动 容器 " + report.scroll.containerTried + "/" + report.scroll.containers +
            " | 页数 " + report.scroll.pages +
            " | 新增 " + report.scroll.addedNodes +
            " | 合并 " + (report.scroll.merged ? "是" : "否") +
            " | 停止 " + report.scroll.stopReason +
            " | 已回滚 " + (report.scroll.restored ? "是" : "否"));
    } else {
        o.push("# 滚动 未启用（单屏采集）");
    }
    if (report.empty.hints.length) {
        for (var h = 0; h < report.empty.hints.length; h++) o.push("# 提示 " + report.empty.hints[h]);
    }
    if (report.notes.length) {
        for (var n = 0; n < report.notes.length; n++) o.push("# 备注 " + report.notes[n]);
    }
    o.push("# 字段 path dN Class id= T= D= b=l,t,r,b c=cx,cy dp=l,t,r,b [flags]");
    o.push("# flags click long scroll edit check0/1 sel foc focz inv off pwd wv act(疑似可点) pN(第N页)");
    return o;
}

function buildText(report) {
    var o = buildHeaderLines(report);
    var multi = report.windows && report.windows.length > 1;
    for (var i = 0; i < report.nodes.length; i++) o.push(compactLine(report.nodes[i], multi));
    return o.join("\n") + "\n";
}

function cmpPath(a, b) {
    var sa = (a === "" ? [] : a.split("."));
    var sb = (b === "" ? [] : b.split("."));
    var n = Math.min(sa.length, sb.length);
    for (var i = 0; i < n; i++) {
        var da = parseInt(sa[i], 10);
        var db = parseInt(sb[i], 10);
        if (da !== db) return da - db;
    }
    return sa.length - sb.length;
}

function sortNodes(nodes) {
    nodes.sort(function (x, y) {
        if (x.windowIndex !== y.windowIndex) return x.windowIndex - y.windowIndex;
        if (x.page !== y.page) return x.page - y.page;
        return cmpPath(x.path, y.path);
    });
}

/* ============================ 落盘（多级兜底） ============================ */

function candidateDirs() {
    var dirs = [];
    function push(p) {
        if (!p) return;
        for (var i = 0; i < dirs.length; i++) if (dirs[i] === p) return;
        dirs.push(p);
    }
    var sd = "";
    try {
        var src = engines.myEngine().getSource();
        if (src) {
            // getSource() 可能返回 Java 对象（ScriptSource/Uri），没有 JS 的 indexOf，
            // 必须先取出路径并转成 JS 字符串再使用
            if (typeof src.getPath === "function") sd = S(src.getPath());
            else if (typeof src.getUri === "function") sd = S(src.getUri());
            else sd = S(src);
        }
    } catch (e) { sd = ""; }
    sd = S(sd);
    if (sd && sd.indexOf("file://") === 0) sd = sd.substring(7);
    if (!sd) sd = safeGet(function () { return files.cwd(); }, "");
    if (sd) {
        var dir = safeGet(function () { return files.dirname(sd); }, "");
        if (dir) push(safeGet(function () { return files.join(dir, "viewtree"); }, ""));
    }
    push(safeGet(function () { return files.join(files.getSdcardPath(), "ViewTreeDump"); }, ""));
    push(safeGet(function () { return files.join(files.getSdcardPath(), "Download", "ViewTreeDump"); }, ""));
    push(safeGet(function () {
        var f = context.getExternalFilesDir(null);
        return f ? files.join(f.getAbsolutePath(), "viewtree") : "";
    }, ""));
    push(safeGet(function () {
        var f = context.getFilesDir();
        return f ? files.join(f.getAbsolutePath(), "viewtree") : "";
    }, ""));
    return dirs;
}

// 文件名 = 序号_时分秒_应用名.txt，如 03_134635_v2ray设置.txt
// 序号自动接上目录里已有的最大值，按名称排序即按时间排序
function appLabel(pkg) {
    var name = S(safeGet(function () { return app.getAppName(pkg); }, ""));
    if (!name) name = pkg ? pkg.substring(pkg.lastIndexOf(".") + 1) : "screen";
    name = name.replace(/[\/\\:*?"<>|\s]+/g, "_");
    if (name.length > 14) name = name.substring(0, 14);
    return name || "screen";
}

function nextSeq(dir) {
    var max = 0;
    var names = safeGet(function () { return files.list(dir); }, null);
    if (names) {
        for (var i = 0; i < names.length; i++) {
            var m = /^(\d{1,4})_/.exec(names[i]);
            if (m) {
                var v = parseInt(m[1], 10);
                if (v > max) max = v;
            }
        }
    }
    return max + 1;
}

// 只保留最近 keep 份 view_ 开头的输出（含旧版 view_tree_*），其余删除
function pruneOld(dir, keep) {
    var names = safeGet(function () { return files.list(dir); }, null);
    if (!names) return;
    var arr = [];
    for (var i = 0; i < names.length; i++) {
        var n = names[i];
        var mine = n.indexOf("view_") === 0 || /^[0-9]/.test(n) ||
            n.indexOf("定位_") === 0 || n.indexOf("对比_") === 0;
        if (!mine) continue;
        var isTxt = n.length > 4 && n.substring(n.length - 4) === ".txt";
        var isJson = n.length > 5 && n.substring(n.length - 5) === ".json";
        if (!isTxt && !isJson) continue;
        var p = files.join(dir, n);
        arr.push([p, safeGet(function () { return files.lastModified(p); }, 0)]);
    }
    arr.sort(function (a, b) { return b[1] - a[1]; });
    for (var k = keep; k < arr.length; k++) {
        try { files.remove(arr[k][0]); } catch (e) { }
    }
}

function saveOutputs(report, txt, jsonBuilder) {
    report.storage = { txtPath: "", jsonPath: "", attempts: [] };
    var label = appLabel(report.active.pkg);
    var hhmmss = report.stamp.length > 9 ? report.stamp.substring(9) : report.stamp;
    var dirs = candidateDirs();
    for (var i = 0; i < dirs.length; i++) {
        var dir = dirs[i];
        if (!dir) continue;
        var base = "";
        try {
            base = nextSeq(dir) + "_" + hhmmss + "_" + label;
            if (parseInt(base, 10) < 10) base = "0" + base;
        } catch (e) { base = hhmmss + "_" + label; }
        var p = safeGet(function () { return files.join(dir, base + ".txt"); }, "");
        if (!p) continue;
        var ok = false, err = "";
        try {
            files.ensureDir(p);
            files.write(p, txt, "utf-8");
            var back = safeGet(function () { return files.read(p); }, null);
            if (back !== null && S(back).length === txt.length) ok = true;
            else err = "回读长度不一致";
        } catch (e) {
            err = S(e);
        }
        report.storage.attempts.push({ path: p, ok: ok, error: err });
        if (ok) {
            report.storage.txtPath = p;
            if (CFG.WITH_JSON) {
                try {
                    var jp = files.join(dir, base + ".json");
                    files.write(jp, jsonBuilder(report), "utf-8");
                    report.storage.jsonPath = jp;
                } catch (e) { }
            }
            pruneOld(dir, CFG.KEEP_FILES * 2);
            break;
        }
    }
    report.storage.ok = !!report.storage.txtPath;
    report.preconditions.storage = {
        txtPath: report.storage.txtPath, jsonPath: report.storage.jsonPath,
        ok: report.storage.ok, attempts: report.storage.attempts.slice(0)
    };
    return report.storage;
}

/* ============================ 菜单 ============================ */

function chooseMode() {
    var def = { scroll: true, onlyActive: false, includeInvisible: true, label: "全屏·全部窗口·含滚动" };
    if (!CFG.MENU) { CFG.WITH_JSON = false; return def; }
    var items = [
        "1 全屏 · 全部窗口 · 含滚动采集（推荐）",
        "2 全屏 · 全部窗口 · 不滚动（快，约 1 秒）",
        "3 全屏 · 仅活动窗口 · 含滚动",
        "4 全屏 · 全部窗口 · 含滚动 · 不跳过不可见节点",
        "5 同 1，另存一份 JSON（给程序用，平时不用选）",
        "6 关键词定位（当前屏找按钮，含 H5 伪可点元素）",
        "7 状态对比（先快照 → 你做一次点击 → 自动 diff 前后变化）"
    ];
    var idx = -1;
    try {
        idx = dialogs.select("全屏控件树 v2 · 采集模式", items);
    } catch (e) {
        idx = -1;
    }
    if (idx === undefined || idx === null || idx < 0) idx = 0;
    CFG.WITH_JSON = (idx === 4);
    if (idx === 1) return { scroll: false, onlyActive: false, includeInvisible: true, label: "全屏·全部窗口·不滚动" };
    if (idx === 2) return { scroll: true, onlyActive: true, includeInvisible: true, label: "全屏·仅活动窗口·含滚动" };
    if (idx === 3) return { scroll: true, onlyActive: false, includeInvisible: false, label: "全屏·全部窗口·含滚动·含不可见" };
    if (idx === 5) return { search: true, scroll: false, onlyActive: false, includeInvisible: true, label: "关键词定位" };
    if (idx === 6) return { diff: true, scroll: false, onlyActive: false, includeInvisible: true, label: "状态对比" };
    return def;
}

/* ============================ 关键词定位 & 状态对比 ============================ */

// 快照：遍历全部窗口（跳过系统栏降噪），返回节点数组
function snapshotAll(metas, density) {
    var acc = newAcc();
    for (var i = 0; i < metas.length; i++) {
        var m = metas[i];
        if (m.root == null) continue;
        if (m.pkg === "com.android.systemui") continue;
        walk(m.root, 0, "", m, acc, density, []);
    }
    return acc.nodes;
}

function saveModeFile(nameBase, content) {
    var dirs = candidateDirs();
    for (var i = 0; i < dirs.length; i++) {
        var dir = dirs[i];
        if (!dir) continue;
        var p = safeGet(function () { return files.join(dir, nameBase); }, "");
        if (!p) continue;
        try {
            files.ensureDir(p);
            files.write(p, content, "utf-8");
            var back = safeGet(function () { return files.read(p); }, null);
            if (back !== null && S(back).length === content.length) {
                L("已保存 " + p);
                try { pruneOld(dir, CFG.KEEP_FILES); } catch (e) { }
                return p;
            }
        } catch (e) { }
    }
    L("保存失败，内容已打印在上方");
    return "";
}

function runLocate(metas, density, report) {
    var kw = "";
    try {
        kw = S(dialogs.rawInput("关键词定位", "输入按钮文字/描述片段（支持正则，忽略大小写）", ""));
    } catch (e) { kw = ""; }
    if (!kw) { L("已取消"); return; }
    L("===== 关键词定位 [" + kw + "] =====");
    var re = null;
    try { re = new RegExp(kw, "i"); } catch (e2) { re = null; }
    var nodes = snapshotAll(metas, density);
    var hits = [];
    for (var i = 0; i < nodes.length; i++) {
        var r = nodes[i];
        var hay = r.text + "\u0001" + r.desc + "\u0001" + r.id + "\u0001" + r.className;
        if (re ? re.test(hay) : hay.indexOf(kw) >= 0) hits.push(r);
    }
    var out = ["# LOCATE v2 | 关键词 [" + kw + "] | " + report.generatedAt,
        "# 扫描 " + nodes.length + " 节点，命中 " + hits.length + " 个"];
    for (var j = 0; j < hits.length; j++) {
        var h = hits[j];
        var line = compactLine(h, true);
        var tap = (h.center && h.visible !== false)
            ? "  → tap(" + h.center[0] + "," + h.center[1] + ")" : "";
        out.push(line + tap);
    }
    if (hits.length === 0) {
        out.push("（无命中）建议：1) 换更短关键词 2) 确认目标在当前屏 3) H5 页先滚动到目标区域 4) 用菜单 7 状态对比找按钮");
    }
    for (var k = 0; k < out.length; k++) L(out[k]);
    var safeKw = kw.replace(/[^\w\u4e00-\u9fa5-]/g, "_").substring(0, 12);
    saveModeFile("定位_" + safeKw + "_" + report.stamp + ".txt", out.join("\n") + "\n");
}

function runDiff(metas, density, report) {
    L("===== 状态对比 =====");
    var nodesA = snapshotAll(metas, density);
    L("快照 A：" + nodesA.length + " 节点。请在 8 秒内到手机上完成那一次点击（如 一键领取）。");
    try { toast("8 秒倒计时，请现在操作手机"); } catch (e) { }
    sleepSafe(8000);
    var metasB = collectWindowMetas();
    var nodesB = snapshotAll(metasB, density);
    L("快照 B：" + nodesB.length + " 节点。差异如下：");

    function keyOf(r) { return r.className + "|" + r.id + "|" + r.text + "|" + r.desc; }
    var mapA = {}, mapB = {};
    for (var i = 0; i < nodesA.length; i++) mapA[keyOf(nodesA[i])] = nodesA[i];
    for (var j = 0; j < nodesB.length; j++) mapB[keyOf(nodesB[j])] = nodesB[j];

    var added = [], removed = [], moved = [];
    for (var kb in mapB) if (!(kb in mapA)) added.push(mapB[kb]);
    for (var ka in mapA) if (!(ka in mapB)) removed.push(mapA[ka]);
    for (var kc in mapB) {
        if (mapA[kc] && mapA[kc].center && mapB[kc].center) {
            var dx = Math.abs(mapA[kc].center[0] - mapB[kc].center[0]);
            var dy = Math.abs(mapA[kc].center[1] - mapB[kc].center[1]);
            if (dx > 4 || dy > 4) moved.push({ a: mapA[kc], b: mapB[kc] });
        }
    }

    var out = ["# DIFF v2 | " + report.generatedAt,
        "# A " + nodesA.length + " 节点 → B " + nodesB.length + " 节点",
        "# 新增 " + added.length + " | 消失 " + removed.length + " | 移动 " + moved.length];
    out.push("----- 新增（点击后才出现的，如 查看更多）-----");
    for (var a = 0; a < added.length; a++) out.push("+ " + compactLine(added[a], true));
    out.push("----- 消失（点击后不见的，如 一键领取）-----");
    for (var rm = 0; rm < removed.length; rm++) out.push("- " + compactLine(removed[rm], true));
    out.push("----- 移动（位置变化 >4px）-----");
    for (var mv = 0; mv < moved.length; mv++) {
        out.push("~ " + moved[mv].a.className + " " +
            moved[mv].a.center + " → " + moved[mv].b.center +
            " T=\"" + moved[mv].b.text + "\" D=\"" + moved[mv].b.desc + "\"");
    }
    for (var l = 0; l < out.length; l++) L(out[l]);
    saveModeFile("对比_" + report.stamp + ".txt", out.join("\n") + "\n");
}

/* ============================ 主流程 ============================ */

function emptyStats() {
    return {
        visited: 0, stored: 0, truncated: false, dedupRemoved: 0,
        emptyBoundsSkipped: 0, invisibleSkipped: 0, webview: 0,
        maxDepth: 0, maxNodes: CFG.MAX_NODES, visitLimitHit: false,
        truncationNote: "", windows: 0
    };
}

function emptyScroll(reason) {
    return {
        enabled: false, merged: false, containers: 0, containerTried: 0,
        pages: 0, addedNodes: 0, stopReason: reason || "未启用", restored: false,
        containersDetail: []
    };
}

function emptySpecial(hint) {
    return {
        emptyTree: true, needScreenshot: true, textNodeCount: 0,
        hints: hint ? [hint] : [], renderClasses: [], webviewNodes: 0
    };
}

function metaForJson(m) {
    return {
        index: m.index, id: m.id, type: m.type, typeName: m.typeName,
        layer: m.layer, active: m.active, focused: m.focused,
        bounds: m.bounds, pkg: m.pkg, title: m.title,
        rootNull: m.rootNull, synthetic: m.synthetic,
        nodeCount: m.nodeCount || 0
    };
}

function printReport(report, txt, fallbackAll) {
    L("===== VIEW-TREE v2 =====");
    var head = buildHeaderLines(report);
    for (var i = 0; i < head.length; i++) L(head[i]);
    if (report.nodes.length === 0) {
        L("（没有采集到任何节点）");
    } else {
        var limit = fallbackAll ? report.nodes.length : Math.min(CFG.CONSOLE_LINES, report.nodes.length);
        L("----- 节点（前 " + limit + " 条，共 " + report.nodes.length + " 条）-----");
        var multi = report.windows && report.windows.length > 1;
        for (var j = 0; j < limit; j++) L(compactLine(report.nodes[j], multi));
        if (limit < report.nodes.length) L("----- 其余 " + (report.nodes.length - limit) + " 条在文件里 -----");
    }
    if (report.storage && report.storage.txtPath) L("TXT  " + report.storage.txtPath);
    if (report.storage && report.storage.jsonPath) L("JSON " + report.storage.jsonPath);
    if (report.storage && !report.storage.ok) {
        L("所有路径都写不进去，下面是可直接复制的文本：");
        L("===== BEGIN VIEW TREE TXT =====");
        L(txt);
        L("===== END VIEW TREE TXT =====");
        try { toast("落盘失败，已输出到控制台，请全选复制"); } catch (e) { }
    } else {
        try { toast("采集完成：" + report.stats.stored + " 个节点"); } catch (e) { }
    }
}

(function main() {
    RUN.notes = [];
    var d = new Date();
    var report = {
        reportType: "android-view-tree",
        version: CFG.VERSION,
        generatedAt: fmtTime(d),
        stamp: fmtStamp(d),
        preconditions: {},
        environment: {},
        screen: {},
        bars: { statusBar: -1, navBar: -1, navBarSource: "", navBarWidth: -1, ime: -1, imeSource: "未读取", gestureNav: false },
        active: { pkg: "", activity: "" },
        windows: [],
        nodes: [],
        stats: {},
        scroll: {},
        empty: {},
        storage: {},
        notes: RUN.notes
    };

    report.environment = collectEnvironment();
    report.screen = collectScreen();
    report.preconditions.accessibility = checkAccessibility();
    report.preconditions.floaty = checkFloaty();

    if (!report.preconditions.accessibility.ok) {
        report.stats = emptyStats();
        report.bars.imeSource = "无障碍未开启，读不到窗口信息";
        report.scroll = emptyScroll("无障碍未开启，未采集");
        report.empty = emptySpecial(report.preconditions.accessibility.hint);
        var tMissing = buildText(report);
        saveOutputs(report, tMissing, function (r) { return JSON.stringify(r, null, 1); });
        printReport(report, tMissing, true);
        return;
    }

    var mode = chooseMode();
    CFG.INCLUDE_INVISIBLE = mode.includeInvisible;

    var metas = collectWindowMetas();
    report.bars = collectBars(report.screen, metas);

    var acc = newAcc();
    var density = report.screen.density || 0;
    var used = [];

    if (mode.search) { runLocate(metas, density, report); return; }
    if (mode.diff) { runDiff(metas, density, report); return; }

    for (var i = 0; i < metas.length; i++) {
        var m = metas[i];
        if (mode.onlyActive && !m.active) continue;
        if (m.root == null) continue;
        var before = acc.stored;
        m.nodeCount = 0;
        walk(m.root, 0, "", m, acc, density, []);
        m.nodeCount = acc.stored - before;
        used.push(m);
        RUN.notes.push("窗口[" + m.index + "] " + m.typeName + " " + (m.pkg || "?") + " 收录 " + m.nodeCount + " 条");
    }

    if (mode.onlyActive) RUN.notes.push("菜单选择：仅活动窗口");
    if (!mode.includeInvisible) RUN.notes.push("菜单选择：不跳过不可见节点");

    if (mode.scroll) {
        var act = null;
        for (var k = 0; k < used.length; k++) {
            if (used[k].active) { act = used[k]; break; }
        }
        if (act == null && used.length > 0) act = used[0];
        if (act != null) {
            report.scroll = scrollMerge(acc, act, density);
        } else {
            report.scroll = emptyScroll("没有可采集的窗口");
        }
    } else {
        report.scroll = emptyScroll("菜单选择不滚动");
    }

    report.nodes = acc.nodes;

    var countByIndex = {};
    for (var w = 0; w < used.length; w++) countByIndex[used[w].index] = 0;
    for (var n = 0; n < acc.nodes.length; n++) {
        var wi = acc.nodes[n].windowIndex;
        if (countByIndex[wi] === undefined) countByIndex[wi] = 0;
        countByIndex[wi]++;
    }
    for (var w2 = 0; w2 < used.length; w2++) used[w2].nodeCount = countByIndex[used[w2].index] || 0;
    report.windows = [];
    for (var w3 = 0; w3 < metas.length; w3++) report.windows.push(metaForJson(metas[w3]));

    report.active.pkg = S(safeGet(function () { return currentPackage(); }, ""));
    report.active.activity = S(safeGet(function () { return currentActivity(); }, ""));
    if (!report.active.pkg) {
        for (var w4 = 0; w4 < metas.length; w4++) {
            if (metas[w4].active && metas[w4].pkg) { report.active.pkg = metas[w4].pkg; break; }
        }
    }

    report.stats = {
        visited: acc.total,
        stored: acc.stored,
        truncated: acc.truncated || acc.visitHit,
        dedupRemoved: acc.dedupRemoved,
        emptyBoundsSkipped: acc.emptyBoundsSkipped,
        invisibleSkipped: acc.invisibleSkipped,
        webview: acc.webviewCount,
        maxDepth: acc.maxDepth,
        maxNodes: CFG.MAX_NODES,
        visitLimitHit: acc.visitHit,
        truncationNote: "",
        windows: used.length
    };
    if (acc.visitHit) {
        report.stats.truncationNote = "已截断（遍历硬上限 " + CFG.MAX_VISIT + " 条），共 " + acc.total + " 条，显示前 " + acc.stored + " 条";
    } else if (acc.truncated) {
        report.stats.truncationNote = "已截断，共 " + acc.total + " 条，显示前 " + acc.stored + " 条";
    }

    report.empty = detectSpecial(report);
    sortNodes(report.nodes);

    var txt = buildText(report);
    saveOutputs(report, txt, function (r) { return JSON.stringify(r, null, 1); });
    printReport(report, txt, false);
})();
