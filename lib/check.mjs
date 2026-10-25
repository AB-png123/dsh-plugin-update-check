#!/usr/bin/env node
/**
 * dsh-plugin-update-check —— 检查 DSH profile 里已安装的插件是否有新版本。
 *
 * 支持三种来源：
 *   · npm 包（普通/带 scope）         → 对比 registry 的 dist-tags.latest（预发布版本会额外查全量 versions）
 *   · github:owner/repo[#ref]        → 对比 GitHub API 的分支最新 commit 与 pnpm-lock 里锁定的 commit
 *   · file: / link: / portal: 本地包 → 无法自动查询，报告中标注
 *
 * 结果写入 ~/.dsh/plugin-update-check/report.md 与 status.json；
 * 有更新时按配置发系统通知（Electron 原生通知 → osascript 兜底）并设置 Dock 角标。
 *
 * 也可独立运行：
 *   node <profile>/node_modules/dsh-plugin-update-check/lib/check.mjs [--json] [--no-notify] [--force-notify] [--profile <dir>]
 */
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.HOME || os.homedir()
const DATA_DIR = process.env.DSH_UPDATE_CHECK_DATA_DIR
  ? path.resolve(process.env.DSH_UPDATE_CHECK_DATA_DIR)
  : path.join(HOME, '.dsh', 'plugin-update-check')
const REPORT_PATH = path.join(DATA_DIR, 'report.md')
const STATUS_PATH = path.join(DATA_DIR, 'status.json')
const STATE_PATH = path.join(DATA_DIR, 'state.json')
const CONFIG_PATH = path.join(DATA_DIR, 'config.json')
const LOG_PATH = path.join(DATA_DIR, 'run.log')
const USER_AGENT = 'dsh-plugin-update-check/0.1.0'
const REQUEST_TIMEOUT_MS = 12_000
const CONCURRENCY = 4

export const DEFAULT_CONFIG = {
  /** 启动后第一次检查的延迟（毫秒），避开 DSH 自身启动高峰 */
  firstDelayMs: 8_000,
  /** 应用持续运行时的复查间隔（小时） */
  intervalHours: 6,
  /** 提示方式：notification（系统通知）| dialog（应用内原生弹窗）| none */
  prompt: 'notification',
  /** 是否提示（false 时只写报告和日志） */
  notify: true,
  /** 同一个更新集合的提示冷却时间（小时），期间只刷新报告不重复打扰 */
  notifyCooldownHours: 24,
  /** 有更新时把数量写到 Dock 角标 */
  badge: true,
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

function toLocalTime(date) {
  return date.toLocaleString('zh-CN', { hour12: false })
}

async function appendLog(line) {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true })
    const stat = await fs.stat(LOG_PATH).catch(() => null)
    if (stat && stat.size > 256 * 1024) await fs.writeFile(LOG_PATH, '')
    await fs.appendFile(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 日志失败不影响检查 */
  }
}

/** 以固定并发执行异步任务，返回与输入同序的结果。 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/* ------------------------------------------------------------------ */
/* semver（只做比较，够用即可）                                          */
/* ------------------------------------------------------------------ */

function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? '').trim())
  if (!match) return null
  return {
    main: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  }
}

function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) return null
  for (let i = 0; i < 3; i += 1) {
    if (a.main[i] !== b.main[i]) return a.main[i] - b.main[i]
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < length; i += 1) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y)
      continue
    }
    if (nx) return -1
    if (ny) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function maxVersion(versions) {
  let max = null
  for (const version of versions) {
    if (!parseSemver(version)) continue
    if (max === null || compareSemver(version, max) > 0) max = version
  }
  return max
}

/* ------------------------------------------------------------------ */
/* profile / 配置                                                       */
/* ------------------------------------------------------------------ */

function resolveProfile(explicit) {
  return explicit ? path.resolve(explicit) : null
}

