// 数据模型（对应规格书 §7，进阶功能所需字段为可选扩展）

export type GrainDemand = 'length' | 'width' | 'none' // 竖纹 / 横纹 / 无要求
export type EdgeSide = 'top' | 'bottom' | 'left' | 'right'

// 改版影响核定（中途改图：新旧两版板件明细对比）
// 件号比对结论：新增 / 删除 / 未变 / 尺寸变 / 数量变 / 纹理变 / 封边变 / 板材变（可并列多因）
export type PartChangeKind =
  | 'added'
  | 'removed'
  | 'unchanged'
  | 'size'
  | 'qty'
  | 'grain'
  | 'edge'
  | 'board'

// 改版后的排样取舍：rerun=整批重排（干净但旧摆法/刀路全废），reuse=留用旧摆法（省工但混排板要回头切）
export type RevisionStrategy = 'rerun' | 'reuse'
// 旧板处置：kept 整板留用 / mixed 新旧混排（回头切） / reopened 受影响整板重开
export type SheetReuseState = 'kept' | 'mixed' | 'reopened'

export interface Board {
  id: string
  name: string
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  priceCents: number
  quantity: number // 库存张数，0 = 不限
  kind?: 'stock' | 'offcut' // stock 常规板材 / offcut 登记余料转来的小板
  offcutId?: string
}

export interface Part {
  id: string
  code: string
  name: string
  lenMm: number
  widMm: number
  qty: number
  grain: GrainDemand
  edgeBands: EdgeSide[]
  cabinet: string // 所在柜体/房间，便于分拣
  exposed: boolean // 是否见光
  boardId?: string // 指定板材类型，空 = 自动
}

export interface Placement {
  partId: string
  instanceId: string
  boardIndex: number
  x: number
  y: number
  lenMm: number // 实际占 x 方向的尺寸（纹理=横纹时为零件 wid，rotated 仍为 false）
  widMm: number // 实际占 y 方向的尺寸
  origLen: number // 清单录入尺寸（标签用）
  origWid: number
  rotated: boolean
  seq: number
  // 冗余展示字段
  code: string
  name: string
  cabinet: string
  exposed: boolean
  grain: GrainDemand
  edgeBands: EdgeSide[]
  adjusted?: boolean // 手工微调产生
  retained?: boolean // 改版留用：来自旧版摆法、未重排
}

export interface CutStep {
  boardIndex: number
  axis: 'v' | 'h'
  at: number // 切割线坐标（mm，板左下角原点）
  span: [number, number] // 贯通区间起止
  order: number
  kind: 'trim' | 'cut'
  label: string
}

export interface OffcutInfo {
  x: number
  y: number
  wMm: number
  hMm: number
  areaMm2: number
  usable: boolean // 两边 ≥300mm 才登记为可用余料，其余仅作碎料留档
}

export interface SheetResult {
  index: number
  boardId: string
  boardName: string
  material: string
  thicknessMm: number
  wMm: number
  hMm: number
  priceCents: number
  placements: Placement[]
  steps: CutStep[]
  usedAreaMm2: number
  boardAreaMm2: number
  utilization: number
  offcuts: OffcutInfo[]
  adjusted?: boolean
  reuseState?: SheetReuseState // 改版留用排样时本张旧板的处置
  reopenedReason?: string // mixed/reopened 时为何要重开
  oldSheetIndex?: number // 留用板对应旧版第几站
}

export interface UnplacedInfo {
  partId: string
  code: string
  name: string
  qty: number
  reason: string
}

export interface NestResult {
  sheets: SheetResult[]
  boardsUsed: number
  boardsByType: Record<string, number>
  edgeBandM: { exposed: number; normal: number }
  unplaced: UnplacedInfo[]
  baselineBoards: number // 随手排（朴素顺板）需要的张数
  savedBoards: number
  savedCents: number
  totalCostCents: number
  stockShortage: { boardId: string; boardName: string; need: number; have: number }[]
  elapsedMs: number
  generatedAt: number
  reuseStats?: {
    strategy: RevisionStrategy
    keptSheets: number
    mixedSheets: number
    reopenedSheets: number
    newSheets: number
    backCuts: number // 留用方案里混排板上的回头切刀数
  }
}

export interface Job {
  id: string
  name: string
  createdAt: number
  boards: Board[]
  parts: Part[]
  kerfMm: number
  trimMm: number
  useOffcutIds: string[] // 参与本单排样的登记余料
  batchByCabinet: boolean // 按柜体批次分组开料
  result?: NestResult
  revisions?: RevisionRecord[] // 改版档案（最新在前，含旧版快照，永不被新版覆盖）
  activeRevisionId?: string // 当前清单基于哪次改版；undefined = 原始版（revNo 0）
  exports?: ExportRecord[] // 本机导出/下发台账（最新在前）
}

