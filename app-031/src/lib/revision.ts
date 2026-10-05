// 改版影响核定（纯函数核心）：
// 旧版 vs 新版板件明细 → 按件号并件比对 → 逐件算差（用板/板钱/封边/五金）
// → 合计 + 逐项对账。三个页面（明细/工单/统计）只读同一份 RevisionReport，不允许各算一遍。
//
// 单位与精度（全局唯一口径，见 REPORT_PRECISION）：
// - 长度内部用 mm（整数输入），封边展示 m，保留 2 位小数（mm/1000）
// - 面积内部 mm²，展示 m²，保留 2 位（mm²/1_000_000）
// - 用板张数：实际张数为整数；逐件折算张数为小数（面积分摊口径），展示 3 位
// - 金额内部用「分」（整数），逐件折算可为小数分，展示前用最大余数法取整到分
// - 五金：连接件/木榫/螺丝按件取整数（套/个/颗），胶按 g 内部、kg 展示 3 位
//
// 折算口径说明：逐件的用板张数/板钱是「面积分摊毛口径」
// （件净面积 ÷ 整板面积，× 整板单价），保证逐项差值可加、合计与逐项对得平；
// 实际开板张数受排样整数化/锯路影响，另行列「实际排样」差值，两者差额即排样损益，
// 对账区明确指出，绝不用毛口径冒充实际张数。
import type {
  Board,
  CostRow,
  EdgeSide,
  GrainDemand,
  ItemMetrics,
  NormalizedPart,
  Part,
  PartChangeKind,
  ReconcileItem,
  RevisionReport,
  RevisionStrategy,
  RevisionTotals,
  SheetPlanRow,
  NestResult,
  SheetResult
} from '../types'
import boardsData from '../data/boards.json'

export const REPORT_PRECISION = {
  edgeM: 2,
  areaM2: 2,
  sheets: 3,
  glueKg: 3
} as const

const HW = boardsData.hardware

/** 外部粘贴/解析来的松行（缺字段允许 null）。 */
export interface LooseRow {
  code?: string | null
  name?: string | null
  lenMm?: number | null
  widMm?: number | null
  qty?: number | null
  grain?: GrainDemand | null
  edgeBands?: EdgeSide[] | null
  cabinet?: string | null
  exposed?: boolean | null
  boardKey?: string | null
}

const strOrNull = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const grainOrNull = (v: unknown): GrainDemand | null =>
  v === 'length' || v === 'width' || v === 'none' ? v : null

export const boardKeyOf = (b: Pick<Board, 'name' | 'thicknessMm'>): string =>
  `${b.name}|${b.thicknessMm}`

export function partToLoose(p: Part): LooseRow {
  return {
    code: p.code,
    name: p.name,
    lenMm: p.lenMm,
    widMm: p.widMm,
    qty: p.qty,
    grain: p.grain,
    edgeBands: p.edgeBands ?? [],
    cabinet: p.cabinet,
    exposed: p.exposed,
    boardKey: p.boardId ? `id:${p.boardId}` : null
  }
}

/**
 * 规范化一行：缺什么记什么为 null（空值），绝不臆造默认尺寸/数量。
 * boardKey 支持 `id:<旧boardId>`（内部 Part 转换，调用方需再用 boardIndex 映射成名+厚度）
 * 与 `名|厚度`（外部粘贴）两种写法。
 */
export function normalizeRow(raw: LooseRow): NormalizedPart {
  const code = strOrNull(raw.code)
  const name = strOrNull(raw.name)
  const lenMm = numOrNull(raw.lenMm)
  const widMm = numOrNull(raw.widMm)
  const qty = numOrNull(raw.qty)
  return {
    code,
    name,
    lenMm: lenMm !== null && lenMm > 0 ? lenMm : null,
    widMm: widMm !== null && widMm > 0 ? widMm : null,
    qty: qty !== null && qty > 0 ? Math.floor(qty) : null,
    grain: grainOrNull(raw.grain),
    edgeBands: Array.isArray(raw.edgeBands) ? [...new Set(raw.edgeBands)] : null,
    cabinet: strOrNull(raw.cabinet),
    exposed: typeof raw.exposed === 'boolean' ? raw.exposed : null,
    boardKey: strOrNull(raw.boardKey),
    mergedRows: 1,
    mergeNote: null
  }
}

interface BoardCtx {
  boards: Board[] // 已归一化（w>=h）
  byKey: Map<string, Board>
  byId: Map<string, Board>
}

