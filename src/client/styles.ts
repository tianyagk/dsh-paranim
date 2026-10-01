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
  /**
   * 布局根的三条约束，缺一条整页都会塌。
   *
   * 此前这里只有配色 —— .pa-body 虽然写着 flex: 1 1 auto，但父容器不是
   * flex，那条规则**从未生效**：head / body / foot 按普通块流排列，body 的高度
   * 完全由内容决定，于是右侧那几个长列表（沙盒库、图层编辑、资源池）把整页
   * 一路撑到两千多像素。地图画布跟着变成 425×2163，地图内容绘制在画布中央，
   * 视口里看到的几乎全是空白——**点上去算出的格子落在地图之外，被边界检查
   * 丢掉，表现就是"怎么涂都没反应"，而且不报任何错**。（用 Playwright 实测
   * canvas 的 CSS 尺寸才发现的：此前一直盯着服务端查，方向完全错了。）
   *
   *  - display:flex + column：让 head/body/foot 纵向排，body 才能吃掉剩余高度
   *  - height:100%：给"剩余高度"一个确定参照
   *  - min-height:0：允许子项收缩（flex 项默认 min-height:auto，不肯缩小）
   */
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  /* 主题的全部变量由 theme.ts 注入（见 applyTheme）。这里只留两条兜底，
     避免注入失败时页面是白板——兜底不求好看，只求看得见。 */
  --pa-bg: #0b0e13;
  --pa-text: #eef2f8;
  /* 这一行是"白底白字"的根治点：.pa-root 是唯一覆盖整个页签的层，
     它不铺底，侧栏（.pa-side / .pa-sec 都是透明布局层）就会露出宿主页面的底色。
     以前只在 .pa-mapwrap 上给了背景，所以只有地图区是深色，右侧栏是透的。 */
  background: var(--pa-bg);
  color: var(--pa-text);
  --pa-overlay: rgba(14,17,23,.86);
  --pa-vignette: rgba(0,0,0,.45);
}
.pa-root * { box-sizing: border-box; }
.pa-root ::-webkit-scrollbar { width: 9px; height: 9px; }
.pa-root ::-webkit-scrollbar-thumb { background: var(--pa-layer4); border-radius: 6px; border: 2px solid transparent; background-clip: content-box; }
.pa-root ::-webkit-scrollbar-thumb:hover { background: var(--pa-textFaint); background-clip: content-box; }
.pa-root ::-webkit-scrollbar-track { background: transparent; }

/* ── 顶栏 ─────────────────────────────────────────────────────────── */
.pa-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--pa-borderSoft);
  background: linear-gradient(180deg, var(--pa-layer), var(--pa-bg));
  flex-wrap: wrap;
}
.pa-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: var(--pa-bg);
  border: 1px solid var(--pa-borderSoft);
}
.pa-tab {
  border: none;
  background: transparent;
  color: var(--pa-textDim);
  padding: 3px 11px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: background .12s ease, color .12s ease;
}
.pa-tab:hover { color: var(--pa-text); background: var(--pa-layer3); }
.pa-tab[data-on="true"] {
  background: linear-gradient(180deg, var(--pa-layer4), var(--pa-layer3));
  color: var(--pa-text);
  box-shadow: inset 0 0 0 1px var(--pa-border), 0 1px 0 rgba(255,200,97,.16);
}

