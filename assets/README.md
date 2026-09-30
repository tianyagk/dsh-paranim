# dsh-paranim · Smallville 素材索引

本目录的素材用于构建 dsh-paranim 的默认沙盒镜像 **Smallville（斯坦福小镇）**。所有人物名、地标名、物件名、年龄与身份**均来自开源仓库的真实文件**，未凭空捏造；凡属推算或本项目的演绎，一律标注 `inferred`；凡查不到、无法证实的，标注 `unverified` 并保留空缺。

---

## 一、文件清单

| 文件 | 内容 | 规模 |
|---|---|---|
| `smallville.json` | 默认沙盒镜像数据：地图、地标、物件、角色、关系、道具 | 19 places / 12 objects / 8 agents / 8 relations / 12 props |
| `roster.md` | Smallville 全 25 位居民的名册与「可加入候选」表 | 25 行 |
| `design-notes.md` | 三套开源实现的记忆/日程/人格结构对比与合并建议 | — |
| `README.md` | 本文件：素材来源、许可、取用范围与未证实项 | — |

---

## 二、来源索引

### 1. Stanford Generative Agents（主力来源）

- **仓库**：<https://github.com/joonspk-research/generative_agents>
- **许可**：**Apache-2.0**
- **对应论文**：*Generative Agents: Interactive Simulacra of Human Behavior*, UIST 2023
- **取用了什么**：
  - **地图元数据**：`environment/frontend_server/static_dirs/assets/the_ville/matrix/maze_meta_info.json` → `world_name: "the ville"`, `maze_width: 140`, `maze_height: 100`, `sq_tile_size: 32`
  - **19 个地标分区名**：`matrix/special_blocks/sector_blocks.csv`
  - **68 个建筑内部区域名**：`matrix/special_blocks/arena_blocks.csv`
  - **50 个物件类型名**：`matrix/special_blocks/game_object_blocks.csv`
  - **各地标的真实网格坐标**：由 `matrix/maze/arena_maze.csv`（140×100 网格矩阵，14000 格）逐格解析出每栋建筑的包围盒
  - **各物件的真实网格坐标**：由 `matrix/maze/game_object_maze.csv`（44718 字节）解析
  - **25 位居民的完整设定**：`storage/base_the_ville_n25/personas/<Name>/bootstrap_memory/scratch.json`（25 份，逐份读取 `age` / `innate` / `learned` / `currently` / `lifestyle` / `living_area`）
  - **居民关系线索**：`static_dirs/assets/the_ville/agent_history_init_n25.csv`（17709 字节，25 位居民的 Whisper 初始关系描述）
- **放在哪**：
  - 19 个地标 → `smallville.json` 的 `places`（**x/y/w/h 全部为原版真实坐标**）
  - 12 个道具 → `smallville.json` 的 `props`（坐标取自原版物件矩阵）
  - 8 位角色 → `smallville.json` 的 `agents`（`age`/`persona`/`backstory` 等直接对应原版字段）
  - 全 25 位居民 → `roster.md`
  - 运行时字段结构（记忆流参数、日程、反思阈值）→ `design-notes.md` 第 3 节

### 2. a16z AI Town

- **仓库**：<https://github.com/a16z-infra/ai-town>
- **许可**：**MIT**
- **取用了什么**：
  - **精灵槽位清单**：`data/spritesheets/` 下 `f1.ts`…`f8.ts`（人物）+ `p1.ts`…`p3.ts` + `player.ts` + `types.ts`；所有人物共用 `public/assets/32x32folk.png`
  - **启用的角色与人格**：`data/characters.ts` 中启用的 5 位（`Lucky`/f1、`Alice`/f3、`Bob`/f4、`Stella`/f6、`Pete`/f7）与注释停用的 3 位（`Alex`/f5、`Kurt`/f2、`Kira`/f8），每人 `identity` + `plan` 两字段
  - **移动参数**：`movementSpeed = 0.75`（tiles per second）
  - **物件命名**：`public/assets/spritesheets/` 下的 `campfire.png`、`windmill.png`、`gentlewaterfall32.png`、`gentlesparkle32.png`
- **放在哪**：
  - `smallville.json` 的 `objects`——其中 **`campfire`、`windmill`、`waterfall`、`sparkle-streetlamp` 直接采用上述真实命名**；其余街道家具按同一命名思路扩展（见下方 `inferred` 说明）
  - 角色/精灵解耦与 `plan` 句式 → `design-notes.md` 第 2 节

### 3. Microverse

