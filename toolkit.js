/**
 * AutoJs6 工具链（单文件整合版）
 * 一次运行，菜单选择：环境情报 / 界面分析 / 定位点击 / 坐标探测 / 录制 / 回放 / 全链路
 * 由 probe.js + analyze_view.js + app_clicker_v8.js 自动整合生成，各模块代码与原文件一致
 */
(function () {
var Probe = {
    run: function () {
        function pad2(n) {
            return (n < 10 ? "0" : "") + n;
        }

        function formatDateTime(d) {
            return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
                + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
        }

        function formatTimestamp(d) {
            return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
                + "-" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
        }

        function fmt(v) {
            return (v === null || v === undefined || v === "") ? "?" : String(v);
        }

        function truncate(s, n) {
            s = String(s);
            return s.length > n ? s.substring(0, n) + "…" : s;
        }

        function getGlobal() {
            try {
                if (typeof globalThis !== "undefined" && globalThis !== null) return globalThis;
            } catch (e) {}
            return (function () { return this; })();
        }

        function resolveContext() {
            try {
                if (typeof context !== "undefined" && context !== null) return context;
            } catch (e) {}
            try {
                if (typeof $app !== "undefined" && $app && $app.context) return $app.context;
            } catch (e2) {}
            throw new Error("无法获取 Android Context");
        }

        function normalizeArray(v) {
            if (v === null || v === undefined) return [];
            try {
                if (Array.isArray(v)) return v;
            } catch (e0) {}
            try {
                if (typeof v.size === "function") {
                    var out = [];
                    for (var i = 0; i < v.size(); i++) out.push(v.get(i));
                    return out;
                }
            } catch (e1) {}
            try {
                var it = v.iterator();
                var out2 = [];
                while (it.hasNext()) out2.push(it.next());
                return out2;
            } catch (e2) {}
            return [v];
        }

        function listMemberNames(obj, limit) {
            var names = [];
            try {
                for (var k in obj) {
                    names.push(k);
                    if (names.length >= limit) break;
                }
            } catch (e) {}
            return names;
        }

        function readVersionCode(pi) {
            try {
                return Number(pi.longVersionCode);
            } catch (e) {
                return pi.versionCode;
            }
        }

        function readMetaBundle(bundle) {
            var meta = {};
            if (bundle === null || bundle === undefined) return meta;
            try {
                var it = bundle.keySet().iterator();
                while (it.hasNext()) {
                    var key = String(it.next());
                    var v = bundle.get(key);
                    meta[key] = (v === null || v === undefined) ? null : String(v);
                }
            } catch (e) {
                meta.__error__ = String(e);
            }
            return meta;
        }

        var OFFICIAL_PLUGIN_PREFIX = "io.github.supermonster003.autojs6.plugin.";

        function classifyPluginPackage(pkgName, meta) {
            if (pkgName.indexOf(OFFICIAL_PLUGIN_PREFIX) === 0) return "official";
            for (var k in meta) {
                if (k.toLowerCase().indexOf("org.autojs.plugin.sdk") >= 0) return "legacy";
            }
            for (var k2 in meta) {
                if (k2.toLowerCase().indexOf("org.autojs.plugin.contract") >= 0) return "contract";
            }
            try {
                if (meta.requiresHostVersion !== undefined) return "contract";
            } catch (e0) {}
            for (var k3 in meta) {
                if (k3 !== "__error__" && k3.toLowerCase().indexOf("autojs") >= 0) return "legacy";
            }
            return null;
        }

        var PLUGIN_KIND_LABEL = {
            official: "官方插件",
            contract: "契约声明插件",
            legacy: "旧式声明插件"
        };

        function collectHostInfo(ctx) {
            var pm = ctx.getPackageManager();
            var host = {
                packageName: String(ctx.getPackageName()),
                appName: null,
                versionName: null,
                versionCode: null
            };
            try {
                var pi = pm.getPackageInfo(host.packageName, 0);
                host.appName = String(pm.getApplicationLabel(pi.applicationInfo));
                host.versionName = pi.versionName === null ? null : String(pi.versionName);
                host.versionCode = readVersionCode(pi);
            } catch (e) {}
            return host;
        }

        function collectDeviceInfo() {
            var info = {
                brand: null,
                manufacturer: null,
                model: null,
                release: null,
                sdkInt: null
            };
            try { info.brand = String(device.brand); } catch (e0) {}
            try { info.manufacturer = String(device.manufacturer); } catch (e1) {}
            try { info.model = String(device.model); } catch (e2) {}
            try { info.release = String(device.release); } catch (e3) {}
            try { info.sdkInt = device.sdkInt; } catch (e4) {}
            return info;
        }

        function detectSyntaxFeatures() {
            function check(code) {
                try {
                    new Function(code);
                    return true;
                } catch (e) {
                    return false;
                }
            }
            return {
                templateStrings: check("var s = `a${1 + 1}b`;"),
                classes: check("class A { constructor() { this.x = 1; } }"),
                asyncAwait: check("var f = async function () { await Promise.resolve(1); };"),
                bigint: check("var b = 1n;"),
                optionalChaining: check("var o = {}; var v = o?.a?.b;"),
                nullishCoalescing: check("var v = null ?? 1;"),
                spreadDestructuring: check("var a = [1, 2, 3]; var [p, ...rest] = a; var m = { x: 1 }; var q = { ...m };")
            };
        }

        var GLOBAL_CANDIDATES = [
            "app", "device", "console", "files", "floaty", "ui", "http", "images",
            "colors", "util", "events", "threads", "timers", "engines", "storages",
            "dialogs", "auto", "automator", "shell", "shizuku", "ocr", "qrcode",
            "barcode", "yolo", "speech", "tts", "ai", "compose", "terminal", "imgui",
            "pangu", "zip", "mediainfo", "installer", "mail", "epub", "gallery",
            "settings", "work_manager", "power_manager", "memory", "notice", "crypto",
            "base64", "sqlite", "i18n", "opencc", "pinyin", "flow", "plugins",
            "continuation", "sensors", "keys", "tasks", "web"
        ];

        var REQUIRE_CANDIDATES = [
            "app", "device", "files", "floaty", "ui", "http", "images", "colors",
            "util", "events", "threads", "timers", "engines", "storages", "dialogs",
            "auto", "automator", "shell", "shizuku", "ocr", "qrcode", "barcode",
            "yolo", "speech", "tts", "ai", "compose", "terminal", "imgui", "pangu",
            "zip", "mediainfo", "installer", "mail", "epub", "gallery", "settings",
            "work_manager", "power_manager", "memory", "notice", "crypto", "base64",
            "sqlite", "i18n", "opencc", "pinyin", "flow", "tasks", "keys", "sensors",
            "continuation", "web",
            "axios", "cheerio", "dayjs", "lodash"
        ];

        var MODULE_PLUGIN_MAP = {
            ai: "3-Stone AI (会话/生成) + 3-Stove Agent (ai.agent)",
            barcode: "ML Kit Barcode",
            qrcode: "ML Kit Barcode",
            compose: "3-Block Compose",
            epub: "3-Folio EPUB (Readium EPUB Reader)",
            gallery: "3-Maple Image",
            installer: "3-Setup Installer",
            mail: "3-Stamp Mail (Angus Mail)",
            ocr: "OCR 插件 (Paddle / Rapid / MLKit OCR)",
            opencc: "3-Hanzi CC (OpenCC)",
            pinyin: "Pinyin 插件",
            speech: "3-Macaw Speech",
            terminal: "3-Shell Terminal",
            yolo: "AutoJs6 YOLO NCNN",
            mediainfo: "MediaInfo",
            "files.batchRename": "Batch Rename",
            images: "OpenCV 插件 (部分图像功能)",
            axios: "Bundled Libraries",
            cheerio: "Bundled Libraries",
            dayjs: "Bundled Libraries",
            lodash: "Bundled Libraries",
            i18n: "Bundled Libraries",
            pangu: "Bundled Libraries"
        };

        // ===== 插件能力知识库 (静态参考, 摘自 AutoJs6 6.8.0 官方文档/更新日志) =====
        // 匹配依据: appName 或 packageName 包含 keys 任一项 (大小写不敏感)。
        // 运行时权威状态以 plugins.tools.providers() 与 require 结果为准; 本表只补充"能做什么/怎么调/适用/限制"。
        var PLUGIN_CAPABILITY_DB = [
            { keys: ["3-Stone AI", "three.stone.ai"], name: "3-Stone AI", role: "AI 提供方",
              caps: ["为 ai 模块提供本地或在线大模型调用", "支持流式输出、持久会话、结构化 JSON 结果"],
              mods: ["ai"], usage: "require('ai') 或全局 ai; 先在插件内配置提供方与模型", scene: ["脚本内调用大模型", "文本生成", "结构化数据抽取"],
              limit: ["需配置 AI 服务与模型", "云端模型需网络"] },
            { keys: ["3-Stove Agent", "three.stove.agent"], name: "3-Stove Agent", role: "AI 智能体运行时",
              caps: ["ai.agent 启动及控制智能体任务, 支持计划模式与后台任务", "脚本可登记为供智能体调用的工具"],
              mods: ["ai"], usage: "require('ai').agent 或全局 ai.agent", scene: ["多步自主任务", "把脚本暴露为智能体工具", "后台长任务"],
              limit: ["需 AI 提供方插件 (如 3-Stone AI)", "需模型授权", "后台任务受系统后台限制"] },
            { keys: ["MCP Server", "mcp.server"], name: "MCP Server", role: "MCP 协议服务",
              caps: ["通过 MCP 客户端访问 AutoJs6 的脚本、文件及设备操作能力"],
              mods: [], usage: "入口: 主页抽屉/插件中心; 在 MCP 客户端中配置连接", scene: ["电脑端 AI 客户端直连手机 AutoJs6", "跨端脚本/文件/设备控制"],
              limit: ["需 MCP 客户端配置", "需设备与客户端网络连通"] },
            { keys: ["3-Block Compose", "three.block.compose"], name: "3-Block Compose", role: "Compose UI 构建",
              caps: ["Jetpack Compose 构建界面、悬浮窗及对话框", "代码编辑器可在可视化设计器中打开编辑"],
              mods: ["compose"], usage: "require('compose')", scene: ["复杂 UI", "悬浮窗", "对话框"],
              limit: ["需该插件"] },
            { keys: ["3-Folio EPUB", "three.folio.epub"], name: "3-Folio EPUB", role: "EPUB 阅读",
              caps: ["读取电子书内容及打开阅读器 (Readium)", "元数据/目录/正文提取/封面与资源导出/全文搜索/阅读会话"],
              mods: ["epub"], usage: "require('epub')", scene: ["电子书解析", "阅读器集成"],
              limit: ["需该插件"] },
            { keys: ["3-Macaw Speech", "three.macaw.speech"], name: "3-Macaw Speech", role: "离线语音",
              caps: ["离线语音识别", "唤醒词检测", "语音合成", "说话人识别", "音频分析"],
              mods: ["speech"], usage: "require('speech')", scene: ["语音控制", "语音播报", "音频分析"],
              limit: ["需该插件", "部分模型需下载"] },
            { keys: ["3-Maple Image", "three.maple.image"], name: "3-Maple Image", role: "图片处理",
              caps: ["选择、查看、编辑及转换图片"],
              mods: ["gallery"], usage: "require('gallery')", scene: ["图片选择", "图片编辑/转换"],
              limit: ["需该插件"] },
            { keys: ["3-Setup Installer", "three.setup.installer"], name: "3-Setup Installer", role: "应用安装器",
              caps: ["安装、更新及卸载应用", "Shizuku/Root/Dhizuku 静默操作", "APKS/XAPK 分包容器安装"],
              mods: ["installer"], usage: "require('installer')", scene: ["静默安装", "分包安装"],
              limit: ["静默需 Shizuku/Root/Dhizuku", "否则退回系统安装器", "APKS/XAPK 必须该插件"] },
            { keys: ["3-Shell Terminal", "three.shell.terminal"], name: "3-Shell Terminal", role: "终端",
              caps: ["应用内终端", "terminal 全局对象管理终端会话"],
              mods: ["terminal"], usage: "全局 terminal 或 require('terminal')", scene: ["执行 shell 命令", "终端会话管理"],
              limit: ["需该插件"] },
            { keys: ["3-Stamp Mail", "three.stamp.mail"], name: "3-Stamp Mail", role: "邮件",
              caps: ["邮件收发、查询、附件下载", "新邮件监听", "广播任务\"邮件到达时\""],
              mods: ["mail"], usage: "require('mail')", scene: ["邮件自动化", "邮件触发任务"],
              limit: ["需该插件", "需邮箱配置"] },
            { keys: ["3-Hanzi CC", "three.hanzi.cc"], name: "3-Hanzi CC", role: "简繁转换",
              caps: ["OpenCC 简繁/异体转换"],
              mods: ["opencc"], usage: "require('opencc')", scene: ["文本简繁转换"],
              limit: ["需该插件"] },
            { keys: ["Pinyin", "pinyin"], name: "Pinyin", role: "拼音",
              caps: ["汉字转拼音"],
              mods: ["pinyin"], usage: "require('pinyin')", scene: ["拼音标注", "拼音排序"],
              limit: ["需该插件"] },
            { keys: ["Paddle OCR", "paddle.ocr"], name: "Paddle OCR", role: "OCR 引擎 (PP-OCRv5)",
              caps: ["光学字符识别", "按语种 profile 选择插件", "useCls 文字方向分类选项"],
              mods: ["ocr"], usage: "require('ocr'); 默认按 ML Kit/Paddle/Rapid 顺序自动选引擎", scene: ["图片文字识别"],
              limit: ["需该插件", "同时装多个版本可能不可用"] },
            { keys: ["Rapid OCR", "rapid.ocr"], name: "Rapid OCR", role: "OCR 引擎",
              caps: ["光学字符识别 (Rapid 引擎)"],
              mods: ["ocr"], usage: "require('ocr')", scene: ["图片文字识别"],
              limit: ["需该插件"] },
            { keys: ["ML Kit OCR", "mlkit.ocr"], name: "ML Kit OCR", role: "OCR 引擎",
              caps: ["光学字符识别 (ML Kit 引擎)"],
              mods: ["ocr"], usage: "require('ocr')", scene: ["图片文字识别"],
              limit: ["需该插件"] },
            { keys: ["ML Kit Barcode", "barcode"], name: "ML Kit Barcode", role: "条码/二维码",
              caps: ["条码识别与生成", "二维码识别与生成"],
              mods: ["barcode", "qrcode"], usage: "require('barcode') / require('qrcode')", scene: ["扫码", "二维码生成"],
              limit: ["需该插件"] },
            { keys: ["OpenCV", "opencv"], name: "OpenCV", role: "图像处理",
              caps: ["部分图像功能 (模板匹配等)"],
              mods: ["images"], usage: "require('images') 中的 OpenCV 相关方法", scene: ["图像匹配", "图像处理"],
              limit: ["需该插件", "非全部 images 方法"] },
            { keys: ["YOLO", "yolo"], name: "YOLO", role: "目标检测",
              caps: ["通过 YOLO 插件进行目标检测"],
              mods: ["yolo"], usage: "require('yolo')", scene: ["目标检测", "界面元素识别"],
              limit: ["需该插件", "需模型文件"] },
            { keys: ["MediaInfo", "mediainfo"], name: "MediaInfo", role: "媒体信息",
              caps: ["音视频等媒体文件元数据"],
              mods: ["mediainfo"], usage: "require('mediainfo')", scene: ["媒体元数据读取"],
              limit: ["需该插件"] },
            { keys: ["Batch Rename", "batch.rename"], name: "Batch Rename", role: "批量重命名",
              caps: ["按查找替换/正则/计数器/日期规则批量重命名", "支持预览与撤销"],
              mods: ["files"], usage: "files.batchRename(...)", scene: ["批量文件整理"],
              limit: ["需该插件"] },
            { keys: ["Image Quantization", "image.quantization"], name: "Image Quantization", role: "图像压缩",
              caps: ["images.quantize/quantizeToFile 及 save 量化选项", "压缩 PNG 图像"],
              mods: ["images"], usage: "images.quantize / images.quantizeToFile", scene: ["PNG 压缩", "减小图片体积"],
              limit: ["需该插件"] },
            { keys: ["ImGui", "imgui"], name: "ImGui", role: "即时 UI",
              caps: ["Dear ImGui 构建悬浮窗及全屏界面"],
              mods: ["imgui"], usage: "全局 imgui 或 require('imgui')", scene: ["高性能悬浮 UI"],
              limit: ["需该插件"] },
            { keys: ["Ace Editor", "ace.editor"], name: "Ace Editor", role: "代码编辑器",
              caps: ["Ace 编辑器: 代码补全、参数提示、悬浮文档、诊断、快捷键面板"],
              mods: [], usage: "在设置中选择编辑器引擎", scene: ["编辑器体验增强 (非脚本 API)"],
              limit: ["需该插件"] },
            { keys: ["Offline Docs", "offline.docs"], name: "Offline Docs", role: "离线文档",
              caps: ["插件化离线项目文档", "独立安装及更新"],
              mods: [], usage: "文档页面", scene: ["离线查阅 API 文档"],
              limit: ["需该插件"] },
            { keys: ["VSCode", "vscode"], name: "VSCode 插件", role: "PC 互联",
              caps: ["PC 与手机互联", "远程文件管理及设备脚本运行", "LAN/ADB 连接", "二维码扫描与配对确认"],
              mods: [], usage: "安装 AutoJs6-VSCode-Extension 并连接", scene: ["PC 端开发调试", "远程运行脚本"],
              limit: ["需 VSCode 扩展", "需 LAN/ADB 连通"] },
            { keys: ["Tasker", "tasker"], name: "Tasker", role: "Tasker 集成",
              caps: ["作为 Tasker 插件使用"],
              mods: [], usage: "在 Tasker 中配置", scene: ["Tasker 自动化联动"],
              limit: ["需 Tasker"] },
            { keys: ["Node.js Runtime", "node.runtime"], name: "Node.js Runtime", role: "Node.js 运行时",
              caps: ["运行 Node.js 脚本和项目", "可调用 AutoJs6 的自动化、图像、界面及文件等大部分脚本能力"],
              mods: [], usage: "以 Node.js 项目/脚本运行", scene: ["Node.js 生态", "复用 npm 生态"],
              limit: ["需该插件"] },
            { keys: ["Bun Runtime", "bun.runtime"], name: "Bun Runtime", role: "Bun 运行时",
              caps: ["运行 Bun 脚本和项目", "可调用 AutoJs6 大部分脚本能力"],
              mods: [], usage: "以 Bun 项目/脚本运行", scene: ["Bun 生态"],
              limit: ["需该插件"] },
            { keys: ["Python Runtime", "python.runtime"], name: "Python Runtime", role: "Python 运行时",
              caps: ["运行 Python 脚本"],
              mods: [], usage: "以 Python 脚本运行", scene: ["Python 生态"],
              limit: ["需该插件"] },
            { keys: ["Lua Runtime", "lua.runtime"], name: "Lua Runtime", role: "Lua 运行时",
              caps: ["运行 Lua 脚本"],
              mods: [], usage: "以 Lua 脚本运行", scene: ["Lua 生态"],
              limit: ["需该插件"] },
            { keys: ["QuickJS Runtime", "quickjs.runtime"], name: "QuickJS Runtime", role: "QuickJS 运行时",
              caps: ["运行 QuickJS (JavaScript) 脚本"],
              mods: [], usage: "以 QuickJS 脚本运行", scene: ["轻量 JS 运行"],
              limit: ["需该插件"] },
            { keys: ["Java Runtime", "java.runtime"], name: "Java Runtime", role: "Java 运行时",
              caps: ["编译并运行 Java 源码"],
              mods: [], usage: "以 Java 源码运行", scene: ["Java 代码执行"],
              limit: ["需该插件", "需 Android 7+"] },
            { keys: ["Kotlin Runtime", "kotlin.runtime"], name: "Kotlin Runtime", role: "Kotlin 运行时",
              caps: ["编译并运行 Kotlin 源码"],
              mods: [], usage: "以 Kotlin 源码运行", scene: ["Kotlin 代码执行"],
              limit: ["需该插件", "需 Android 8+"] },
            { keys: ["TypeScript Engine", "typescript.engine"], name: "TypeScript Engine", role: "TypeScript 引擎",
              caps: ["编译并运行 TypeScript 文件及项目", "类型检查", "UI 模式 TSX 布局"],
              mods: [], usage: "以 TS 文件/项目运行; 定时任务、快捷方式、日志页面也可运行 TS", scene: ["TypeScript 开发"],
              limit: ["需该插件"] },
            { keys: ["AutoJs4 Runtime", "autojs4.runtime"], name: "AutoJs4 Runtime", role: "AutoJs4 引擎",
              caps: ["内嵌 AutoJs4 引擎, 以原版引擎运行脚本并与 AutoJs6 对照结果"],
              mods: [], usage: "文件管理器脚本菜单 \"使用 AutoJs4 运行\"", scene: ["旧脚本兼容", "结果对照"],
              limit: ["需该插件"] },
            { keys: ["DEX Compiler", "dex.compiler"], name: "DEX Compiler", role: "DEX 编译",
              caps: ["runtime.loadJar 借助该插件加载 JAR 文件 (实验性, 默认关闭)"],
              mods: [], usage: "runtime.loadJar", scene: ["动态加载 JAR"],
              limit: ["需该插件", "实验性"] },
            { keys: ["R8 Compiler", "r8.compiler"], name: "R8 Compiler", role: "R8 编译",
              caps: ["runtime.loadJarWithR8 借助 R8 插件加载 JAR (实验性)"],
              mods: [], usage: "runtime.loadJarWithR8", scene: ["动态加载 JAR"],
              limit: ["需该插件", "实验性"] },
            { keys: ["APK Builder Template", "apk.builder.template"], name: "APK Builder Template", role: "APK 打包模板",
              caps: ["提供 APK 打包模板"],
              mods: [], usage: "打包应用时选择模板", scene: ["打包独立 APK"],
              limit: ["需该插件"] }
        ];

        function findCapability(plugin) {
            var hay = String(plugin.appName || "") + "|" + String(plugin.packageName || "");
            var low = hay.toLowerCase();
            for (var i = 0; i < PLUGIN_CAPABILITY_DB.length; i++) {
                var e = PLUGIN_CAPABILITY_DB[i];
                for (var k = 0; k < e.keys.length; k++) {
                    if (low.indexOf(String(e.keys[k]).toLowerCase()) >= 0) return e;
                }
            }
            return null;
        }

        function collectGlobalModules() {
            var g = getGlobal();
            var found = [], missing = [];
            for (var i = 0; i < GLOBAL_CANDIDATES.length; i++) {
                var name = GLOBAL_CANDIDATES[i];
                var exists = false;
                try {
                    exists = typeof g[name] !== "undefined";
                } catch (e) {
                    exists = false;
                }
                if (exists) found.push(name); else missing.push(name);
            }
            return { found: found, missing: missing };
        }

        function probeRequires() {
            var available = [], unavailable = [];
            for (var i = 0; i < REQUIRE_CANDIDATES.length; i++) {
                var name = REQUIRE_CANDIDATES[i];
                try {
                    require(name);
                    available.push(name);
                } catch (e) {
                    var msg = (e && e.message) ? e.message : String(e);
                    unavailable.push({ name: name, error: truncate(msg, 180) });
                }
            }
            return { available: available, unavailable: unavailable };
        }

        function collectPluginTools() {
            var result = {
                available: false,
                memberNames: [],
                tools: [],
                providers: [],
                error: null
            };
            var hasPlugins = false;
            try { hasPlugins = typeof plugins !== "undefined"; } catch (e0) {}
            if (!hasPlugins) {
                result.error = "全局 plugins 模块不存在";
                return result;
            }
            result.memberNames = listMemberNames(plugins, 40);
            try {
                if (plugins.tools && typeof plugins.tools.list === "function") {
                    result.tools = normalizeArray(plugins.tools.list());
                    result.available = true;
                } else {
                    result.error = "plugins.tools.list 不可用 (AutoJs6 < 6.8.0?)";
                }
            } catch (e) {
                result.error = truncate(String(e), 300);
            }
            try {
                if (plugins.tools && typeof plugins.tools.providers === "function") {
                    result.providers = normalizeArray(plugins.tools.providers());
                }
            } catch (e2) {
                if (result.error === null) result.error = truncate(String(e2), 300);
            }
            return result;
        }

        function scanAppPlugins(ctx, hostPkg) {
            var pm = ctx.getPackageManager();
            var GET_META_DATA = 8192;
            var GET_SERVICES = 2;
            var list = pm.getInstalledPackages(GET_META_DATA | GET_SERVICES);
            var total = list.size();
            var pluginsFound = [];
            for (var i = 0; i < total; i++) {
                var pi = list.get(i);
                try {
                    var pkgName = String(pi.packageName);
                    if (pkgName === hostPkg) continue;
                    var ai = pi.applicationInfo;
                    var meta = readMetaBundle(ai === null ? null : ai.metaData);
                    var kind = classifyPluginPackage(pkgName, meta);
                    if (kind === null) continue;
                    var item = {
                        kind: kind,
                        kindLabel: PLUGIN_KIND_LABEL[kind] || kind,
                        appName: null,
                        packageName: pkgName,
                        versionName: pi.versionName === null ? null : String(pi.versionName),
                        versionCode: readVersionCode(pi),
                        targetSdk: ai === null ? null : ai.targetSdkVersion,
                        apkPath: (ai === null || ai.sourceDir === null) ? null : String(ai.sourceDir),
                        firstInstallTime: pi.firstInstallTime === null ? null : String(pi.firstInstallTime),
                        lastUpdateTime: pi.lastUpdateTime === null ? null : String(pi.lastUpdateTime),
                        metaData: meta,
                        services: []
                    };
                    try {
                        item.appName = String(pm.getApplicationLabel(ai));
                    } catch (e2) {}
                    try {
                        var services = pi.services;
                        if (services !== null && services !== undefined) {
                            for (var s = 0; s < services.length && item.services.length < 8; s++) {
                                try {
                                    item.services.push(String(services[s].name));
                                } catch (e3) {}
                            }
                        }
                    } catch (e4) {}
                    pluginsFound.push(item);
                } catch (e) {}
            }
            return { visibleCount: total, plugins: pluginsFound };
        }

        function buildInstalledCapabilities(plugins, pluginTools, requires) {
            var reqAvail = {};
            for (var ra = 0; ra < requires.available.length; ra++) reqAvail[requires.available[ra]] = true;

            var provByKey = {};
            for (var pv = 0; pv < pluginTools.providers.length; pv++) {
                var p = pluginTools.providers[pv];
                try {
                    if (p.packageName) provByKey[String(p.packageName)] = p;
                    if (p.shortName) provByKey[String(p.shortName)] = p;
                } catch (e0) {}
            }

            var toolsByProv = {};
            for (var t = 0; t < pluginTools.tools.length; t++) {
                var tool = pluginTools.tools[t];
                var tk = String(tool.provider || "");
                if (!toolsByProv[tk]) toolsByProv[tk] = [];
                toolsByProv[tk].push({
                    name: tool.name, description: tool.description,
                    risk: tool.risk, timeoutMs: tool.timeoutMs, inputSchema: tool.inputSchema
                });
            }

            var out = [];
            for (var i = 0; i < plugins.length; i++) {
                var ap = plugins[i];
                var cap = findCapability(ap);
                var prov = provByKey[ap.packageName] || (ap.appName ? provByKey[String(ap.appName)] : null) || null;
                var tools = toolsByProv[ap.packageName] || (prov && prov.shortName ? toolsByProv[String(prov.shortName)] : null) || [];
                var modsOn = [], modsOff = [];
                if (cap && cap.mods) {
                    for (var m = 0; m < cap.mods.length; m++) {
                        if (reqAvail[cap.mods[m]]) modsOn.push(cap.mods[m]);
                        else modsOff.push(cap.mods[m]);
                    }
                }
                out.push({
                    appName: ap.appName,
                    packageName: ap.packageName,
                    versionName: ap.versionName,
                    kindLabel: ap.kindLabel,
                    known: cap !== null,
                    role: cap ? cap.role : null,
                    capabilities: cap ? cap.caps : [],
                    usage: cap ? cap.usage : null,
                    scenarios: cap ? cap.scene : [],
                    limits: cap ? cap.limit : [],
                    modulesEnabled: modsOn,
                    modulesDisabled: modsOff,
                    providerStatus: prov ? String(prov.status) : null,
                    providerDetail: prov ? String(prov.detail || "") : null,
                    tools: tools
                });
            }
            return out;
        }

        function buildAiDirective(r) {
            var availModules = r.requireModules.available.slice(0);
            var missingModules = [];
            for (var i = 0; i < r.requireModules.unavailable.length; i++) {
                missingModules.push(r.requireModules.unavailable[i].name);
            }

            var availTools = [];
            for (var t = 0; t < r.pluginTools.tools.length; t++) availTools.push(String(r.pluginTools.tools[t].name));

            var availPlugins = [], unavailPlugins = [];
            for (var p = 0; p < r.installedCapabilities.length; p++) {
                var c = r.installedCapabilities[p];
                if (c.providerStatus === null || c.providerStatus === "available") availPlugins.push(c.appName);
                else unavailPlugins.push(c.appName + " (" + c.providerStatus + ")");
            }

            var syntaxOn = [];
            for (var s in r.syntaxFeatures) {
                if (r.syntaxFeatures[s]) syntaxOn.push(s);
            }

            return {
                environment: {
                    host: r.host.appName,
                    hostVersion: r.host.versionName,
                    android: r.device.release,
                    sdkInt: r.device.sdkInt
                },
                available: { modules: availModules, tools: availTools, plugins: availPlugins },
                unavailable: { modules: missingModules, plugins: unavailPlugins },
                syntaxSupported: syntaxOn,
                workflow: [
                    "probe.js -> 本报告 (环境事实 + 能力清单 + 硬约束)",
                    "analyze_view.js 停在目标界面运行 -> view_dump_<ts>.json (可点控件清单)",
                    "app_clicker_v8.js 填 CONFIG -> 五级定位 + 点击 + 校验 + 重试"
                ],
                hardRules: [
                    "只使用 available.modules 中的模块; 其他模块调用会抛插件错误",
                    "只使用 available.tools 中的工具; 参数必须符合第 3 节对应工具的 inputSchema",
                    "语法按 syntaxSupported 选择; 不确定时用 ES5 (var/function)",
                    "插件可用性以第 3.2 节 providers 状态为准; available 才可调用其工具",
                    "不要假设未列出的模块/工具存在; 写脚本前先查本报告"
                ]
            };
        }

        function buildReport(host, deviceInfo, syntax, globalModules, requires, pluginTools, scanResult) {
            var hints = [];
            for (var i = 0; i < requires.available.length; i++) {
                var n = requires.available[i];
                hints.push({ module: n, provider: MODULE_PLUGIN_MAP[n] || null });
            }
            var report = {
                reportType: "autojs6-environment-probe",
                generatedAt: formatDateTime(new Date()),
                purpose: "供 AI 了解设备上的 AutoJs6 环境 (能力面、插件、工具、语法边界), 用于辅助编写 AutoJs6 脚本与插件",
                host: host,
                device: deviceInfo,
                syntaxFeatures: syntax,
                globalModules: globalModules,
                requireModules: { available: requires.available, unavailable: requires.unavailable },
                moduleProviderHints: hints,
                pluginTools: pluginTools,
                appPlugins: scanResult.plugins,
                visiblePackageCount: scanResult.visibleCount
            };
            report.installedCapabilities = buildInstalledCapabilities(report.appPlugins, report.pluginTools, report.requireModules);
            report.aiDirective = buildAiDirective(report);
            return report;
        }

        function escTable(s) {
            return String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
        }

        function buildTxtReport(r) {
            var L = [];
            L.push("AutoJs6 环境情报（AI 直接可用 · 固定文件名每次覆盖）");
            L.push("生成: " + r.generatedAt);
            L.push("说明: " + r.purpose);
            L.push("");

            L.push("===== 1. 宿主与设备 =====");
            L.push("宿主: " + fmt(r.host.appName) + " v" + fmt(r.host.versionName) + " (versionCode " + fmt(r.host.versionCode) + ")");
            L.push("包名: " + r.host.packageName);
            L.push("设备: " + fmt(r.device.brand) + " " + fmt(r.device.model) + ", Android " + fmt(r.device.release) + " (SDK " + fmt(r.device.sdkInt) + ")");
            L.push("可见包: " + fmt(r.visiblePackageCount));
            L.push("");

            L.push("===== 2. 语法能力 =====");
            var on = [], off = [];
            for (var sn in r.syntaxFeatures) {
                if (r.syntaxFeatures[sn]) on.push(sn); else off.push(sn);
            }
            L.push("支持: " + (on.length > 0 ? on.join(", ") : "(仅 ES5)"));
            L.push("不支持: " + (off.length > 0 ? off.join(", ") : "(无)"));
            L.push("");

            L.push("===== 3. 可调用插件工具 =====");
            if (r.pluginTools.error !== null) {
                L.push("工具清单不可用: " + r.pluginTools.error);
            } else {
                L.push("工具数: " + r.pluginTools.tools.length + " | 提供方: " + r.pluginTools.providers.length);
            }
            for (var t = 0; t < r.pluginTools.tools.length; t++) {
                var tool = r.pluginTools.tools[t];
                L.push("- " + fmt(tool.name) + " [" + fmt(tool.risk) + ", " + fmt(tool.timeoutMs) + "ms, " + fmt(tool.provider) + "] " + truncate(fmt(tool.description), 200));
                L.push("  args: " + truncate(JSON.stringify(tool.inputSchema), 800));
            }
            if (r.pluginTools.tools.length > 0) {
                L.push("调用: plugins.tools.call('工具名', {参数}, {outputs:{...}})");
            }
            if (r.pluginTools.providers.length > 0) {
                L.push("提供方状态:");
                for (var p = 0; p < r.pluginTools.providers.length; p++) {
                    var pv = r.pluginTools.providers[p];
                    L.push("- " + fmt(pv.shortName) + " (" + fmt(pv.packageName) + "): " + fmt(pv.status) + (pv.detail ? " — " + truncate(fmt(pv.detail), 120) : ""));
                }
            }
            L.push("");

            L.push("===== 4. 已装插件能力（按插件聚合） =====");
            if (r.installedCapabilities.length === 0) L.push("(未发现插件)");
            for (var a = 0; a < r.installedCapabilities.length; a++) {
                var c = r.installedCapabilities[a];
                L.push("[" + (a + 1) + "] " + fmt(c.appName) + " v" + fmt(c.versionName) + " [" + fmt(c.kindLabel) + "]");
                L.push("  包名: " + c.packageName);
                if (c.known) {
                    L.push("  定位: " + c.role);
                    L.push("  能力: " + c.capabilities.join("; "));
                    if (c.usage) L.push("  调用: " + c.usage);
                    if (c.scenarios.length > 0) L.push("  场景: " + c.scenarios.join("; "));
                    if (c.limits.length > 0) L.push("  限制: " + c.limits.join("; "));
                } else {
                    L.push("  定位: (知识库未收录，以第 3 节工具明细为准)");
                }
                if (c.modulesEnabled.length > 0) L.push("  模块(已加载): " + c.modulesEnabled.join(", "));
                if (c.modulesDisabled.length > 0) L.push("  模块(未加载): " + c.modulesDisabled.join(", ") + " (插件可能未启用)");
                L.push("  状态: " + (c.providerStatus === null ? "未报告" : c.providerStatus));
                if (c.tools.length > 0) {
                    var tn = [];
                    for (var ct = 0; ct < c.tools.length; ct++) tn.push(c.tools[ct].name);
                    L.push("  工具: " + tn.join(", "));
                }
            }
            L.push("");

            L.push("===== 5. 模块可用性 =====");
            L.push("可加载(" + r.requireModules.available.length + "): " + r.requireModules.available.join(", "));
            if (r.requireModules.unavailable.length > 0) {
                var miss = [];
                for (var u = 0; u < r.requireModules.unavailable.length; u++) miss.push(r.requireModules.unavailable[u].name);
                L.push("缺失(" + miss.length + "): " + miss.join(", "));
            }
            L.push("");

            var d = r.aiDirective;
            L.push("===== 6. AI 执行指令（照此执行，勿假设） =====");
            L.push("环境: " + fmt(d.environment.host) + " v" + fmt(d.environment.hostVersion) + ", Android " + fmt(d.environment.android));
            L.push("可用模块: " + (d.available.modules.length > 0 ? d.available.modules.join(", ") : "(无)"));
            L.push("可用工具: " + (d.available.tools.length > 0 ? d.available.tools.join(", ") : "(无)"));
            L.push("可用插件: " + (d.available.plugins.length > 0 ? d.available.plugins.join(", ") : "(无)"));
            L.push("不可用模块: " + (d.unavailable.modules.length > 0 ? d.unavailable.modules.join(", ") : "(无)"));
            L.push("异常插件: " + (d.unavailable.plugins.length > 0 ? d.unavailable.plugins.join(", ") : "(无)"));
            L.push("工作流:");
            for (var wf = 0; wf < d.workflow.length; wf++) L.push("  " + (wf + 1) + ") " + d.workflow[wf]);
            L.push("硬约束:");
            for (var hr = 0; hr < d.hardRules.length; hr++) L.push("  " + (hr + 1) + ") " + d.hardRules[hr]);
            L.push("");
            L.push("===== 结束 =====");
            return L.join("\n");
        }
        var TXT_REPORT_NAME = "autojs6-env-report.txt";

        function saveReports(ctx, report) {
            var txtText = buildTxtReport(report);
            var candidates = [];
            try {
                candidates.push({ label: "脚本目录", dir: files.cwd() });
            } catch (e0) {}
            candidates.push({ label: "共享存储", dir: "/sdcard/脚本" });
            try {
                var extDir = ctx.getExternalFilesDir(null);
                if (extDir !== null) {
                    candidates.push({ label: "应用外部私有目录", dir: String(extDir.getAbsolutePath()) });
                }
            } catch (e1) {}
            for (var i = 0; i < candidates.length; i++) {
                try {
                    var txtPath = files.join(candidates[i].dir, TXT_REPORT_NAME);
                    var ok = files.write(txtPath, txtText);
                    if (ok === false) throw new Error("文件写入返回失败");
                    return { txt: txtPath, label: candidates[i].label };
                } catch (e) {
                    console.warn("报告目录不可用[" + candidates[i].label + "]: " + candidates[i].dir + " (" + truncate(String(e), 120) + ")");
                }
            }
            return null;
        }

        function main() {
            console.info("== AutoJs6 环境情报探针 v3 (TXT 单文件) ==");
            var ctx = resolveContext();

            var host = collectHostInfo(ctx);
            console.info("[宿主] " + fmt(host.appName) + "  " + host.packageName + "  v" + fmt(host.versionName) + " (" + fmt(host.versionCode) + ")");

            var deviceInfo = collectDeviceInfo();
            console.info("[设备] " + fmt(deviceInfo.brand) + " " + fmt(deviceInfo.model) + "  Android " + fmt(deviceInfo.release) + " (SDK " + fmt(deviceInfo.sdkInt) + ")");

            var syntax = detectSyntaxFeatures();
            var syntaxOn = [];
            for (var sn in syntax) {
                if (syntax[sn]) syntaxOn.push(sn);
            }
            console.info("[语法] 支持: " + (syntaxOn.length > 0 ? syntaxOn.join(", ") : "(ES5 基础特性)"));

            var globalModules = collectGlobalModules();
            console.log("[模块] 全局对象存在 " + globalModules.found.length + " 个 / 不存在 " + globalModules.missing.length + " 个");

            var requires = probeRequires();
            console.log("[模块] require 可加载 " + requires.available.length + " 个 / 失败 " + requires.unavailable.length + " 个");

            var pluginTools = collectPluginTools();
            if (pluginTools.error !== null) {
                console.warn("[工具] 插件工具清单不可用: " + pluginTools.error);
            } else {
                console.warn("[工具] 可用插件工具 " + pluginTools.tools.length + " 个, 提供方 " + pluginTools.providers.length + " 个");
                for (var ti = 0; ti < pluginTools.tools.length; ti++) {
                    var t = pluginTools.tools[ti];
                    console.log("  - " + t.name + "  [" + fmt(t.risk) + "]  ← " + fmt(t.provider));
                }
                for (var pi = 0; pi < pluginTools.providers.length; pi++) {
                    var pv = pluginTools.providers[pi];
                    if (pv.status !== "available") {
                        console.warn("  ! " + fmt(pv.shortName) + " (" + pv.packageName + ") 状态 " + pv.status + ": " + fmt(pv.detail));
                    }
                }
            }

            var scanResult;
            try {
                scanResult = scanAppPlugins(ctx, host.packageName);
            } catch (e) {
                console.error("[扫描] 无法获取已安装包列表: " + e);
                console.error("可能缺少包可见性权限, 探针终止。");
                return;
            }
            console.warn("[插件] 发现应用插件 " + scanResult.plugins.length + " 个 (可见包 " + scanResult.visibleCount + ")");
            for (var ai = 0; ai < scanResult.plugins.length; ai++) {
                var ap = scanResult.plugins[ai];
                console.log("  - " + fmt(ap.appName) + "  " + ap.packageName + "  v" + fmt(ap.versionName) + "  [" + ap.kindLabel + "]");
            }

            var report = buildReport(host, deviceInfo, syntax, globalModules, requires, pluginTools, scanResult);

            console.info("[能力] 已装插件能力清单:");
            for (var ci = 0; ci < report.installedCapabilities.length; ci++) {
                var cap = report.installedCapabilities[ci];
                console.log("  - " + fmt(cap.appName) + " → " + (cap.known ? cap.role : "能力未知") +
                    " | 模块 " + (cap.modulesEnabled.length > 0 ? cap.modulesEnabled.join(",") : "-") +
                    " | 工具 " + cap.tools.length);
            }

            var saved = saveReports(ctx, report);
            if (saved !== null) {
                console.info("[报告] 已写入 (" + saved.label + "): " + saved.txt);
                console.info("[报告] 固定文件名 " + TXT_REPORT_NAME + "，下次运行同名覆盖");
                console.info("[报告] 只需把该 TXT 上传给 AI 即可");
            } else {
                console.error("[报告] 写入失败, 结果仅在控制台输出");
            }
        }

        main();

    }
};

var AnalyzeView = {
    run: function () {

            auto.waitFor();
            function L(m) { console.log(m); }

            var W = device.width, H = device.height;
            L("===== 结构分析 v2 =====");
            L("包名:" + currentPackage() + " 页面:" + currentActivity() + " 屏幕:" + W + "x" + H);

            var region = { yMin: 0, yMax: 0.45, label: "上半部" };
            var mode = dialogs.select("分析区域", ["上半部（默认，y<45%）", "全屏", "下半部（y>55%）", "自定义 yMin,yMax"]);
            if (mode === 1) region = { yMin: 0, yMax: 1, label: "全屏" };
            else if (mode === 2) region = { yMin: 0.55, yMax: 1, label: "下半部" };
            else if (mode === 3) {
                var inp = dialogs.rawInput("输入 yMin,yMax（0-1，逗号分隔）", "0,0.45");
                if (inp) {
                    var parts = inp.split(",");
                    var a = parseFloat(parts[0]), b = parseFloat(parts[1]);
                    if (!isNaN(a) && !isNaN(b) && a >= 0 && b <= 1 && a < b) {
                        region = { yMin: a, yMax: b, label: "自定义[" + a + "," + b + "]" };
                    }
                }
            }

            var yMinPx = H * region.yMin, yMaxPx = H * region.yMax;
            L("区域:" + region.label + " (y:" + Math.round(yMinPx) + "-" + Math.round(yMaxPx) + ")");

            var cs = clickable(true).find();
            var out = [];
            var classCount = {};
            for (var i = 0; i < cs.length; i++) {
                try {
                    var b = cs[i].bounds();
                    if (b.width() <= 0 || b.height() <= 0) continue;
                    if (b.top > yMaxPx || b.bottom < yMinPx) continue;
                    var cls = (cs[i].className() || "").split(".").pop() || "?";
                    var idv = cs[i].id() || "";
                    var tx = cs[i].text() || "";
                    var de = cs[i].desc() || "";
                    var item = {
                        idx: out.length, x: Math.round(b.centerX()), y: Math.round(b.centerY()),
                        w: Math.round(b.width()), h: Math.round(b.height()),
                        cls: cls, id: idv, text: tx, desc: de,
                        left: b.left, top: b.top, right: b.right, bottom: b.bottom
                    };
                    out.push(item);
                    classCount[cls] = (classCount[cls] || 0) + 1;
                } catch (e) { }
            }

            L("可点容器:" + out.length + " 个（区域 " + region.label + "）");
            var clsKeys = Object.keys(classCount);
            L("class 分布:" + clsKeys.map(function (k) { return k + "×" + classCount[k]; }).join(", "));
            for (var j = 0; j < out.length; j++) {
                var o = out[j];
                L("[" + j + "] @" + o.x + "," + o.y + " " + o.w + "x" + o.h +
                  " [" + o.cls + "] id=" + o.id + " T='" + o.text + "' D='" + o.desc + "'");
            }

            var report = {
                ts: new Date().toISOString(),
                package: currentPackage(), activity: currentActivity(),
                screen: { width: W, height: H },
                region: { label: region.label, yMin: region.yMin, yMax: region.yMax },
                totalClickable: out.length,
                classDistribution: classCount,
                widgets: out
            };
            var jsonPath = null;
            try {
                var dir = files.dirname(engines.myEngine().getSource());
                jsonPath = files.join(dir, "view_dump_" + new Date().getTime() + ".json");
                files.write(jsonPath, JSON.stringify(report, null, 2));
                L("JSON 已保存: " + jsonPath);
            } catch (e) {
                L("JSON 保存失败（scoped storage?）: " + e);
            }

            L("===== 结束 =====");
            return { jsonPath: jsonPath, count: out.length };

    }
};

var AppClicker = {
    run: function (presetMode) {

            var CONFIG = {
                text: "", desc: "", ids: [], neighborText: "", neighborDx: 160, neighborDy: 0,
                template: "", visionAsk: "", coord: null, autoTap: true, swipeFind: 0,
                texts: [],        // 同义组：["一键领取","查看更多","去领取"] 任一命中即可
                doneTexts: [],     // 前置终态词：命中即跳过点击
                expectJump: false,   // 点击后期待页面跳转（package 或 activity 变化）
                expectGone: "",      // 点击后期待消失的文字/描述
                expectDone: [],      // 后置终态词：点击后期待出现，命中即视为成功
                verifyTimeoutMs: 3000, // 点击后验证等待时长
                retryMax: 2           // 验证失败后整体重试次数（locate+click+verify）
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
            var POPUP_BLACKLIST = {};
            var blPath = null;
            try { blPath = files.join(files.dirname(engines.myEngine().getSource()), ".popup_blacklist.txt"); } catch (e) { }
            function loadBL() { try { if (blPath && files.exists(blPath)) POPUP_BLACKLIST = JSON.parse(files.read(blPath)) || {}; } catch (e) { } }
            function saveBL() { try { if (blPath) files.write(blPath, JSON.stringify(POPUP_BLACKLIST)); } catch (e) { } }

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
                return !!(textMatches("^(跳过|跳过广告|关闭广告)$").findOnce() || descMatches("^(跳过|跳过广告|关闭广告)$").findOnce());
            }

            function findCloseBtn() {
                var area = device.width * device.height;
                var cands = [];
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
                        if (a <= 0 || a > area * 0.05) continue;
                        if (POPUP_BLACKLIST[tx] || (idv && POPUP_BLACKLIST[idv])) continue;
                        if (DANGER.test(tx)) continue;
                        var isSafeText = SAFE_CLOSE.test((w.text() || w.desc() || "").trim());
                        var isCloseId = /(close|dismiss|cancel|guanbi)/i.test(idv);
                        if (!isSafeText && !isCloseId) continue;
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

            // ===== 点击后校验闭环（v8 新增）=====
            // beforePkg/beforeAct：点击前的 package/activity，用于跳转检测
            // 返回 { verified: bool, reason: string }
            function verifyClick(spec, beforePkg, beforeAct) {
                var timeout = spec.verifyTimeoutMs || 3000;
                var step = 300, elapsed = 0;
                while (elapsed < timeout) {
                    sleep(step); elapsed += step;
                    if (spec.expectJump) {
                        var pkg = currentPackage(), act = currentActivity();
                        if (pkg !== beforePkg || act !== beforeAct) {
                            return { verified: true, reason: "跳转成功 " + beforePkg + "→" + pkg };
                        }
                    }
                    if (spec.expectGone) {
                        var gone = !(textMatches(spec.expectGone).findOnce() || descMatches(spec.expectGone).findOnce());
                        if (gone) return { verified: true, reason: "目标已消失: " + spec.expectGone };
                    }
                    if (spec.expectDone && spec.expectDone.length) {
                        for (var d = 0; d < spec.expectDone.length; d++) {
                            var dw = textMatches(spec.expectDone[d]).findOnce() || descMatches(spec.expectDone[d]).findOnce();
                            if (dw) return { verified: true, reason: "终态出现: " + spec.expectDone[d] };
                        }
                    }
                }
                if (spec.expectJump || spec.expectGone || (spec.expectDone && spec.expectDone.length)) {
                    return { verified: false, reason: "校验超时(" + timeout + "ms)未达预期" };
                }
                return { verified: true, reason: "无校验要求，默认通过" };
            }

            // ===== 坐标捕获（非阻塞版）=====
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
                        try { win.setSize(1, 1); win.setPosition(-200, -200); } catch (er) { }
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

            // ===== 生成脚本代码 =====
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

            // ===== steps 持久化（v8 新增：断点续传）=====
            var stepsPath = null;
            try { stepsPath = files.join(files.dirname(engines.myEngine().getSource()), ".record_steps.json"); } catch (e) { }
            function saveSteps(steps, jobId) {
                try {
                    if (stepsPath) {
                        var data = { jobId: jobId || ("job_" + new Date().getTime()), ts: new Date().toISOString(), total: steps.length, steps: steps };
                        files.write(stepsPath, JSON.stringify(data, null, 2));
                    }
                } catch (e) { L("steps 保存失败: " + e); }
            }
            function loadSteps() {
                try { if (stepsPath && files.exists(stepsPath)) return JSON.parse(files.read(stepsPath)); } catch (e) { }
                return null;
            }

            // ===== 模式③ 录制（每步持久化，防中断丢失）=====
            function recordMode() {
                var steps = [];
                var jobId = "job_" + new Date().getTime();
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
                        threads.start(function () {
                            sleep(400);
                            var info = infoAt(x, y);
                            steps.push({ x: x, y: y, info: info });
                            saveSteps(steps, jobId);   // 每步持久化
                            var nm = info ? (info.text || info.desc || ("[" + (info.cls || "无字") + "]")) : "[空]";
                            L("第" + steps.length + "步: " + x + "," + y + " 锚=" + nm + "（已持久化）");
                            toastS("已记第" + steps.length + "步: " + nm);
                            busy = false;
                        });
                    });
                    if (!ok) busy = false;
                }

                function finish() {
                    try { ball.close(); } catch (e) { }
                    if (steps.length === 0) { L("未录到任何步骤"); exit(); }
                    saveSteps(steps, jobId);
                    var code = genCode(steps);
                    L("===== 生成代码 =====\n" + code);
                    try {
                        var out = files.join(files.dirname(engines.myEngine().getSource()), "recorded_" + new Date().getTime() + ".js");
                        files.write(out, code);
                        L("已保存: " + out);
                        L("steps json: " + stepsPath + "（可用于回放/断点续传）");
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
                        if (Date.now() - downT < 900) setTimeout(recordOne, 60);
                        return true;
                    }
                    return false;
                });

                setInterval(function () { }, 1000);
            }

            // ===== 模式④ 回放（v8 新增：断点续传）=====
            function replayMode() {
                var data = loadSteps();
                if (!data || !data.steps || !data.steps.length) {
                    L("无录制 steps 文件: " + stepsPath);
                    toastS("请先录制");
                    return;
                }
                L("找到录制任务 " + (data.jobId || "?") + "，共 " + data.total + " 步，时间 " + data.ts);
                var resumeFrom = dialogs.rawInput("从第几步开始回放？（1-" + data.total + "，默认 1）", "1");
                var startIdx = (parseInt(resumeFrom, 10) || 1) - 1;
                if (startIdx < 0) startIdx = 0;
                if (startIdx >= data.steps.length) { L("起始步超出范围"); return; }
                L("从第 " + (startIdx + 1) + " 步开始回放，共 " + (data.steps.length - startIdx) + " 步待执行");

                for (var i = startIdx; i < data.steps.length; i++) {
                    var step = data.steps[i];
                    L("--- 回放第 " + (i + 1) + "/" + data.steps.length + " 步 ---");
                    guardPopup(2);

                    var info = step.info || {};
                    var hit = null;
                    if (info.text && info.text.length <= 20) {
                        var w = textMatches(info.text).findOnce();
                        if (w) { var b = w.bounds(); hit = { x: b.centerX(), y: b.centerY(), by: "text:" + info.text }; }
                    }
                    if (!hit && info.desc && info.desc.length <= 20) {
                        var w2 = descMatches(info.desc).findOnce();
                        if (w2) { var b2 = w2.bounds(); hit = { x: b2.centerX(), y: b2.centerY(), by: "desc:" + info.desc }; }
                    }
                    if (!hit) hit = { x: step.x, y: step.y, by: "坐标" };

                    var beforePkg = currentPackage(), beforeAct = currentActivity();
                    click(hit.x, hit.y);
                    L("已点击 " + hit.x + "," + hit.y + "（" + hit.by + "）");
                    sleep(1500);
                    guardPopup(1);

                    var spec = { expectJump: true, verifyTimeoutMs: 3000, expectDone: [], expectGone: "" };
                    var vr = verifyClick(spec, beforePkg, beforeAct);
                    L("校验: " + (vr.verified ? "✓" : "✗") + " " + vr.reason);
                    if (!vr.verified) L("⚠ 第 " + (i + 1) + " 步校验未通过，继续下一步（可在 CONFIG 配 retryMax 重试）");
                }
                L("===== 回放完成 =====");
                toastS("回放完成");
            }

            // ===== 入口 =====
            auto.waitFor();
            var mode = (typeof presetMode === "number" && presetMode >= 0) ? presetMode : dialogs.select("选择模式", [
                "① 按文字/描述定位并点击",
                "② 坐标探测（记坐标）",
                "③ 录制（分步拾取→生成脚本）",
                "④ 回放（断点续传）"
            ]);
            if (mode === 1) {
                captureOnceAsync(function (x, y) {
                    L("【探测坐标】 " + x + ", " + y);
                    toastS("坐标: " + x + ", " + y);
                });
                setInterval(function () { }, 1000);
                return;
            }
            if (mode === 2) { recordMode(); return; }
            if (mode === 3) { replayMode(); return; }
            if (mode !== 0) { L("已取消"); return; }

            var spec = {
                text: CONFIG.text, texts: CONFIG.texts, desc: CONFIG.desc, ids: CONFIG.ids,
                neighborText: CONFIG.neighborText, neighborDx: CONFIG.neighborDx, neighborDy: CONFIG.neighborDy,
                template: CONFIG.template, visionAsk: CONFIG.visionAsk, coord: CONFIG.coord,
                name: CONFIG.text || (CONFIG.texts && CONFIG.texts.join("|")) || CONFIG.desc || "target",
                expectJump: CONFIG.expectJump, expectGone: CONFIG.expectGone, expectDone: CONFIG.expectDone,
                verifyTimeoutMs: CONFIG.verifyTimeoutMs, retryMax: CONFIG.retryMax
            };
            if (!spec.text && !(spec.texts && spec.texts.length) && !spec.desc && !spec.neighborText && !spec.visionAsk && !spec.coord) {
                var q = dialogs.rawInput("要定位什么？（多个同义写法用 | 分隔，如：一键领取|查看更多）", "");
                if (!q) { L("未输入，退出"); exit(); }
                if (q.indexOf("|") >= 0) { spec.texts = q.split("|"); spec.text = ""; }
                else { spec.text = q; }
                spec.desc = q; spec.visionAsk = q.split("|")[0]; spec.name = q;
            }
            L("目标: " + spec.name + " | 界面: " + currentPackage());

            // ===== 幂等：前置终态词检测 =====
            var doneList = CONFIG.doneTexts || [];
            for (var di = 0; di < doneList.length; di++) {
                var dw = textMatches(doneList[di]).findOnce() || descMatches(doneList[di]).findOnce();
                if (dw) {
                    L("已处于完成态（命中「" + doneList[di] + "」），跳过点击");
                    toastS("已完成，无需操作");
                    return;
                }
            }

            // ===== 主流程：locate + click + verify + 重试（v8 闭环）=====
            var retryMax = spec.retryMax || 0;
            var attempt = 0, success = false;
            while (attempt <= retryMax && !success) {
                if (attempt > 0) L("=== 重试第 " + attempt + "/" + retryMax + " 次 ===");
                var res = { ok: false };
                var rounds = (CONFIG.swipeFind || 0) + 1;
                for (var k = 0; k < rounds; k++) {
                    guardPopup(2);
                    res = locate(spec);
                    if (res.ok) break;
                    if (k < rounds - 1) {
                        L("未找到，下滑 " + (k + 1));
                        swipe(device.width / 2, device.height * 0.75, device.width / 2, device.height * 0.30, 500);
                        sleep(2000);
                    }
                }
                guardPopup(1);
                if (res.ok) {
                    if (CONFIG.autoTap) {
                        var beforePkg = currentPackage(), beforeAct = currentActivity();
                        click(res.x, res.y);
                        L("已点击 " + res.x + "," + res.y + "（" + res.by + "）");
                        var vr = verifyClick(spec, beforePkg, beforeAct);
                        L("校验: " + (vr.verified ? "✓" : "✗") + " " + vr.reason);
                        if (vr.verified) {
                            success = true;
                            toastS("成功: " + vr.reason);
                        } else {
                            L("校验失败，" + (attempt < retryMax ? "将重试" : "已达重试上限"));
                            back();   // 尝试退回原页面再试
                            sleep(1500);
                        }
                    } else {
                        success = true;
                        toastS("定位成功: " + res.x + ", " + res.y);
                    }
                } else {
                    L("未找到目标: " + spec.name + (attempt < retryMax ? "，将重试" : ""));
                    if (attempt < retryMax) sleep(2000);
                }
                attempt++;
            }
            if (!success) {
                L("最终失败: " + spec.name + "（尝试 " + attempt + " 次）");
                toastS("失败: " + spec.name);
            }

    }
};

    function safeRun(label, fn, arg) {
        try { return fn(arg); }
        catch (e) { console.error("[" + label + "] 运行失败: " + e); toast(label + " 运行失败"); }
    }

    auto.waitFor();
    var choice = dialogs.select("AutoJs6 工具链（一次运行）", [
        "① 环境情报（插件能力 + AI 指令）",
        "② 界面分析（当前页面控件清单）",
        "③ 定位点击（五级定位 + 校验）",
        "④ 坐标探测",
        "⑤ 录制（分步拾取 → 生成脚本）",
        "⑥ 回放（断点续传）",
        "⑦ 全链路向导（情报 → 等待切界面 → 分析 → 点击）"
    ]);
    if (choice === 0) { safeRun("环境情报", Probe.run); }
    else if (choice === 1) { safeRun("界面分析", AnalyzeView.run); }
    else if (choice === 2) { safeRun("定位点击", AppClicker.run, 0); }
    else if (choice === 3) { safeRun("坐标探测", AppClicker.run, 1); }
    else if (choice === 4) { safeRun("录制", AppClicker.run, 2); }
    else if (choice === 5) { safeRun("回放", AppClicker.run, 3); }
    else if (choice === 6) {
        toast("1/3 环境情报...");
        safeRun("环境情报", Probe.run);
        toast("2/3 请切到目标界面，8 秒后自动分析");
        sleep(8000);
        safeRun("界面分析", AnalyzeView.run);
        toast("3/3 定位点击");
        safeRun("定位点击", AppClicker.run, 0);
    }
    else { console.log("已取消"); }
})();
