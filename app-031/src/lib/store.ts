// 全局状态：Vue reactive 单例 + localStorage 持久化（无 Pinia/Vuex）
import { reactive, computed } from 'vue'
import type {
  Board,
  Job,
  NestResult,
  Part,
  Placement,
  RegisteredOffcut,
  SheetResult,
  RevisionRecord,
  RevisionReport,
  RevisionSnapshot,
  RevisionStrategy,
  ExportRecord
} from '../types'
import { nestJob, type FrozenSheet } from './packing'
import { rebuildFromPlacements } from './cuts'
import { guillotineViolation } from './geometry'
import { buildRevisionReport, partToLoose } from './revision'
import { uid, parseEdges } from './format'
import boardsData from '../data/boards.json'

const JOBS_KEY = 'fco.jobs.v1'
const OFFCUTS_KEY = 'fco.offcuts.v1'

interface State {
  jobs: Job[]
  offcuts: RegisteredOffcut[]
  loaded: boolean
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as T
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback
    return parsed
  } catch {
    return fallback
  }
}

const state = reactive<State>({
  jobs: [],
  offcuts: [],
  loaded: false
})

function persist(): void {
  localStorage.setItem(JOBS_KEY, JSON.stringify(state.jobs))
  localStorage.setItem(OFFCUTS_KEY, JSON.stringify(state.offcuts))
}

function init(): void {
  if (state.loaded) return
  state.jobs = load<Job[]>(JOBS_KEY, [])
  state.offcuts = load<RegisteredOffcut[]>(OFFCUTS_KEY, [])
  state.loaded = true
}

export function defaultBoards(): Board[] {
  return boardsData.stockBoards.slice(0, 3).map((b) => ({
    id: uid('b'),
    name: b.name,
    wMm: b.wMm,
    hMm: b.hMm,
    thicknessMm: b.thicknessMm,
    material: b.material,
    priceCents: b.priceCents,
    quantity: 0,
    kind: 'stock'
  }))
}

export function allStockTemplates(): Omit<Board, 'id'>[] {
  return boardsData.stockBoards.map((b) => ({
    name: b.name,
    wMm: b.wMm,
    hMm: b.hMm,
    thicknessMm: b.thicknessMm,
    material: b.material,
    priceCents: b.priceCents,
    quantity: 0,
    kind: 'stock' as const
  }))
}

export function createJob(name: string): Job {
  init()
  const job: Job = {
    id: uid('job'),
    name: name.trim() || `开料项目 ${state.jobs.length + 1}`,
    createdAt: Date.now(),
    boards: defaultBoards(),
    parts: [],
    kerfMm: boardsData.defaults.kerfMm,
    trimMm: boardsData.defaults.trimMm,
    useOffcutIds: [],
    batchByCabinet: false
  }
  state.jobs.unshift(job)
  persist()
  return job
}

export function deleteJob(id: string): void {
  const i = state.jobs.findIndex((j) => j.id === id)
  if (i >= 0) state.jobs.splice(i, 1)
  persist()
}

export function duplicateJob(id: string): Job | null {
  const src = getJob(id)
  if (!src) return null
  const job: Job = JSON.parse(JSON.stringify(src))
  job.id = uid('job')
  job.name = `${src.name} 副本`
  job.createdAt = Date.now()
  job.result = undefined
  state.jobs.unshift(job)
  persist()
  return job
}

export function saveJob(_job: Job): void {
  persist()
}

export function getJob(id: string): Job | undefined {
  init()
  return state.jobs.find((j) => j.id === id)
}

/** 把勾选的登记余料转成本单可用的小板（排在板材列表前，优先消耗）。 */
function boardsWithOffcuts(job: Job): Board[] {
  const offcutBoards: Board[] = state.offcuts
    .filter((o) => o.available && job.useOffcutIds.includes(o.id))
    .map((o) => ({
      id: `offcut_${o.id}`,
      name: `余料板 ${o.wMm}×${o.hMm}×${o.thicknessMm}（${o.material}）`,
      wMm: o.wMm,
      hMm: o.hMm,
      thicknessMm: o.thicknessMm,
      material: o.material,
      priceCents: 0,
      quantity: 1,
      kind: 'offcut' as const,
      offcutId: o.id
    }))
  return [...offcutBoards, ...job.boards]
}

