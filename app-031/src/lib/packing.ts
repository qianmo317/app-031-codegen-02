// 核心排样：guillotine（直线贯通可锯）递归二分 2D 装箱
// - 纹理 length/width 硬约束：只允许指定朝向，rotated 恒为 false，放不下就报原因
// - 锯路 kerf：零件与零件、零件与余料之间留锯缝；修边 trim 为四周先切掉的边
// - 利用率分母为整板面积，分子为零件净面积（不含锯路）
import type {
  Board,
  Job,
  NestResult,
  OffcutInfo,
  Part,
  Placement,
  SheetResult,
  UnplacedInfo
} from '../types'
import { EPS, type Rect } from './geometry'
import { buildSteps, simulate, rebuildFromPlacementsBudget } from './cuts'
import type { DSeg } from './cuts'
import type { CutStep } from '../types'

/** 改版留用：旧版已摆好、要求冻结的一张板（placements 为要留用的零件）。 */
export interface FrozenSheet {
  board: Board
  placements: Placement[]
  oldSheetIndex: number
  oldCutCount: number // 旧板内部刀数（用于统计回头切）
}

interface Inst {
  part: Part
  k: number // 第 k 件（qty 展开）
  key: string
  cabinet: string
}

interface FRect extends Rect {
  id: number
  parentRec: number | null // 由哪次放置产生（切割依赖）
  entrySeg: 'A' | 'B' | null // 进入该空档前必须完成的刀：首刀/次刀
  frozen?: boolean // 改版留用旧板上回收的空档
}

interface Rec {
  id: number
  frId: number
  instKey: string
  x: number
  y: number
  pw: number
  ph: number
  dir: 'v' | 'h'
  segA?: DSeg
  segB?: DSeg
}

interface SheetState {
  board: Board
  index: number
  usable: Rect
  free: FRect[]
  recs: Rec[]
  placements: Placement[]
  frozen?: FrozenSheet
  insertedCount: number // 留用板上新插入的件数（0 = 整板留用）
  retainedCount: number // 留用旧件数
  oldCutCount: number
}

function boardMatches(b: Board, p: Part): boolean {
  if (!p.boardId) return true
  if (b.id === p.boardId) return true
  if (b.kind === 'offcut') {
    const target = boardDefs.get(p.boardId)
    return !!target && target.thicknessMm === b.thicknessMm
  }
  // 改版留用：冻结的旧板 id 不在新版 boardDefs 里，按同厚度同材质兼容（板种未变的件才能留）
  const frozen = frozenBoardIds.has(b.id)
  if (frozen) {
    const target = boardDefs.get(p.boardId)
    return !!target && target.thicknessMm === b.thicknessMm && target.material === b.material
  }
  return false
}

const boardDefs = new Map<string, Board>()
const frozenBoardIds = new Set<string>()

/** 统一为横向板（长边沿 x）。余料上台可以转，所以归一化安全。 */
function normalize(b: Board): Board {
  if (b.wMm >= b.hMm) return b
  return { ...b, wMm: b.hMm, hMm: b.wMm }
}

