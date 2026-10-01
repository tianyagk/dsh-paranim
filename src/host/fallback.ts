/**
 * 内联兜底小镇 —— **由 scripts/gen-fallback.mjs 从 assets/smallville.json 生成，不要手改**。
 *
 * 作用：镜像文件读不到（缺失 / JSON 坏了 / 打包时 assets 没带上）时，引擎与 UI
 * 仍要能立刻可用。因此它是**降级路径**，不追求完整：40 处地标、
 * 12 件可改状态的物件、8 位居民，全部取自发货镜像本身，
 * 只是裁掉了长文本与重复的 props 组。
 *
 * 素材出处：地点外接框与路网解自 joonspk-research/generative_agents 的 arena_maze.csv（Stanford Generative Agents, UIST 2023, Apache-2.0）；居民设定取自 storage/base_the_ville_n25/personas/<N…
 * 许可：Apache-2.0
 *
 * 改动镜像后请重新生成：node scripts/gen-fallback.mjs
 */
import type { Sandbox } from '../shared/model.ts'

export const INLINE_SMALLVILLE: Sandbox = {
  v: 1,
  id: 'smallville',
  name: 'Smallville · 斯坦福小镇',
  desc: "复刻斯坦福 generative_agents 的 Smallville：地点外接框与路网全部按原版 140×100 栅格还原。",
  attribution: "地点外接框与路网解自 joonspk-research/generative_agents 的 arena_maze.csv（Stanford Generative Agents, UIST 2023, Apache-2.0）；居民设定取自 storage/base_the_ville_n25/personas/<Name>/bootstrap_memory/scratch.json；像素图集取…",
  license: "Apache-2.0",
  builtin: true,
  createdAt: 0,
  updatedAt: 0,
  map: {
    "width": 140,
    "height": 100,
    "ground": "#5c8b3a"
  },
  places: [
    {
      "id": "place-1",
      "name": "罗西公寓",
      "kind": "place",
      "x": 88,
      "y": 19,
      "w": 5,
      "h": 14,
      "color": "#6b7f9c",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-2",
      "name": "戈麦斯公寓",
      "kind": "place",
      "x": 95,
      "y": 19,
      "w": 5,
      "h": 14,
      "color": "#6b7f9c",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-3",
      "name": "玫瑰与王冠酒馆",
      "kind": "place",
      "x": 58,
      "y": 20,
      "w": 10,
      "h": 14,
      "color": "#6b7f9c",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-4",
      "name": "霍布斯咖啡馆",
      "kind": "place",
      "x": 67,
      "y": 20,
      "w": 5,
      "h": 14,
      "color": "#6b7f9c",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-5",
      "name": "伊莎贝拉公寓",
      "kind": "place",
      "x": 78,
      "y": 20,
      "w": 12,
      "h": 14,
      "color": "#6b7f9c",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-6",
      "name": "艺术家合居空间",
      "kind": "place",
      "x": 19,
      "y": 20,
      "w": 8,
      "h": 6,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-7",
      "name": "亚瑟·伯顿公寓",
      "kind": "place",
      "x": 29,
      "y": 20,
      "w": 8,
      "h": 6,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-8",
      "name": "起居室 1",
      "kind": "place",
      "x": 39,
      "y": 25,
      "w": 8,
      "h": 16,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-9",
      "name": "橡树山学院",
      "kind": "place",
      "x": 116,
      "y": 27,
      "w": 17,
      "h": 16,
      "color": "#6b7f9c",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-10",
      "name": "约翰逊公园",
      "kind": "place",
      "x": 19,
      "y": 30,
      "w": 8,
      "h": 6,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-11",
      "name": "厨房 1",
      "kind": "place",
      "x": 29,
      "y": 30,
      "w": 8,
      "h": 6,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-12",
      "name": "橡树山学院宿舍",
      "kind": "place",
      "x": 124,
      "y": 36,
      "w": 15,
      "h": 11,
      "color": "#c9843f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-13",
      "name": "山本宅",
      "kind": "place",
      "x": 28,
      "y": 46,
      "w": 14,
      "h": 9,
      "color": "#c9843f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-14",
      "name": "哈维橡树五金店",
      "kind": "place",
      "x": 64,
      "y": 48,
      "w": 14,
      "h": 12,
      "color": "#c9843f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-15",
      "name": "柳树超市与药房",
      "kind": "place",
      "x": 84,
      "y": 48,
      "w": 19,
      "h": 12,
      "color": "#c9843f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-16",
      "name": "店面 1",
      "kind": "place",
      "x": 129,
      "y": 46,
      "w": 7,
      "h": 5,
      "color": "#c9843f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-17",
      "name": "后厨 1",
      "kind": "place",
      "x": 121,
      "y": 50,
      "w": 8,
      "h": 9,
      "color": "#c9843f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-18",
      "name": "仓库 1",
      "kind": "place",
      "x": 109,
      "y": 51,
      "w": 6,
      "h": 4,
      "color": "#c9843f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-19",
      "name": "店面 2",
      "kind": "place",
      "x": 131,
      "y": 54,
      "w": 3,
      "h": 7,
      "color": "#c9843f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-20",
      "name": "后厨 2",
      "kind": "place",
      "x": 125,
      "y": 55,
      "w": 6,
      "h": 6,
      "color": "#c9843f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-21",
      "name": "仓库 2",
      "kind": "place",
      "x": 109,
      "y": 59,
      "w": 6,
      "h": 7,
      "color": "#c9843f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-22",
      "name": "店面 3",
      "kind": "place",
      "x": 117,
      "y": 59,
      "w": 6,
      "h": 7,
      "color": "#c9843f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-23",
      "name": "亚当·史密斯宅",
      "kind": "place",
      "x": 22,
      "y": 65,
      "w": 5,
      "h": 12,
      "color": "#c9843f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-24",
      "name": "摩尔家",
      "kind": "place",
      "x": 30,
      "y": 65,
      "w": 5,
      "h": 12,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-25",
      "name": "泰勒与奥尔蒂斯之家",
      "kind": "place",
      "x": 38,
      "y": 65,
      "w": 5,
      "h": 12,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-26",
      "name": "莫雷诺家",
      "kind": "place",
      "x": 54,
      "y": 68,
      "w": 7,
      "h": 6,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-27",
      "name": "林家宅",
      "kind": "place",
      "x": 61,
      "y": 67,
      "w": 3,
      "h": 5,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-28",
      "name": "卧室 1",
      "kind": "place",
      "x": 72,
      "y": 68,
      "w": 7,
      "h": 6,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-29",
      "name": "书房 1",
      "kind": "place",
      "x": 79,
      "y": 67,
      "w": 3,
      "h": 5,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-30",
      "name": "起居室 2",
      "kind": "place",
      "x": 90,
      "y": 68,
      "w": 7,
      "h": 6,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-31",
      "name": "厨房 2",
      "kind": "place",
      "x": 97,
      "y": 67,
      "w": 3,
      "h": 5,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-32",
      "name": "卧室 2",
      "kind": "place",
      "x": 53,
      "y": 74,
      "w": 5,
      "h": 3,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-33",
      "name": "书房 2",
      "kind": "place",
      "x": 60,
      "y": 74,
      "w": 6,
      "h": 3,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-34",
      "name": "起居室 3",
      "kind": "place",
      "x": 71,
      "y": 74,
      "w": 5,
      "h": 3,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-35",
      "name": "厨房 3",
      "kind": "place",
      "x": 78,
      "y": 74,
      "w": 6,
      "h": 3,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-36",
      "name": "卧室 3",
      "kind": "place",
      "x": 89,
      "y": 74,
      "w": 5,
      "h": 3,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-37",
      "name": "书房 3",
      "kind": "place",
      "x": 96,
      "y": 74,
      "w": 6,
      "h": 3,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-38",
      "name": "起居室 4",
      "kind": "place",
      "x": 57,
      "y": 80,
      "w": 10,
      "h": 5,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-39",
      "name": "厨房 4",
      "kind": "place",
      "x": 75,
      "y": 80,
      "w": 10,
      "h": 5,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    },
    {
      "id": "place-40",
      "name": "卧室 4",
      "kind": "place",
      "x": 93,
      "y": 80,
      "w": 10,
      "h": 5,
      "color": "#a8623f",
      "interactive": true,
      "state": {
        "open": true
      }
    }
  ],
  objects: [
    {
      "id": "campfire",
      "name": "篝火堆",
      "kind": "fixture",
      "x": 44,
      "y": 30,
      "color": "#d4752f",
      "interactive": true,
      "state": {
        "status": "正常",
        "lit": false
      },
      "affordances": [
        "生火",
        "围坐",
        "添柴"
      ]
    },
    {
      "id": "windmill",
      "name": "风车",
      "kind": "fixture",
      "x": 4,
      "y": 30,
      "color": "#c9b28a",
      "interactive": true,
      "state": {
        "status": "正常",
        "spinning": true
      },
      "affordances": [
        "观察",
        "修理",
        "破坏"
      ]
    },
    {
      "id": "waterfall",
      "name": "小瀑布",
      "kind": "fixture",
      "x": 100,
      "y": 40,
      "color": "#6fa8c4",
      "interactive": true,
      "state": {
        "status": "正常",
        "flowing": true
      },
      "affordances": [
        "取水",
        "观赏",
        "涉水"
      ]
    },
    {
      "id": "sparkle-streetlamp",
      "name": "萤光路灯",
      "kind": "fixture",
      "x": 46,
      "y": 36,
      "color": "#e0d16a",
      "interactive": true,
      "state": {
        "status": "正常",
        "lit": true
      },
      "affordances": [
        "点灯",
        "熄灯",
        "修理",
        "破坏"
      ]
    },
    {
      "id": "streetlamp-2",
      "name": "路灯",
      "kind": "fixture",
      "x": 28,
      "y": 55,
      "color": "#c9c07a",
      "interactive": true,
      "state": {
        "status": "正常",
        "lit": true
      },
      "affordances": [
        "点灯",
        "修理",
        "破坏"
      ]
    },
    {
      "id": "bench",
      "name": "长椅",
      "kind": "fixture",
      "x": 50,
      "y": 44,
      "color": "#9c7a52",
      "interactive": true,
      "state": {
        "status": "正常",
        "occupied": false
      },
      "affordances": [
        "坐下",
        "休息",
        "破坏"
      ]
    },
    {
      "id": "trash-can",
      "name": "垃圾桶",
      "kind": "fixture",
      "x": 66,
      "y": 35,
      "color": "#6b6b6b",
      "interactive": true,
      "state": {
        "status": "正常",
        "full": false
      },
      "affordances": [
        "投放垃圾",
        "翻找",
        "清空"
      ]
    },
    {
      "id": "fountain",
      "name": "喷泉",
      "kind": "fixture",
      "x": 100,
      "y": 60,
      "color": "#7fb8d0",
      "interactive": true,
      "state": {
        "status": "正常",
        "running": true
      },
      "affordances": [
        "观赏",
        "取水",
        "投币许愿"
      ]
    },
    {
      "id": "notice-board",
      "name": "告示牌",
      "kind": "fixture",
      "x": 30,
      "y": 80,
      "color": "#b09a6a",
      "interactive": true,
      "state": {
        "status": "正常",
        "posts": 1
      },
      "affordances": [
        "阅读",
        "张贴启事",
        "撕下"
      ]
    },
    {
      "id": "oak-tree",
      "name": "橡树",
      "kind": "fixture",
      "x": 44,
      "y": 74,
      "color": "#3f7038",
      "interactive": true,
      "state": {
        "status": "正常",
        "season": "春"
      },
      "affordances": [
        "乘凉",
        "攀爬",
        "刻字"
      ]
    },
    {
      "id": "market-stall",
      "name": "集市摊位",
      "kind": "fixture",
      "x": 104,
      "y": 70,
      "color": "#c98b4a",
      "interactive": true,
      "state": {
        "status": "正常",
        "open": false
      },
      "affordances": [
        "摆摊",
        "买卖",
        "收摊"
      ]
    },
    {
      "id": "street-sign",
      "name": "路牌",
      "kind": "fixture",
      "x": 120,
      "y": 70,
      "color": "#a8a89c",
      "interactive": true,
      "state": {
        "status": "正常"
      },
      "affordances": [
        "查看方向",
        "转动",
        "破坏"
      ]
    }
  ],
  relations: [
    {
      "a": "john",
      "b": "mei",
      "label": "夫妻（同住林家宅）",
      "affinity": 90
    },
    {
      "a": "tom",
      "b": "sam",
      "label": "政见与积怨（汤姆明确不喜欢山姆）",
      "affinity": -40
    },
    {
      "a": "isabella",
      "b": "maria",
      "label": "咖啡馆熟客与帮手（一起张罗情人节派对）",
      "affinity": 60
    },
    {
      "a": "klaus",
      "b": "maria",
      "label": "互相吸引（克劳斯更愿意找玛丽亚而不是同宿舍的沃尔夫冈）",
      "affinity": 55
    },
    {
      "a": "abigail",
      "b": "isabella",
      "label": "常客（阿比盖尔常在咖啡馆改稿）",
      "affinity": 30
    },
    {
      "a": "sam",
      "b": "john",
      "label": "街坊（选举话题上的闲聊对象）",
      "affinity": 20
    },
    {
      "a": "tom",
      "b": "john",
      "label": "同店不同柜台（共事但不投缘）",
      "affinity": -10
    },
    {
      "a": "mei",
      "b": "klaus",
      "label": "教授与学生",
      "affinity": 25
    }
  ],
  agents: [
    {
      "id": "abigail",
      "name": "阿比盖尔·陈",
      "concept": "数字艺术家与动画师（住艺术家合居空间）",
      "x": 39,
      "y": 21,
      "appearance": "二十五岁，短而利落的黑发常别在耳后，指节上留着数位笔磨出的薄茧…",
      "persona": "开放、好奇、认死理。她对「技术能怎么承载情绪」这件事有近乎偏执的兴趣，聊到这个会突然语速变快、把屏幕转过来给你…",
      "backstory": "在合居空间住了几年，靠接客户的动画项目过活。工作室就是卧室，墙上贴着做废的分镜稿。她和拉托雅、拉吉夫、弗朗西斯科、海莉共用一个厨房和大客厅，晚…",
      "goal": "把手上这个客户项目做出真正让她自己满意的东西，并搞明白怎样把互动艺术变成能持续…",
      "attrs": {
        "str": 5,
        "con": 6,
        "dex": 8,
        "app": 7,
        "int": 7,
        "pow": 6
      },
      "plan": [
        "08:00 起床，煮一壶浓咖啡，先看昨晚渲染的序列有没有崩",
        "09:30 在合居空间客厅做晨间草图，顺便听同屋的人聊今天的安排",
        "13:00 去霍布斯咖啡馆坐一会儿，带着电脑改客户的反馈",
        "16:00 回工作室继续做那个没人知道的交互原型"
      ],
      "inventory": [],
      "color": "#7aa2f7",
      "portrait": "🙂"
    },
    {
      "id": "klaus",
      "name": "克劳斯·穆勒",
      "concept": "橡树山学院社会学研究生（住学院宿舍）",
      "x": 129,
      "y": 46,
      "appearance": "二十岁，瘦高，深色卷发有点乱，眼镜片后是常年缺觉的红眼，外套口…",
      "persona": "温和、爱追问、心里烧着一团火。他习惯先听别人说完再开口，但一旦谈到社会公平，句子会变得又快又密。对人不设防，容…",
      "backstory": "从外地考进橡树山学院读社会学，宿舍隔壁住着沃尔夫冈——两人只是点头之交。他最近频繁跑霍布斯咖啡馆，因为那里能观察人，也因为玛丽亚总在那儿看书。",
      "goal": "写完那篇关于低收入社区中产阶级化影响的研究论文，并且真的做出一点不只是在纸上的…",
      "attrs": {
        "str": 5,
        "con": 6,
        "dex": 5,
        "app": 6,
        "int": 9,
        "pow": 7
      },
      "plan": [
        "07:00 起床，边啃面包边读两页文献",
        "09:00 去橡树山学院图书馆占座，写论文第三章",
        "13:00 到霍布斯咖啡馆，点最便宜的黑咖啡，一边写一边留意来往的人",
        "17:00 如果玛丽亚在，试着聊两句；她似乎总愿意听他说"
      ],
      "inventory": [],
      "color": "#7aa2f7",
      "portrait": "🙂"
    },
    {
      "id": "isabella",
      "name": "伊莎贝拉·罗德里格斯",
      "concept": "霍布斯咖啡馆店主（住咖啡馆楼上）",
      "x": 76,
      "y": 16,
      "appearance": "三十四岁，头发利落地盘成髻，围裙上总有咖啡渍，笑起来眼角先弯；…",
      "persona": "外向、热络、天生让人放松。她记得每个熟客的口味和忌讳，也记得谁上周看起来不太开心。做事风风火火，但从不把忙写在…",
      "backstory": "接手霍布斯咖啡馆多年，把它做成了小镇的公共客厅。最近满脑子都是二月十四号那场情人节派对：物料、菜单、邀请，还有到底会有多少人来。",
      "goal": "把二月十四日下午五点到七点的情人节派对办成全镇都会记住的一晚，让每个推门进来的…",
      "attrs": {
        "str": 6,
        "con": 7,
        "dex": 6,
        "app": 8,
        "int": 7,
        "pow": 8
      },
      "plan": [
        "06:00 起床，下楼开火、摆出当天的糕点",
        "08:00 开门迎客，一边招呼一边清点派对要用的杯子与蜡烛",
        "12:00 拉着在店里看书的玛丽亚聊派对安排，请她帮忙出主意",
        "15:00 见缝插针地问每一个熟客：十四号晚上有空吗"
      ],
      "inventory": [],
      "color": "#7aa2f7",
      "portrait": "🙂"
    },
    {
      "id": "maria",
      "name": "玛丽亚·洛佩斯",
      "concept": "橡树山学院物理系学生 / 兼职 Twitch 主播（住学院宿舍）",
      "x": 125,
      "y": 55,
      "appearance": "二十一岁，扎着高马尾，耳机线常挂在脖子上，背包侧袋塞着游戏手柄…",
      "persona": "精力旺盛、热情、问题多。她能在同一小时里讨论薛定谔方程和昨晚的直播弹幕，而且真心觉得两件事一样有趣。对人毫无距…",
      "backstory": "一边读物理学位一边靠直播打游戏补贴开销。宿舍房间桌上摊着习题，旁边就是补光灯和麦克风。她几乎每天都去霍布斯咖啡馆学习和吃饭，也是在那里和伊莎贝…",
      "goal": "把学位读下来，同时让直播这一摊做出稳定的收入，不必再为下个月的账单分心。",
      "attrs": {
        "str": 5,
        "con": 6,
        "dex": 8,
        "app": 7,
        "int": 8,
        "pow": 7
      },
      "plan": [
        "10:00 起床（前一晚直播到很晚），先刷半小时消息",
        "11:30 去霍布斯咖啡馆，占靠窗的位子写作业，顺便吃早午餐",
        "14:00 在咖啡馆和伊莎贝拉聊情人节派对的安排，顺手帮她写了两张卡片",
        "17:00 回宿舍准备今晚的直播选题"
      ],
      "inventory": [],
      "color": "#7aa2f7",
      "portrait": "🙂"
    },
    {
      "id": "mei",
      "name": "梅·林",
      "concept": "橡树山学院哲学教授 / 妻子与母亲（住林家宅）",
      "x": 89,
      "y": 74,
      "appearance": "四十四岁，齐肩黑发里夹着几根白，戴细框眼镜，袖口常沾粉笔灰；说…",
      "persona": "温和、耐心、有分寸。她有种让人愿意把话说完的本事——不急着反驳，也不轻易给答案。在家里是那个记得所有事的人：谁…",
      "backstory": "和丈夫约翰、儿子埃迪一起住在林家宅。白天在学院教哲学，晚上改论文、听埃迪弹琴、顺手把家里的事都理一遍。她也在断断续续写自己的研究论文。",
      "goal": "在教课、带家和自己的研究之间找到那个能撑住的平衡点，把那篇停了大半年的论文写完。",
      "attrs": {
        "str": 5,
        "con": 7,
        "dex": 5,
        "app": 7,
        "int": 9,
        "pow": 8
      },
      "plan": [
        "07:00 起床，做早饭，顺便把约翰和埃迪的午饭装好",
        "09:00 到学院上哲学课，课后留半小时答疑",
        "13:00 在办公室读文献，试着推进自己的论文",
        "17:00 回家做晚饭，吃饭时问问埃迪的作曲进度"
      ],
      "inventory": [],
      "color": "#7aa2f7",
      "portrait": "🙂"
    },
    {
      "id": "john",
      "name": "约翰·林",
      "concept": "柳树超市与药房药剂师（住林家宅）",
      "x": 90,
      "y": 74,
      "appearance": "四十五岁，头发梳得整齐，穿浅色衬衫袖口永远卷到同一高度，胸前别…",
      "persona": "耐心、和善、有条理。他天生记性好，能记住老顾客吃什么药、什么时候该来续方。不爱争辩，遇到冲突宁可多解释两遍。有…",
      "backstory": "在柳树超市与药房管着药房那一半，汤姆·莫雷诺管杂货那一半——两人相处得不算融洽。他和妻子梅、儿子埃迪住在林家宅，最近还在上网课补新药知识。邻居…",
      "goal": "把药房守好、让每个顾客拿药这件事变得更省心，同时别错过儿子埃迪长大的这段日子。",
      "attrs": {
        "str": 6,
        "con": 7,
        "dex": 6,
        "app": 6,
        "int": 7,
        "pow": 6
      },
      "plan": [
        "06:00 起床，和梅一起吃早饭，出门前跟儿子打个招呼",
        "08:00 到柳树超市与药房开门，盘点当天的处方",
        "12:00 午休时跟隔壁柜台的汤姆少说两句，多喝口水",
        "15:00 招呼顾客，照例问上一句：市长选举你知道有谁要选吗"
      ],
      "inventory": [],
      "color": "#7aa2f7",
      "portrait": "🙂"
    },
    {
      "id": "tom",
      "name": "汤姆·莫雷诺",
      "concept": "柳树超市与药房杂货店主（住莫雷诺家）",
      "x": 71,
      "y": 74,
      "appearance": "五十二岁，体格壮实，前臂有旧疤，爱穿深色Polo衫，说话时习惯…",
      "persona": "粗声粗气、急躁、精力旺盛。他把店当成自己的地盘，对顾客却出奇地肯帮忙——只要你别越界。说话不绕弯，得罪人也不在…",
      "backstory": "和妻子简住在莫雷诺家，每天打理柳树超市与药房的杂货部分。他干了这行很多年，店里的每一寸货架该怎么摆他心里有数。和同店的药剂师约翰·林算不上朋友。",
      "goal": "把店的日常攥在自己手里，绝不让那个自以为是的老兵山姆·摩尔在这镇上说了算。",
      "attrs": {
        "str": 8,
        "con": 8,
        "dex": 5,
        "app": 4,
        "int": 5,
        "pow": 7
      },
      "plan": [
        "07:00 起床，简已经做好早饭，他吃得很急",
        "08:00 到店，先巡一遍货架和冷柜，把昨天没补的货补上",
        "12:00 盯着收银和进货单，顺便跟约翰敷衍两句",
        "16:00 招呼熟客，一有机会就聊到市长选举上去"
      ],
      "inventory": [],
      "color": "#7aa2f7",
      "portrait": "🙂"
    },
    {
      "id": "sam",
      "name": "山姆·摩尔",
      "concept": "退休海军军官 / 市长候选人（住摩尔家）",
      "x": 38,
      "y": 62,
      "appearance": "六十五岁，身板笔直，头发花白剪得很短，常戴一顶旧棒球帽，手上有…",
      "persona": "通达、随和、满肚子故事。他讲起海军那些年能讲一整晚，而且总能从故事里抖出点用得上的道理。闲不住——公园的活他抢…",
      "backstory": "和结婚四十年的妻子珍妮弗住在摩尔家，两人一个画画一个打理公园。他是镇上的老面孔，认识几乎所有街坊。决定参选市长之后，他更频繁地出现在公共场合。",
      "goal": "赢下下个月的市长选举，把这个他住了一辈子的镇子推到一条更像样的路上去。",
      "attrs": {
        "str": 7,
        "con": 7,
        "dex": 5,
        "app": 6,
        "int": 7,
        "pow": 8
      },
      "plan": [
        "05:00 起床，在院子里活动筋骨，等珍妮弗醒了一起吃早饭",
        "07:00 去约翰逊公园修剪灌木、捡垃圾，跟路过的人打招呼",
        "11:00 顺路去柳树超市与药房买点东西，见人就说选举的事",
        "14:00 回家读书，或者和珍妮弗在客厅聊聊她的画展"
      ],
      "inventory": [],
      "color": "#7aa2f7",
      "portrait": "🙂"
    }
  ],
  startTick: 0,
}