export function makeBoardCtx(boards: Board[]): BoardCtx {
  const norm = boards.map((b) => (b.wMm >= b.hMm ? b : { ...b, wMm: b.hMm, hMm: b.wMm }))
  const byKey = new Map<string, Board>()
  const byId = new Map<string, Board>()
  for (const b of norm) {
    byKey.set(boardKeyOf(b), b)
    byId.set(b.id, b)
  }
  return { boards: norm, byKey, byId }
}

/** 把规范化行里的板种引用解析到具体板；解析不到/未指定时按自动选板规则。 */
function resolveBoard(row: NormalizedPart, ctx: BoardCtx): Board | null {
  if (row.boardKey) {
    if (row.boardKey.startsWith('id:')) {
      const b = ctx.byId.get(row.boardKey.slice(3))
      if (b) return b
    }
    const direct = ctx.byKey.get(row.boardKey)
    if (direct) return direct
    // 外部粘贴只写了名称的容错
    const byName = ctx.boards.find((b) => b.name === row.boardKey)
    if (byName) return byName
  }
  return autoBoard(row, ctx)
}

/** 自动选板：与排样器同口径——纹理朝向下放得下的最小整板；都放不下取最小板（会进未排下）。 */
function autoBoard(row: NormalizedPart, ctx: BoardCtx): Board | null {
  if (ctx.boards.length === 0) return null
  const l = row.lenMm
  const w = row.widMm
  if (l === null || w === null) return [...ctx.boards].sort((a, b) => a.wMm * a.hMm - b.wMm * b.hMm)[0]
  const fits = ctx.boards.filter((b) => {
    // 归一化后板长边沿 x；length 竖纹：件长沿 x；width 横纹：件宽沿 x
    const pw = row.grain === 'width' ? w : l
    const ph = row.grain === 'width' ? l : w
    return pw <= b.wMm + 0.05 && ph <= b.hMm + 0.05
  })
  const pool = fits.length > 0 ? fits : ctx.boards
  return [...pool].sort((a, b) => a.wMm * a.hMm - b.wMm * b.hMm)[0]
}

const edgeLenMm = (row: NormalizedPart): { exposed: number; normal: number; ok: boolean } => {
  const l = row.lenMm
  const w = row.widMm
  if (l === null || w === null || !row.edgeBands) return { exposed: 0, normal: 0, ok: false }
  const m =
    l *
      ((row.edgeBands.includes('top') ? 1 : 0) + (row.edgeBands.includes('bottom') ? 1 : 0)) +
    w *
      ((row.edgeBands.includes('left') ? 1 : 0) + (row.edgeBands.includes('right') ? 1 : 0))
  // 见光字段缺失（null）按非见光计（车间缺省即不见光），不臆造为见光
  const exposed = row.exposed === true
  return { exposed: exposed ? m * (row.qty ?? 0) : 0, normal: exposed ? 0 : m * (row.qty ?? 0), ok: true }
}

/** 逐件指标（原始精度）。 */
export function metricsOf(row: NormalizedPart, ctx: BoardCtx, warnings: string[]): ItemMetrics {
  const qty = row.qty ?? 0
  const l = row.lenMm
  const w = row.widMm
  if ((l === null || w === null) && (row.qty !== null || row.edgeBands)) {
    warnings.push(
      `件号「${row.code ?? '（空）'}」缺长或宽，面积/用板/该向封边按 0 计，请补录后再核`
    )
  }
  const area = (l ?? 0) * (w ?? 0) * qty
  const edges = edgeLenMm(row)
  if (!edges.ok && row.edgeBands && row.edgeBands.length > 0) {
    warnings.push(`件号「${row.code ?? '（空）'}」尺寸缺失，封边米数无法逐边计算，已按 0 计`)
  }
  let boardSheets = 0
  let boardArea = 0
  let boardCost = 0
  const board = resolveBoard(row, ctx)
  if (row.boardKey && !board) {
    warnings.push(`件号「${row.code ?? '（空）'}」指定板材「${row.boardKey}」在板材库中找不到，按自动选板计`)
  }
  if (board) {
    boardArea = board.wMm * board.hMm
    boardSheets = boardArea > 0 ? area / boardArea : 0
    boardCost = boardSheets * board.priceCents
  }
  const edgeMm = edges.exposed + edges.normal
  return {
    pieces: qty,
    areaMm2: area,
    edgeExposedMm: edges.exposed,
    edgeNormalMm: edges.normal,
    boardAreaMm2: boardArea,
    boardSheets,
    boardCostCents: boardCost,
    connectors: qty * HW.connectorPerPart,
    dowels: qty * HW.dowelPerPart,
    screws: qty * HW.screwPerPart,
    glueGrams: (edgeMm / 1000) * HW.glueGramPerEdgeMeter
  }
}

