/**
 * 淘宝会员领红包 v4.2（AutoJs6）
 * v4：去掉泛化的 desc「关闭」/id close（会误点「我的淘宝」页模块的×，弹出“确定关闭当前模块”），只留广告专用词
 * 步骤（录制 2026-11-04 02:17）：我的淘宝 → 会员中心 → 一键领取
 * 定位：先认文字锚，认不到才用录制坐标
 * 第3步：有「一键领取」先点；之后不管领没领，「查看更多」都要点一下
 * 弹窗：后台守卫 + 每步前后清场；误触「确定关闭当前模块」时一律返回，不确认
 */
var STEPS = [
    { name: "我的淘宝", re: /^我的淘宝$/,       x: 645, y: 1462, wait: 3000 },
    { name: "会员中心", re: /^会员中心/, x: 382, y: 225, wait: 3500 } // 结构分析: desc="会员中心点击有惊喜" 节点中心
];
var BASE_W = 0; // 换手机时填录制那台的屏宽，同一台手机保持0
var POP_TEXT = /^(跳过|跳过广告|关闭广告|我知道了|知道了|以后再说|暂不|暂不需要|残忍离开|下次再说|不感兴趣)$/;
var POP_DESC = /^(关闭广告|关闭弹窗|跳过广告)$/;
var POP_ID = /.*(ad_close|popup_close|splash_skip|skip_ad).*/;
var DANGER = /确定关闭当前模块|关闭原因|确定关闭/; // 模块关闭确认框：只退不确认

function L(m) { console.log("[HB] " + m); }
function find(re) { return textMatches(re).findOnce() || descMatches(re).findOnce(); }
function tapW(w) { var b = w.bounds(); click(b.centerX(), b.centerY()); }
var k = 1;
function tapXY(x, y) { click(Math.round(x * k), Math.round(y * k)); }

function dangerGuard() {
    if (!(find(DANGER) || textContains("关闭原因").findOnce())) return false;
    back(); L("误弹模块关闭确认 → 返回，不确认"); sleep(900);
    if (find(DANGER) || textContains("关闭原因").findOnce()) { // 返回没关掉：点右上角×（屏宽93%、高度55%处）
        click(Math.round(device.width * 0.935), Math.round(device.height * 0.548)); L("点×取消"); sleep(900);
    }
    return true;
}
function killOnce() {
    if (dangerGuard()) return true;
    var w = textMatches(POP_TEXT).findOnce() || descMatches(POP_DESC).findOnce()
         || idMatches(POP_ID).clickable(true).findOnce();
    if (w) {
        tapW(w); L("关弹窗: " + (w.text() || w.desc() || w.id())); sleep(900);
        dangerGuard();
        return true;
    }
    return false;
}
function clearPops() { for (var i = 0; i < 6 && killOnce(); i++); }

var busy = false;
var guard = threads.start(function () {
    while (true) { if (!busy) { try { killOnce(); } catch (e) { } } sleep(800); }
});
function quit(m) { L(m); guard.interrupt(); exit(); }

auto.waitFor();
k = BASE_W ? device.width / BASE_W : 1;
app.launchPackage("com.taobao.taobao");
var t0 = Date.now();
while (currentPackage() !== "com.taobao.taobao" && Date.now() - t0 < 20000) sleep(500);
if (currentPackage() !== "com.taobao.taobao") quit("淘宝未启动");
sleep(4000);
clearPops();

// 第1、2步：文字锚优先，坐标兜底
STEPS.forEach(function (s) {
    clearPops();
    busy = true;
    var w = find(s.re);
    if (w) { tapW(w); L(s.name + " ← 文字锚"); }
    else { tapXY(s.x, s.y); L(s.name + " ← 录制坐标 " + s.x + "," + s.y); }
    busy = false;
    sleep(s.wait);
    clearPops();
});

// 第3步：一键领取（有就点）→ 查看更多（必点），最多下滑6屏
var claimed = false;
for (var i = 0; i < 6; i++) {
    clearPops();
    if (!claimed) {
        var get = find(/^一键领取$/);
        if (get) { busy = true; tapW(get); busy = false; claimed = true; L("一键领取 ✔"); sleep(2500); clearPops(); continue; }
    }
    var more = find(/^查看更多$/);
    if (more) {
        busy = true; tapW(more); busy = false; L("查看更多 ✔");
        sleep(2500); clearPops();
        quit("===== 完成：" + (claimed ? "已领取＋已点查看更多" : "已点查看更多（本次无一键领取）") + " =====");
    }
    L("未见按钮，下滑 " + (i + 1));
    swipe(device.width / 2, device.height * 0.72, device.width / 2, device.height * 0.30, 500);
    sleep(2000);
}
quit("===== 6屏内没找到查看更多" + (claimed ? "（一键领取已点）" : "") + " =====");
