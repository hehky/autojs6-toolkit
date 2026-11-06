/**
 * 界面结构分析器（精简版，1-2秒出结果）
 * 只 dump 屏幕上半部（y<45%）的可点容器，带 class / id / bounds / text / desc
 * 用法：停在目标界面（我的淘宝）→ 运行 → 日志贴回
 * 目的：拿到真实 class/id，写成结构规则（改版只要 id 不变就自动找到）
 */
(function () {
    auto.waitFor();
    function L(m) { console.log(m); }
    L("===== 结构分析 =====");
    L("包名:" + currentPackage() + " 页面:" + currentActivity());
    var cs = clickable(true).find();
    var out = [];
    for (var i = 0; i < cs.length; i++) {
        try {
            var b = cs[i].bounds();
            if (b.width() <= 0 || b.height() <= 0) continue;
            if (b.top > device.height * 0.45) continue;   // 只看上半部
            var cls = (cs[i].className() || "").split(".").pop();
            var idv = cs[i].id() || "";
            var tx = cs[i].text() || "";
            var de = cs[i].desc() || "";
            out.push("@" + Math.round(b.centerX()) + "," + Math.round(b.centerY()) +
                     " " + Math.round(b.width()) + "x" + Math.round(b.height()) +
                     " [" + cls + "] id=" + idv + " T='" + tx + "' D='" + de + "'");
        } catch (e) { }
    }
    L("上半部可点容器:" + out.length + " 个");
    for (var j = 0; j < out.length; j++) L("[" + j + "] " + out[j]);
    L("===== 结束 =====");
})();
