// 数据模型（对应规格书 §7，进阶功能所需字段为可选扩展）

export type GrainDemand = 'length' | 'width' | 'none' // 竖纹 / 横纹 / 无要求
export type EdgeSide = 'top' | 'bottom' | 'left' | 'right'

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
  // 改版留用旧摆法时：混排板上已被新版废弃的旧件（标废勿切，但板材已耗）
  void?: boolean
  voidReason?: string
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
  // 改版留用摆法时标记本张来源：kept=旧版干净留用，mixed=混排照旧切（含标废件），reopen=改版后新开
  provenance?: 'kept' | 'mixed' | 'reopen'
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
  // 改版影响核定（三处页面同源读取的唯一数据；空 = 未做改版核定）
  revision?: RevisionReport
  versionNo?: number // 当前版本号（第 1 版、第 2 版……）
  archives?: VersionArchive[] // 历次版本存档，旧版那组数留在这里，不被新版盖掉
  exports?: ExportRecord[] // 本机存档/已导出下料单台账，用于作废回退重发
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

// ───────────────────────── 改版影响核定（客户改图） ─────────────────────────

export type RevStrategy = 'renest' | 'reuse'
export type RevKind = 'added' | 'removed' | 'changed' | 'same'
export type RevFieldKind =
  | 'lenMm'
  | 'widMm'
  | 'qty'
  | 'grain'
  | 'edgeBands'
  | 'exposed'
  | 'boardId'
  | 'name'
  | 'cabinet'

export interface RevFieldChange {
  field: RevFieldKind
  label: string
  old: string | null
  now: string | null
}

/** 归并后（件号重复行已并成一条）的单版件号行及按规则折算出的用料量。 */
export interface RevRow {
  code: string
  kind: RevKind
  fields: RevFieldKind[]
  changes: RevFieldChange[]
  name: string
  boardName: string
  // 归并后取值（缺字段按空值：null）
  old: {
    lenMm: number | null
    widMm: number | null
    qty: number | null
    grain: GrainDemand | null
    edgeBands: EdgeSide[] | null
    exposed: boolean | null
    boardId: string | null
  }
  now: RevRow['old']
  // 逐项差值（新−旧；旧无此件则 old 项全 0，删除反之）。单位见注释
  dAreaMm2: number // 净面积差 mm²
  dSheetsEq: number // 折算用板差，按所属板种毛面积折算（行内不取整，展示 3 位小数）
  dBoardCents: number // 板材花费差（分，行内不取整，合计行统一四舍五入到分）
  dEdgeExposedM: number // 见光封边差（m，2 位精度）
  dEdgeNormalM: number // 非见光封边差（m）
  dPieces: number // 件数差（五金按件估算的口径）
  // 留用判定：尺寸/数量/纹理任一变动，或整件新增/删除 → 所在板必须重开
  forcesReopen: boolean
  // 归并冲突：同件号两行的规矩字段不一致（并条时已提示）
  mergeWarnings: string[]
}

/** 留用旧摆法方案：旧版每张板留用还是重开。 */
export interface ReusePlan {
  keptSheets: number[] // 旧版板序号（0 起）：整板零件全部不受影响，板与刀路直接留用
  reopenSheets: number[] // 整板受影响（全部件都在改动清单内）→ 板不切，整板重排
  mixedSheets: number[] // 新旧混排板：板已耗，未受影响件按旧刀路回头切，受影响件标废
  keptPieces: number // 干净留用板上直接留用的件数
  reopenPieces: number // 必须重新下刀的件数（整板重排件 + 混排板上标废后重排件）
  backCutPieces: number // 混排板上照旧刀路回头切的件数（件可用，但多出返机次数）
  voidPieces: number // 混排板上标废的旧件数（板已切出，料已耗）
  affectedCodes: string[] // 受影响件号（新增/删除/长宽/数量/纹理变化）
  extraBackCuts: number // 回头切次数（每张混排板返机 1 次）
  carryOverPieces: {
    code: string
    name: string
    lenMm: number
    widMm: number
    qty: number
    cabinet: string
    oldSheetIndex: number
  }[]
}

export interface RevTotals {
  dSheetsByType: { boardName: string; dSheetsEq: number }[] // 逐项折算（分板种，3 位小数）
  dSheetsEq: number // 逐项折算合计（张，3 位小数）
  dSheetsExact: number // 整单重排实算差（张，整数口径，新−旧）
  dBoardCents: number // 逐项板材花费差（分）
  dBoardCentsExact: number // 整单重排实算板材花费差（分，新−旧）
  dEdgeExposedM: number
  dEdgeNormalM: number
  dEdgeM: number
  dPieces: number
  dHardware: { name: string; value: number; unit: string }[] // 逐项件数差折算的五金差
  // 按选定路线的落账差（应用后成本表显示用）：
  // 整批重排 = 全新整单 − 旧整单；留用旧摆法 = 重排新板 − 被重开旧板（混排板照旧切，不省也不补）
  ledgerBoardCents?: number
  ledgerSheets?: number // 留用路线净增板（重排新板 − 省掉的重开旧板）
}

export interface RevCheck {
  name: string
  ok: boolean
  detail: string
  level: 'ok' | 'warn' | 'bad'
}

/** 一版排样实算用料（改版两版各只算一次，三处页面同源读取）。 */
export interface RevExactMetrics {
  boardsUsed: number
  totalCostCents: number
  edgeExposedM: number
  edgeNormalM: number
  pieces: number
}

export interface RevisionReport {
  id: string
  createdAt: number
  strategy: RevStrategy
  status: 'draft' | 'applied'
  appliedAt?: number
  // 新版解析后的完整清单（件号已归并），应用时直接落库
  newParts: Part[]
  newBoards: Board[]
  // 新版排样的工作用板（含旧版已消耗的登记余料）；应用时只把 newBoards 写回板材库
  workBoards?: Board[]
  rows: RevRow[]
  totals: RevTotals
  reuse: ReusePlan
  checks: RevCheck[]
  // 归并/解析警告（缺字段空值、重复行冲突等）
  warnings: string[]
  // 两版各跑一次整单排样（只跑这一次，三处同源）的实算结果
  oldExact: RevExactMetrics
  newExact: RevExactMetrics
  signature: string // 当前旧版清单+参数指纹，用于识别核定是否已过期
  newSignature: string
}

/** 改版前历史版本存档（只增不改，回退时可恢复）。 */
export interface VersionArchive {
  versionNo: number
  archivedAt: number
  reason: string // 如「改版核定 改 → 第 2 版」/「回退前自动存档」
  label: string
  parts: Part[]
  boards: Board[]
  kerfMm: number
  trimMm: number
  useOffcutIds: string[]
  batchByCabinet: boolean
  result?: NestResult
  // 该版当时算出来的一组数（防被新版盖掉，独立留存）
  metrics: { boardsUsed: number; totalCostCents: number; edgeExposedM: number; edgeNormalM: number; pieces: number }
  status: 'active' | 'superseded' | 'voided'
  revisionId?: string
}

/** 已发出清单台账：改版应用/回退时据此作废旧单、提示重发。 */
export interface ExportRecord {
  id: string
  versionNo: number
  sections: string[]
  createdAt: number
  voided: boolean
  voidReason?: string
}
