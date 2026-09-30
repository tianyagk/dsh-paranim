# dsh-paranim 设计笔记 · 从三套开源实现里能借鉴什么

采集时间：本次素材作业期间，全部字段来自对仓库原始文件的直接读取（详见每节末尾的取值路径）。

---

## 0. 一句话结论

- **斯坦福原版**给的是**完整到可抄的运行时字段**（记忆流参数、日程、反思阈值全套写在一个 `scratch.json` 里）。
- **Microverse** 给的是**工程化的记忆分类与重要性分级**，以及一套「人格配置只描述人、不描述数值」的写法。
- **AI Town** 给的是**极简的三人格字段 + 一个 `plan` 字符串**，以及 `f1..f8` 精灵槽位的资源组织方式。
- **jev-town 不存在**（见第 5 节）。

---

## 1. Microverse（`KsanaDock/Microverse`，MIT，Godot 4 / GDScript）

> ⚠️ 采集校正：任务里给的 `holab-hku/Microverse` 返回 404，该仓库不存在。GitHub 搜索确认同名项目里唯一的多智能体社会模拟实现是 **`KsanaDock/Microverse`**（约 2.5k star，MIT，self-described *"A god-simulation sandbox game built on Godot 4 as a multi-agent AI social simulation system"*，README 自述 *"Similar to Stanford AI Town"*）。以下全部取自该仓库。

### 1.1 人格配置：五字段，全是自然语言（`script/CharacterPersonality.gd`）

```gdscript
const PERSONALITY_CONFIG = {
    "Stephen": {
        "position":       "SleepySheep公司老板",
        "personality":    "奥斯卡级虚伪表演家……",
        "speaking_style": "张嘴就是'期权池已备好'……",
        "work_duties":    "每周发布新的'三年愿景'……",
        "work_habits":    "下班时间必在公司群发'深夜奋斗者照片'……"
    },
    ...
}
```

**值得借鉴的点**：它把人格拆成 **5 个正交维度**，而不是一段散文。其中 `speaking_style`（说话方式）和 `work_duties`/`work_habits`（职责与习惯）是**可直接喂给 LLM 当收敛约束**的——比一大段 personality 更能稳定控制语感。

对 dsh-paranim 的映射：

| Microverse 字段 | dsh-paranim 建议 | 理由 |
|---|---|---|
| `position` | `concept` | 一个短语就能定位角色在社会结构里的位置 |
| `personality` | `persona` | 直接对应 |
| `speaking_style` | 建议新增 `voice` | 让 NPC 说话像同一个人，是长期扮演里最先崩的一环 |
| `work_duties` | `plan`（稳态部分） | 与每日计划不同，这是「职责」层的恒定约束 |
| `work_habits` | `plan`（细节层） | 给 LLM 提供可循环的日常素材 |

`CharacterPersonality.gd` 里还有个防御性写法值得抄——查不到时返回兜底：

```gdscript
static func get_personality(character_name: String) -> Dictionary:
    if character_name in PERSONALITY_CONFIG:
        return PERSONALITY_CONFIG[character_name]
    return { "personality": "普通的办公室职员", "speaking_style": "正常的交谈方式" }
```

### 1.2 记忆系统：类型 × 重要性 = 二维打分（`script/ai/memory/MemoryManager.gd`）

```gdscript
enum MemoryType {
    PERSONAL,      # 个人记忆
    INTERACTION,   # 互动记忆
    TASK,          # 任务记忆
    EMOTION,       # 情感记忆
    EVENT          # 事件记忆
}

enum MemoryImportance {
    LOW = 1,
    NORMAL = 3,
    HIGH = 5,
    CRITICAL = 10
}

var memory_obj = {
    "content":    memory_content,
    "timestamp":  "2025-01-01 20:30",        # 人可读
    "type":       memory_type,                # 上述 5 类
    "importance": importance,                 # 1 / 3 / 5 / 10
    "created_at": Time.get_unix_time_from_system()   # 机器可排序
}
```

**值得借鉴的点**（比原版更适合我们）：