export function nestJob(
  job: Job,
  frozenSheets: FrozenSheet[] = [],
  extraSkipKeys: string[] = []
): NestResult {
  const t0 = performance.now()
  boardDefs.clear()
  frozenBoardIds.clear()
  const boards = job.boards.map(normalize)
  boards.forEach((b) => boardDefs.set(b.id, b))
  const kerf = job.kerfMm
  const trim = job.trimMm

  // 各板种实际开板数（用于库存补采提示）
  const openedCount = new Map<string, number>()

  // 零件实例展开
  const insts: Inst[] = []
  for (const p of job.parts) {
    for (let k = 1; k <= Math.max(0, p.qty); k++) {
      insts.push({ part: p, k, key: `${p.id}#${k}`, cabinet: p.cabinet || '未分组' })
    }
  }
  // 排序：按柜体批次分组时柜体优先；随后大边降序、面积降序
  const sorted = [...insts].sort((a, b) => {
    if (job.batchByCabinet && a.cabinet !== b.cabinet) return a.cabinet < b.cabinet ? -1 : 1
    const am = Math.max(a.part.lenMm, a.part.widMm)
    const bm = Math.max(b.part.lenMm, b.part.widMm)
    if (bm !== am) return bm - am
    return b.part.lenMm * b.part.widMm - a.part.lenMm * a.part.widMm
  })

  const sheets: SheetState[] = []
  let frSeq = 0
  const openSheet = (b: Board): SheetState => {
    const usable: Rect = {
      x: trim,
      y: trim,
      w: Math.max(1, b.wMm - 2 * trim),
      h: Math.max(1, b.hMm - 2 * trim)
    }
    const s: SheetState = {
      board: b,
      index: sheets.length,
      usable,
      free: [
        {
          id: frSeq++,
          x: usable.x,
          y: usable.y,
          w: usable.w,
          h: usable.h,
          parentRec: null,
          entrySeg: null
        }
      ],
      recs: [],
      placements: [],
      insertedCount: 0,
      retainedCount: 0,
      oldCutCount: 0
    }
    sheets.push(s)
    return s
  }

  // —— 改版留用：先把旧板冻结上台，按 guillotine 二分口径从可用区里逐块「挖掉」
  // 留用零件，把剩下的空档并入 free 池，供新版/改版件插入。冻结件不参与后续摆放循环。
  const skipKeys = new Set<string>()
  const openFrozenSheet = (f: FrozenSheet): SheetState | null => {
    const b = normalize(f.board)
    frozenBoardIds.add(b.id)
    if (!boardDefs.has(b.id)) boardDefs.set(b.id, b)
    const usable: Rect = {
      x: trim,
      y: trim,
      w: Math.max(1, b.wMm - 2 * trim),
      h: Math.max(1, b.hMm - 2 * trim)
    }
    const retained: Placement[] = f.placements.map((p) => ({ ...p, retained: true }))
    // 越界/重叠校验：旧摆法必须本身合法
    for (const p of retained) {
      if (
        p.x < trim - EPS ||
        p.y < trim - EPS ||
        p.x + p.lenMm > b.wMm - trim + EPS ||
        p.y + p.widMm > b.hMm - trim + EPS
      )
        return null
    }
    for (let i = 0; i < retained.length; i++)
      for (let j = i + 1; j < retained.length; j++) {
        const a = retained[i]
        const c = retained[j]
        if (
          a.x < c.x + c.lenMm - EPS &&
          c.x < a.x + a.lenMm - EPS &&
          a.y < c.y + c.widMm - EPS &&
          c.y < a.y + a.widMm - EPS
        )
          return null
      }
    // 从可用区逐块减去留用矩形，按锯路剥出仍可下刀的空档（与排样器自身的二分余隙一致）
    let free: FRect[] = [{ id: frSeq++, x: usable.x, y: usable.y, w: usable.w, h: usable.h, parentRec: null, entrySeg: null, frozen: true }]
    const subtract = (cell: FRect, rx: number, ry: number, rw: number, rh: number): FRect[] => {
      // 不相交：整块保留
      if (rx >= cell.x + cell.w - EPS || rx + rw <= cell.x + EPS || ry >= cell.y + cell.h - EPS || ry + rh <= cell.y + EPS)
        return [cell]
      const out: FRect[] = []
      // 相对可用区的左右余隙（≥kerf 才下得了刀，剥掉一条锯路）
      const gxL = rx - cell.x
      const gxR = cell.x + cell.w - (rx + rw)
      if (gxL >= kerf - EPS) out.push({ id: frSeq++, x: cell.x, y: cell.y, w: gxL - kerf, h: cell.h, parentRec: null, entrySeg: null, frozen: true })
      const innerX = gxL >= kerf - EPS ? rx : cell.x
      const innerW = cell.w - (gxL >= kerf - EPS ? gxL : 0) - (gxR >= kerf - EPS ? gxR : 0)
      if (gxR >= kerf - EPS) out.push({ id: frSeq++, x: rx + rw + kerf, y: cell.y, w: gxR - kerf, h: cell.h, parentRec: null, entrySeg: null, frozen: true })
      const gyB = ry - cell.y
      const gyT = cell.y + cell.h - (ry + rh)
      if (gyB >= kerf - EPS) out.push({ id: frSeq++, x: innerX, y: cell.y, w: innerW, h: gyB - kerf, parentRec: null, entrySeg: null, frozen: true })
      if (gyT >= kerf - EPS) out.push({ id: frSeq++, x: innerX, y: ry + rh + kerf, w: innerW, h: gyT - kerf, parentRec: null, entrySeg: null, frozen: true })
      return out.filter((r) => r.w >= 1 && r.h >= 1)
    }
    for (const p of retained) {
      const next: FRect[] = []
      for (const cell of free) next.push(...subtract(cell, p.x, p.y, p.lenMm, p.widMm))
      free = next
    }
    const s: SheetState = {
      board: b,
      index: sheets.length,
      usable,
      free,
      recs: [],
      placements: retained,
      frozen: f,
      insertedCount: 0,
      retainedCount: retained.length,
      oldCutCount: f.oldCutCount
    }
    retained.forEach((p) => skipKeys.add(p.instanceId))
    sheets.push(s)
    return s
  }

  for (const f of frozenSheets) openFrozenSheet(f)
  // 留用件用新版实例号登记为「已摆放」，主摆放循环据此跳过，避免重复排
  for (const k of extraSkipKeys) skipKeys.add(k)

  const canOpen = (b: Board): boolean => {
    // 余料板只有一块，用完即止；常规板库存是采购参考，可超开（稍后提示补采）
    if (b.kind === 'offcut') {
      const used = openedCount.get(b.id) ?? 0
      return used < 1
    }
    return true
  }

  const pickNewBoard = (p: Part, pw: number, ph: number): Board | null => {
    const viable = boards.filter(
      (b) =>
        canOpen(b) &&
        boardMatches(b, p) &&
        fitsClean(b.wMm - 2 * trim, pw) &&
        fitsClean(b.hMm - 2 * trim, ph)
    )
    // 余料小板优先，其次选面积最小的（省大板）
    viable.sort((a, b) => {
      if ((a.kind === 'offcut') !== (b.kind === 'offcut')) return a.kind === 'offcut' ? -1 : 1
      return a.wMm * a.hMm - b.wMm * b.hMm
    })
    return viable[0] ?? null
  }

  interface Orient {
    pw: number
    ph: number
    rotated: boolean
  }
  // 只允许严丝合缝（0）或余隙 ≥ 锯路；0<余隙<锯路 时下不了刀，禁止放入
  const fitsClean = (avail: number, size: number): boolean => {
    const gap = avail - size
    return gap >= -EPS && (gap <= EPS || gap >= kerf - EPS)
  }
  const orientsOf = (p: Part): Orient[] => {
    if (p.grain === 'length') return [{ pw: p.lenMm, ph: p.widMm, rotated: false }]
    if (p.grain === 'width') return [{ pw: p.widMm, ph: p.lenMm, rotated: false }]
    if (p.lenMm === p.widMm) return [{ pw: p.lenMm, ph: p.widMm, rotated: false }]
    return [
      { pw: p.lenMm, ph: p.widMm, rotated: false },
      { pw: p.widMm, ph: p.lenMm, rotated: true }
    ]
  }

  const unplaced = new Map<string, { part: Part; qty: number }>()
  const markUnplaced = (p: Part): void => {
    const cur = unplaced.get(p.id)
    if (cur) cur.qty++
    else unplaced.set(p.id, { part: p, qty: 1 })
  }

  let seq = 0
  for (const inst of sorted) {
    if (skipKeys.has(inst.key)) continue // 该件已在旧板上冻结留用
    const p = inst.part
    let best:
      | { sheet: SheetState | null; fr: FRect | null; nb: Board | null; o: Orient; tier: number; waste: number }
      | null = null
    for (const o of orientsOf(p)) {
      // tier 0：已打开的、板种匹配的板里最贴合的空档
      for (const s of sheets) {
        if (!boardMatches(s.board, p)) continue
        for (const fr of s.free) {
          if (fitsClean(fr.w, o.pw) && fitsClean(fr.h, o.ph)) {
            const waste = fr.w * fr.h - o.pw * o.ph
            if (!best || waste < best.waste) {
              best = { sheet: s, fr, nb: null, o, tier: 0, waste }
            }
          }
        }
      }
      // tier 1：新开余料小板 / tier 2：新开常规板
      const nb = pickNewBoard(p, o.pw, o.ph)
      if (nb) {
        const tier = nb.kind === 'offcut' ? 1 : 2
        const waste = (nb.wMm - 2 * trim) * (nb.hMm - 2 * trim) - o.pw * o.ph
        if (!best || tier < best.tier || (tier === best.tier && waste < best.waste)) {
          best = { sheet: null, fr: null, nb, o, tier, waste }
        }
      }
    }
    if (!best) {
      markUnplaced(p)
      continue
    }
    let s: SheetState
    let fr: FRect
    if (best.sheet && best.fr) {
      s = best.sheet
      fr = best.fr
    } else {
      // 正式新板（库存扣减）
      const nb = best.nb ?? pickNewBoard(p, best.o.pw, best.o.ph)
      if (!nb) {
        markUnplaced(p)
        continue
      }
      s = openSheet(nb)
      openedCount.set(nb.id, (openedCount.get(nb.id) ?? 0) + 1)
      fr = s.free[0]
    }
    const o = best.o
    // 占用该空档并按 guillotine 递归二分拆出余隙
    s.free = s.free.filter((f) => f.id !== fr.id)
    const rec: Rec = {
      id: s.recs.length,
      frId: fr.id,
      instKey: inst.key,
      x: fr.x,
      y: fr.y,
      pw: o.pw,
      ph: o.ph,
      dir: fr.w >= fr.h ? 'v' : 'h'
    }
    const addFree = (r: Rect, parentRec: number, entrySeg: 'A' | 'B'): void => {
      if (r.w >= 1 && r.h >= 1) s.free.push({ ...r, id: frSeq++, parentRec, entrySeg })
    }
    const parentDeps = segDepsOf(fr, s)
    const gx = fr.w - o.pw // 右侧余隙（≈0 或 ≥kerf）
    const gy = fr.h - o.ph // 上方余隙（≈0 或 ≥kerf）
    const cutX = gx >= kerf - EPS
    const cutY = gy >= kerf - EPS
    if (rec.dir === 'v') {
      // 先竖切贯通全高（segA），再在含零件的左条内横切（segB）
      if (cutX) {
        rec.segA = {
          axis: 'v',
          at: fr.x + o.pw + kerf / 2,
          lo: fr.y,
          hi: fr.y + fr.h,
          deps: parentDeps
        }
      }
      if (cutY) {
        rec.segB = {
          axis: 'h',
          at: fr.y + o.ph + kerf / 2,
          lo: fr.x,
          hi: cutX ? fr.x + o.pw : fr.x + fr.w,
          deps: rec.segA ? [rec.segA] : parentDeps
        }
      }
      // 左条上方空档需要 segB；右侧整条空档只需要 segA
      if (cutY) {
        addFree(
          { x: fr.x, y: fr.y + o.ph + kerf, w: cutX ? o.pw : fr.w, h: gy - kerf },
          rec.id,
          'B'
        )
      }
      if (cutX) {
        addFree({ x: fr.x + o.pw + kerf, y: fr.y, w: gx - kerf, h: fr.h }, rec.id, 'A')
      }
    } else {
      // 先横切贯通全宽（segA），再在含零件的下条内竖切（segB）
      if (cutY) {
        rec.segA = {
          axis: 'h',
          at: fr.y + o.ph + kerf / 2,
          lo: fr.x,
          hi: fr.x + fr.w,
          deps: parentDeps
        }
      }
      if (cutX) {
        rec.segB = {
          axis: 'v',
          at: fr.x + o.pw + kerf / 2,
          lo: fr.y,
          hi: cutY ? fr.y + o.ph : fr.y + fr.h,
          deps: rec.segA ? [rec.segA] : parentDeps
        }
      }
      // 上方整条空档只需要 segA；下条右侧空档需要 segB
      if (cutY) {
        addFree({ x: fr.x, y: fr.y + o.ph + kerf, w: fr.w, h: gy - kerf }, rec.id, 'A')
      }
      if (cutX) {
        addFree(
          { x: fr.x + o.pw + kerf, y: fr.y, w: gx - kerf, h: cutY ? o.ph : fr.h },
          rec.id,
          'B'
        )
      }
    }
    s.recs.push(rec)
    seq++
    if (s.frozen) s.insertedCount++
    s.placements.push({
      partId: p.id,
      instanceId: inst.key,
      boardIndex: s.index,
      x: fr.x,
      y: fr.y,
      lenMm: o.pw,
      widMm: o.ph,
      origLen: p.lenMm,
      origWid: p.widMm,
      rotated: o.rotated,
      seq,
      code: p.code,
      name: p.name,
      cabinet: inst.cabinet,
      exposed: p.exposed,
      grain: p.grain,
      edgeBands: p.edgeBands
    })
  }

  // 组装 SheetResult（冻结板刀路重建可能受 DFS 预算影响失败）
  const built = sheets.map((s) => buildSheet(s, kerf, trim))
  if (frozenSheets.length > 0 && built.some((r) => r === null)) {
    // 自愈：放弃整批留用，无冻结板重排一次（受影响旧板在 sheetPlan 中全部记为重开）
    return nestJob(job, [])
  }
  const results = built.filter((r): r is SheetResult => r !== null)

  // 全局重排 seq：留用件保留旧号会与新件撞号，按最终摆放顺序统一编号
  let seqFinal = 0
  for (const s of results) for (const p of s.placements) p.seq = ++seqFinal

  // 统计
  const boardsByType: Record<string, number> = {}
  let totalCost = 0
  for (const s of results) {
    boardsByType[s.boardName] = (boardsByType[s.boardName] ?? 0) + 1
    totalCost += s.priceCents
  }
  let exposedM = 0
  let normalM = 0
  for (const s of results) {
    for (const pl of s.placements) {
      const m =
        (pl.origLen *
          ((pl.edgeBands.includes('top') ? 1 : 0) + (pl.edgeBands.includes('bottom') ? 1 : 0)) +
          pl.origWid *
            ((pl.edgeBands.includes('left') ? 1 : 0) + (pl.edgeBands.includes('right') ? 1 : 0))) /
        1000
      if (pl.exposed) exposedM += m
      else normalM += m
    }
  }

  const unplacedList: UnplacedInfo[] = [...unplaced.values()].map((u) => ({
    partId: u.part.id,
    code: u.part.code,
    name: u.part.name,
    qty: u.qty,
    reason:
      u.part.grain === 'none'
        ? '板材尺寸或库存不足，无法排下'
        : u.part.grain === 'length'
          ? '因纹理要求为竖纹（不可旋转），现有板材排不下'
          : '因纹理要求为横纹（不可旋转），现有板材排不下'
  }))

  const baselineBoards = shelfBaseline(job, boards, kerf, trim, results.length)
  const optimizedBoards = results.length
  const savedBoards = Math.max(0, baselineBoards - optimizedBoards)
  const stockShortage = boards
    .filter((b) => b.kind !== 'offcut' && b.quantity > 0)
    .map((b) => ({
      boardId: b.id,
      boardName: b.name,
      need: openedCount.get(b.id) ?? 0,
      have: b.quantity
    }))
    .filter((x) => x.need > x.have)

  const stockUsed = results.filter((s) => s.priceCents > 0)
  const avgPrice =
    stockUsed.length > 0
      ? stockUsed.reduce((a, s) => a + s.priceCents, 0) / stockUsed.length
      : job.boards.reduce((a, b) => a + b.priceCents, 0) / Math.max(1, job.boards.length)

  let reuseStats: NestResult['reuseStats']
  if (frozenSheets.length > 0) {
    const kept = results.filter((s) => s.reuseState === 'kept').length
    const mixed = results.filter((s) => s.reuseState === 'mixed').length
    const reopened = results.filter((s) => s.reuseState === 'reopened').length
    const newSheets = results.filter((s) => s.oldSheetIndex === undefined).length
    const oldCutByIndex = new Map(frozenSheets.map((f) => [f.oldSheetIndex, f.oldCutCount]))
    const backCuts = results.reduce((a, s) => {
      if (s.oldSheetIndex === undefined) return a
      const oldCuts = oldCutByIndex.get(s.oldSheetIndex) ?? 0
      return a + Math.max(0, s.steps.filter((st) => st.kind === 'cut').length - oldCuts)
    }, 0)
    reuseStats = { strategy: 'reuse', keptSheets: kept, mixedSheets: mixed, reopenedSheets: reopened, newSheets, backCuts }
  }

  return {
    sheets: results,
    boardsUsed: optimizedBoards,
    boardsByType,
    edgeBandM: {
      exposed: Math.round(exposedM * 100) / 100,
      normal: Math.round(normalM * 100) / 100
    },
    unplaced: unplacedList,
    baselineBoards,
    savedBoards,
    savedCents: Math.round(savedBoards * avgPrice),
    totalCostCents: totalCost,
    stockShortage,
    elapsedMs: Math.round(performance.now() - t0),
    generatedAt: Date.now(),
    ...(reuseStats ? { reuseStats } : {})
  }
}

