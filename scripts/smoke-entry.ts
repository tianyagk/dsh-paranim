/**
 * 冒烟测试的浏览器侧入口。
 *
 * 把真实渲染函数挂到 window 上，让 Playwright 能直接驱动它并读回像素。
 * **不需要 dsh 运行时、也不需要 React**——要验证的是"瓦片到底画没画出来"
 * 与"编辑时下层有没有淡显"，这两件事在 renderTown 里就能观察，而它们恰恰
 * 是这几轮反复出问题的地方（画一片黑、图层叠加看不见）。
 */
import { collectImages, renderTown } from '../src/client/town.ts'
import { loadSheets } from '../src/client/tiles.ts'
import type { Sandbox } from '../src/shared/model.ts'

interface SmokeApi {
  /** 解码内置图集。**必须先 await 它**——sheet() 是同步取已加载的图，
   *  没加载完就渲染的话画布上是纯背景色，看着像"瓦片全丢了"。 */
  ready: () => Promise<{ ok: boolean; failed: string[] }>
  render: (canvas: HTMLCanvasElement, sandbox: Sandbox, only?: 'background' | 'structure' | 'object') => void
}

declare global {
  interface Window { __smoke: SmokeApi }
}

window.__smoke = {
  ready: () => loadSheets(),
  render(canvas, sandbox, only) {
    const ctx = canvas.getContext('2d')
    if (ctx === null) throw new Error('拿不到 2d context')
    renderTown(ctx, {
      sandbox,
      view: { scale: 1, offsetX: 0, offsetY: 0 },
      size: { w: canvas.width, h: canvas.height },
      agents: [],
      images: collectImages(sandbox),
      tick: 0,
      ...(only === undefined ? {} : { only }),
    })
  },
}
