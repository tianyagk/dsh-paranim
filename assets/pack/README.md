# assets/pack —— 归一后的图集（运行时素材）

**这里的 PNG 是生成物**，由 `npm run assets:normalize` 从 `assets/style-preview/`
的原始图集产出：把各家的 1px 间隙消掉、拼成严格 `16×16` 的规范网格，运行时按
`列/行` 直接取格，不必在每个取图处再算 `x*17+1`（那种算式最容易错一格）。

| 文件 | 网格 | 分工 |
| --- | --- | --- |
| `tiny-town.png` | 12×11 = 132 | 主素材：地面、道路、屋顶、墙体、树 |
| `tiny-farm.png` | 12×11 = 132 | 主素材：田垄、栅栏、农舍 |
| `tiny-battle.png` | 18×11 = 198 | 主素材：载具、机械、道具 |
| `city.png` | 37×28 = 1036 | 补充：镇上物件与设施（城市题材） |
| `onebit.png` | 49×22 = 1078 | **后备**：Tiny 系列缺的标记 / 状态 / 事件符号 |
| `characters.png` | 54×12 = 648 | 角色（4 向，16×16） |

`manifest.json` 记录每张图的网格与出处；`src/client/sheetData.ts` 是它们的
base64 快照（`npm run assets:snapshot` 生成），供浏览器端直接解码。

## 许可

全部来自 [Kenney](https://kenney.nl)，**CC0 1.0**：可商用、免署名、无传染性。
原始许可文本逐字保留在 `assets/style-preview/LICENSE-kenney-*.txt`；
按 CC0 条款，本仓库**不需要**因此承担任何署名或开源义务。

## 工具

| 命令 | 用途 |
| --- | --- |
| `npm run assets:normalize` | 原始图集 → 规范网格（去间隙、补调色板索引色解码） |
| `npm run assets:snapshot` | 规范网格 → `src/client/sheetData.ts`（base64 内嵌） |
| `npm run assets:all` | 上面两步 |
| `npm run assets:inspect <图集> [--rows A-B] [--at 列:行]` | 把图集打到终端逐格查看（序号不能靠猜） |
