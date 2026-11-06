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

function resolveContext() {
    try {
        if (typeof context !== "undefined" && context !== null) return context;
    } catch (e) {}
    try {
        if (typeof $app !== "undefined" && $app && $app.context) return $app.context;
    } catch (e2) {}
    throw new Error("无法获取 Android Context");
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

function findAutojsMetaKeys(meta) {
    var hits = [];
    for (var k in meta) {
        if (k !== "__error__" && k.toLowerCase().indexOf("autojs") >= 0) hits.push(k);
    }
    return hits;
}

function readVersionCode(pi) {
    try {
        return Number(pi.longVersionCode);
    } catch (e) {
        return pi.versionCode;
    }
}

function collectHostInfo(ctx) {
    var pm = ctx.getPackageManager();
    var host = {
        flavor: "unknown",
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
    if (host.packageName.indexOf("org.autojs.autojs6") === 0) {
        host.flavor = "AutoJs6";
    } else if (typeof plugins !== "undefined") {
        host.flavor = "Auto.js Pro";
    } else {
        host.flavor = "Auto.js 系分支";
    }
    return host;
}

function collectDeviceInfo() {
    return {
        brand: String(device.brand),
        model: String(device.model),
        release: String(device.release),
        sdkInt: device.sdkInt
    };
}

function scanPackages(ctx, hostPkg) {
    var pm = ctx.getPackageManager();
    var GET_META_DATA = 8192;
    var list = pm.getInstalledPackages(GET_META_DATA);
    var total = list.size();
    var pluginList = [];
    var related = [];
    for (var i = 0; i < total; i++) {
        var pi = list.get(i);
        try {
            var pkgName = String(pi.packageName);
            if (pkgName === hostPkg) continue;
            var ai = pi.applicationInfo;
            var meta = readMetaBundle(ai === null ? null : ai.metaData);
            var hits = findAutojsMetaKeys(meta);
            if (hits.length > 0) {
                var item = {
                    appName: null,
                    packageName: pkgName,
                    versionName: pi.versionName === null ? null : String(pi.versionName),
                    versionCode: readVersionCode(pi),
                    pluginSdkVersion: null,
                    targetSdk: ai === null ? null : ai.targetSdkVersion,
                    apkPath: (ai === null || ai.sourceDir === null) ? null : String(ai.sourceDir),
                    firstInstallTime: pi.firstInstallTime === null ? null : String(pi.firstInstallTime),
                    lastUpdateTime: pi.lastUpdateTime === null ? null : String(pi.lastUpdateTime),
                    matchedMetaKeys: hits,
                    metaData: meta
                };
                try {
                    item.appName = String(pm.getApplicationLabel(ai));
                } catch (e2) {}
                for (var h = 0; h < hits.length; h++) {
                    if (hits[h].toLowerCase().indexOf("sdk") >= 0) {
                        item.pluginSdkVersion = meta[hits[h]];
                        break;
                    }
                }
                pluginList.push(item);
            } else if (/autojs|auto\.js|autox/i.test(pkgName)) {
                var rel = {
                    appName: null,
                    packageName: pkgName,
                    versionName: pi.versionName === null ? null : String(pi.versionName)
                };
                try {
                    rel.appName = String(pm.getApplicationLabel(ai));
                } catch (e3) {}
                related.push(rel);
            }
        } catch (e) {}
    }
    return { total: total, pluginList: pluginList, related: related };
}

function buildVisibilityNotes(total, deviceInfo) {
    var notes = [];
    if (deviceInfo.sdkInt >= 30 && total < 60) {
        notes.push("可见包数量偏少(" + total + ")且系统为 Android 11+，可能受包可见性限制，部分插件 APK 可能未被扫描到。");
    }
    return notes;
}

function buildConclusion(host) {
    if (host.flavor === "AutoJs6") {
        return "宿主为 AutoJs6 开源版，未内置 Auto.js Pro 的插件加载体系（plugins 模块）。"
            + "扫描到的插件 APK 仅能被识别，无法被 AutoJs6 加载运行；它们面向 Auto.js Pro 设计。";
    }
    if (host.flavor === "Auto.js Pro") {
        return "宿主具备 plugins 模块（Auto.js Pro），已尝试逐个加载插件，结果见控制台。";
    }
    return "宿主为 Auto.js 系分支，通常不具备 Pro 插件加载体系。";
}

function buildReport(host, deviceInfo, scanResult, notes) {
    return {
        generatedAt: formatDateTime(new Date()),
        host: host,
        device: deviceInfo,
        summary: {
            visiblePackageCount: scanResult.total,
            pluginCount: scanResult.pluginList.length,
            relatedAppCount: scanResult.related.length
        },
        plugins: scanResult.pluginList,
        relatedAutojsApps: scanResult.related,
        notes: notes,
        conclusion: buildConclusion(host)
    };
}

function tryLoadPlugins(pluginList) {
    if (typeof plugins === "undefined") return;
    console.info("[兼容] 检测到 plugins 模块（Auto.js Pro 环境），尝试加载插件…");
    for (var i = 0; i < pluginList.length; i++) {
        try {
            plugins.load(pluginList[i].packageName);
            console.info("  加载成功: " + pluginList[i].packageName);
        } catch (e) {
            console.error("  加载失败: " + pluginList[i].packageName + " → " + e);
        }
    }
}

function buildTextReport(r) {
    var L = [];
    L.push("AutoJs6 插件探针报告");
    L.push("生成时间: " + r.generatedAt);
    L.push("");
    L.push("[宿主]");
    L.push("  " + r.host.flavor + "  " + r.host.packageName
        + "  v" + fmt(r.host.versionName) + " (" + fmt(r.host.versionCode) + ")");
    L.push("[设备]");
    L.push("  " + r.device.brand + " " + r.device.model
        + "  Android " + r.device.release + " (SDK " + r.device.sdkInt + ")");
    L.push("[扫描概况]");
    L.push("  可见包总数: " + r.summary.visiblePackageCount);
    L.push("  AutoJS 插件: " + r.summary.pluginCount);
    L.push("  AutoJS 系应用: " + r.summary.relatedAppCount);
    L.push("");
    L.push("[插件明细]");
    if (r.plugins.length === 0) L.push("  (未发现声明 AutoJS 插件元数据的 APK)");
    for (var i = 0; i < r.plugins.length; i++) {
        var p = r.plugins[i];
        L.push("  " + (i + 1) + ") " + fmt(p.appName) + "  " + p.packageName);
        L.push("     版本: " + fmt(p.versionName) + " (" + fmt(p.versionCode) + ")");
        L.push("     插件SDK: " + fmt(p.pluginSdkVersion));
        L.push("     APK: " + fmt(p.apkPath));
        L.push("     安装: " + fmt(p.firstInstallTime) + "  更新: " + fmt(p.lastUpdateTime));
        L.push("     命中元数据: " + p.matchedMetaKeys.join(", "));
        for (var k in p.metaData) {
            L.push("       " + k + " = " + fmt(p.metaData[k]));
        }
        L.push("");
    }
    L.push("[AutoJS 系应用]");
    if (r.relatedAutojsApps.length === 0) L.push("  (无)");
    for (var j = 0; j < r.relatedAutojsApps.length; j++) {
        var a = r.relatedAutojsApps[j];
        L.push("  - " + fmt(a.appName) + "  " + a.packageName + "  v" + fmt(a.versionName));
    }
    L.push("");
    L.push("[结论]");
    L.push("  " + r.conclusion);
    if (r.notes.length > 0) {
        L.push("");
        L.push("[提示]");
        for (var n = 0; n < r.notes.length; n++) {
            L.push("  * " + r.notes[n]);
        }
    }
    return L.join("\n");
}

function saveReports(report) {
    var ts = formatTimestamp(new Date());
    var jsonText = JSON.stringify(report, null, 2);
    var textReport = buildTextReport(report);
    var candidates = ["/sdcard/脚本/插件探针报告", files.cwd() + "/插件探针报告"];
    for (var i = 0; i < candidates.length; i++) {
        try {
            files.ensureDir(candidates[i]);
            var jsonPath = files.join(candidates[i], "probe-" + ts + ".json");
            var txtPath = files.join(candidates[i], "probe-" + ts + ".txt");
            var okJson = files.write(jsonPath, jsonText);
            var okTxt = files.write(txtPath, textReport);
            if (okJson === false || okTxt === false) throw new Error("文件写入返回失败");
            return { json: jsonPath, txt: txtPath };
        } catch (e) {
            console.warn("报告目录不可用: " + candidates[i] + " (" + e + ")");
        }
    }
    return null;
}

function main() {
    console.info("== AutoJs6 插件探针 ==");
    var ctx = resolveContext();
    var host = collectHostInfo(ctx);
    console.info("[宿主] " + host.flavor + "  " + host.packageName
        + "  v" + fmt(host.versionName) + " (" + fmt(host.versionCode) + ")");
    var deviceInfo = collectDeviceInfo();
    console.info("[设备] " + deviceInfo.brand + " " + deviceInfo.model
        + "  Android " + deviceInfo.release + " (SDK " + deviceInfo.sdkInt + ")");

    var scanResult;
    try {
        scanResult = scanPackages(ctx, host.packageName);
    } catch (e) {
        console.error("[扫描] 无法获取已安装包列表: " + e);
        console.error("可能缺少包可见性权限，探针终止。");
        return;
    }
    console.log("[扫描] 可见包总数: " + scanResult.total);

    var notes = buildVisibilityNotes(scanResult.total, deviceInfo);
    var report = buildReport(host, deviceInfo, scanResult, notes);

    console.warn("[结果] 发现 AutoJS 插件 " + report.plugins.length + " 个");
    for (var i = 0; i < report.plugins.length; i++) {
        var p = report.plugins[i];
        console.info("  " + (i + 1) + ") " + fmt(p.appName) + "  " + p.packageName);
        console.log("     v" + fmt(p.versionName) + " (" + fmt(p.versionCode)
            + ")  插件SDK=" + fmt(p.pluginSdkVersion));
        console.log("     " + fmt(p.apkPath));
    }

    if (report.relatedAutojsApps.length > 0) {
        console.warn("[相关] AutoJS 系应用 " + report.relatedAutojsApps.length + " 个:");
        for (var j = 0; j < report.relatedAutojsApps.length; j++) {
            var a = report.relatedAutojsApps[j];
            console.log("  - " + fmt(a.appName) + "  " + a.packageName + "  v" + fmt(a.versionName));
        }
    }

    console.warn("[结论] " + report.conclusion);
    for (var n = 0; n < notes.length; n++) {
        console.error("[提示] " + notes[n]);
    }

    var saved = saveReports(report);
    if (saved !== null) {
        console.info("[报告] JSON: " + saved.json);
        console.info("[报告] TXT: " + saved.txt);
    } else {
        console.error("[报告] 写入失败（无存储权限），结果仅在控制台输出");
    }

    tryLoadPlugins(report.plugins);
}

main();