/* ── 按钮 / 徽标 / 文本 ───────────────────────────────────────────── */
.pa-btn {
  border: 1px solid var(--pa-border);
  background: linear-gradient(180deg, var(--pa-layer3), var(--pa-layer));
  color: var(--pa-text);
  padding: 3px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  transition: border-color .12s ease, transform .06s ease, background .12s ease;
}
.pa-btn:hover { border-color: var(--pa-textFaint); background: linear-gradient(180deg, var(--pa-layer4), var(--pa-layer3)); }
.pa-btn:active { transform: translateY(1px); }
.pa-btn[disabled] { opacity: .42; cursor: not-allowed; }
.pa-btn[data-primary="true"] {
  background: linear-gradient(180deg, var(--pa-gold), var(--pa-goldDim));
  border-color: var(--pa-gold);
  color: var(--pa-bg);
  font-weight: 650;
}
.pa-btn[data-primary="true"]:hover { filter: brightness(1.08); }
.pa-btn[data-danger="true"] { color: var(--pa-danger); border-color: var(--pa-danger); background: transparent; }
.pa-btn[data-danger="true"]:hover { background: var(--pa-layer3); }
.pa-btn[data-tiny="true"] { padding: 1px 7px; font-size: 11px; border-radius: 5px; }
.pa-spacer { flex: 1; }
.pa-dim { color: var(--pa-textDim); }
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
  background: var(--pa-layer3);
  color: var(--pa-textDim);
  margin-left: 4px;
  white-space: nowrap;
}
.pa-chip[data-tone="ok"] { color: var(--pa-ok); border-color: var(--pa-ok); }
.pa-chip[data-tone="warn"] { color: var(--pa-warn); border-color: var(--pa-warn); }
.pa-chip[data-tone="danger"] { color: var(--pa-danger); border-color: var(--pa-danger); }
.pa-chip[data-tone="accent"] { color: var(--pa-accent); border-color: var(--pa-accent); }

/* ── 主体 ─────────────────────────────────────────────────────────── */
.pa-body { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; }
.pa-col { display: flex; flex-direction: column; min-height: 0; min-width: 0; }

