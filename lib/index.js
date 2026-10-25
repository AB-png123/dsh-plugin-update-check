/**
 * dsh-plugin-update-check —— DSH 启动钩子。
 *
 * apply() 时注册一个 effect：
 *   · 启动 firstDelayMs 后做第一次插件版本检查（避开 DSH 自身启动高峰）；
 *   · 之后每 intervalHours 小时复查一次（应用一直开着也不会遗漏）。
 *
 * 具体检查逻辑见 ./check.mjs；所有异常都只写日志，绝不影响 DSH 启动。
 */
import { loadConfig, runCheck } from './check.mjs'

export const name = 'dsh-plugin-update-check'

/** 纯独立启动钩子，不依赖其他服务。 */
export const inject = []

export function apply(ctx) {
  const logger = ctx?.logger

  const start = (startup) => {
    runCheck({ logger, startup }).catch((error) => {
      try {
        logger?.warn?.(`update-check: 检查异常 ${error?.message ?? error}`)
      } catch {
        /* 连日志都不可用时静默 */
      }
    })
  }

  try {
    if (process.env.DSH_PLUGIN_UPDATE_CHECK_DISABLE === '1') {
      try {
        logger?.info?.('update-check: 已被 DSH_PLUGIN_UPDATE_CHECK_DISABLE 禁用')
      } catch {
        /* ignore */
      }
      return
    }

    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => {
        let stopped = false
        const timers = []
        loadConfig()
          .then((config) => {
            if (stopped) return
            const firstDelay = Math.max(0, Number(config.firstDelayMs) || 0)
            const first = setTimeout(() => start(true), firstDelay)
            first.unref?.()
            timers.push(first)

            const hours = Number(config.intervalHours)
            if (Number.isFinite(hours) && hours > 0) {
              const interval = setInterval(() => start(false), hours * 3600_000)
              interval.unref?.()
              timers.push(interval)
            }
            try {
              logger?.info?.(
                `update-check: 已排程（${Math.round(firstDelay / 1000)}s 后首次检查` +
                  (Number.isFinite(hours) && hours > 0 ? `，之后每 ${hours} 小时一次` : '') +
                  '）',
              )
            } catch {
              /* ignore */
            }
          })
          .catch(() => {
            /* 配置读不到就用默认值兜底：8 秒后检查一次 */
            const first = setTimeout(() => start(true), 8000)
            first.unref?.()
            timers.push(first)
          })

        return () => {
          stopped = true
          for (const timer of timers) {
            clearTimeout(timer)
            clearInterval(timer)
          }
        }
      })
    } else {
      const first = setTimeout(() => start(true), 8000)
      first.unref?.()
    }
  } catch (error) {
    try {
      logger?.warn?.(`update-check: 初始化异常 ${error?.message ?? error}`)
    } catch {
      /* 绝不拖垮启动 */
    }
  }
}

export default { name, inject, apply }