/** 沿父放置的切割线建立依赖：进入空档前要求对应首刀/次刀已完成。 */
function segDepsOf(fr: FRect, s: SheetState): DSeg[] {
  if (fr.parentRec === null || !fr.entrySeg) return []
  const rec = s.recs.find((r) => r.id === fr.parentRec)
  if (!rec) return []
  const seg = fr.entrySeg === 'A' ? rec.segA ?? rec.segB : rec.segB ?? rec.segA
  return seg ? [seg] : []
}

/**
 * 冻结板刀路重建：对「留用件 + 新插入件」全部就位矩形重新枚举 guillotine 分解。
 * 留用件集合是旧版合法布局的子集（切去部分零件不会破坏 guillotine 性质），
 * 加上新插入件来自本排样器的余隙二分，整体仍为 guillotine 可切；
 * DFS 预算放大（旧单板零件可能较多），失败返回 null，由上层自愈。
 */
function buildFrozenSheet(s: SheetState, kerf: number, trim: number): SheetResult | null {
  const b = s.board
  const w = b.wMm
  const h = b.hMm
  const boardArea = w * h
  const usedArea = s.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)
  let rebuilt: { steps: CutStep[]; leftovers: Rect[] } | null = null
  for (const doMerge of [true, false]) {
    rebuilt = rebuildFromPlacementsBudget(w, h, kerf, trim, s.index, s.placements, 6000, doMerge)
    if (rebuilt) break
  }
  if (!rebuilt) return null
  const steps = rebuilt.steps
  const sim = simulate(w, h, kerf, steps, s.placements)
  if (!sim.ok) return null
  const offcuts: OffcutInfo[] = rebuilt.leftovers
    .filter((r) => r.w >= 2 && r.h >= 2)
    .map((r) => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      wMm: Math.round(r.w),
      hMm: Math.round(r.h),
      areaMm2: Math.round(r.w * r.h),
      usable: r.w >= 300 - EPS && r.h >= 300 - EPS
    }))
    .sort((a, c) => c.areaMm2 - a.areaMm2)
  const state =
    s.retainedCount > 0 && s.insertedCount > 0
      ? 'mixed'
      : s.retainedCount > 0
        ? 'kept'
        : 'reopened'
  const internalNow = steps.filter((st) => st.kind === 'cut').length
  return {
    index: s.index,
    boardId: b.id,
    boardName: b.name,
    material: b.material,
    thicknessMm: b.thicknessMm,
    wMm: w,
    hMm: h,
    priceCents: b.kind === 'offcut' ? 0 : b.priceCents,
    placements: s.placements,
    steps,
    usedAreaMm2: usedArea,
    boardAreaMm2: boardArea,
    utilization: usedArea / boardArea,
    offcuts,
    reuseState: state,
    reopenedReason:
      state === 'mixed'
        ? `新旧混排板：留用 ${s.retainedCount} 件、新插 ${s.insertedCount} 件，需单独挑出回头切 ${Math.max(0, internalNow - s.oldCutCount)} 刀`
        : state === 'reopened'
          ? '旧件全部改/删，整板重开'
          : undefined,
    oldSheetIndex: s.frozen?.oldSheetIndex
  }
}