function zeroMetrics(): ItemMetrics {
  return {
    pieces: 0,
    areaMm2: 0,
    edgeExposedMm: 0,
    edgeNormalMm: 0,
    boardAreaMm2: 0,
    boardSheets: 0,
    boardCostCents: 0,
    connectors: 0,
    dowels: 0,
    screws: 0,
    glueGrams: 0
  }
}

function addMetrics(a: ItemMetrics, b: ItemMetrics): ItemMetrics {
  return {
    pieces: a.pieces + b.pieces,
    areaMm2: a.areaMm2 + b.areaMm2,
    edgeExposedMm: a.edgeExposedMm + b.edgeExposedMm,
    edgeNormalMm: a.edgeNormalMm + b.edgeNormalMm,
    boardAreaMm2: a.boardAreaMm2 + b.boardAreaMm2,
    boardSheets: a.boardSheets + b.boardSheets,
    boardCostCents: a.boardCostCents + b.boardCostCents,
    connectors: a.connectors + b.connectors,
    dowels: a.dowels + b.dowels,
    screws: a.screws + b.screws,
    glueGrams: a.glueGrams + b.glueGrams
  }
}

/**
 * 件号并件规矩（写明、可核）：
 * 1) 件号为空的行不并（无法认件），每行单独保留并警告；
 * 2) 同件号多行：长宽/纹理/指定板种一致 → 数量相加；名称取首个非空、柜组取首个非空、
 *    见光取「任一行为见光」、封边取并集（多封边只会多工不会切错）；
 * 3) 长宽/纹理/指定板种不一致 → 不允许糊成一条：以「数量最多的一行」为基准行，
 *    其余行数量不并入、原样保留为独立异常行（件号加后缀），并在 mergeNote/警告里指出。
 */
export function mergeByCode(loose: LooseRow[]): { rows: NormalizedPart[]; warnings: string[] } {
  const warnings: string[] = []
  const groups = new Map<string, NormalizedPart[]>()
  const blank: NormalizedPart[] = []
  for (const raw of loose) {
    const row = normalizeRow(raw)
    if (row.code === null) {
      row.mergeNote = '件号为空，未参与并件与按件号比对'
      warnings.push(`第 ${blank.length + 1} 行没有件号，无法认件，已单列且不参与比对`)
      blank.push(row)
      continue
    }
    const arr = groups.get(row.code) ?? []
    arr.push(row)
    groups.set(row.code, arr)
  }

  const sameSpec = (a: NormalizedPart, b: NormalizedPart): boolean =>
    a.lenMm === b.lenMm &&
    a.widMm === b.widMm &&
    (a.grain ?? 'none') === (b.grain ?? 'none') &&
    (a.boardKey ?? '') === (b.boardKey ?? '')

  const out: NormalizedPart[] = []
  for (const [code, rows] of groups) {
    if (rows.length === 1) {
      out.push(rows[0])
      continue
    }
    // 规格一致的行数量相加；不一致的行踢出
    const base = rows.reduce((a, b) => ((b.qty ?? 0) > (a.qty ?? 0) ? b : a), rows[0])
    const qtySum = (r: NormalizedPart[]): number => r.reduce((a, r2) => a + (r2.qty ?? 0), 0)
    const conflict: NormalizedPart[] = []
    const edgeSet = new Set<EdgeSide>()
    let exposed = false
    let merged = 0
    for (const r of rows) {
      if (!sameSpec(base, r)) {
        conflict.push(r)
        continue
      }
      merged++
      r.edgeBands?.forEach((e) => edgeSet.add(e))
      exposed = exposed || r.exposed === true
    }
    const mergedRow: NormalizedPart = {
      ...base,
      name: rows.map((r) => r.name).find((n) => n !== null) ?? null,
      cabinet: rows.map((r) => r.cabinet).find((c) => c !== null) ?? null,
      qty: qtySum(rows.filter((r) => sameSpec(base, r))),
      edgeBands: base.edgeBands ? [...edgeSet] : null,
      exposed: base.edgeBands ? exposed : base.exposed,
      mergedRows: merged,
      mergeNote: merged > 1 ? `${merged} 行同规格，数量已相加；封边取并集` : null
    }
    out.push(mergedRow)
    if (conflict.length > 0) {
      warnings.push(
        `件号「${code}」出现 ${rows.length} 行但长宽/纹理/板种不一致：按规矩以数量最多的一行为准并为一条，冲突 ${conflict.length} 行未并入（见异常行 ${code}~c1…）`
      )
      conflict.forEach((r, i) => {
        out.push({
          ...r,
          code: `${code}~c${i + 1}`,
          mergeNote: `与件号 ${code} 主行规格冲突，未并入；请确认是否应为新件号`
        })
      })
    }
  }
  return { rows: [...out, ...blank], warnings }
}