async function findProfile(explicit) {
  const direct = resolveProfile(explicit)
  if (direct) return direct

  const fromEnv = process.env.DSH_PROFILE_DIR || process.env.DSH_PROFILE_PATH
  if (fromEnv) return path.resolve(fromEnv)

  const base = path.join(HOME, '.dsh', 'profiles')
  const names = await fs.readdir(base).catch(() => [])
  let best = null
  for (const name of names) {
    const dir = path.join(base, name)
    const pkg = await readJson(path.join(dir, 'package.json'))
    if (!pkg?.dependencies) continue
    const installedSelf = await exists(path.join(dir, 'node_modules', 'dsh-plugin-update-check', 'package.json'))
    const declaredSelf = Boolean(pkg.dependencies['dsh-plugin-update-check'])
    let score = Object.keys(pkg.dependencies).length / 1000
    if (name === 'desktop') score += 10
    if (installedSelf) score += 50
    if (declaredSelf) score += 100
    if (!best || score > best.score) best = { dir, score }
  }
  return best?.dir ?? path.join(base, 'desktop')
}

export async function loadConfig() {
  const user = await readJson(CONFIG_PATH, {})
  const config = { ...DEFAULT_CONFIG, ...(user && typeof user === 'object' ? user : {}) }
  return config
}

/** 顺带支持 ~/.npmrc、profile/.npmrc 里配置的镜像。 */
async function resolveRegistry(profileDir) {
  if (process.env.npm_config_registry) return process.env.npm_config_registry.replace(/\/+$/, '')
  const files = [path.join(HOME, '.npmrc'), path.join(profileDir, '.npmrc'), path.join(profileDir, '.pnpmrc')]
  for (const file of files) {
    const text = await readText(file)
    if (!text) continue
    const match = /^\s*registry\s*=\s*(\S+)\s*$/m.exec(text)
    if (match) return match[1].replace(/\/+$/, '')
  }
  return 'https://registry.npmjs.org'
}

/* ------------------------------------------------------------------ */
/* pnpm-lock：github 依赖安装时锁定的 commit                              */
/* ------------------------------------------------------------------ */