- **仓库**：<https://github.com/KsanaDock/Microverse>（**注**：任务给出的 `holab-hku/Microverse` 返回 404，不存在；经 GitHub 搜索确认，同名项目中唯一的多智能体社会模拟实现是 KsanaDock 的这个仓库，约 2.5k star）
- **许可**：**MIT**
- **取用了什么**：
  - **角色人格五字段**：`script/CharacterPersonality.gd` 的 `PERSONALITY_CONFIG`（8 位角色，字段为 `position` / `personality` / `speaking_style` / `work_duties` / `work_habits`）
  - **记忆系统**：`script/ai/memory/MemoryManager.gd` 的 `MemoryType`（PERSONAL / INTERACTION / TASK / EMOTION / EVENT）与 `MemoryImportance`（LOW=1 / NORMAL=3 / HIGH=5 / CRITICAL=10），记忆对象结构 `{content, timestamp, type, importance, created_at}`
  - **对话历史结构**：`script/ChatHistory.gd`（按对话对象分桶的 `history`、`{message, timestamp, participants[]}`）
  - **背景故事/世界规则层**：`script/ai/background_story/README.md`（预设 Office/School/Jail 三种地图背景 + 用户自定义社会规则）
- **放在哪**：全部写入 `design-notes.md` 第 1 节，并作为第 4 节合并 schema 的主要依据。
- **未取用**：该仓库的角色（Stephen / Tom / Lea / Alice / Grace / Jack / Joe / Monica，一家叫 SleepySheep 的公司）与 dsh-paranim 的世界观无关，**未被写入任何数据文件**，仅作结构参考。

### 4. jev-town

- **仓库**：<https://github.com/jev-p/jev-town> → **返回 404，仓库不存在**
- **许可**：无法确认（`unverified`）
- **取用了什么**：**无**
- **说明**：任务要求「如不存在就找 jev 的同类项目并说明」。经 GitHub 仓库搜索核实，以 `jev` 为关键词的结果（`cobanov/awesome-jev`、`wuyoscar/jev-skill` 等）**全部与多智能体社会模拟无关**——它们指向 TypeSafe AI 的 "Jev" 模型及其工具链，属**同名不同指**，不应冒充。因此**未取用任何内容**，也未以其他项目顶替。详见 `design-notes.md` 第 5 节。

---

## 三、`inferred`（推算/演绎，非原版事实）

这些内容**在原仓库里不存在**，是本项目为 dsh-paranim 补的，已尽量做到与真实设定自洽：

1. **全 25 位角色的属性六项 `attrs`（STR/CON/DEX/APP/INT/POW）**。原版是**纯自然语言 prompt 驱动，没有任何数值属性系统**。数值依据是各角色真实的 `innate` 性格词与 `learned` 职业设定（如 Wolfgang 是「化学系学生 + 学生运动员」→ STR 8 / CON 8；Klaus 是社会学研究生 → INT 9）。
2. **全 25 位角色的中文译名**。原版只有英文名。
3. **8 位入场角色的 `appearance`（外貌）**。原版 `scratch.json` **没有**这个字段——依据各角色真实的 `innate`/`learned`/`currently` 演绎。
   > **变更记录（v0.2.0）**：早期版本曾带 `fear`（恐惧）与 `secret`（隐瞒之事）两个字段，现已**从 schema、界面与镜像数据中一并移除**。理由是它们属于"小说家写人物"时的内在设定，放进角色卡会让每张卡都背上两个填空，并与 `persona` / `backstory` / `goal` 的语义互相覆盖；有所忌惮或有所隐瞒完全可以写进这三个既有字段，模型同样读得到。清理用 `node scripts/migrate-drop-fields.mjs fear secret`（只删键，其它内容原样保留）。
4. **`objects` 里的 12 件街道家具坐标**。命名思路来自 AI Town 的真实物件名，坐标是**按地标之外的空地布设**的（已校验：12 个 `objects` 全部落在 19 个地标之外的空白格上，无一重叠）。
5. **`agents` 的 `plan`（每日日程）**。原版 `scratch.json` 的 `daily_req` / `f_daily_schedule` 在初始状态下**均为空数组**，日程是运行时才生成的。这里的 plan 依据各角色真实的 `lifestyle` 字段（作息时间）与 `currently`（当下在做的事）演绎，并与原版设定一致。
6. **`relations` 的 `affinity` 数值与部分 `label`**。关系本身有真实依据（见下），但 affinity 的**数值**是本项目给的。有真实依据的部分：
   - John Lin ↔ Mei Lin：夫妻（`living_area` 同为林家宅卧室）
   - Sam Moore ↔ Tom Moreno：原版 Tom 的 `currently` 明确写着 *"You don't like Sam Moore."*
   - Klaus ↔ Maria：论文记载「问 Klaus 想和谁共度时间，他选 Maria 而不是 Wolfgang」
   - Isabella ↔ Maria：论文记载两人在霍布斯咖啡馆商量情人节派对
   - John Lin ↔ Yuriko Yamamoto：论文记载 *"he knows his neighbor, Yuriko Yamamoto, well"*
