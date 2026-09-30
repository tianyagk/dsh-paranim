# 像素素材（原始图集与许可）

运行时用的图集在 `../pack/`（由 `npm run assets:normalize` 从这里的原始文件产出）。
本目录只保留**原始图集 + 逐字许可文本**：归一脚本要读它们，许可文本是授权凭证。

| 文件 | 内容 |
| --- | --- |
| `tiny-town-tilemap.png` / `tiny-farm-tilemap.png` / `tiny-battle-tilemap.png` | Tiny 系列原始图集（带 1px 间隙） |
| `rogue-city-tilemap.png` | Roguelike Modern City 原始图集 |
| `onebit-colored-packed.png` / `onebit-mono-packed.png` | 1-Bit Pack 彩色与单色 |
| `roguelike-characters.png` | Roguelike Characters（16×16 角色图集） |
| `LICENSE-kenney-*.txt` | 各包原始许可文本（逐字保留） |

**许可**：全部来自 [Kenney](https://kenney.nl)，**CC0 1.0** —— 可商用、免署名、无传染性。
按 CC0 条款，本仓库不因此承担任何署名或开源义务；保留许可文本只为可追溯。

**已移除**：早期用于"挑风格"的对比页（`index.html`）、其生成器
（`scripts/make-style-preview.mjs`）与各包官方示例图。风格已确认，对比页的职责结束；
要核瓦片序号现在用 `npm run assets:inspect <图集>`（直接读归一后的网格，比截图更准）。
