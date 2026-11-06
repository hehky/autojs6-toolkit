/**
 * ima 每日签到领算力  v2.0
 * 运行环境：AutoX.js（免费、无需 root）
 *
 * 实测路径（依据用户截图）：
 *   桌面 ima → 「我的copilot」→ 设置齿轮 → 用量统计
 *   → 限时活动·领取算力 → 每日登录送算力页 → 底部绿色卡片「签到」
 *
 * 用法：AutoX.js 打开无障碍 → 导入本文件 → 点运行（即时执行，无定时）
 */

// ============ 参数（一般不用改） ============
var WAIT_APP = 4500;      // 启动后等加载
var STEP_WAIT = 3000;     // 每步等界面响应
var RECON = true;         // true = 打印界面元素到日志（首次建议开着）
var MAX_ROUND = 2;        // 签到页最多尝试滑动次数

// 坐标兜底（按屏幕比例，0~1）。文本匹配全失败时才用
var FB = {
  icon:   null,           // 桌面 ima 图标位置 [x比例,y比例]，留 null 则不加兜底
  gear:   [0.93, 0.075],  // 右上角齿轮
  usage:  [0.50, 0.62],   // 下拉菜单「用量统计」
  claim:  [0.85, 0.40],   // 「领取算力」按钮
  signin: [0.25, 0.86]    // 签到按钮
};
var USE_FALLBACK = true;  // false = 只认文本，绝不盲点
// ===========================================

auto.waitFor();
console.show();
console.setSize(0.9, 0.5);

var W = device.width, H = device.height;
log("屏幕尺寸：" + W + " x " + H);

var PKG = app.getPackageName("ima");
if (!PKG) { PKG = "com.tencent.ima"; log("!! 未按名字找到 ima，用兜底包名"); }
log("ima 包名：" + PKG);

// ---------- 基础工具 ----------
var SKIP = ["已领取", "已签到", "已领", "明天再来", "明日再来", "已达上限"];

function skipped(t) {
  for (var i = 0; i < SKIP.length; i++) if (t.indexOf(SKIP[i]) >= 0) return true;
  return false;
}

/** 向上找可点击祖先 */
function clickableUp(node) {
  var p = node;
  for (var d = 0; d < 6 && p; d++) { if (p.clickable()) return p; p = p.parent(); }
  return null;
}

/**
 * 等待并点击。遍历全部匹配节点（不用 findOnce，避免被说明文字挡住真按钮）
 * 精确匹配优先，其次包含匹配；长说明句（>8字）不点
 */
function tap(kws, timeout, opt) {
  opt = opt || {};
  var end = Date.now() + (timeout || STEP_WAIT);
  while (Date.now() < end) {
    for (var i = 0; i < kws.length; i++) {
      var kw = kws[i];
      var pool = text(kw).find();          // 先精确
      if (!pool || pool.length === 0) pool = textContains(kw).find(); // 再包含
      if (!pool || pool.length === 0) continue;
      for (var j = 0; j < pool.length; j++) {
        var n = pool[j];
        var t = n.text() || "";
        if (t.length > 8 && !opt.allowLong) continue; // 说明书式长句不点
        if (skipped(t)) { log("跳过（已完成）：" + t); return "done"; }
        var tgt = clickableUp(n);
        if (!tgt || !tgt.clickable()) continue;       // 不可点就换下一个
        if (tgt.click()) {
          log("✔ 点击：" + t);
          sleep(opt.after || 1500);
          return true;
        }
      }
    }
    sleep(250);
  }
  log("✘ 未找到可点击的：" + kws.join(" / "));
  return false;
}

/** 坐标点击（比例） */
function tapPt(p, label) {
  if (!USE_FALLBACK) { log("坐标兜底已禁用，跳过 " + label); return false; }
  var x = Math.round(W * p[0]), y = Math.round(H * p[1]);
  log("→ 兜底坐标点击 " + label + " (" + x + "," + y + ")");
  click(x, y);
  sleep(1500);
  return true;
}

/** 打印当前屏所有带文字的节点 */
function recon(tag) {
  if (!RECON) return;
  log("===== 侦察[" + tag + "] =====");
  var all = clickable(true).find();
  var cnt = 0;
  for (var i = 0; i < all.length; i++) {
    var t = all[i].text() || "", d = all[i].desc() || "";
    if (!t && !d) continue;
    var b = all[i].bounds();
    log("[" + cnt++ + "] \"" + t + "\" desc=\"" + d + "\" (" + b.left + "," + b.top + "," + b.right + "," + b.bottom + ")");
    if (cnt > 40) { log("... 元素过多，截断"); break; }
  }
  if (cnt === 0) log("!! 零个可点文字节点 —— 若是 Flutter/WebView，无障碍读不到，只能走坐标");
  log("===== 侦察结束 =====");
}

/** 找不到就下滑，找得到就点 */
function findWithScroll(kws) {
  for (var r = 0; r <= MAX_ROUND; r++) {
    var res = tap(kws, 1200, { after: 1200 });
    if (res) return res;
    if (r < MAX_ROUND) {
      log("下滑找：" + kws.join("/"));
      swipe(W / 2, H * 0.75, W / 2, H * 0.35, 400);
      sleep(1000);
    }
  }
  return false;
}

/**
 * 扫尾收割：把当前页所有「可领取但未领」的按钮挨个点掉
 * 专门处理第 7 天的「满签奖励」——签到完它才解锁，且不一定是首屏
 */