export function runNest(job: Job): NestResult {
  const effective: Job = { ...job, boards: boardsWithOffcuts(job) }
  const result = nestJob(effective)
  // 标记被用掉的余料
  const usedOffcutBoardIds = new Set(
    result.sheets.filter((s) => s.boardId.startsWith('offcut_')).map((s) => s.boardId)
  )
  for (const oc of state.offcuts) {
    if (usedOffcutBoardIds.has(`offcut_${oc.id}`)) {
      oc.available = false
      oc.usedByJobId = job.id
    }
  }
  job.result = result
  persist()
  return result
}

// ───────────────────────── 改版影响核定（中途改图） ─────────────────────────

export function currentRevNo(job: Job): number {
  const id = job.activeRevisionId
  if (!id) return 0
  const rec = job.revisions?.find((r) => r.id === id)
  return rec ? rec.newRevNo : 0
}

/** 当前生效的改版核定报告（明细页/工单页/统计页同源读取，杜绝三处各算一遍）。 */
export function activeRevisionReport(job: Job): RevisionReport | null {
  if (!job.activeRevisionId || !job.revisions) return null
  const rec = job.revisions.find((r) => r.id === job.activeRevisionId && r.applied)
  return rec?.report ?? null
}

export function pendingRevisionReport(job: Job): RevisionReport | null {
  const rec = job.revisions?.find((r) => !r.applied && !r.rolledBack)
  return rec?.report ?? null
}

interface DraftRevisionInput {
  newParts: Part[]
  strategy: RevisionStrategy
  label: string
  boards?: Board[] // 一般沿用本单板材库；留空取 job.boards
}

interface DraftRevisionResult {
  record: RevisionRecord
  previewResult: NestResult
}

/**
 * 试算一版改版（不落库）：把旧版整版快照 + 新旧对比报告 + 按所选策略的预排结果
 * 一次性算齐。三个页面以后只读本对象。
 */
export function draftRevision(job: Job, input: DraftRevisionInput): DraftRevisionResult | null {
  const strategy = input.strategy
  const boards = input.boards ?? job.boards
  const baseRevNo = currentRevNo(job)
  const oldParts = JSON.parse(JSON.stringify(job.parts)) as Part[]
  const newParts = JSON.parse(JSON.stringify(input.newParts)) as Part[]
  const oldResult = job.result ? (JSON.parse(JSON.stringify(job.result)) as NestResult) : undefined

  // 板种 id 在新版 parts 里仍引用 job.boards 的 id；两版结构靠 report 内 boardKey（名+厚度）对齐
  const oldLoose = oldParts.map(partToLoose)
  const newLoose = newParts.map(partToLoose)

  let previewResult: NestResult
  if (strategy === 'reuse' && oldResult) {
    const { sheets: frozen, skipKeys } = buildFrozenSheets(oldParts, newParts, oldResult, boards)
    previewResult = nestJob({ ...job, boards, parts: newParts }, frozen, skipKeys)
  } else {
    previewResult = nestJob({ ...job, boards, parts: newParts })
  }

  const report = buildRevisionReport({
    oldLoose,
    newLoose,
    boards,
    strategy,
    oldResult,
    newResult: previewResult
  })

  const oldSnapshot: RevisionSnapshot = {
    revNo: baseRevNo,
    label: baseRevNo === 0 ? '原始版' : `第 ${baseRevNo} 版`,
    appliedAt: job.revisions?.find((r) => r.id === job.activeRevisionId)?.appliedAt ?? job.createdAt,
    strategy: job.revisions?.find((r) => r.id === job.activeRevisionId)?.strategy ?? 'rerun',
    parts: oldParts,
    result: oldResult
  }

  const record: RevisionRecord = {
    id: uid('rev'),
    createdAt: Date.now(),
    strategy,
    baseRevNo,
    newRevNo: baseRevNo + 1,
    label: input.label.trim() || `第 ${baseRevNo + 1} 版`,
    report,
    oldSnapshot,
    applied: false
  }
  return { record, previewResult }
}

/**
 * 由旧排样结果构造冻结板：只保留「件号两版相同 且 长宽/纹理 未变 且 板种结构兼容
 * （厚度+材质；粘贴来的新版不带板 id，按自动选板落到同结构板）且数量内」的件，
 * 其余件从旧板撤出（该板要么 reopened 要么 mixed）。放置坐标/朝向原样保留。
 * 新 part 对象有新 id，需要把旧 placement 的 partId/instanceId 重写到新 part，
 * 才能让排样器的 skipKeys 与最终标签一致。
 */