const KIND_LABEL: Record<PartChangeKind, string> = {
  added: '新增',
  removed: '删除',
  unchanged: '未变',
  size: '长宽变',
  qty: '数量变',
  grain: '纹理变',
  edge: '封边变',
  board: '板材变'
}
export const kindLabel = (k: PartChangeKind): string => KIND_LABEL[k]

function dimsText(r: NormalizedPart | null): string {
  if (!r) return '—'
  return `${r.lenMm ?? '?'}×${r.widMm ?? '?'} ×${r.qty ?? '?'}`
}
const grainText = (g: GrainDemand | null): string =>
  g === 'length' ? '竖纹' : g === 'width' ? '横纹' : g === 'none' ? '无要求' : '（空）'
const edgeText = (e: EdgeSide[] | null): string => {
  if (!e) return '（空）'
  const map: Record<EdgeSide, string> = { top: '上', bottom: '下', left: '左', right: '右' }
  return e.length ? e.map((x) => map[x]).join('') : '无封边'
}

function classify(old: NormalizedPart | null, neu: NormalizedPart | null): PartChangeKind[] {
  if (old && !neu) return ['removed']
  if (!old && neu) return ['added']
  if (!old || !neu) return ['unchanged']
  const kinds: PartChangeKind[] = []
  if (old.lenMm !== neu.lenMm || old.widMm !== neu.widMm) kinds.push('size')
  if (old.qty !== neu.qty) kinds.push('qty')
  if ((old.grain ?? null) !== (neu.grain ?? null)) kinds.push('grain')
  if (edgeSetKey(old.edgeBands) !== edgeSetKey(neu.edgeBands)) kinds.push('edge')
  if ((old.boardKey ?? '') !== (neu.boardKey ?? '')) kinds.push('board')
  return kinds
}

const edgeSetKey = (e: EdgeSide[] | null): string =>
  e === null ? '\0null' : [...e].sort().join(',')

function reasonsFor(old: NormalizedPart | null, neu: NormalizedPart | null, kinds: PartChangeKind[]): string[] {
  const out: string[] = []
  for (const k of kinds) {
    if (k === 'added') out.push(`新版新增 ×${neu?.qty ?? 0}`)
    else if (k === 'removed') out.push(`新版删除（旧版 ×${old?.qty ?? 0}）`)
    else if (k === 'size') out.push(`长宽 ${dimsText(old)} → ${dimsText(neu)}`)
    else if (k === 'qty') out.push(`数量 ${old?.qty ?? '空'} → ${neu?.qty ?? '空'}`)
    else if (k === 'grain') out.push(`纹理 ${grainText(old?.grain ?? null)} → ${grainText(neu?.grain ?? null)}`)
    else if (k === 'edge') out.push(`封边 ${edgeText(old?.edgeBands ?? null)} → ${edgeText(neu?.edgeBands ?? null)}`)
    else if (k === 'board') out.push(`指定板材 ${old?.boardKey ?? '自动'} → ${neu?.boardKey ?? '自动'}`)
  }
  return out
}

/** 实际排样口径的封边（mm，直接从 placements 复算，绕开结果里 2 位小数的截断）。 */
export function actualEdgeMm(result: NestResult | undefined): { exposed: number; normal: number } {
  if (!result) return { exposed: 0, normal: 0 }
  let exposed = 0
  let normal = 0
  for (const s of result.sheets) {
    for (const p of s.placements) {
      const m =
        p.origLen *
          ((p.edgeBands.includes('top') ? 1 : 0) + (p.edgeBands.includes('bottom') ? 1 : 0)) +
        p.origWid *
          ((p.edgeBands.includes('left') ? 1 : 0) + (p.edgeBands.includes('right') ? 1 : 0))
      if (p.exposed) exposed += m
      else normal += m
    }
  }
  return { exposed, normal }
}