function claimBonus() {
  log("—— 检查满签/额外奖励 ——");
  var claimed = 0;
  var KEY = ["满签奖励", "额外随机奖励", "额外奖励", "领取奖励", "领取算力", "领取"];
  var LOCK = ["未解锁", "连续7天", "解锁", "明日", "明天", "已达上限", "已领"];

  for (var pass = 0; pass < 4; pass++) {
    var got = false;
    for (var i = 0; i < KEY.length && !got; i++) {
      var kw = KEY[i];
      var pool = text(kw).find();
      if (!pool || pool.length === 0) pool = textContains(kw).find();
      if (!pool) continue;
      for (var j = 0; j < pool.length; j++) {
        var t = pool[j].text() || "";
        if (t.length > 10) continue;              // 长说明句不点
        var locked = false;
        for (var k = 0; k < LOCK.length; k++) if (t.indexOf(LOCK[k]) >= 0) locked = true;
        if (locked) { log("  · 未解锁/已领：" + t); continue; }
        var tgt = clickableUp(pool[j]);
        if (!tgt || !tgt.clickable()) continue;
        if (tgt.click()) {
          log("✔ 点击奖励：" + t);
          claimed++;
          got = true;
          sleep(2000);
          break;
        }
      }
    }
    if (!got) {
      // 本屏没有可领的：下滑看看（满签卡片常在下方）
      if (pass < 3) {
        log("  本屏无可领，下滑再扫");
        swipe(W / 2, H * 0.75, W / 2, H * 0.4, 400);
        sleep(1000);
      }
    }
  }
  log("奖励领取完毕，共 " + claimed + " 次");
  return claimed;
}

/**
 * 收尾：退掉 ima 内所有页面栈 → 回桌面
 * 先 back 逐层退，退到不在 ima 就停；最后 home() 双保险
 */
function backToDesktop() {
  log("—— 收尾：返回桌面 ——");
  for (var i = 0; i < 5; i++) {
    var cur = currentPackage();
    if (cur && cur !== PKG) {
      log("已退出 ima（当前：" + cur + "）");
      break;
    }
    back();
    sleep(800);
    log("  back ×" + (i + 1) + " → " + (currentPackage() || "?"));
  }
  sleep(500);
  home();
  sleep(800);
  log("已回桌面");
}

// ---------- 步骤 0：回桌面 → 找 ima 图标 → 点开 ----------
function openFromDesktop() {
  home();
  sleep(1500);
  log("已回桌面");
  recon("桌面");

  // 桌面图标文字/描述匹配
  var names = ["ima", "ima.copilot", "ima copilot", "IMA"];
  for (var i = 0; i < names.length; i++) {
    var n = text(names[i]).findOnce() || desc(names[i]).findOnce();
    if (!n) continue;
    var tgt = clickableUp(n) || n;
    if (tgt && tgt.clickable() && tgt.click()) {
      log("✔ 桌面点开：" + names[i]);
      sleep(WAIT_APP);
      return true;
    }
  }

  // 图标可能是图片无文字：用坐标兜底（你告诉我坐标我再填精确值）
  if (USE_FALLBACK && FB.icon) {
    log("桌面图标无文字，走兜底坐标");
    click(Math.round(W * FB.icon[0]), Math.round(H * FB.icon[1]));
    sleep(WAIT_APP);
    return true;
  }

  // 最后手段
  log("!! 桌面未找到 ima 图标，改用 app.launch 拉起（未经桌面）");
  app.launch(PKG);
  sleep(WAIT_APP);
  return false;
}

// ---------- 主流程 ----------
try { } catch (e) {}
openFromDesktop();
log("前台包名：" + currentPackage());
recon("启动首屏");

// 步骤 1：进入「我的copilot」
if (textContains("我的copilot").exists() || textContains("用量统计").exists()) {
  log("已在个人页或更深处");
} else {
  var ok1 = tap(["我的copilot", "copilot", "我的"], STEP_WAIT, { after: 2000 });
  if (!ok1) { log("进不去个人页，尝试坐标"); tapPt([0.5, 0.94], "底部我的"); }
}
recon("个人页");

// 步骤 2：打开设置菜单 → 点「用量统计」
if (!tap(["用量统计"], 2000, { after: 2500 })) {
  log("菜单未展开，先点齿轮");
  if (!tap(["设置", "更多", "菜单"], 2000, { after: 800 })) {
    tapPt(FB.gear, "齿轮");
  }
  if (!tap(["用量统计"], STEP_WAIT, { after: 2500 })) {
    tapPt(FB.usage, "用量统计");
  }
}
recon("用量统计页");

// 步骤 3：限时活动「领取算力」
var r3 = tap(["领取算力", "去领取", "领取"], STEP_WAIT, { after: 2500 });
if (r3 === false) {
  log("未找到领取按钮，尝试兜底");
  tapPt(FB.claim, "领取算力");
}
recon("活动页");

// 步骤 4：签到
var r4 = findWithScroll(["签到", "立即签到", "今日签到"]);
if (r4 === false) {
  log("签到按钮未找到，尝试兜底坐标");
  tapPt(FB.signin, "签到");
}
sleep(1200);
recon("签到后");

// 步骤 5：满签/额外奖励收割（第 7 天才有，平时会自动跳过）
claimBonus();
recon("奖励收割后");

// 步骤 6：收尾回桌面
backToDesktop();

log("========== 执行结束，已回桌面 ==========");
log("若任一步显示 ✘，请把上面的【侦察】日志截图发回，按真实文字/坐标校准");