function buildFrozenSheets(
  oldParts: Part[],
  newParts: Part[],
  oldResult: NestResult,
  boards: Board[]
): { sheets: FrozenSheet[]; skipKeys: string[] } {
  const oldByCode = new Map<string, Part>()
  for (const p of oldParts) oldByCode.set(p.code, p)
  const newByCode = new Map<string, Part>()
  for (const p of newParts) newByCode.set(p.code, p)
  const boardById = new Map(boards.map((b) => [b.id, b]))
  // 件的「板种结构」：指定板取该板，否则自动选最小板（与 revision 核算的自动选板同口径）
  const structureOf = (p: Part): string => {
    const direct = p.boardId ? boardById.get(p.boardId) : undefined
    if (direct) return `${direct.thicknessMm}/${direct.material}`
    const auto = [...boards].sort((a, b) => a.wMm * a.hMm - b.wMm * b.hMm)[0]
    return auto ? `${auto.thicknessMm}/${auto.material}` : ''
  }

  const geomSame = (a: Part, b: Part): boolean =>
    a.lenMm === b.lenMm && a.widMm === b.widMm && a.grain === b.grain && structureOf(a) === structureOf(b)

  const out: FrozenSheet[] = []
  const newInstanceKeys: string[] = []
  const globalUsed = new Map<string, number>() // 件号在所有旧板上已保留到第几件（跨板连续编号）
  oldResult.sheets.forEach((sheet, oldSheetIndex) => {
    const kept: Placement[] = []
    for (const pl of sheet.placements) {
      const oldP = oldByCode.get(pl.code)
      const newP = newByCode.get(pl.code)
      if (!oldP || !newP || !geomSame(oldP, newP)) continue
      const used = globalUsed.get(pl.code) ?? 0
      if (used >= newP.qty) continue // 数量减少：多余的件不留
      globalUsed.set(pl.code, used + 1)
      // 留用件用新版实例号（标签/选择器与新版 parts 对齐），同件号跨旧板连续编号，
      // 并登记为「已摆放」，排样器展开新版实例时跳过，不会在新板上重复排。
      const newInstanceKey = `${newP.id}#${used + 1}`
      newInstanceKeys.push(newInstanceKey)
      kept.push({
        ...pl,
        partId: newP.id,
        instanceId: newInstanceKey,
        boardIndex: oldSheetIndex,
        retained: true
      })
    }
    if (kept.length === 0) return // 整板撤空：不冻结，走 reopened/新开
    out.push({
      board: {
        id: `frozen_${oldSheetIndex}_${uid('b')}`,
        name: sheet.boardName,
        wMm: sheet.wMm,
        hMm: sheet.hMm,
        thicknessMm: sheet.thicknessMm,
        material: sheet.material,
        priceCents: sheet.priceCents,
        quantity: 1,
        kind: 'stock'
      },
      placements: kept,
      oldSheetIndex,
      oldCutCount: sheet.steps.filter((s) => s.kind === 'cut').length
    })
  })
  return { sheets: out, skipKeys: newInstanceKeys }
}

/** 应用改版：旧版整版入档（含当时用板/封边原数，永不被覆盖），清单与排样切到新版。 */
export function applyRevision(
  job: Job,
  record: RevisionRecord,
  previewResult: NestResult,
  newParts: Part[]
): void {
  // 存根（_newParts 仅供同会话再回退使用；持久化以 job.parts/result 为准）
  ;(record as RevisionRecord & { _newParts?: Part[] })._newParts = JSON.parse(
    JSON.stringify(newParts)
  )

  // 作废台账：本改版前导出/下发过的清单全部标记作废，等待重发
  voidPendingExports(job, record)

  record.applied = true
  record.appliedAt = Date.now()
  if (!job.revisions) job.revisions = []
  const idx = job.revisions.findIndex((r) => r.id === record.id)
  if (idx >= 0) job.revisions.splice(idx, 1)
  job.revisions.unshift(record)
  job.activeRevisionId = record.id
  job.parts = JSON.parse(JSON.stringify(newParts))
  job.result = previewResult
  persist()
}

