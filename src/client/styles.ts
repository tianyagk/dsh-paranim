/**
 * 页签自己的样式。颜色一律优先取 DSH 主题变量（`--dsw-alias-*`），取不到时退回
 * 一套深浅皆可读的暗色 —— 皮肤换了页面不会变成白底黑字，也不会因为变量名变化
 * 整块糊掉。**只在本 Package 内生效**（一次性插入一个 <style>，随插件卸载移除）。
 */

const CSS = `
.pa-root {
  --pa-bg: var(--dsw-alias-bg-base, #16181d);
  --pa-layer: var(--dsw-alias-bg-layer-2, #1d2027);
  --pa-layer-3: var(--dsw-alias-bg-layer-3, #242833);
  --pa-text: var(--dsw-alias-text-primary, #e6e8ee);
  --pa-text-dim: var(--dsw-alias-text-secondary, #a2a8b8);
  --pa-border: var(--dsw-alias-border-secondary, #31353f);
  --pa-accent: var(--dsw-alias-state-info-primary, #6aa1ff);
  --pa-danger: var(--dsw-alias-state-error-primary, #f07178);
  --pa-ok: var(--dsw-alias-state-success-primary, #7fd18b);
  --pa-warn: var(--dsw-alias-state-warning-primary, #e0af68);
  display: flex;
  flex-direction: column;
  /* 页签宿主给的是"有确定高度的块级容器"，所以这里的 100% 必须是*确定*高度：
     只要有一层缺了 height/min-height，flex 就退化成内容高度，页面会越撑越长
     （表现为"向下无限下坠"）。 */
  height: 100%;
  max-height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  background: var(--pa-bg);
  color: var(--pa-text);
  font-size: 12px;
  line-height: 1.5;
}
.pa-root * { box-sizing: border-box; }
.pa-head {
  display: flex;
  /* 不参与收缩：顶栏被挤成 0 高会让底下的 flex 计算反复变化。 */
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--pa-border);
  flex-wrap: wrap;
  background: var(--pa-layer);
}
.pa-tabs { display: flex; gap: 2px; }
.pa-tab {
  border: 1px solid transparent;
  background: transparent;
  color: var(--pa-text-dim);
  padding: 3px 9px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
}
.pa-tab[data-on="true"] { background: var(--pa-layer-3); color: var(--pa-text); border-color: var(--pa-border); }
.pa-tab:hover { color: var(--pa-text); }
.pa-btn {
  border: 1px solid var(--pa-border);
  background: var(--pa-layer-3);
  color: var(--pa-text);
  padding: 3px 9px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}
.pa-btn:hover { border-color: var(--pa-accent); }
.pa-btn[disabled] { opacity: .45; cursor: not-allowed; }
.pa-btn[data-primary="true"] { background: var(--pa-accent); color: #0b1220; border-color: var(--pa-accent); font-weight: 600; }
.pa-btn[data-danger="true"] { color: var(--pa-danger); border-color: var(--pa-danger); }
.pa-btn[data-tiny="true"] { padding: 1px 6px; font-size: 11px; }
.pa-spacer { flex: 1; }
.pa-dim { color: var(--pa-text-dim); }
.pa-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pa-body { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }
.pa-col { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.pa-mapwrap {
  flex: 1.35 1 0;
  /* min-height: 0 —— 没有它，flex 项的自动最小尺寸就是内容高度，而画布的高度
     又是按容器量出来的：容器被内容撑高 → 量到更大的高度 → 画布更高 → …… 无限增长。
     这一行是"向下无限下坠"的根治点，不是装饰。 */
  min-height: 0;
  min-width: 240px;
  border-right: 1px solid var(--pa-border);
  position: relative;
  overflow: hidden;
}
.pa-map {
  /* 绝对定位铺满：画布的尺寸只由容器决定，永远不会反过来影响容器高度
     （那正是 ResizeObserver + 内容高度互相喂养的回路）。 */
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  cursor: crosshair;
}
.pa-mapbar {
  position: absolute; left: 6px; top: 6px; display: flex; gap: 4px; align-items: center;
  background: color-mix(in srgb, var(--pa-layer) 88%, transparent);
  border: 1px solid var(--pa-border); border-radius: 6px; padding: 3px 5px;
}
.pa-legend {
  position: absolute; right: 6px; bottom: 6px; max-width: 74%;
  background: color-mix(in srgb, var(--pa-layer) 90%, transparent);
  border: 1px solid var(--pa-border); border-radius: 6px; padding: 4px 7px;
  color: var(--pa-text-dim); font-size: 11px; text-align: right;
}
.pa-menu {
  position: absolute; z-index: 20; min-width: 232px; max-height: 74%; overflow: auto;
  background: var(--pa-layer-3); border: 1px solid var(--pa-border); border-radius: 7px;
  box-shadow: 0 10px 28px rgba(0,0,0,.45); padding: 6px;
}
.pa-menu h4 { margin: 2px 2px 6px; font-size: 12px; }
.pa-menu .pa-row { display: flex; gap: 4px; align-items: center; margin: 3px 0; }
.pa-menu .pa-row input, .pa-menu .pa-row select {
  flex: 1; min-width: 0; background: var(--pa-layer); color: var(--pa-text);
  border: 1px solid var(--pa-border); border-radius: 4px; padding: 2px 5px; font-size: 11px;
}
.pa-side { flex: 1 1 0; min-width: 260px; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.pa-sec { border-bottom: 1px solid var(--pa-border); padding: 7px 8px; min-height: 0; }
.pa-sec:last-child { border-bottom: none; }
.pa-sec h4 { margin: 0 0 5px; font-size: 12px; display: flex; align-items: center; gap: 6px; }
.pa-scroll { overflow: auto; min-height: 0; overscroll-behavior: contain; }
.pa-list { margin: 0; padding: 0; list-style: none; }
.pa-item {
  display: flex; gap: 6px; align-items: flex-start; padding: 4px 6px; border-radius: 5px;
  border: 1px solid transparent; cursor: pointer;
}
.pa-item:hover { background: var(--pa-layer-3); }
.pa-item[data-on="true"] { background: var(--pa-layer-3); border-color: var(--pa-accent); }
.pa-item .pa-portrait { font-size: 16px; line-height: 1.2; }
.pa-item .pa-main { flex: 1; min-width: 0; }
.pa-item .pa-main b { font-weight: 600; }
.pa-chip {
  display: inline-block; padding: 0 5px; border-radius: 999px; font-size: 10px;
  border: 1px solid var(--pa-border); color: var(--pa-text-dim); margin-left: 4px;
}
.pa-chip[data-tone="ok"] { color: var(--pa-ok); border-color: var(--pa-ok); }
.pa-chip[data-tone="warn"] { color: var(--pa-warn); border-color: var(--pa-warn); }
.pa-chip[data-tone="danger"] { color: var(--pa-danger); border-color: var(--pa-danger); }
.pa-attrs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin-top: 4px; }
.pa-attr {
  border: 1px solid var(--pa-border); border-radius: 5px; padding: 2px 5px; background: var(--pa-layer);
  display: flex; justify-content: space-between; align-items: baseline; gap: 4px;
}
.pa-attr b { font-size: 13px; font-weight: 650; }
.pa-attr .pa-attrbar { height: 3px; border-radius: 2px; background: var(--pa-layer-3); overflow: hidden; }
.pa-attr .pa-attrbar i { display: block; height: 100%; background: var(--pa-accent); }
.pa-mem { border-left: 2px solid var(--pa-border); padding-left: 6px; margin: 3px 0; color: var(--pa-text-dim); }
.pa-ev { display: flex; gap: 6px; padding: 3px 2px; border-bottom: 1px dashed var(--pa-border); }
.pa-ev:last-child { border-bottom: none; }
.pa-ev .pa-tick { color: var(--pa-text-dim); min-width: 34px; }
.pa-roll { color: var(--pa-warn); }
.pa-roll[data-ok="true"] { color: var(--pa-ok); }
.pa-foot {
  flex: 0 0 auto;
  border-top: 1px solid var(--pa-border); background: var(--pa-layer);
  display: flex; flex-direction: column; gap: 5px; padding: 6px 8px;
}
.pa-foot .pa-line { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.pa-foot input[type="text"], .pa-foot textarea, .pa-form input, .pa-form textarea, .pa-form select {
  background: var(--pa-layer-3); color: var(--pa-text); border: 1px solid var(--pa-border);
  border-radius: 5px; padding: 3px 6px; font-size: 12px; font-family: inherit;
}
.pa-foot input[type="text"] { flex: 1; min-width: 120px; }
.pa-foot input[type="range"] { flex: 1; min-width: 90px; max-width: 160px; }
.pa-form { display: grid; grid-template-columns: 68px 1fr; gap: 4px 6px; align-items: center; }
.pa-form label { color: var(--pa-text-dim); }
.pa-form textarea { resize: vertical; min-height: 34px; }
.pa-err { color: var(--pa-danger); }
.pa-ok { color: var(--pa-ok); }
.pa-notice { padding: 3px 7px; border-radius: 5px; background: var(--pa-layer-3); border: 1px solid var(--pa-border); }
.pa-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.pa-kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; }
.pa-kv span:nth-child(odd) { color: var(--pa-text-dim); }
`

let inserted = false

/** 插入本 Package 的样式表（一次）。返回 disposer（卸载时移除 <style>）。 */
export function ensureCss(): () => void {
  if (inserted) return () => undefined
  const element = document.createElement('style')
  element.setAttribute('data-paranim', 'styles')
  element.textContent = CSS
  document.head.appendChild(element)
  inserted = true
  return () => {
    element.remove()
    inserted = false
  }
}