7. **`map.tile` 取 32 而非 schema 示例中的 16**。原版 `maze_meta_info.json` 明确写着 `sq_tile_size: 32`，且 140×100 网格正是按 32px 瓦片设计的。取 32 以忠于原版事实。

---

## 四、`unverified`（未证实，宁缺勿造）

| 项 | 说明 |
|---|---|
| `jev-town` 的存在性 | 仓库 404。若有该项目，需要正确的仓库地址才能补采 |
| `jev-town` 的许可 | 同上，无法确认 |
| 角色**精确年龄**以外的生平细节 | 原版只给了 `age` 一个数字，无生日、无出生地、无具体年份。任何更细的年龄相关设定都属演绎 |
| `Carlos Gomez` 等角色的**性别自称** | 原版部分角色使用 they/them 或未指明，本素材沿用中性表述，未做断定 |
| 原版**实际启用**的角色数量 | 原仓库 `base_the_ville_n25/` 下有 25 个 persona 目录（已逐一核实全部 25 个）；但论文与 README 描述的运行配置可能不同，未进一步验证 |

---

## 五、采集时发现的事实校正

原版真实数据与常见转述/任务描述存在出入，本素材**一律以原仓库文件为准**：

1. **不存在 `Carlos Lopez`**，原版是 **`Carlos Gomez`**（诗人），住 `Carlos Gomez's apartment`。`Francisco Lopez` 是另一个人（演员）。仓库中无任何 `Carlos Lopez` 目录或引用。
2. **`Abigail Chen` 不是咖啡馆老板**，她是**数字艺术家与动画师**（原版 `learned` 原文：*"Abigail Chen is a digital artist and animator…"*）。霍布斯咖啡馆的主人是 `Isabella Rodriguez`。
3. **`Wolfgang Schulz` 不是钢琴家**，他是**橡树山学院化学系学生兼学生运动员**。
4. **`Maria Lopez` 是物理系**（`scratch.json` 原文 *"studying physics"*），而论文举例段落里写过 "Chemistry test"——**两处不一致，本素材以 `scratch.json` 为准**。
5. **`Mei Lin` 是大学教授**（教哲学），不是家庭主妇；家庭主妇是 `Jane Moreno`。
6. **`Tom Moreno` 是杂货店主**，药房那一半归 `John Lin`，两人同店不同柜台。
7. 地标规范名：**`Lin family's house`**（非 "Lin family home"）、**`The Willows Market and Pharmacy`**、**`artist's co-living space`**（小写 a、带撇号）。

---

## 六、坐标校验结果

`smallville.json` 落盘后已用脚本校验，结果如下：

```
JSON 合法 ✓
places=19  objects=12  agents=8  relations=8  props=12   map=140x100 tile=32
越界（超出 0..139 / 0..99）：无 ✓
19 个 places 两两重叠：无 ✓
8 个 agents 初始坐标重复：无 ✓
12 个 objects 落在某地标内：无（全部在空地）✓
12 个 props 落在对应地标内：是（语义正确，如 piano → hobbs-cafe）✓
```

19 个地标的 `x/y/w/h` **全部来自原版 `arena_maze.csv` 的真实包围盒**（例如 Hobbs Cafe 为 `(72,19)-(83,26)`，Johnson Park 为 `(21,41)-(35,51)`，Oak Hill College 由教室+图书馆+走廊三个 arena 合并为 `(108,19)-(124,34)`）。

8 位入场角色落在**各自真实的住所室内**：阿比盖尔在合居空间自己的房间、克劳斯/玛丽亚在学院宿舍各自的房间、梅与约翰在林家宅主卧、汤姆在莫雷诺家主卧、山姆在摩尔家客厅、伊莎贝拉在自己公寓。

---

## 七、复现方式

本目录所有数据均由以下公开接口直接读取生成，无手工编造：

- 原始文件：`https://raw.githubusercontent.com/<owner>/<repo>/main/<path>`（网络拥塞时可改用 `https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/<path>`）
- 目录列举：`https://api.github.com/repos/<owner>/<repo>/contents/<path>`
- 坐标解析：读取 `arena_maze.csv` / `game_object_maze.csv` 的单行 14000 格逗号分隔矩阵（索引方式 `v[y*140 + x]`），对每个非 0 的建筑/物件编号求包围盒