/**
 * 回退到旧版（走错的那条路：存档旧结果与已发清单作废，回退重发）。
 * 回退目标 = 该次改版的旧版（oldSnapshot）；旧版那组数（用板/封边）原样恢复，不重算。
 */
export function rollbackRevision(job: Job, revisionId: string, reason: string): void {
  const rec = job.revisions?.find((r) => r.id === revisionId)
  if (!rec || !rec.applied) return
  rec.rolledBack = true
  rec.rolledBackAt = Date.now()
  // 该版导出的清单全部作废
  for (const ex of job.exports ?? []) {
    if (ex.revNo === rec.newRevNo && !ex.voided) {
      ex.voided = true
      ex.voidedAt = Date.now()
      ex.voidReason = `改版回退：${reason}`
    }
  }
  // 恢复到「旧版自己」的零件与排样（不是它的再上一版）
  const targetParts = JSON.parse(JSON.stringify(rec.oldSnapshot.parts)) as Part[]
  const targetResult = rec.oldSnapshot.result
    ? (JSON.parse(JSON.stringify(rec.oldSnapshot.result)) as NestResult)
    : undefined
  // 若旧版也是一次改版应用后的状态，其零件即等于那次改版应用时的 newParts
  const earlier = (job.revisions ?? [])
    .filter((r) => r.applied && !r.rolledBack && r.newRevNo === rec.baseRevNo)
    .sort((a, b) => b.newRevNo - a.newRevNo)[0]
  const restoreParts = earlier
    ? JSON.parse(
        JSON.stringify((earlier as RevisionRecord & { _newParts?: Part[] })._newParts ?? targetParts)
      ) as Part[]
    : targetParts
  job.parts = restoreParts
  job.result = targetResult
  job.activeRevisionId = earlier?.id
  persist()
}

/** 翻回旧版查看（只读，不动当前清单）：返回旧版快照。 */
export function viewOldSnapshot(job: Job, revisionId: string): RevisionSnapshot | null {
  const rec = job.revisions?.find((r) => r.id === revisionId)
  return rec?.oldSnapshot ?? null
}

/** 导出/下发记账：登记一次清单导出，带文号与当时版号。 */
export function recordExport(job: Job, sections: string[], documentId?: string): ExportRecord {
  const doc: ExportRecord = {
    id: uid('doc'),
    at: Date.now(),
    sections,
    revNo: currentRevNo(job),
    documentId: documentId ?? `XL-${job.id.slice(-4)}-R${currentRevNo(job)}-${Date.now().toString(36).slice(-4)}`.toUpperCase(),
    voided: false
  }
  if (!job.exports) job.exports = []
  job.exports.unshift(doc)
  persist()
  return doc
}

/** 重发：把指定旧清单作废，登记一份新文号清单（两号互相挂接）。 */
export function reissueExport(
  job: Job,
  oldDocId: string,
  sections: string[]
): { oldDoc: ExportRecord; newDoc: ExportRecord } | null {
  const oldDoc = job.exports?.find((e) => e.id === oldDocId)
  if (!oldDoc) return null
  const newDoc = recordExport(job, sections)
  oldDoc.voided = true
  oldDoc.voidedAt = Date.now()
  oldDoc.voidReason = '改版后重发，旧清单作废'
  oldDoc.supersededBy = newDoc.documentId
  newDoc.replacedDocId = oldDoc.documentId
  persist()
  return { oldDoc, newDoc }
}

function voidPendingExports(job: Job, record: RevisionRecord): void {
  const oldRevNo = record.baseRevNo
  for (const ex of job.exports ?? []) {
    if (ex.revNo <= oldRevNo && !ex.voided) {
      ex.voided = true
      ex.voidedAt = Date.now()
      ex.voidReason = `第 ${record.newRevNo} 版改图：旧版清单停止使用，请按重发清单下料`
    }
  }
}

export function activeExports(job: Job): ExportRecord[] {
  return (job.exports ?? []).filter((e) => !e.voided)
}
export function voidedExports(job: Job): ExportRecord[] {
  return (job.exports ?? []).filter((e) => e.voided)
}