function totalsFrom(
  rows: NormalizedPart[],
  ctx: BoardCtx,
  warnings: string[]
): { totals: RevisionTotals; metrics: Map<string, ItemMetrics> } {
  const acc = zeroMetrics()
  const metrics = new Map<string, ItemMetrics>()
  for (const r of rows) {
    const m = metricsOf(r, ctx, warnings)
    metrics.set(r.code ?? '', m)
    Object.assign(acc, addMetrics(acc, m))
  }
  const totals: RevisionTotals = {
    pieces: acc.pieces,
    areaMm2: acc.areaMm2,
    edgeExposedMm: acc.edgeExposedMm,
    edgeNormalMm: acc.edgeNormalMm,
    edgeMm: acc.edgeExposedMm + acc.edgeNormalMm,
    boardSheets: acc.boardSheets,
    boardCostCents: acc.boardCostCents,
    connectors: acc.connectors,
    dowels: acc.dowels,
    screws: acc.screws,
    glueGrams: acc.glueGrams,
    actualBoardsUsed: 0,
    actualCostCents: 0,
    actualEdgeExposedMm: 0,
    actualEdgeNormalMm: 0
  }
  return { totals, metrics }
}

/**
 * 最大余数法：把各行的小数差值（分）取整为整数分，且各行取整后之和恰好等于总差取整值。
 * 正负混合时按各自分数部分的绝对值大小分配尾差，符号不变。
 */
export function largestRemainderCents(values: number[], targetCents: number): number[] {
  const target = Math.round(targetCents)
  const floors = values.map((v) => Math.trunc(v))
  let rest = target - floors.reduce((a, b) => a + b, 0)
  const order = values
    .map((v, i) => ({ i, frac: Math.abs(v - Math.trunc(v)) }))
    .sort((a, b) => b.frac - a.frac)
  const out = [...floors]
  const step = rest > 0 ? 1 : rest < 0 ? -1 : 0
  for (const { i } of order) {
    if (rest === 0) break
    if (values[i] === 0) continue
    if (step > 0) {
      out[i] += 1
      rest--
    } else {
      out[i] -= 1
      rest++
    }
  }
  return out
}

const METRIC_LABELS: { key: keyof ItemMetrics; name: string; unit: string; precision: number }[] = [
  { key: 'pieces', name: '件数', unit: '件', precision: 0 },
  { key: 'areaMm2', name: '净面积', unit: 'mm²', precision: 0 },
  { key: 'edgeExposedMm', name: '见光封边', unit: 'mm', precision: 0 },
  { key: 'edgeNormalMm', name: '非见光封边', unit: 'mm', precision: 0 },
  { key: 'boardSheets', name: '折算用板张数', unit: '张', precision: 6 },
  { key: 'connectors', name: '三合一连接件', unit: '套', precision: 0 },
  { key: 'dowels', name: '木榫', unit: '个', precision: 0 },
  { key: 'screws', name: '自攻螺丝', unit: '颗', precision: 0 },
  { key: 'glueGrams', name: '封边热熔胶', unit: 'g', precision: 3 }
]

export interface BuildReportInput {
  oldLoose: LooseRow[]
  newLoose: LooseRow[]
  boards: Board[]
  strategy: RevisionStrategy
  oldResult?: NestResult
  newResult?: NestResult
  strategyNote?: string
}