/** 改版一版的完整留档（旧版也算一版；原始版 revNo=0）。 */
export interface RevisionSnapshot {
  revNo: number
  label: string
  appliedAt: number
  strategy: RevisionStrategy
  parts: Part[]
  result?: NestResult
}

export interface RevisionRecord {
  id: string
  createdAt: number
  appliedAt?: number
  strategy: RevisionStrategy
  baseRevNo: number // 以哪一版为旧版
  newRevNo: number // 应用后的新版号
  label: string // 新版说明
  report: RevisionReport
  oldSnapshot: RevisionSnapshot // 旧版整版留底（当时的用板/封边原数可回看）
  applied: boolean
  rolledBack?: boolean
  rolledBackAt?: number
}

/** 规范化并件后的单行（缺失字段一律 null/空，绝不臆造）。 */
export interface NormalizedPart {
  code: string | null
  name: string | null
  lenMm: number | null
  widMm: number | null
  qty: number | null
  grain: GrainDemand | null
  edgeBands: EdgeSide[] | null
  cabinet: string | null
  exposed: boolean | null
  boardKey: string | null // 指定板材稳定标识（名+厚度）；null=自动
  mergedRows: number // 同件号合并了几行
  mergeNote: string | null // 并件规矩下的异常说明
}

/** 逐件指标（原始精度，不提前取整；展示时再按单位精度截位）。 */
export interface ItemMetrics {
  pieces: number // 件数（整数）
  areaMm2: number // 净面积（长宽有缺时为 0 并记账）
  edgeExposedMm: number
  edgeNormalMm: number
  boardAreaMm2: number // 按该件指定/适配板种折算的整板占用面积（毛口径）
  boardSheets: number // 折算用板张数（毛口径，小数）
  boardCostCents: number // 板材料钱（毛口径，按整板单价折算，小数分）
  connectors: number
  dowels: number
  screws: number
  glueGrams: number // 封边胶
}

export interface RevisionTotals {
  pieces: number
  areaMm2: number
  edgeExposedMm: number
  edgeNormalMm: number
  edgeMm: number
  boardSheets: number
  boardCostCents: number
  connectors: number
  dowels: number
  screws: number
  glueGrams: number
  actualBoardsUsed: number // 实际排样张数（整数，旧版取留底、新版取重排结果）
  actualCostCents: number // 实际排样板钱
  actualEdgeExposedMm: number // 实际排样封边（受未排下件影响时与毛口径不同）
  actualEdgeNormalMm: number
}

export interface CostRow {
  code: string
  name: string
  kinds: PartChangeKind[]
  reasons: string[]
  old: NormalizedPart | null
  neu: NormalizedPart | null
  delta: ItemMetrics // 新 - 旧
  oldM: ItemMetrics
  newM: ItemMetrics
  deltaCostRoundedCents: number // 最大余数法取整后的料钱差（分），保证逐项合计与总差一致
}

export interface ReconcileItem {
  metric: string
  sumDeltas: number // 逐项差值合计
  totalDelta: number // 两版合计之差
  unit: string
  precision: number
  ok: boolean
  detail: string
}

export interface SheetPlanRow {
  oldSheetIndex: number | null // 新版新板为 null
  newSheetIndex: number | null // 应用前为 null
  boardName: string
  state: SheetReuseState | 'new'
  reason: string
  retainedCodes: string[]
  changedCodes: string[]
  extraBackCuts: number
}

export interface RevisionReport {
  generatedAt: number
  oldRows: NormalizedPart[]
  newRows: NormalizedPart[]
  rows: CostRow[]
  warnings: string[] // 缺字段/空件号/并件异常/缺尺寸等
  oldTotals: RevisionTotals
  newTotals: RevisionTotals
  deltaTotals: RevisionTotals
  reconcile: ReconcileItem[]
  costReconcileOk: boolean
  // 按件号索引的改动结论（明细页/工单页同源取用）
  byCode: Record<
    string,
    { kinds: PartChangeKind[]; reasons: string[]; deltaCostCents: number }
  >
  affectedCodes: string[] // 新增+删除+任何变化
  unchangedCodes: string[]
  sheetPlan: SheetPlanRow[] // 留用方案下的旧板处置（应用前为预估，应用后回填新板号）
  strategy: RevisionStrategy
  strategyNote: string
}

export interface ExportRecord {
  id: string
  at: number
  sections: string[]
  revNo: number
  documentId: string // 下发清单文号
  voided: boolean
  voidedAt?: number
  voidReason?: string
  supersededBy?: string // 重发文号
  replacedDocId?: string // 本记录重发自哪份作废清单
}

export interface RegisteredOffcut {
  id: string
  jobId: string
  jobName: string
  sheetIndex: number
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  createdAt: number
  available: boolean
  usedByJobId?: string
}