/** 手工微调：移动/交换后重新校验 guillotine 并重算刀路；非法返回错误信息。 */
export function applyAdjustment(
  job: Job,
  sheetIndex: number,
  placements: SheetResult['placements']
): string | null {
  if (!job.result) return '尚未排样'
  const sheet = job.result.sheets[sheetIndex]
  const bounds = {
    x: job.trimMm,
    y: job.trimMm,
    w: sheet.wMm - 2 * job.trimMm,
    h: sheet.hMm - 2 * job.trimMm
  }
  const violation = guillotineViolation(
    placements.map((p) => ({ id: p.instanceId, x: p.x, y: p.y, w: p.lenMm, h: p.widMm })),
    bounds,
    job.kerfMm
  )
  if (violation) return violation
  const rebuilt = rebuildFromPlacements(
    sheet.wMm,
    sheet.hMm,
    job.kerfMm,
    job.trimMm,
    sheetIndex,
    placements
  )
  if (!rebuilt) return '调整后无法生成可执行的贯通裁切刀路'
  const offcuts = rebuilt.leftovers
    .filter((r) => r.w >= 300 - 0.05 && r.h >= 300 - 0.05)
    .map((r) => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      wMm: Math.round(r.w),
      hMm: Math.round(r.h),
      areaMm2: Math.round(r.w * r.h),
      usable: true
    }))
    .sort((a, b) => b.areaMm2 - a.areaMm2)
  sheet.placements = placements.map((p) => ({ ...p, adjusted: true }))
  sheet.steps = rebuilt.steps
  sheet.offcuts = offcuts
  sheet.adjusted = true
  sheet.usedAreaMm2 = sheet.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)
  sheet.utilization = sheet.usedAreaMm2 / sheet.boardAreaMm2
  persist()
  return null
}

export function registerOffcuts(
  job: Job,
  picks: { sheetIndex: number; x: number; y: number; wMm: number; hMm: number }[]
): number {
  if (!job.result) return 0
  let n = 0
  for (const pick of picks) {
    const sheet = job.result.sheets[pick.sheetIndex]
    state.offcuts.push({
      id: uid('oc'),
      jobId: job.id,
      jobName: job.name,
      sheetIndex: pick.sheetIndex,
      wMm: pick.wMm,
      hMm: pick.hMm,
      thicknessMm: sheet.thicknessMm,
      material: sheet.material,
      createdAt: Date.now(),
      available: true
    })
    n++
  }
  persist()
  return n
}

export function addManualOffcut(input: {
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
}): void {
  state.offcuts.push({
    id: uid('oc'),
    jobId: '',
    jobName: '手工登记',
    sheetIndex: -1,
    wMm: input.wMm,
    hMm: input.hMm,
    thicknessMm: input.thicknessMm,
    material: input.material,
    createdAt: Date.now(),
    available: true
  })
  persist()
}

export function removeOffcut(id: string): void {
  const i = state.offcuts.findIndex((o) => o.id === id)
  if (i >= 0) state.offcuts.splice(i, 1)
  persist()
}

export function toggleOffcut(id: string): void {
  const o = state.offcuts.find((x) => x.id === id)
  if (o) {
    o.available = !o.available
    if (o.available) o.usedByJobId = undefined
    persist()
  }
}