export function buildRevisionReport(input: BuildReportInput): RevisionReport {
  const warnings: string[] = []
  const ctx = makeBoardCtx(input.boards)
  const oldMerge = mergeByCode(input.oldLoose)
  const newMerge = mergeByCode(input.newLoose)
  warnings.push(...oldMerge.warnings, ...newMerge.warnings)
  const oldRows = oldMerge.rows
  const newRows = newMerge.rows

  const oldT = totalsFrom(oldRows, ctx, warnings)
  const newT = totalsFrom(newRows, ctx, warnings)

  // 实际排样口径
  const oldEdge = actualEdgeMm(input.oldResult)
  const newEdge = actualEdgeMm(input.newResult)
  oldT.totals.actualBoardsUsed = input.oldResult?.boardsUsed ?? 0
  oldT.totals.actualCostCents = input.oldResult?.totalCostCents ?? 0
  oldT.totals.actualEdgeExposedMm = oldEdge.exposed
  oldT.totals.actualEdgeNormalMm = oldEdge.normal
  newT.totals.actualBoardsUsed = input.newResult?.boardsUsed ?? 0
  newT.totals.actualCostCents = input.newResult?.totalCostCents ?? 0
  newT.totals.actualEdgeExposedMm = newEdge.exposed
  newT.totals.actualEdgeNormalMm = newEdge.normal

  // 件号对齐（冲突后缀行视为独立件号，两边都可能新增/删除）
  const codes = new Set<string>([
    ...oldRows.map((r) => r.code ?? ''),
    ...newRows.map((r) => r.code ?? '')
  ])
  const oldMap = new Map(oldRows.map((r) => [r.code ?? '', r]))
  const newMap = new Map(newRows.map((r) => [r.code ?? '', r]))

  const rawRows: CostRow[] = []
  for (const code of codes) {
    const o = oldMap.get(code) ?? null
    const n = newMap.get(code) ?? null
    const kinds = classify(o, n)
    if (kinds.length === 0) kinds.push('unchanged')
    const oldM = o ? oldT.metrics.get(code) ?? zeroMetrics() : zeroMetrics()
    const newM = n ? newT.metrics.get(code) ?? zeroMetrics() : zeroMetrics()
    const delta = addMetrics(newM, negate(oldM))
    rawRows.push({
      code: code || '（空件号）',
      name: n?.name ?? o?.name ?? '',
      kinds,
      reasons: reasonsFor(o, n, kinds),
      old: o,
      neu: n,
      delta,
      oldM,
      newM,
      deltaCostRoundedCents: 0
    })
  }

  // 料钱差取整到分（最大余数法，保证逐项合计与总差一致）
  const targetDeltaCents = newT.totals.boardCostCents - oldT.totals.boardCostCents
  const rounded = largestRemainderCents(rawRows.map((r) => r.delta.boardCostCents), targetDeltaCents)
  rawRows.forEach((r, i) => (r.deltaCostRoundedCents = rounded[i]))

  // 成本表排序：差得多 → 差得少（先按取整料钱绝对值，再折算张数、面积、件数）
  const rows = rawRows.sort(
    (a, b) =>
      Math.abs(b.deltaCostRoundedCents) - Math.abs(a.deltaCostRoundedCents) ||
      Math.abs(b.delta.boardSheets) - Math.abs(a.delta.boardSheets) ||
      Math.abs(b.delta.areaMm2) - Math.abs(a.delta.areaMm2) ||
      Math.abs(b.delta.pieces) - Math.abs(a.delta.pieces)
  )

  const deltaTotals: RevisionTotals = {
    pieces: newT.totals.pieces - oldT.totals.pieces,
    areaMm2: newT.totals.areaMm2 - oldT.totals.areaMm2,
    edgeExposedMm: newT.totals.edgeExposedMm - oldT.totals.edgeExposedMm,
    edgeNormalMm: newT.totals.edgeNormalMm - oldT.totals.edgeNormalMm,
    edgeMm: newT.totals.edgeMm - oldT.totals.edgeMm,
    boardSheets: newT.totals.boardSheets - oldT.totals.boardSheets,
    boardCostCents: targetDeltaCents,
    connectors: newT.totals.connectors - oldT.totals.connectors,
    dowels: newT.totals.dowels - oldT.totals.dowels,
    screws: newT.totals.screws - oldT.totals.screws,
    glueGrams: newT.totals.glueGrams - oldT.totals.glueGrams,
    actualBoardsUsed: newT.totals.actualBoardsUsed - oldT.totals.actualBoardsUsed,
    actualCostCents: newT.totals.actualCostCents - oldT.totals.actualCostCents,
    actualEdgeExposedMm: newT.totals.actualEdgeExposedMm - oldT.totals.actualEdgeExposedMm,
    actualEdgeNormalMm: newT.totals.actualEdgeNormalMm - oldT.totals.actualEdgeNormalMm
  }

  // 对账：逐项差值合计 vs 两版合计之差
  const reconcile: ReconcileItem[] = []
  for (const m of METRIC_LABELS) {
    const sum = rows.reduce((a, r) => a + r.delta[m.key], 0)
    const total = deltaTotals[m.key as keyof RevisionTotals] as number
    const ok = Math.abs(sum - total) <= Math.pow(10, -m.precision) * 0.5 + 1e-6
    reconcile.push({
      metric: m.name,
      sumDeltas: sum,
      totalDelta: total,
      unit: m.unit,
      precision: m.precision,
      ok,
      detail: ok
        ? `逐项合计 ${fmtNum(sum, m.precision)}${m.unit} = 两版总差`
        : `对不上：逐项合计 ${fmtNum(sum, m.precision)}${m.unit} ≠ 两版总差 ${fmtNum(total, m.precision)}${m.unit}`
    })
  }
  // 料钱单独用「取整到分」的口径对
  const sumCostRounded = rows.reduce((a, r) => a + r.deltaCostRoundedCents, 0)
  const totalCostRounded = Math.round(targetDeltaCents)
  const costOk = sumCostRounded === totalCostRounded
  reconcile.push({
    metric: '板材料钱（取整到分）',
    sumDeltas: sumCostRounded,
    totalDelta: totalCostRounded,
    unit: '分',
    precision: 0,
    ok: costOk,
    detail: costOk
      ? `逐项料钱差合计 ${sumCostRounded} 分 = 两版板钱总差（最大余数法分尾差）`
      : `对不上：逐项 ${sumCostRounded} 分 ≠ 总差 ${totalCostRounded} 分`
  })
  // 实际排样口径单列对账（指出与毛口径的排样损益，不允许混作一项）
  if (input.oldResult || input.newResult) {
    const grossSheetDelta = deltaTotals.boardSheets
    reconcile.push({
      metric: '实际开板张数（排样整数口径）',
      sumDeltas: grossSheetDelta,
      totalDelta: deltaTotals.actualBoardsUsed,
      unit: '张',
      precision: 0,
      ok: true,
      detail: `实际 ${input.oldResult?.boardsUsed ?? 0} → ${input.newResult?.boardsUsed ?? 0} 张（差 ${deltaTotals.actualBoardsUsed} 张）；折算毛口径差 ${grossSheetDelta.toFixed(3)} 张，差额 ${(deltaTotals.actualBoardsUsed - grossSheetDelta).toFixed(3)} 张为排样整数化/锯路损益（锯缝与空档不参与面积分摊）`
    })
    reconcile.push({
      metric: '实际板钱（排样整数口径）',
      sumDeltas: Math.round(targetDeltaCents),
      totalDelta: deltaTotals.actualCostCents,
      unit: '分',
      precision: 0,
      ok: true,
      detail: `实际板钱 ${input.oldResult?.totalCostCents ?? 0} → ${input.newResult?.totalCostCents ?? 0} 分（差 ${deltaTotals.actualCostCents} 分）；毛口径差 ${Math.round(targetDeltaCents)} 分，差 ${deltaTotals.actualCostCents - Math.round(targetDeltaCents)} 分为排样损益`
    })
  }

  const byCode: RevisionReport['byCode'] = {}
  for (const r of rows) {
    byCode[r.code] = { kinds: r.kinds, reasons: r.reasons, deltaCostCents: r.deltaCostRoundedCents }
  }
  const affected = rows
    .filter((r) => !(r.kinds.length === 1 && r.kinds[0] === 'unchanged'))
    .map((r) => r.code)
  const unchanged = rows
    .filter((r) => r.kinds.length === 1 && r.kinds[0] === 'unchanged')
    .map((r) => r.code)

  const sheetPlan = buildSheetPlan(input.oldResult, input.newResult, rows, input.strategy)

  return {
    generatedAt: Date.now(),
    oldRows,
    newRows,
    rows,
    warnings,
    oldTotals: oldT.totals,
    newTotals: newT.totals,
    deltaTotals,
    reconcile,
    costReconcileOk: costOk && reconcile.every((r) => r.ok),
    byCode,
    affectedCodes: affected,
    unchangedCodes: unchanged,
    sheetPlan,
    strategy: input.strategy,
    strategyNote:
      input.strategyNote ??
      (input.strategy === 'rerun'
        ? '整批重排：摆法与刀路全部重算，结果最干净；代价是旧版已摆好的摆法/刀路与已切板全部白做（多花一遍工时与料）。'
        : '留用旧摆法：未受影响的板不动，只重开受影响板并把新版件插进空档；省工时，但新旧混排的板要多走几次回头切。')
  }
}