/* 地图区：min-height:0 + 相对定位；画布绝对铺满，尺寸只由容器决定。 */
.pa-mapwrap {
  flex: 1.45 1 0;
  min-height: 0;
  min-width: 260px;
  border-right: 1px solid var(--pa-borderSoft);
  position: relative;
  overflow: hidden;
  background: var(--pa-bg);
}
.pa-map { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: crosshair; }
/* 编辑镜像时给地图一圈高亮：让人一眼看出"现在点画布是在改镜像，不是在改正在跑的世界" */
.pa-map[data-editing='true'] { outline: 1px solid color-mix(in srgb, var(--pa-accent, #7aa2f7) 70%, transparent); outline-offset: -1px; }
.pa-mapvignette {
  position: absolute; inset: 0; pointer-events: none;
  box-shadow: inset 0 0 0 1px var(--pa-border), inset 0 0 90px var(--pa-vignette);
  /* 暗角强度跟主题走：浅色主题下压黑 45% 会把整张地图糊掉 */
}

.pa-mapbar {
  position: absolute; left: 10px; top: 10px;
  display: flex; gap: 5px; align-items: center;
  padding: 4px 6px;
  border-radius: 9px;
  border: 1px solid var(--pa-border);
  background: var(--pa-overlay);
  backdrop-filter: blur(8px);
  box-shadow: var(--pa-shadow);
}
.pa-legend {
  position: absolute; left: 10px; bottom: 10px; max-width: calc(100% - 20px);
  padding: 5px 9px;
  border-radius: 8px;
  border: 1px solid var(--pa-border);
  background: var(--pa-overlay);
  backdrop-filter: blur(8px);
  color: var(--pa-textDim); font-size: 11px;
  box-shadow: var(--pa-shadow);
}
.pa-legend b { color: var(--pa-text); font-weight: 600; }

/* ── 右键菜单 ─────────────────────────────────────────────────────── */
.pa-menu {
  position: absolute; z-index: 30;
  min-width: 260px; max-height: 76%; overflow: auto;
  padding: 9px;
  border-radius: 10px;
  border: 1px solid var(--pa-border);
  background: var(--pa-layer3);
  box-shadow: var(--pa-shadow);
}
.pa-menu h4 { margin: 0 0 7px; font-size: 12.5px; font-weight: 600; }
.pa-menu .pa-row { display: flex; gap: 5px; align-items: center; margin: 4px 0; }
.pa-menu .pa-row > span:first-child { flex: 0 0 auto; }
.pa-menu .pa-row input, .pa-menu .pa-row select {
  flex: 1; min-width: 0;
  background: var(--pa-bg); color: var(--pa-text);
  border: 1px solid var(--pa-border); border-radius: 5px;
  padding: 3px 6px; font-size: 11.5px; font-family: inherit;
}
.pa-menu .pa-row input:focus, .pa-menu .pa-row select:focus { outline: none; border-color: var(--pa-gold); }

/* ── 右列 ─────────────────────────────────────────────────────────── */
.pa-side { flex: 1 1 0; min-width: 288px; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.pa-sec {
  border-bottom: 1px solid var(--pa-borderSoft);
  padding: 9px 11px;
  /**
   * flex: 0 0 auto —— 区块按内容高度排布，**不许被压缩**。
   *
   * 默认是 flex-shrink:1：当侧栏内容比容器高时，浏览器会把每个区块压扁到
   * 小于自身高度，于是它们叠在一起——文字糊成一团、按钮被上层区块盖住点不动。
   * （实测：石头地面这个笔刷按钮的中心点上，最上层元素是别人的说明文字。）
   * 原先这里的 min-height:0 只解决"能不能缩到 0"，解决不了"该不该缩"。
   * 需要占满剩余高度的区块自己写了 inline 的 flex:1，优先级更高，不受影响。
   */
  flex: 0 0 auto;
  min-height: 0;
}
.pa-sec:last-child { border-bottom: none; }
.pa-sec h4 {
  margin: 0 0 7px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .3px;
  color: var(--pa-text);
  display: flex; align-items: center; gap: 6px;
}
.pa-scroll { overflow: auto; min-height: 0; overscroll-behavior: contain; }

/**
 * 世界页的左右分栏：地图在左，推演日志在右。
 * 两列都必须是 min-width: 0，否则 flex 子项不肯收缩、长文本会把它们撑破。
 */
.pa-split { display: flex; gap: 8px; flex: 1; min-height: 0; }
.pa-split-main { flex: 1 1 auto; min-width: 0; overflow: auto; }
.pa-split-feed { min-width: 0; overflow: auto; padding-left: 8px; }

/* 可拖拽的分隔线：细但好抓（命中区 9px，视觉只有 1px 线） */
.pa-splitter { flex: 0 0 auto; position: relative; background: transparent; }
.pa-splitter[data-dir="v"] { width: 9px; cursor: col-resize; margin-left: -4px; }
.pa-splitter[data-dir="h"] { height: 9px; cursor: row-resize; margin-top: -4px; }
.pa-splitter::after {
  content: ''; position: absolute; background: var(--pa-border); transition: background .12s ease;
}
.pa-splitter[data-dir="v"]::after { left: 4px; top: 0; bottom: 0; width: 1px; }
.pa-splitter[data-dir="h"]::after { top: 4px; left: 0; right: 0; height: 1px; }
.pa-splitter:hover::after, .pa-splitter[data-dragging="true"]::after { background: var(--pa-gold); }

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
.pa-item:hover { background: var(--pa-layer3); }
.pa-item[data-on="true"] { background: var(--pa-layer3); border-color: var(--pa-gold); }
.pa-item .pa-portrait {
  flex: 0 0 auto;
  width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 7px;
  background: var(--pa-bg);
  border: 1px solid var(--pa-border);
  font-size: 15px; line-height: 1;
}
.pa-item .pa-main { flex: 1; min-width: 0; }
.pa-item .pa-main b { font-weight: 600; color: var(--pa-text); }

/* ── 六维属性 ─────────────────────────────────────────────────────── */
.pa-attrs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin-top: 5px; }
.pa-attr {
  border: 1px solid var(--pa-border); border-radius: 7px;
  padding: 4px 7px;
  background: linear-gradient(180deg, var(--pa-layer3), var(--pa-layer));
  display: flex; flex-direction: column; gap: 2px;
}
.pa-attr > span { display: flex; justify-content: space-between; align-items: baseline; }
.pa-attr b { font-size: 14px; font-weight: 650; color: var(--pa-text); font-variant-numeric: tabular-nums; }
.pa-attr input[type="number"] {
  width: 42px; text-align: right;
  background: var(--pa-bg); color: var(--pa-text);
  border: 1px solid var(--pa-border); border-radius: 5px;
  font-size: 13px; font-weight: 600; padding: 1px 4px;
}

/* ── 记忆 / 事件流 ────────────────────────────────────────────────── */
.pa-mem {
  border-left: 2px solid var(--pa-border);
  padding: 2px 0 2px 8px;
  margin: 4px 0;
  color: var(--pa-textDim);
}
.pa-mem[data-kind="thought"] { border-left-color: var(--pa-accent); font-style: italic; }
.pa-mem[data-kind="whisper"] { border-left-color: var(--pa-gold); color: var(--pa-text); }
.pa-mem[data-kind="summary"] { border-left-color: var(--pa-ok); }

/* ── 消息栏：按语义着色的三条渲染路径 ─────────────────────────────────
   同一份事件数据，三种呈现：卡片 / 日志 / 对白。颜色全部来自主题变量，
   语义→颜色的映射在 theme.ts 的 tone 定义里，样式这里只负责"长什么样"。 */

.pa-feed { display: flex; flex-direction: column; gap: 5px; }

/* 语义色调：一组通用变量，三种模式共用 */
.pa-ev {
  --tone: var(--pa-textDim);
  --toneBg: transparent;
  --toneBorder: var(--pa-borderSoft);
  border-left: 3px solid var(--toneBorder);
  border-radius: 0 6px 6px 0;
}
.pa-ev[data-tone="system"]    { --tone: var(--pa-textFaint); --toneBorder: var(--pa-border); }
.pa-ev[data-tone="move"]      { --tone: var(--pa-accent);    --toneBorder: var(--pa-accent); }
.pa-ev[data-tone="say"]       { --tone: var(--pa-text);      --toneBorder: var(--pa-textFaint); }
.pa-ev[data-tone="act"]       { --tone: var(--pa-textDim);   --toneBorder: var(--pa-textFaint); }
.pa-ev[data-tone="mutate"]    { --tone: var(--pa-warn);      --toneBorder: var(--pa-warn); }
.pa-ev[data-tone="directive"] { --tone: var(--pa-gold);      --toneBorder: var(--pa-gold); }
.pa-ev[data-tone="spawn"]     { --tone: var(--pa-ok);        --toneBorder: var(--pa-ok); }
.pa-ev[data-tone="despawn"]   { --tone: var(--pa-textFaint); --toneBorder: var(--pa-border); }
.pa-ev[data-tone="rollOk"]    { --tone: var(--pa-ok);        --toneBorder: var(--pa-ok); }
.pa-ev[data-tone="rollFail"]  { --tone: var(--pa-danger);    --toneBorder: var(--pa-danger); }
.pa-ev[data-tone="rollCrit"]  { --tone: var(--pa-gold);      --toneBorder: var(--pa-gold); }
.pa-ev[data-tone="rollFumble"]{ --tone: var(--pa-danger);    --toneBorder: var(--pa-danger); }

/* 模式一：卡片（默认）——类型标签 + 正文 + 判定块 */
.pa-feed[data-mode="card"] .pa-ev {
  padding: 5px 9px 6px;
  background: var(--pa-feedRow);
  border-radius: 0 6px 6px 0;
}
.pa-feed[data-mode="card"] .pa-evhead {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 2px;
}
.pa-feed[data-mode="card"] .pa-evkind {
  font-size: 10px; letter-spacing: .4px;
  color: var(--tone);
  border: 1px solid var(--tone);
  border-radius: 999px;
  padding: 0 6px;
  opacity: .95;
}
.pa-feed[data-mode="card"] .pa-evbody { color: var(--pa-feedText); }

/* 模式二：日志——单行，等宽，色调只在左侧条与类型字上 */
.pa-feed[data-mode="line"] { gap: 0; }
.pa-feed[data-mode="line"] .pa-ev {
  display: flex; gap: 8px; align-items: baseline;
  padding: 3px 0 3px 8px;
  border-radius: 0;
  border-left-width: 2px;
}
.pa-feed[data-mode="line"] .pa-ev:hover { background: var(--pa-feedRow); }
.pa-feed[data-mode="line"] .pa-evkind {
  flex: 0 0 46px; font-size: 10px; color: var(--tone); text-align: right;
}
.pa-feed[data-mode="line"] .pa-evbody { color: var(--pa-feedText); flex: 1; min-width: 0; }

/* 模式三：对白——说话的行高亮成大段，其余压成小注 */
.pa-feed[data-mode="chat"] .pa-ev {
  padding: 6px 10px;
  background: var(--pa-feedRow);
  border-radius: 0 8px 8px 0;
}
.pa-feed[data-mode="chat"] .pa-ev[data-tone="say"] {
  background: var(--pa-layer3);
  border-left-width: 4px;
}
.pa-feed[data-mode="chat"] .pa-ev[data-tone="say"] .pa-evbody {
  font-size: 13.5px;
  color: var(--pa-feedText);
}
.pa-feed[data-mode="chat"] .pa-ev:not([data-tone="say"]):not([data-tone="directive"]) .pa-evbody {
  color: var(--pa-feedMeta);
  font-size: 11.5px;
}
.pa-feed[data-mode="chat"] .pa-evkind { display: none; }

/* 判定块：三种模式共用，颜色跟语义走 */
.pa-roll {
  display: inline-block;
  margin-top: 3px;
  padding: 2px 7px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--tone) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--tone) 45%, transparent);
  color: var(--tone);
  font-size: 11px;
  line-height: 1.5;
}
.pa-roll b { color: var(--tone); font-weight: 700; }