/** 示例：一套橱柜 + 衣柜混合 BOM（含竖纹门板、见光侧板、背板 9mm） */
export function createSampleJob(): Job {
  const job = createJob('示例：三室全屋柜体（18mm 柜体 + 9mm 背板）')
  const b18 = job.boards[0] // 颗粒板 18mm
  const bBack = boardsData.stockBoards[6]
  const back: Board = {
    id: uid('b'),
    name: bBack.name,
    wMm: bBack.wMm,
    hMm: bBack.hMm,
    thicknessMm: bBack.thicknessMm,
    material: bBack.material,
    priceCents: bBack.priceCents,
    quantity: 0,
    kind: 'stock'
  }
  job.boards.push(back)
  const P = (
    code: string,
    name: string,
    l: number,
    w: number,
    qty: number,
    grain: Part['grain'],
    edges: Part['edgeBands'],
    cabinet: string,
    exposed: boolean,
    boardId?: string
  ): Part => ({
    id: uid('p'),
    code,
    name,
    lenMm: l,
    widMm: w,
    qty,
    grain,
    edgeBands: edges,
    cabinet,
    exposed,
    boardId: boardId ?? b18.id
  })
  const all4: Part['edgeBands'] = ['top', 'bottom', 'left', 'right']
  const lb: Part['edgeBands'] = ['left', 'right']
  const tb: Part['edgeBands'] = ['top', 'bottom']
  job.parts = [
    // 地柜（600 宽标准柜 ×2 + 800 宽水槽柜）
    P('DC-S', '地柜侧板', 700, 560, 4, 'length', lb, '地柜', false),
    P('DC-D', '地柜底板', 564, 560, 2, 'none', tb, '地柜', false),
    P('DC-T', '地柜顶板/拉带', 564, 100, 2, 'none', [], '地柜', false),
    P('DC-M', '地柜门(竖纹见光)', 700, 296, 2, 'length', all4, '地柜', true),
    P('SC-S', '水槽柜侧板', 700, 560, 2, 'length', lb, '水槽柜', false),
    P('SC-D', '水槽柜底板', 764, 560, 1, 'none', tb, '水槽柜', false),
    P('SC-M', '水槽柜门(竖纹见光)', 700, 396, 2, 'length', all4, '水槽柜', true),
    // 吊柜
    P('GC-S', '吊柜侧板', 700, 320, 4, 'length', lb, '吊柜', false),
    P('GC-P', '吊柜层板', 764, 320, 2, 'none', tb, '吊柜', false),
    P('GC-M', '吊柜门板(竖纹见光)', 700, 396, 2, 'length', all4, '吊柜', true),
    // 衣柜
    P('WR-S', '衣柜见光侧板', 2200, 580, 2, 'length', all4, '衣柜', true),
    P('WR-IS', '衣柜中侧板', 2180, 560, 1, 'length', lb, '衣柜', false),
    P('WR-P', '衣柜层板', 564, 560, 5, 'none', tb, '衣柜', false),
    P('WR-T', '衣柜顶板', 1800, 560, 1, 'none', tb, '衣柜', false),
    P('WR-B', '衣柜底板', 1800, 560, 1, 'none', tb, '衣柜', false),
    P('WR-M', '衣柜门板(竖纹见光)', 2180, 446, 4, 'length', all4, '衣柜', true),
    // 9mm 背板（指定板材）
    P('BB-D', '地柜/水槽柜背板', 690, 564, 3, 'none', [], '地柜', false, back.id),
    P('BB-G', '吊柜背板', 690, 764, 1, 'none', [], '吊柜', false, back.id),
    P('BB-W', '衣柜背板(竖纹)', 2180, 900, 2, 'length', [], '衣柜', false, back.id)
  ]
  return job
}

export function newPart(partial: Partial<Part> = {}): Part {
  return {
    id: uid('p'),
    code: partial.code ?? '',
    name: partial.name ?? '',
    lenMm: partial.lenMm ?? 0,
    widMm: partial.widMm ?? 0,
    qty: partial.qty ?? 1,
    grain: partial.grain ?? 'none',
    edgeBands: partial.edgeBands ?? [],
    cabinet: partial.cabinet ?? '未分组',
    exposed: partial.exposed ?? false,
    boardId: partial.boardId ?? ''
  }
}

/**
 * 改版粘贴导入：新版零件暂不指定板种（boardId 空=自动），
 * 若两版自动选板一致，「板材变」一栏不误报；用户也可在应用后到明细页指定。
 * 返回全新 part（新 id），不影响当前清单，直到用户确认应用。
 */
export function buildRevisionParts(
  _job: Job,
  rows: {
    code: string
    name: string
    lenMm: number
    widMm: number
    qty: number
    grain: string
    edges: string
    cabinet: string
    exposed: boolean
  }[]
): Part[] {
  return rows.map((r) =>
    newPart({
      code: r.code,
      name: r.name,
      lenMm: r.lenMm,
      widMm: r.widMm,
      qty: r.qty,
      grain: r.grain as Part['grain'],
      edgeBands: parseEdges(r.edges),
      cabinet: r.cabinet,
      exposed: r.exposed,
      boardId: ''
    })
  )
}

export function exportJobJson(job: Job): string {
  return JSON.stringify(job, null, 2)
}

export function importJobJson(json: string): Job | null {
  try {
    const obj = JSON.parse(json) as Job
    if (!obj.parts || !obj.boards) return null
    obj.id = uid('job')
    obj.createdAt = Date.now()
    obj.result = undefined
    state.jobs.unshift(obj)
    persist()
    return obj
  } catch {
    return null
  }
}

export function useStore() {
  init()
  return {
    state,
    jobs: computed(() => state.jobs),
    offcuts: computed(() => state.offcuts)
  }
}

export { boardsData }
