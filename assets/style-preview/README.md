# 像素素材候选（风格确认用）

这里的图集全部来自 **Kenney**（<https://kenney.nl>），许可 **CC0 1.0**——可商用、
无需署名、无传染性。瓦片尺寸统一 **16×16**，与本项目 `TILE_PX = 16` 直接对齐。

| 文件 | 内容 | 来源 |
| --- | --- | --- |
| `tiny-town-tilemap.png` | Tiny Town 图集（12×11 = 132 格） | kenney.nl/assets/tiny-town |
| `tiny-farm-tilemap.png` | Tiny Farm 图集（12×11） | kenney.nl/assets/tiny-farm |
| `tiny-battle-tilemap.png` | Tiny Battle 图集（19×11 = 209 格，含载具） | kenney.nl/assets/tiny-battle |
| `onebit-colored-packed.png` | 1-Bit Pack 彩色图集（49×22 = 1078 格） | kenney.nl/assets/1-bit-pack |
| `onebit-mono-packed.png` | 1-Bit Pack 单色图集 | 同上 |
| `*-sample.png` / `onebit-*-official.png` | 各包官方示例图 | 同上 |
| `LICENSE-kenney-*.txt` | 原包许可文本（逐字保留） | 同上 |
| `index.html` | **风格确认页**（自包含，图集内嵌；`npm run preview:styles` 重新生成） | 本仓库 |

## 为什么是"确认页"而不是直接套上

瓦片序号必须由人确认，不能猜：一张 140×100 的地图由几十种瓦片拼成，序号错一个
就是一整块地面画错，而且**在浏览器里只表现为"有点怪"**，不报错、typecheck 也看不见。
所以确认页把"挑风格"与"定序号"压在同一次浏览里完成。

## 关于角色的已知缺口

Kenney 的 Tiny 系列与 1-Bit Pack **都不含角色行走图**（它们是场景/道具图集）。
当前方案是：场景与物件用图集，角色沿用项目内程序化的四向行走图，并与图集共用
同一套调色板以压住风格差。若确认后需要角色也换成图集，需要另找一套 CC0 角色包
（如 LPC 系，但那是 CC-BY-SA，会给仓库带来署名与传染性约束，需要你明确同意）。