1. **同时存人可读时间与 unix 时间戳**。LLM prompt 要前者，排序与衰减要后者。原版 scratch.json 只有相对时刻，Microverse 的「双时间戳」更省事。
2. **记忆类型枚举**让「互动记忆」和「任务记忆」分开存储——查询时可以只取 `INTERACTION` 塞进对话 prompt，只取 `TASK` 塞进规划 prompt，避免把整个记忆流都塞进上下文。
3. **重要性是离散档位而非 1-10 连乘**（1/3/5/10）。档位比连续值更好让 LLM 自己打分，也更省 token。
4. **`_cleanup_old_memories`**：记忆条数有上限，超了就清旧/清低分的。长期跑下去必须有这条，否则上下文必然爆。
5. **`get_formatted_memories_for_prompt(character, max_count)`**：有专门的「格式化给 prompt」的出口，把「按重要性和时间排序」这件事收在记忆模块内部，不让调用方各自拼字符串。

### 1.3 对话历史：按「对话对象」分桶（`script/ChatHistory.gd`）

```gdscript
var history = {}    # key = 对方名字

var message_data = {
    "message":      message,
    "timestamp":    Time.get_unix_time_from_system(),
    "participants": participants.duplicate()   # 本次对话的参与者快照
}
# 插入时按 timestamp 顺序插入，保证重放时顺序正确
```

**值得借鉴的点**：`history` 的 key 是**对话对象**而不是全局单流。这意味着「我和克劳斯的关系」是**按关系维度可检索**的——比一条全局日志更贴近人记忆的样子。`participants` 快照则让群聊、私聊能用同一个结构存。

### 1.4 背景故事系统：世界规则与角色分离（`script/ai/background_story/README.md`）

```
三种预设地图背景：Office（办公室）/ School（学校）/ Jail（监狱）

每种背景包含：
- 地图名称
- 机构名称
- 背景描述
- 预设社会规则
```

再叠加用户通过 UI 加的 `custom_rules`，最终 `get_all_rules()` = 预设 + 自定义，**全部注入 AI 对话 prompt**。

**值得借鉴的点**：把「世界规则」当成和角色卡平级的**独立可编辑层**，而不是散落在每个角色的设定里。dsh-paranim 里这正好对应 `smallville.json` 的 `map` / `places` 层级——**建议再加一个 `worldRules: string[]`**，让「这个镇子当晚戒严」「咖啡馆今天歇业」这类全局约束有地方放，不必改任何一张角色卡。

---

## 2. AI Town（`a16z-infra/ai-town`，MIT）

### 2.1 角色清单：`f1..f8` 是精灵槽位，不是角色

```
data/spritesheets/  →  f1.ts f2.ts f3.ts f4.ts f5.ts f6.ts f7.ts f8.ts
                       p1.ts p2.ts p3.ts player.ts types.ts
public/assets/      →  32x32folk.png   (所有 f1..f8 共用这一张图集)
                       player.png, gentle-obj.png, rpg-tileset.png, magecity.png
                       tilemap.json, background.mp3
```

`f1..f8` 是**八套人物精灵**（共用 `32x32folk.png`）；`p1..p3` 与 `player` 是玩家侧精灵。**角色与精灵槽位是一对多**——`data/characters.ts` 里用 `character: 'f1'` 把某个具体人物绑到某个槽位。

```js
export const movementSpeed = 0.75;   // tiles per second
```

### 2.2 三个人格字段 + plan（`data/characters.ts`）

```js
{
  name: 'Lucky',
  character: 'f1',
  identity: `Lucky is always happy and curious, and he loves cheese. ...`,
  plan: 'You want to hear all the gossip.'
}
```

库内**实际启用的 5 位**：Lucky(`f1`)、Alice(`f3`)、Bob(`f4`)、Stella(`f6`)、Pete(`f7`)；
**被注释停用的 3 位**：Alex(`f5`)、Kurt(`f2`)、Kira(`f8`)。

**值得借鉴的点**：

1. **`identity` + `plan` 两字段就能跑起来**——人格一段、**意图一句**。`plan` 用第二人称祈使句写（*"You want to…"*），这比第三人称描述更能让模型把它当作自己的目标。dsh-paranim 的 `goal` 字段建议沿用这个句式。
2. **精灵槽位与角色解耦**：`f1..f8` 是资源，`name` 是内容。dsh-paranim 的沙盒如果要做可视化，应该照抄这个解耦——换角色不必换贴图。
3. **被注释掉的三个角色是一份现成的「待启用」名单**，连 `identity`/`plan` 都写好了。

### 2.3 物件命名（`public/assets/spritesheets/`）

```
campfire.png          gentlesparkle32.png
gentlewaterfall32.png windmill.png
```