function buildSheet(s: SheetState, kerf: number, trim: number): SheetResult | null {
  if (s.frozen) return buildFrozenSheet(s, kerf, trim)
  const raw: DSeg[] = []
  for (const r of s.recs) {
    if (r.segA) raw.push(r.segA)
    if (r.segB) raw.push(r.segB)
  }
  const b = s.board
  const steps = buildSteps(b.wMm, b.hMm, kerf, trim, s.index, raw)
  const boardArea = b.wMm * b.hMm
  const usedArea = s.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)

  // 剩余空档全部留档；两边 ≥300mm 才标记为可用余料，按面积降序
  const offcuts: OffcutInfo[] = s.free
    .filter((f) => f.w >= 2 && f.h >= 2)
    .map((f) => ({
      x: Math.round(f.x),
      y: Math.round(f.y),
      wMm: Math.round(f.w),
      hMm: Math.round(f.h),
      areaMm2: Math.round(f.w * f.h),
      usable: f.w >= 300 - EPS && f.h >= 300 - EPS
    }))
    .sort((a, c) => c.areaMm2 - a.areaMm2)

  const sheet: SheetResult = {
    index: s.index,
    boardId: b.id,
    boardName: b.name,
    material: b.material,
    thicknessMm: b.thicknessMm,
    wMm: b.wMm,
    hMm: b.hMm,
    priceCents: b.kind === 'offcut' ? 0 : b.priceCents,
    placements: s.placements,
    steps,
    usedAreaMm2: usedArea,
    boardAreaMm2: boardArea,
    utilization: usedArea / boardArea,
    offcuts
  }
  const sim = simulate(b.wMm, b.hMm, kerf, steps, s.placements)
  if (!sim.ok) {
    console.error(`[排样] 第 ${s.index + 1} 张板切割模拟失败`, sim.errors)
  }
  return sheet
}

