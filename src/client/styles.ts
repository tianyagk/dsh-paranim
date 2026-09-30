/**
 * 页签样式。设计立场：
 *
 *  - **地图是主角**：面板只做低调的深色工作台（近黑画布 + 炭黑浮层 + 发丝描边），
 *    颜色一律优先取 DSH 主题变量，取不到才退回自带的一套暗色，换皮肤不会糊掉。
 *  - **层次靠明度差和 1px 描边**，不靠阴影堆叠：深色界面里大阴影只会显脏。
 *  - 每一层 flex 子项都显式 `min-height: 0`，根容器显式定高。页签宿主是"有确定
 *    高度的块级滚动容器"，缺一层就会退化成内容高度 → 页面越撑越长（无限下坠）。
 */
const CSS = `
.pa-root {
  --pa-bg: var(--dsw-alias-bg-base, #0e1116);
  --pa-layer: var(--dsw-alias-bg-layer-2, #151922);
  --pa-layer-3: var(--dsw-alias-bg-layer-3, #1c212c);
  --pa-layer-4: #232936;
  --pa-text: var(--dsw-alias-text-primary, #e8ecf4);
  --pa-text-dim: var(--dsw-alias-text-secondary, #98a2b6);
  --pa-text-faint: #6b7688;
  --pa-border: var(--dsw-alias-border-secondary, #2a3140);
  --pa-border-soft: #222836;
  --pa-accent: var(--dsw-alias-state-info-primary, #7aa2f7);
  --pa-accent-2: #ffd479;
  --pa-danger: var(--dsw-alias-state-error-primary, #f07178);
  --pa-ok: var(--dsw-alias-state-success-primary, #8bd49c);
  --pa-warn: var(--dsw-alias-state-warning-primary, #e0af68);
  --pa-shadow: 0 6px 22px rgba(0,0,0,.42);
  display: flex;
  flex-direction: column;
  /* 确定高度 + 不溢出：这是"向下无限下坠"的根治条件之一，别删。 */
  height: 100%;
  max-height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  background: var(--pa-bg);
  color: var(--pa-text);
  font-size: 12px;
  line-height: 1.55;
  font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.pa-root * { box-sizing: border-box; }
.pa-root ::-webkit-scrollbar { width: 9px; height: 9px; }
.pa-root ::-webkit-scrollbar-thumb { background: #333c4d; border-radius: 6px; border: 2px solid transparent; background-clip: content-box; }
.pa-root ::-webkit-scrollbar-thumb:hover { background: #435066; background-clip: content-box; }
.pa-root ::-webkit-scrollbar-track { background: transparent; }

/* ── 顶栏 ─────────────────────────────────────────────────────────── */
.pa-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--pa-border-soft);
  background: linear-gradient(180deg, #1a1f2b, #141821);
  flex-wrap: wrap;
}
.pa-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: #10141c;
  border: 1px solid var(--pa-border-soft);
}
.pa-tab {
  border: none;
  background: transparent;
  color: var(--pa-text-dim);
  padding: 3px 11px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: background .12s ease, color .12s ease;
}
.pa-tab:hover { color: var(--pa-text); background: #1b2130; }
.pa-tab[data-on="true"] {
  background: linear-gradient(180deg, #2c3548, #232a3a);
  color: #fff;
  box-shadow: inset 0 0 0 1px #38425a;
}

/* ── 按钮 / 徽标 / 文本 ───────────────────────────────────────────── */
.pa-btn {
  border: 1px solid var(--pa-border);
  background: linear-gradient(180deg, #232a38, #1b212c);
  color: var(--pa-text);
  padding: 3px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  transition: border-color .12s ease, transform .06s ease, background .12s ease;
}
.pa-btn:hover { border-color: #46536e; background: linear-gradient(180deg, #2a3242, #202734); }
.pa-btn:active { transform: translateY(1px); }
.pa-btn[disabled] { opacity: .42; cursor: not-allowed; }
.pa-btn[data-primary="true"] {
  background: linear-gradient(180deg, #3d63c9, #3252a8);
  border-color: #4b74dd;
  color: #fff;
  font-weight: 600;
}
.pa-btn[data-primary="true"]:hover { background: linear-gradient(180deg, #4a73dd, #3a5cc0); }
.pa-btn[data-danger="true"] { color: #ffb4b8; border-color: #5a3138; background: linear-gradient(180deg, #2c1f24, #241a1e); }
.pa-btn[data-danger="true"]:hover { border-color: #8a444c; }
.pa-btn[data-tiny="true"] { padding: 1px 7px; font-size: 11px; border-radius: 5px; }
.pa-spacer { flex: 1; }
.pa-dim { color: var(--pa-text-dim); }
.pa-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pa-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  height: 18px;
  border-radius: 999px;
  font-size: 10.5px;
  letter-spacing: .2px;
  border: 1px solid var(--pa-border);
  background: #1a1f2a;
  color: var(--pa-text-dim);
  margin-left: 4px;
  white-space: nowrap;
}
.pa-chip[data-tone="ok"] { color: var(--pa-ok); border-color: #2f5a3d; background: #16241b; }
.pa-chip[data-tone="warn"] { color: var(--pa-warn); border-color: #5c4a24; background: #241f14; }
.pa-chip[data-tone="danger"] { color: var(--pa-danger); border-color: #5a3138; background: #241a1e; }
.pa-chip[data-tone="accent"] { color: var(--pa-accent); border-color: #2f4266; background: #16202e; }

/* ── 主体 ─────────────────────────────────────────────────────────── */
.pa-body { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }
.pa-col { display: flex; flex-direction: column; min-height: 0; min-width: 0; }

/* 地图区：min-height:0 + 相对定位；画布绝对铺满，尺寸只由容器决定。 */
.pa-mapwrap {
  flex: 1.45 1 0;
  min-height: 0;
  min-width: 260px;
  border-right: 1px solid var(--pa-border-soft);
  position: relative;
  overflow: hidden;
  background: #0b0e13;
}
.pa-map { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: crosshair; }
.pa-mapvignette {
  position: absolute; inset: 0; pointer-events: none;
  box-shadow: inset 0 0 0 1px #2a3346, inset 0 0 90px rgba(0,0,0,.55);
}

.pa-mapbar {
  position: absolute; left: 10px; top: 10px;
  display: flex; gap: 5px; align-items: center;
  padding: 4px 6px;
  border-radius: 9px;
  border: 1px solid #2c3547;
  background: rgba(14,17,23,.82);
  backdrop-filter: blur(8px);
  box-shadow: var(--pa-shadow);
}
.pa-legend {
  position: absolute; left: 10px; bottom: 10px; max-width: calc(100% - 20px);
  padding: 5px 9px;
  border-radius: 8px;
  border: 1px solid #2c3547;
  background: rgba(14,17,23,.82);
  backdrop-filter: blur(8px);
  color: var(--pa-text-dim); font-size: 11px;
  box-shadow: var(--pa-shadow);
}
.pa-legend b { color: var(--pa-text); font-weight: 600; }

/* ── 右键菜单 ─────────────────────────────────────────────────────── */
.pa-menu {
  position: absolute; z-index: 30;
  min-width: 260px; max-height: 76%; overflow: auto;
  padding: 9px;
  border-radius: 10px;
  border: 1px solid #33405a;
  background: linear-gradient(180deg, #1b2130, #161b25);
  box-shadow: 0 16px 40px rgba(0,0,0,.6);
}
.pa-menu h4 { margin: 0 0 7px; font-size: 12.5px; font-weight: 600; }
.pa-menu .pa-row { display: flex; gap: 5px; align-items: center; margin: 4px 0; }
.pa-menu .pa-row > span:first-child { flex: 0 0 auto; }
.pa-menu .pa-row input, .pa-menu .pa-row select {
  flex: 1; min-width: 0;
  background: #10141c; color: var(--pa-text);
  border: 1px solid var(--pa-border); border-radius: 5px;
  padding: 3px 6px; font-size: 11.5px; font-family: inherit;
}
.pa-menu .pa-row input:focus, .pa-menu .pa-row select:focus { outline: none; border-color: #46536e; }

/* ── 右列 ─────────────────────────────────────────────────────────── */
.pa-side { flex: 1 1 0; min-width: 288px; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.pa-sec { border-bottom: 1px solid var(--pa-border-soft); padding: 9px 11px; min-height: 0; }
.pa-sec:last-child { border-bottom: none; }
.pa-sec h4 {
  margin: 0 0 7px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .3px;
  color: #cfd7e6;
  display: flex; align-items: center; gap: 6px;
}
.pa-scroll { overflow: auto; min-height: 0; overscroll-behavior: contain; }

/* ── 列表项 ───────────────────────────────────────────────────────── */
.pa-list { margin: 0; padding: 0; list-style: none; }
.pa-item {
  display: flex; gap: 8px; align-items: flex-start;
  padding: 6px 7px; margin-bottom: 3px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background .12s ease, border-color .12s ease;
}
.pa-item:hover { background: #1a2030; }
.pa-item[data-on="true"] { background: #1c2334; border-color: #3a4a6b; box-shadow: inset 0 0 0 1px rgba(122,162,247,.18); }
.pa-item .pa-portrait {
  flex: 0 0 auto;
  width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 7px;
  background: #10141c;
  border: 1px solid var(--pa-border);
  font-size: 15px; line-height: 1;
}
.pa-item .pa-main { flex: 1; min-width: 0; }
.pa-item .pa-main b { font-weight: 600; color: #eef2f9; }

/* ── 六维属性 ─────────────────────────────────────────────────────── */
.pa-attrs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-top: 5px; }
.pa-attr {
  border: 1px solid var(--pa-border); border-radius: 7px;
  padding: 4px 7px;
  background: linear-gradient(180deg, #1a202c, #151a24);
  display: flex; flex-direction: column; gap: 2px;
}
.pa-attr > span { display: flex; justify-content: space-between; align-items: baseline; }
.pa-attr b { font-size: 14px; font-weight: 650; color: #f0f4fb; font-variant-numeric: tabular-nums; }
.pa-attr input[type="number"] {
  width: 42px; text-align: right;
  background: #0f131a; color: #eef2f9;
  border: 1px solid var(--pa-border); border-radius: 5px;
  font-size: 13px; font-weight: 600; padding: 1px 4px;
}
.pa-attrbar { height: 3px; border-radius: 2px; background: #232a38; overflow: hidden; }
.pa-attrbar i { display: block; height: 100%; background: linear-gradient(90deg, #4a6fd4, #7aa2f7); }

/* ── 记忆 / 事件流 ────────────────────────────────────────────────── */
.pa-mem {
  border-left: 2px solid #303a4e;
  padding: 2px 0 2px 8px;
  margin: 4px 0;
  color: #b6c0d2;
}
.pa-mem[data-kind="thought"] { border-left-color: #6b5cff; color: #a9b3c9; font-style: italic; }
.pa-mem[data-kind="whisper"] { border-left-color: var(--pa-accent-2); color: #e8dcc0; }
.pa-mem[data-kind="summary"] { border-left-color: var(--pa-ok); }
.pa-ev {
  display: flex; gap: 8px;
  padding: 5px 2px;
  border-bottom: 1px solid #1b212c;
}
.pa-ev:last-child { border-bottom: none; }
.pa-ev .pa-tick { color: var(--pa-text-faint); min-width: 36px; font-variant-numeric: tabular-nums; }
.pa-ev .pa-evbody { flex: 1; min-width: 0; }
.pa-roll {
  margin-top: 2px;
  padding: 2px 6px;
  border-radius: 5px;
  background: #201a12;
  border: 1px solid #4a3d22;
  color: var(--pa-warn);
  font-size: 11px;
}
.pa-roll[data-ok="true"] { background: #12231a; border-color: #2c5540; color: var(--pa-ok); }

/* ── 底栏 ─────────────────────────────────────────────────────────── */
.pa-foot {
  flex: 0 0 auto;
  border-top: 1px solid var(--pa-border-soft);
  background: linear-gradient(180deg, #141821, #10141c);
  display: flex; flex-direction: column; gap: 6px; padding: 7px 10px;
}
.pa-foot .pa-line { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
.pa-foot input[type="text"], .pa-foot textarea, .pa-form input, .pa-form textarea, .pa-form select, .pa-side select {
  background: #0f131a; color: var(--pa-text);
  border: 1px solid var(--pa-border); border-radius: 6px;
  padding: 4px 7px; font-size: 12px; font-family: inherit;
}
.pa-foot input[type="text"]:focus, .pa-form input:focus, .pa-form textarea:focus, .pa-form select:focus, .pa-side select:focus {
  outline: none; border-color: #46536e; box-shadow: 0 0 0 2px rgba(122,162,247,.12);
}
.pa-foot input[type="text"] { flex: 1; min-width: 140px; }
.pa-foot input[type="range"] { flex: 1; min-width: 90px; max-width: 170px; accent-color: var(--pa-accent); }
.pa-form { display: grid; grid-template-columns: 62px 1fr; gap: 5px 8px; align-items: center; }
.pa-form label { color: var(--pa-text-dim); font-size: 11.5px; }
.pa-form textarea { resize: vertical; min-height: 38px; line-height: 1.5; }
.pa-err { color: var(--pa-danger); }
.pa-ok { color: var(--pa-ok); }
.pa-notice {
  padding: 2px 9px; border-radius: 999px;
  background: #16241b; border: 1px solid #2f5a3d; color: var(--pa-ok);
}
.pa-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.pa-kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; }
.pa-kv span:nth-child(odd) { color: var(--pa-text-dim); }
.pa-kv span:nth-child(even) { color: #dbe2ee; }
.pa-hr { height: 1px; background: var(--pa-border-soft); margin: 8px 0; }
`

let inserted = false
let styleElement: HTMLStyleElement | null = null

/** 插入本 Package 的样式表（一次）。返回 disposer（卸载时移除 <style>）。 */
export function ensureCss(): () => void {
  if (inserted && styleElement !== null) {
    return () => {
      styleElement?.remove()
      styleElement = null
      inserted = false
    }
  }
  const element = document.createElement('style')
  element.setAttribute('data-paranim', 'styles')
  element.textContent = CSS
  document.head.appendChild(element)
  styleElement = element
  inserted = true
  return () => {
    element.remove()
    if (styleElement === element) {
      styleElement = null
      inserted = false
    }
  }
}