**值得借鉴的点**：物件名是**具体名词 + 尺寸后缀**（`32`），并按自然景观（篝火 / 风车 / 瀑布 / 光点）组织，而不是按功能性目录（furniture/、decor/）。这给了 `smallville.json` 里 `objects` 那 12 件街道家具的命名依据。

> 说明：`smallville.json` 的 `objects` 里，`campfire`、`windmill`、`waterfall`、`sparkle-streetlamp` 直接对应上表的真实命名；其余（长椅、垃圾桶、喷泉、告示牌、橡树、集市摊位、路牌）是**按同一命名思路扩展**的，属 `inferred`——AI Town 并未提供这些具体精灵。

---

## 3. 斯坦福原版：一份 `scratch.json` 里的完整运行时

这是三家里字段最全、也最应该直接抄的。以下字段**全部来自真实读取** `storage/base_the_ville_n25/personas/<Name>/bootstrap_memory/scratch.json`。

### 3.1 人格层（4 个字段，全部是自然语言）

| 字段 | 示例（John Lin） |
|---|---|
| `name` / `first_name` / `last_name` | `John Lin` / `John` / `Lin` |
| `age` | `45` |
| `innate` | `patient, kind, organized` |
| `learned` | `John Lin is a pharmacy shop keeper at the Willow Market and Pharmacy who loves to help people.` |
| `currently` | `John Lin is living with his wife, Mei Lin, and son, Eddy Lin, … John is also curious about who will be running for the local mayor election next month…` |
| `lifestyle` | `John Lin goes to bed around 10pm, awakes up around 6am, eats dinner around 5pm.` |
| `living_area` | `the Ville:Lin family's house:Mei and John Lin's bedroom` |

**注意 `living_area` 用的是「世界:分区:房间」三段冒号路径**——这就是 agent 与地图的绑定方式，也是 `smallville.json` 里 8 个 agent 初始坐标的取值依据（各自落进自己那间房）。

`innate` / `learned` / `currently` 的分工非常干净：**天性 / 学到的背景 / 当下正在做的事**。dsh-paranim 的 `persona` / `backstory` / `goal` 应对应这层。

### 3.2 认知参数层（直接可复用的调参）

```json
"vision_r": 8,                    // 视野半径
"att_bandwidth": 8,               // 注意力带宽
"retention": 8,                   // 记忆保持
"recency_w": 1, "relevance_w": 1, "importance_w": 1,
"recency_decay": 0.995,           // 记忆衰减率
"importance_trigger_max": 250,
"importance_trigger_curr": 250,
"importance_ele_n": 0,
"thought_count": 5
```

**三权打分（recency × relevance × importance）+ 0.995 衰减**是原版检索记忆的核心公式。dsh-paranim 若要实现检索，这四个数字可以直接起手。

### 3.3 反思与日程层

```json
"daily_reflection_time": 180,        // 每天的反思时刻
"daily_reflection_size": 5,          // 一次反思产出几条
"overlap_reflect_th": 4,
"kw_strg_event_reflect_th": 10,
"kw_strg_thought_reflect_th": 9,
"daily_plan_req": "",
"daily_req": [],
"f_daily_schedule": [],
"f_daily_schedule_hourly_org": [],
"act_address": null, "act_start_time": null, "act_duration": null,
"act_description": null, "act_obj_description": null
```

**这就是任务里说的 `plan` / `reflection` 结构的原版出处**：

- `daily_req` → 当天要完成的需求列表（**plan**）
- `f_daily_schedule` / `f_daily_schedule_hourly_org` → 细粒度 / 小时粒度的全天日程（**plan 的展开**）
- `daily_reflection_time` + `daily_reflection_size` + 三个 `*_reflect_th` 阈值 → 什么时候触发反思、一次反思几条（**reflection**）
- `act_*` 一族 → 当前正在执行的动作及其对象（**可被观测、可被仲裁的状态**）

`act_obj_event` 是 `[null, null, null]` 三元组，与 `act_event` 配对——原版用它记录「谁在对谁做什么」，这是让两个 agent 的行动互相可见的关键结构。

---

## 4. 给 dsh-paranim 的合并建议

把三家的长处叠起来，agent 运行时的最小充分结构：