/**
 * 「随手排」基线：保持清单原顺序、固定朝向（不旋转）、朴素顺板货架式摆放。
 * 用于展示「本方案比随手排省几张板」。库存耗尽时退化为与优化方案相同的张数。
 */
function shelfBaseline(
  job: Job,
  boards: Board[],
  kerf: number,
  trim: number,
  optimizedCount: number
): number {
  let count = 0
  // 用对象持有当前板状态，避免闭包对局部变量的窄化问题
  const cur: { value: { b: Board; x: number; y: number; shelfH: number } | null } = { value: null }
  const usable = (b: Board): [number, number] => [b.wMm - 2 * trim, b.hMm - 2 * trim]
  const newSheet = (b: Board): void => {
    count++
    cur.value = { b, x: 0, y: 0, shelfH: 0 }
  }
  // 随手排不用登记余料，只在常规板之间顺
  const canOpen = (b: Board): boolean => b.kind !== 'offcut'
  for (const part of job.parts) {
    for (let k = 0; k < part.qty; k++) {
      const pw = part.grain === 'width' ? part.widMm : part.lenMm
      const ph = part.grain === 'width' ? part.lenMm : part.widMm
      const tryCur = (): boolean => {
        const c = cur.value
        if (!c || !boardMatches(c.b, part)) return false
        const [uw, uh] = usable(c.b)
        if (c.x + pw <= uw + EPS && c.y + Math.max(c.shelfH, ph) <= uh + EPS) {
          if (c.x === 0 && c.shelfH === 0) c.shelfH = ph
          c.x += pw + kerf
          c.shelfH = Math.max(c.shelfH, ph)
          return true
        }
        // 当前层放不下，换行再试
        if (c.x > 0) {
          c.y += c.shelfH + kerf
          c.x = 0
          c.shelfH = 0
          if (pw <= uw + EPS && c.y + ph <= uh + EPS) {
            c.shelfH = ph
            c.x = pw + kerf
            return true
          }
        }
        return false
      }
      if (tryCur()) {
        // 已摆入当前板
      } else {
        const candidates = boards
          .filter(
            (b) =>
              canOpen(b) &&
              boardMatches(b, part) &&
              b.wMm - 2 * trim + EPS >= pw &&
              b.hMm - 2 * trim + EPS >= ph
          )
          .sort((a, b) => a.wMm * a.hMm - b.wMm * b.hMm)
        if (candidates.length === 0) return Math.max(optimizedCount, count)
        newSheet(candidates[0])
        cur.value!.x = pw + kerf
        cur.value!.shelfH = ph
      }
    }
  }
  return Math.max(count, optimizedCount)
}
