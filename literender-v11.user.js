// ==UserScript==
// @name         LiteRender 通用轻量渲染
// @namespace    lite-render
// @version      1.1.0
// @description  通用网页轻量渲染：禁用过渡/毛玻璃 + 图片/iframe 懒加载 + 异步解码；处理延迟插入。v1.1 去重/健壮性优化。
// @run-at       document-start
// @match        *://*/*
// @grant        none
// ==/UserScript==
/* LiteRender · 通用轻量渲染（hark.js 通用化）
 * 只减渲染负担，不隐藏任何元素；保留 animation，转圈和打字点照常。
 * 零外部依赖 / 零侵入 / 可回滚（style 元素可移除）。
 * 兼容：Chromium 系（QUETTA / Chrome / Edge）及 Firefox，document-start 注入，不依赖 GM_* API。
 *
 * v1.1.0 优化（相对 v1.0，功能不变，只减开销、补健壮性）：
 *   - WeakSet 去重：同一节点只处理一次，避免 MutationObserver 反复写属性
 *   - 单标签提前返回：img/iframe 不再做无用的 querySelectorAll
 *   - 属性写入前比对：已是 lazy/async 就不再写 DOM
 *   - documentElement 判空 + 轮询重试：document-start 更早阶段不抛错
 *   - MutationObserver 回调合并到微任务：高频插入（无限滚动）减少重复扫描
 * 哲学不变：不隐藏元素、保留 animation、不动 video/audio（preload=none 高风险）。
 */
(function () {
  'use strict';

  // ============ CSS：禁用过渡 + 毛玻璃，保留 animation ============
  const CSS = `
    *, *::before, *::after {
      transition: none !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }
    html { scroll-behavior: auto !important; }
  `;
  let cssDone = false;
  function addCSS() {
    if (cssDone) return;
    if (document.getElementById('lite-render')) { cssDone = true; return; }
    const target = document.head || document.documentElement;
    if (!target) return;                       // 由 start() 重试触发，不再空转 setTimeout 链
    const s = document.createElement('style');
    s.id = 'lite-render';
    s.textContent = CSS;
    target.appendChild(s);
    cssDone = true;
  }

  // ============ 轻量处理（去重 + 写入前比对） ============
  const handled = new WeakSet();                // 同一节点只处理一次
  function applyImg(img) {
    if (handled.has(img)) return;
    handled.add(img);
    if (!img.hasAttribute('loading')) img.loading = 'lazy';   // 尊重显式 eager
    if (img.decoding !== 'async') img.decoding = 'async';
  }
  function applyFrame(f) {
    if (handled.has(f)) return;
    handled.add(f);
    if (!f.hasAttribute('loading')) f.loading = 'lazy';
  }
  function lite(root) {
    if (!root || root.nodeType !== 1) return;
    const tag = root.tagName;
    if (tag === 'IMG') { applyImg(root); return; }             // 提前返回，不再扫 iframe
    if (tag === 'IFRAME') { applyFrame(root); return; }        // 提前返回，不再扫 img
    const imgs = root.querySelectorAll('img');
    for (let i = 0; i < imgs.length; i++) applyImg(imgs[i]);
    const frames = root.querySelectorAll('iframe');
    for (let i = 0; i < frames.length; i++) applyFrame(frames[i]);
  }

  // ============ 启动：判空重试 + 延迟插入 ============
  function start() {
    const target = document.documentElement;
    if (!target) { setTimeout(start, 0); return; }            // document-start 早期可能未就绪
    addCSS();
    lite(target);                                             // 防御 late injection

    let pending = null;
    function flush() {
      const batch = pending; pending = null;
      if (!batch) return;
      for (let i = 0; i < batch.length; i++) lite(batch[i]);
    }
    try {
      new MutationObserver((list) => {
        if (!pending) pending = [];
        for (let i = 0; i < list.length; i++) {
          const adds = list[i].addedNodes;
          for (let j = 0; j < adds.length; j++) pending.push(adds[j]);
        }
        // 合并到微任务：同一帧多次插入只扫一次
        if (typeof queueMicrotask === 'function') queueMicrotask(flush);
        else setTimeout(flush, 0);
      }).observe(target, { childList: true, subtree: true });
    } catch (e) { /* MO 不可用：已有内容已处理，静默降级 */ }
  }
  start();
})();