```jsonc
{
  // —— 来自 Microverse 1.1（人格五维，自然语言）
  "concept": "药剂师",                  // ← position
  "persona": "耐心、和善、有条理……",     // ← personality
  "voice":   "语速慢，先停一拍再开口",    // ← speaking_style（建议新增，Microverse 有、我们缺）
  "duties":  ["守好药房", "记住老顾客的用药"],   // ← work_duties
  "habits":  ["逢人问市长选举投谁"],       // ← work_habits

  // —— 来自原版 3.1 / 3.3
  "goal":  "把药房守好，别错过儿子长大的日子",
  "plan":  ["08:00 开门盘点处方", "…"],   // ← daily_req + f_daily_schedule
  // 刻意**不采纳**原版那套"恐惧 / 隐瞒"之类的内在心理字段：它们属于写小说时的
  // 人物小传，放进可复用的角色卡会让每张卡都背上两个填空，并与 persona / backstory /
  // goal 的语义互相覆盖。有所忌惮或有所隐瞒写进那三个既有字段即可，模型同样读得到。
  "reflection": { "at": "22:00", "size": 5, "trigger": "重要度累积 ≥ 250" },

  // —— 来自 Microverse 1.2（记忆二维打分 + 双时间戳 + 上限清理）
  "memories": [
    { "kind": "INTERACTION", "importance": 5,
      "text": "玛丽亚说他那杯咖啡太苦了",
      "at": "2025-01-01 20:30", "ts": 1735734600 }
  ],

  // —— 来自 Microverse 1.3（记忆按关系分桶）
  "relations": [
    { "with": "klaus", "label": "常客", "affinity": 20,
      "history": [ { "from": "klaus", "text": "…", "ts": 1735734600 } ] }
  ],

  // —— 来自 Microverse 1.4（世界规则与角色分离）
  "worldRules": ["今晚全镇停电", "咖啡馆周六歇业"]
}
```

**三条落地纪律**（三家踩过、我们也该踩）：

1. **记忆要有上限和清理策略**（Microverse `_cleanup_old_memories`）——原版的 `importance_trigger_max: 250` 是同一意图。没有这条，跑够几轮上下文就爆。
2. **时间戳存两份**：给 LLM 看人可读的，给排序看 unix 的（Microverse 的做法）。
3. **记忆按类型检索、按关系分桶**，别把所有记忆都平铺进每一条 prompt。

---

## 5. jev-town：不存在（如实记录）

任务给的 `https://github.com/jev-p/jev-town` 返回 **404**（GitHub API 与网页均确认仓库不存在）。

进一步核实：

- GitHub 仓库搜索 `microverse multi-agent simulation` 与 `Microverse in:name` 的返回里，没有任何名为 `jev-town` 的项目。
- 以 `jev` 为关键词搜索到的结果（`cobanov/awesome-jev`、`wuyoscar/jev-skill`、`kraayenjon/awesome-jev` 等）**全部与多智能体社会模拟无关**——它们指向 TypeSafe AI 的 "Jev" 模型及其周边工具链（模型路由、triage、skill 包）。这是**同名不同指**，不应拿来冒充任务要的项目。

**结论**：`jev-town` 这一来源**本期无法提供任何素材**，也没有找到可正当代替的「jev 的同类项目」。因此：

- `assets/smallville.json` 与 `assets/roster.md` **未取用任何来自 jev-town 的内容**。
- 本条属 `unverified`：如果确有该项目，需要正确的仓库地址才能补采。

---

## 6. 本文件的来源与取值路径

| 项目 | 仓库 | 许可 | 本文件取用的文件 |
|---|---|---|---|
| Stanford Generative Agents | `joonspk-research/generative_agents` | Apache-2.0 | `.../base_the_ville_n25/personas/John Lin/bootstrap_memory/scratch.json` 等 25 份 |
| Microverse | `KsanaDock/Microverse` | MIT | `script/CharacterPersonality.gd`、`script/ai/memory/MemoryManager.gd`、`script/ChatHistory.gd`、`script/ai/background_story/README.md` |
| AI Town | `a16z-infra/ai-town` | MIT | `data/characters.ts`、`data/spritesheets/` 目录、`public/assets/` 目录、`public/assets/spritesheets/` 目录 |
| jev-town | — | — | **仓库 404，无任何取用** |

标注为 `inferred` 的部分：第 4 节的合并 schema（是我们设计的，不是任何单一仓库的既有格式）；第 2.3 节里「按同一命名思路扩展」的物件名；`voice`、`duties`、`habits`、`worldRules` 这几个**为 dsh-paranim 新加**的字段名（其**概念**源自 Microverse，**字段名**是我们的）。