/* 正文里的语义片段 */
.pa-seg-quote { color: var(--tone); }
.pa-seg-dice { font-family: ui-monospace, monospace; color: var(--pa-gold); }
.pa-seg-object { color: var(--pa-text); border-bottom: 1px dotted var(--pa-textFaint); }

.pa-evhead .pa-evtime { color: var(--pa-feedMeta); font-size: 10.5px; margin-left: auto; }

/* 当前想法：列表里一行、编辑器里一块。用引号式左边条与前文区分。 */
.pa-thought {
  margin-top: 3px;
  padding-left: 7px;
  border-left: 2px solid var(--pa-border);
  color: var(--pa-textDim);
  font-size: 11.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pa-thoughtblock {
  display: grid; grid-template-columns: 62px 1fr; gap: 4px 8px;
  margin-top: 6px;
  padding: 6px 8px;
  border: 1px solid var(--pa-border);
  border-radius: 7px;
  background: var(--pa-layer);
  font-size: 12px;
}
.pa-thoughtblock .pa-dim { font-size: 11.5px; }

/* 物件资源池：贴图按钮按组摆开，点一下即选 */
.pa-palette { display: flex; flex-direction: column; gap: 6px; }
.pa-pal-group { display: flex; flex-direction: column; gap: 3px; }
.pa-sprs { display: flex; flex-wrap: wrap; gap: 4px; }
.pa-spr {
  display: flex; flex-direction: column; align-items: center; gap: 1px;
  width: 46px; padding: 3px 2px;
  background: var(--pa-layer3);
  border: 1px solid var(--pa-border);
  border-radius: 6px;
  color: var(--pa-textDim);
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
}
.pa-spr:hover { background: var(--pa-layer4); color: var(--pa-text); }
.pa-spr[data-on="true"] { border-color: var(--pa-gold); box-shadow: 0 0 0 1px var(--pa-gold); color: var(--pa-text); }
/* 图层/笔刷的选中态：data-on 此前只对 tab/item/spr 生效，按钮上用它没有任何反馈 */
.pa-btn[data-on="true"] { border-color: var(--pa-gold); background: var(--pa-layer3); color: var(--pa-text); }
.pa-spr-cv { width: 30px; height: 30px; display: block; image-rendering: pixelated; }

/* 布局编辑：每处地标一行 + 五个小字段 */
.pa-place {
  border: 1px solid var(--pa-border);
  border-radius: 7px;
  padding: 6px 8px;
  margin-bottom: 5px;
  background: var(--pa-layer);
}
.pa-place[data-on="true"] { border-color: var(--pa-gold); }
.pa-place-grid {
  display: grid;
  grid-template-columns: 1fr 52px 52px 52px 52px 78px;
  gap: 4px;
  margin-top: 5px;
}
.pa-place-cell { display: flex; flex-direction: column; gap: 1px; }
.pa-place-cell > span { font-size: 10px; }
.pa-place-cell input, .pa-place-cell select {
  background: var(--pa-layer3);
  border: 1px solid var(--pa-border);
  border-radius: 5px;
  color: var(--pa-text);
  font-size: 11px;
  font-family: inherit;
  padding: 2px 4px;
  min-width: 0;
  width: 100%;
}

/* ── 底栏 ─────────────────────────────────────────────────────────── */
.pa-foot {
  flex: 0 0 auto;
  border-top: 1px solid var(--pa-borderSoft);
  background: linear-gradient(180deg, var(--pa-layer), var(--pa-bg));
  display: flex; flex-direction: column; gap: 6px; padding: 7px 10px;
}
.pa-foot .pa-line { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
.pa-foot input[type="text"], .pa-foot textarea, .pa-form input, .pa-form textarea, .pa-form select, .pa-side select {
  background: var(--pa-bg); color: var(--pa-text);
  border: 1px solid var(--pa-border); border-radius: 6px;
  padding: 4px 7px; font-size: 12px; font-family: inherit;
}
.pa-foot input[type="text"]:focus, .pa-form input:focus, .pa-form textarea:focus, .pa-form select:focus, .pa-side select:focus {
  outline: none; border-color: var(--pa-gold); box-shadow: 0 0 0 2px rgba(255,200,97,.14);
}
.pa-foot input[type="text"] { flex: 1; min-width: 140px; }
.pa-foot input[type="range"] { flex: 1; min-width: 90px; max-width: 170px; accent-color: var(--pa-accent); }
.pa-form { display: grid; grid-template-columns: 62px 1fr; gap: 5px 8px; align-items: center; }
.pa-form label { color: var(--pa-textDim); font-size: 11.5px; }
.pa-form textarea { resize: vertical; min-height: 38px; line-height: 1.5; }
.pa-err { color: var(--pa-danger); }
.pa-ok { color: var(--pa-ok); }
.pa-notice {
  padding: 2px 9px; border-radius: 999px;
  border: 1px solid var(--pa-ok); color: var(--pa-ok);
}
.pa-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.pa-kv { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; }
.pa-kv span:nth-child(odd) { color: var(--pa-textDim); }
.pa-kv span:nth-child(even) { color: var(--pa-text); }

/* 主题与消息模式选择器（底栏，可即时看到效果） */
.pa-picker { display: flex; align-items: center; gap: 4px; }
.pa-picker .pa-dim { font-size: 11px; }
.pa-swatches { display: flex; gap: 3px; }
.pa-swatch {
  display: inline-flex; align-items: center; gap: 3px;
  height: 18px; padding: 0 5px 0 4px; border-radius: 5px; cursor: pointer;
  border: 1px solid var(--pa-border);
  font-size: 10px; font-family: inherit;
}
.pa-swatch b { font-weight: 500; }
.pa-swatch[data-on="true"] { border-color: var(--pa-gold); box-shadow: 0 0 0 1px var(--pa-gold); }
.pa-swatch i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.pa-seg { display: flex; border: 1px solid var(--pa-border); border-radius: 6px; overflow: hidden; }
.pa-seg button {
  border: none; background: transparent; color: var(--pa-textDim);
  padding: 2px 8px; font-size: 11px; cursor: pointer; font-family: inherit;
}
.pa-seg button[data-on="true"] { background: var(--pa-layer4); color: var(--pa-text); }
.pa-seg button:hover { color: var(--pa-text); }
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
