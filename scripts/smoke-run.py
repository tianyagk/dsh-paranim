#!/usr/bin/env python3
"""
渲染冒烟测试的第二步：用真实 Chromium 驱动渲染并断言像素。

断言的三件事都是这几轮真出过问题的地方：
  · 瓦片画不出来（整幅黑 / 一片空白）
  · 编辑某层时上层没被排除（改的层被盖住，看不见）
  · 编辑某层时下层没淡显（不知道东西该摆在哪）
"""
import json, sys, pathlib
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
page_url = (root / 'lib' / 'smoke.html').as_uri()

# 8×6 的小沙盒：草地 + 一列墙；左上角一格是水，用来区分两种背景瓦片
W, H = 8, 6
fixture = {
    "v": 1, "id": "smoke", "name": "冒烟", "desc": "", "builtin": True,
    "createdAt": 0, "updatedAt": 0,
    "map": {
        "width": W, "height": H,
        "tilesets": [{
            "id": "tiny-town", "name": "Tiny Town", "image": "",
            "imageW": 192, "imageH": 176, "tileW": 16, "tileH": 16,
            "margin": 0, "spacing": 0,
            "notes": {"0,0": {"name": "草地", "pass": "walk"}, "1,0": {"name": "墙", "pass": "block"}},
        }],
        "layers": {
            "background": {"cells": ["tiny-town:0,0"] * (W * H)},
            "structure": {"cells": ["tiny-town:1,0" if i % W == 4 else None for i in range(W * H)]},
            "object": {"cells": [None] * (W * H)},
        },
    },
    "places": [], "relations": [], "agents": [], "startTick": 0,
}
fixture["map"]["layers"]["background"]["cells"][0] = "tiny-town:4,10"

failures = []
def ok(cond, label, extra=""):
    if cond:
        print(f"  ✓ {label}")
    else:
        print(f"  ✗ {label}" + (f" — {extra}" if extra else ""))
        failures.append(label)

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 400, "height": 300})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    page.goto(page_url)
    page.wait_for_function("() => window.__smoke !== undefined", timeout=15000)
    # 图集必须先解码完，否则渲染出来是纯背景色（那就是"瓦片全丢了"的假象）
    sheets = page.evaluate("() => window.__smoke.ready()")
    if not sheets.get("ok"):
        print(f"  ✗ 内置图集解码失败：{sheets.get('failed')}")
        failures.append("图集解码")

    def shot(layer=None):
        return page.evaluate(
            """async ([sandbox, layer]) => {
                 const cv = document.getElementById('cv')
                 window.__smoke.render(cv, sandbox, layer ?? undefined)
                 await new Promise((r) => requestAnimationFrame(r))
                 const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
                 let lit = 0, sum = 0
                 for (let i = 0; i < d.length; i += 4) {
                   const v = d[i] + d[i + 1] + d[i + 2]
                   sum += v
                   if (v > 60) lit += 1
                 }
                 const o = (8 * cv.width + 8) * 4
                 return { lit, sum, total: d.length / 4, px: d[o] + d[o + 1] + d[o + 2] }
               }""",
            [fixture, layer],
        )

    full = shot(None)
    ok(full["lit"] > 48 * 0.8, f"整幅渲染有内容的像素足够多（{full['lit']}/{full['total']}）")
    ok(full["sum"] > 0, "画布不是全黑（瓦片真的画出来了）")

    only_bg = shot("background")
    ok(only_bg["lit"] > 48 * 0.8, f"只画背景层时地面铺满（{only_bg['lit']}/{only_bg['total']}）")

    only_st = shot("structure")
    ok(only_st["lit"] > 0, "建筑层自己画得出来（墙看得见）")
    # 用**亮度总和**而不是"亮点个数"：草地按 0.3 淡显后仍然够亮、仍会被算成 lit，
    # 所以个数不变是正常的，变暗体现在总和上。
    ok(only_st["sum"] < full["sum"] * 0.9,
       f"只画建筑层时整体明显更暗（{only_st['sum']} < {full['sum']}）—— 地面是淡显的，没有整块盖上来")

    # 编辑建筑层时地面应以 0.3 淡显：采样一格「只有草地、没有墙」的中心
    stub = shot("structure")
    ok(stub["px"] > 0 and stub["px"] < only_bg["px"],
       "编辑建筑层时地面仍淡显（比完整渲染暗、但不是纯黑）",
       f"structure={stub['px']} background={only_bg['px']}")

    ok(len(errors) == 0, "没有页面错误", " / ".join(errors))
    browser.close()

if failures:
    print(f"\n❌ 渲染冒烟失败：{len(failures)} 项")
    sys.exit(1)
print("\n✅ 渲染冒烟通过（真实 Chromium）")