function negate(m: ItemMetrics): ItemMetrics {
  return {
    pieces: -m.pieces,
    areaMm2: -m.areaMm2,
    edgeExposedMm: -m.edgeExposedMm,
    edgeNormalMm: -m.edgeNormalMm,
    boardAreaMm2: -m.boardAreaMm2,
    boardSheets: -m.boardSheets,
    boardCostCents: -m.boardCostCents,
    connectors: -m.connectors,
    dowels: -m.dowels,
    screws: -m.screws,
    glueGrams: -m.glueGrams
  }
}

function fmtNum(v: number, precision: number): string {
  return v.toFixed(precision)
}

/**
 * 留用方案的旧板处置单（以实际排样结果为准，同源给工单页）：
 * - 旧板上没有任何受影响件 → kept（整板留用，刀路照旧）
 * - 旧板上有删除/改动件，但没有插入新版件 → reopened（受影响整板重开）
 * - 旧板上既留了未变件、又插进了新版/改版件 → mixed（新旧混排，单独挑出，回头切）
 * - 旧板上的件全没了 → reopened（板腾空，可回池给新版）
 * 新版新开板追加在末尾（state='new'）。
 */
export function buildSheetPlan(
  oldResult: NestResult | undefined,
  newResult: NestResult | undefined,
  rows: CostRow[],
  strategy: RevisionStrategy
): SheetPlanRow[] {
  if (!newResult) return []
  const affected = new Set(
    rows.filter((r) => !(r.kinds.length === 1 && r.kinds[0] === 'unchanged')).map((r) => r.code)
  )

  const plan: SheetPlanRow[] = []
  const oldSheets = oldResult?.sheets ?? []
  const newSheets = newResult.sheets

  // 新版每张板：留用板（有 retained 件）/混排板/新板
  for (const ns of newSheets) {
    if (ns.oldSheetIndex === undefined) {
      plan.push({
        oldSheetIndex: null,
        newSheetIndex: ns.index,
        boardName: ns.boardName,
        state: 'new',
        reason:
          strategy === 'rerun'
            ? '整批重排：全部按新版重新开板，旧摆法不沿用'
            : '新版新开板（旧板空档容不下的件）',
        retainedCodes: [],
        changedCodes: ns.placements.map((p) => p.code),
        extraBackCuts: 0
      })
      continue
    }
    const oldS = oldSheets[ns.oldSheetIndex]
    const retained = ns.placements.filter((p) => p.retained).map((p) => p.code)
    const inserted = ns.placements.filter((p) => !p.retained).map((p) => p.code)
    const state = retained.length > 0 && inserted.length > 0 ? 'mixed' : retained.length > 0 ? 'kept' : 'reopened'
    const reason =
      state === 'kept'
        ? '本板件号全部未变，旧摆法与刀路原样留用'
        : state === 'mixed'
          ? `旧板上有受影响件（${[...new Set(inserted)].slice(0, 4).join('、')}…），未变件留用、新版件插进空档，需单独挑出回头切`
          : '旧板件全部被删/改，整板腾空重开'
    const baseCutCount = oldS?.steps.filter((s) => s.kind === 'cut').length ?? 0
    const backCuts = Math.max(0, ns.steps.filter((s) => s.kind === 'cut').length - baseCutCount)
    plan.push({
      oldSheetIndex: ns.oldSheetIndex,
      newSheetIndex: ns.index,
      boardName: ns.boardName,
      state,
      reason,
      retainedCodes: [...new Set(retained)],
      changedCodes: [...new Set(inserted)],
      extraBackCuts: backCuts
    })
  }

  // 旧板存在、但新结果里完全没有对应（整板废弃重开）——补一行 reopened
  const reusedOldIdx = new Set(
    newSheets.filter((s) => s.oldSheetIndex !== undefined).map((s) => s.oldSheetIndex!)
  )
  oldSheets.forEach((os: SheetResult, i: number) => {
    if (reusedOldIdx.has(i)) return
    const codes = [...new Set(os.placements.map((p) => p.code))]
    const hit = codes.filter((c) => affected.has(c))
    plan.push({
      oldSheetIndex: i,
      newSheetIndex: null,
      boardName: os.boardName,
      state: 'reopened',
      reason:
        strategy === 'rerun'
          ? '整批重排策略：旧摆法与刀路全部不沿用，整板重开（已切板白做）'
          : hit.length > 0
            ? `旧板含删除/改动件 ${hit.slice(0, 4).join('、')}，本板受影响，整板重开`
            : '旧板未沿用',
      retainedCodes: [],
      changedCodes: codes,
      extraBackCuts: 0
    })
  })
  // 排序：kept 在前（先看留了多少），再 mixed/reopened/new
  const order = { kept: 0, mixed: 1, reopened: 2, new: 3 }
  return plan.sort((a, b) => order[a.state] - order[b.state] || (a.oldSheetIndex ?? 999) - (b.oldSheetIndex ?? 999))
}

/** 受影响件号集合（明细页标色、工单页判定重开同源使用）。 */
export function affectedCodeSet(report: RevisionReport | null | undefined): Set<string> {
  return new Set(report?.affectedCodes ?? [])
}

/** 带正负号的差值文本（供三个页面共用，保证口径一致）。 */
export function signedInt(v: number, suffix = ''): string {
  return `${v > 0 ? '+' : ''}${v}${suffix}`
}