async function readLockVersions(profileDir) {
  const map = new Map()
  const text = await readText(path.join(profileDir, 'pnpm-lock.yaml'))
  if (!text) return map
  const block = /^importers:\s*\n([\s\S]*?)(?=^\S)/m.exec(text)
  if (!block) return map
  const entry = /^ {6}('?"?)([^\s:'"][^:\n]*?)\1:\n(?: {8}specifier:[^\n]*\n)? {8}version: ([^\n]+)$/gm
  let match
  while ((match = entry.exec(block[1])) !== null) {
    map.set(match[2], match[3].trim().replace(/^['"]|['"]$/g, ''))
  }
  return map
}

function commitFromLockVersion(version) {
  if (!version) return null
  const match = /(?:tar\.gz\/|archive\/|codeload[^/]*\/[^/]+\/[^/]+\/[^/]+\/)([0-9a-f]{40})/i.exec(version)
  if (match) return match[1]
  const generic = /\/([0-9a-f]{40})(?:\.tar\.gz)?(?:$|[?#])/i.exec(version)
  return generic ? generic[1] : null
}

/* ------------------------------------------------------------------ */
/* 网络                                                                 */
/* ------------------------------------------------------------------ */

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return response.json()
}

async function npmLatest(registry, name) {
  const encoded = name.startsWith('@') ? name.replace('/', '%2f') : encodeURIComponent(name)
  try {
    const json = await fetchJson(`${registry}/${encoded}/latest`)
    return { version: json?.version ?? null }
  } catch (error) {
    if (error?.status === 404) return { missing: true }
    throw error
  }
}

async function npmVersions(registry, name) {
  const encoded = name.startsWith('@') ? name.replace('/', '%2f') : encodeURIComponent(name)
  const json = await fetchJson(`${registry}/${encoded}`, { accept: 'application/vnd.npm.install-v1+json' })
  return Object.keys(json?.versions ?? {})
}

async function githubJson(url) {
  try {
    return await fetchJson(url, { accept: 'application/vnd.github+json' })
  } catch (error) {
    if (error?.status === 403 || error?.status === 429) throw new Error('GitHub API 限流（未登录 60 次/小时）')
    throw error
  }
}

/* ------------------------------------------------------------------ */
/* 单个依赖检查                                                          */
/* ------------------------------------------------------------------ */

function parseGithubSpec(spec) {
  const match = /^github:([^#\s]+)(?:#([^\s]+))?$/i.exec(spec.trim())
  if (!match) return null
  const parts = match[1].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/')
  if (parts.length < 2) return null
  return { owner: parts[0], repo: parts[1], ref: match[2] ?? null, slug: `${parts[0]}/${parts[1]}` }
}

function isPinnedRef(ref) {
  return Boolean(ref) && (/^[0-9a-f]{40}$/i.test(ref) || /^v?\d+\.\d+\.\d+/.test(ref))
}

async function checkGithub(name, spec, lock) {
  const parsed = parseGithubSpec(spec)
  if (!parsed) return { name, source: 'github', status: 'unknown', note: '无法解析 github 规格' }

  const installedCommit = commitFromLockVersion(lock.get(name)) || (parsed.ref && /^[0-9a-f]{40}$/i.test(parsed.ref) ? parsed.ref : null)
  if (isPinnedRef(parsed.ref)) {
    return {
      name,
      source: 'github',
      status: 'pinned',
      note: `已固定在 ${String(parsed.ref).slice(0, 7)}，不自动检查`,
      url: `https://github.com/${parsed.slug}`,
    }
  }

  try {
    let branch = parsed.ref
    if (!branch) {
      const repo = await githubJson(`https://api.github.com/repos/${parsed.slug}`)
      branch = repo?.default_branch || 'main'
    }
    const commit = await githubJson(`https://api.github.com/repos/${parsed.slug}/commits/${encodeURIComponent(branch)}`)
    const head = commit?.sha ?? null
    if (!head) throw new Error('拿不到最新 commit')
    const info = {
      name,
      source: 'github',
      current: installedCommit ? installedCommit.slice(0, 7) : null,
      latest: head.slice(0, 7),
      latestFull: head,
      currentFull: installedCommit,
      url: commit?.html_url ?? `https://github.com/${parsed.slug}`,
      message: (commit?.commit?.message ?? '').split('\n')[0].slice(0, 80),
      date: commit?.commit?.committer?.date ?? null,
    }
    if (!installedCommit) {
      return { ...info, status: 'unknown', note: '已安装但没有锁定 commit，无法比较' }
    }
    return { ...info, status: head === installedCommit ? 'ok' : 'update' }
  } catch (error) {
    return { name, source: 'github', status: 'unknown', note: error?.message ?? String(error), url: `https://github.com/${parsed.slug}` }
  }
}

async function checkDependency(name, spec, context) {
  const { profileDir, registry, lock } = context
  const installedPkg = await readJson(path.join(profileDir, 'node_modules', name, 'package.json'))
  const installed = installedPkg?.version ?? null

  if (/^(file|link|portal):/i.test(spec)) {
    return { name, source: 'local', current: installed, status: 'local', note: '本地包（file:），无法自动查询新版本' }
  }
  if (/^github:/i.test(spec)) return checkGithub(name, spec, lock)
  if (/^(https?:|git\+|git:|workspace:)/i.test(spec)) {
    return { name, source: 'other', current: installed, status: 'unknown', note: '非 npm / github 来源，未检查' }
  }
  if (!installed) {
    return { name, source: 'npm', status: 'unknown', note: '未安装或读不到本地版本' }
  }

  try {
    const latest = await npmLatest(registry, name)
    if (latest.missing) {
      return { name, source: 'npm', current: installed, status: 'unknown', note: 'npm 上找不到这个包（私有或已下架？）' }
    }
    if (!latest.version) {
      return { name, source: 'npm', current: installed, status: 'unknown', note: 'registry 没有返回版本号' }
    }

    let target = latest.version
    let note = null
    if (compareSemver(target, installed) <= 0 && parseSemver(installed)?.pre.length) {
      // 本地是预发布版本，dist-tags.latest 可能落后：从全量 versions 里找更新的预发布
      const versions = await npmVersions(registry, name)
      const newer = versions.filter((version) => compareSemver(version, installed) > 0)
      if (newer.length > 0) {
        target = maxVersion(newer)
        note = '预发布通道'
      }
    }

    const cmp = compareSemver(target, installed)
    if (cmp === null) {
      return { name, source: 'npm', current: installed, latest: latest.version, status: 'unknown', note: '版本号不是标准 semver，无法比较' }
    }
    return {
      name,
      source: 'npm',
      current: installed,
      latest: target,
      status: cmp > 0 ? 'update' : 'ok',
      note,
      url: `https://www.npmjs.com/package/${name}`,
    }
  } catch (error) {
    return { name, source: 'npm', current: installed, status: 'unknown', note: error?.message ?? String(error) }
  }
}

/* ------------------------------------------------------------------ */
/* 提示（Electron 原生 → osascript 兜底）                                */
/* ------------------------------------------------------------------ */

function getElectron() {
  if (!process.versions.electron) return null
  try {
    const electron = createRequire(import.meta.url)('electron')
    return electron && typeof electron === 'object' ? electron : null
  } catch {
    return null
  }
}

async function openReport(electron, reportPath) {
  try {
    const error = await electron.shell.openPath(reportPath)
    if (error) electron.shell.showItemInFolder(reportPath)
  } catch {
    try {
      electron.shell.showItemInFolder(reportPath)
    } catch {
      /* ignore */
    }
  }
}

function setBadge(electron, count, state) {
  if (!electron?.app?.dock?.setBadge) return
  try {
    if (count > 0) {
      electron.app.dock.setBadge(String(count))
      state.badgeCount = count
    } else if (state.badgeCount) {
      electron.app.dock.setBadge('')
      state.badgeCount = 0
    }
  } catch {
    /* 非 macOS 或 Dock 不可用时忽略 */
  }
}

function osascriptNotify(title, body) {
  const escape = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' · ')
  const script = `display notification "${escape(body)}" with title "${escape(title)}"`
  const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

async function present(options, payload) {
  const { electron, config, reportPath, count, log } = options
  const { title, body, detail } = payload

  if (electron) {
    try {
      if (config.prompt === 'dialog' && electron.dialog?.showMessageBox) {
        const result = await electron.dialog.showMessageBox({
          type: 'info',
          title: 'DSH 插件更新检查',
          message: title,
          detail,
          buttons: ['查看详情', '稍后再说'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
        if (result?.response === 0) await openReport(electron, reportPath)
        return 'electron-dialog'
      }
      if (config.prompt !== 'none' && electron.Notification) {
        const notification = new electron.Notification({ title, body, silent: false })
        notification.on('click', () => {
          void openReport(electron, reportPath)
        })
        notification.show()
        return 'electron-notification'
      }
    } catch (error) {
      log('warn', `update-check: Electron 提示失败：${error?.message ?? error}`)
    }
  }

  if (config.prompt === 'none') return 'none'
  if (process.platform === 'darwin') {
    osascriptNotify(title, body.replace(/\n/g, ' · '))
    return 'osascript'
  }
  log('info', `update-check: ${title} — ${body.replace(/\n/g, '；')}`)
  return 'log'
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

let inFlight = null

export function runCheck(options = {}) {
  if (inFlight) return inFlight
  inFlight = doCheck(options).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function doCheck(options = {}) {
  if (process.env.DSH_PLUGIN_UPDATE_CHECK_DISABLE === '1') {
    return { disabled: true }
  }

  const config = { ...(await loadConfig()), ...(options.config ?? {}) }
  const log = (level, message) => {
    void appendLog(`${level}: ${message}`)
    try {
      options.logger?.[level]?.(message)
    } catch {
      /* ignore */
    }
  }

  const profileDir = await findProfile(options.profile)
  const profilePkg = await readJson(path.join(profileDir, 'package.json'))
  if (!profilePkg?.dependencies) {
    log('warn', `update-check: 找不到 profile 依赖：${path.join(profileDir, 'package.json')}`)
    return { error: 'profile-not-found', profileDir }
  }

  const registry = await resolveRegistry(profileDir)
  const lock = await readLockVersions(profileDir)
  const deps = Object.entries(profilePkg.dependencies).filter(([name]) => name !== 'dsh-plugin-update-check')

  log('info', `update-check: 开始检查 ${deps.length} 个插件（registry: ${registry}）`)

  const results = await mapLimit(deps, CONCURRENCY, ([name, spec]) =>
    checkDependency(String(name), String(spec), { profileDir, registry, lock }),
  )

  const updates = results.filter((item) => item.status === 'update').sort((a, b) => a.name.localeCompare(b.name))
  const unknown = results.filter((item) => item.status === 'unknown')
  const local = results.filter((item) => item.status === 'local')
  const pinned = results.filter((item) => item.status === 'pinned')
  const ok = results.filter((item) => item.status === 'ok')
  const now = new Date()

  const status = {
    checkedAt: now.toISOString(),
    profile: profileDir,
    registry,
    counts: {
      total: results.length,
      updates: updates.length,
      ok: ok.length,
      unknown: unknown.length,
      local: local.length,
      pinned: pinned.length,
    },
    updates: updates.map(({ name, current, latest, source, url, note, message, date }) => ({
      name,
      current,
      latest,
      source,
      url,
      note,
      message,
      date,
    })),
    unknown: unknown.map(({ name, current, source, note }) => ({ name, current, source, note })),
    local: local.map(({ name, current, note }) => ({ name, current, note })),
    pinned: pinned.map(({ name, note }) => ({ name, note })),
    ok: ok.map(({ name, current }) => ({ name, current })),
  }

  await writeJson(STATUS_PATH, status)
  await fs.writeFile(REPORT_PATH, renderReport(status, config, profileDir), 'utf8')

  const state = (await readJson(STATE_PATH, {})) || {}
  const electron = getElectron()

  if (config.badge) setBadge(electron, updates.length, state)
  else if (state.badgeCount) setBadge(electron, 0, state)

  let notice = 'none'
  const signature = updates.map((item) => `${item.name}@${item.latest}`).join('|')
  const cooldownMs = Math.max(0, Number(config.notifyCooldownHours) || 0) * 3600_000
  const lastNotified = state.notifiedAt ? Date.parse(state.notifiedAt) : 0
  // 每次启动后的第一次检查总是提示（这是需求本身）；应用运行期间的复查才走冷却。
  const startup = Boolean(options.startup)
  const due =
    config.notify &&
    config.prompt !== 'none' &&
    updates.length > 0 &&
    (startup ||
      options.forceNotify ||
      state.signature !== signature ||
      !lastNotified ||
      now.getTime() - lastNotified > cooldownMs)

  if (due) {
    const head = updates
      .slice(0, 3)
      .map((item) => `${item.name} ${item.current ?? '?'} → ${item.latest}`)
      .join('\n')
    const more = updates.length > 3 ? `\n…等 ${updates.length} 个插件` : ''
    const body = `${head}${more}\n点击查看检测报告`
    notice = await present(
      {
        electron,
        config,
        reportPath: REPORT_PATH,
        count: updates.length,
        log,
      },
      {
        title: `DSH 插件有 ${updates.length} 个可更新`,
        body,
        detail: updates
          .map((item) => `${item.name}  ${item.current ?? '?'} → ${item.latest}${item.note ? `（${item.note}）` : ''}`)
          .join('\n'),
      },
    )
    state.notifiedAt = now.toISOString()
    state.signature = signature
    state.notice = notice
  }

  state.lastCheckAt = now.toISOString()
  state.lastProfile = profileDir
  await writeJson(STATE_PATH, state)

  log(
    'info',
    `update-check: 完成，${updates.length} 个可更新 / ${unknown.length} 个无法检查 / ${local.length + pinned.length} 个跳过` +
      (notice !== 'none' ? `，提示方式 ${notice}` : ''),
  )

  return { ...status, notice, reportPath: REPORT_PATH }
}

/* ------------------------------------------------------------------ */
/* 报告                                                                 */
/* ------------------------------------------------------------------ */

function renderReport(status, config, profileDir) {
  const lines = []
  lines.push('# DSH 插件更新检查')
  lines.push('')
  lines.push(`- 检查时间：${toLocalTime(new Date(status.checkedAt))}`)
  lines.push(`- Profile：\`${profileDir}\``)
  lines.push(`- Registry：${status.registry}`)
  lines.push(
    `- 结果：共 ${status.counts.total} 个插件，**${status.counts.updates} 个可更新**，${status.counts.ok} 个最新，` +
      `${status.counts.unknown} 个无法检查，${status.counts.local + status.counts.pinned} 个跳过`,
  )
  lines.push('')

  if (status.updates.length > 0) {
    lines.push('## 可更新')
    lines.push('')
    lines.push('| 插件 | 当前 | 最新 | 来源 |')
    lines.push('| --- | --- | --- | --- |')
    for (const item of status.updates) {
      const note = item.note ? `（${item.note}）` : ''
      lines.push(`| ${item.name} | ${item.current ?? '?'} | ${item.latest}${note} | ${item.source} |`)
    }
    lines.push('')
    const npmNames = status.updates.filter((item) => item.source === 'npm').map((item) => `${item.name}@${item.latest}`)
    if (npmNames.length > 0) {
      lines.push('升级命令（在终端执行，升级后重启 DSH 生效）：')
      lines.push('')
      lines.push('```bash')
      lines.push(`cd ${JSON.stringify(profileDir)}`)
      lines.push(`dsh plugin --profile ${JSON.stringify(path.basename(profileDir))} add ${npmNames.join(' ')} --prefer-offline`)
      lines.push('```')
      lines.push('')
    }
    if (status.updates.some((item) => item.source === 'github')) {
      lines.push('GitHub 来源的插件需要重新锁定版本后再安装（`dsh plugin add github:owner/repo#<新 commit>`）。')
      lines.push('')
    }
    lines.push('也可以打开 DSH 的插件市场，在「已安装」页里点更新。')
    lines.push('')
  } else {
    lines.push('## 全部为最新版本 🎉')
    lines.push('')
  }

  if (status.unknown.length > 0) {
    lines.push('## 无法检查')
    lines.push('')
    for (const item of status.unknown) {
      lines.push(`- **${item.name}**${item.current ? `（当前 ${item.current}）` : ''}：${item.note}`)
    }
    lines.push('')
  }

  const skipped = [...status.local, ...status.pinned]
  if (skipped.length > 0) {
    lines.push('## 跳过的插件')
    lines.push('')
    for (const item of skipped) {
      const current = item.current ? `（当前 ${item.current}）` : ''
      lines.push(`- **${item.name}**${current}：${item.note}`)
    }
    lines.push('')
  }

  lines.push('## 已是最新')
  lines.push('')
  if (status.ok.length > 0) {
    for (const item of status.ok) lines.push(`- ${item.name} ${item.current}`)
  } else {
    lines.push('（无）')
  }
  lines.push('')
  lines.push('---')
  lines.push(
    `由 dsh-plugin-update-check 生成 · 启动后 ${Math.round(Number(config.firstDelayMs) / 1000)}s 首次检查，` +
      `之后每 ${config.intervalHours} 小时复查一次 · 提示方式 ${config.prompt}`,
  )
  lines.push('')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* CLI                                                                  */
/* ------------------------------------------------------------------ */

if (path.basename(process.argv[1] ?? '') === 'check.mjs') {
  const argv = process.argv.slice(2)
  const flag = (name) => argv.includes(name)
  const value = (name) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const wantsJson = flag('--json')
  const result = await runCheck({
    profile: value('--profile'),
    forceNotify: flag('--force-notify'),
    config: {
      ...(flag('--no-notify') ? { notify: false, prompt: 'none' } : {}),
      ...(flag('--no-badge') ? { badge: false } : {}),
    },
    logger: wantsJson ? undefined : { info: (m) => console.log(m), warn: (m) => console.warn(m) },
  })

  if (wantsJson) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result?.disabled) {
    console.log('插件更新检查已被 DSH_PLUGIN_UPDATE_CHECK_DISABLE=1 禁用')
  } else if (result?.error) {
    console.error(`检查失败：${result.error}（${result.profileDir ?? ''}）`)
    process.exitCode = 1
  } else {
    console.log('')
    console.log(`报告：${result.reportPath}`)
    if (result.updates.length === 0) console.log('全部插件都是最新版本。')
    else {
      console.log(`可更新 ${result.updates.length} 个：`)
      for (const item of result.updates) console.log(`  · ${item.name} ${item.current ?? '?'} → ${item.latest}`)
    }
    if (result.counts.unknown > 0) console.log(`另有 ${result.counts.unknown} 个插件无法检查，见报告。`)
  }
}
