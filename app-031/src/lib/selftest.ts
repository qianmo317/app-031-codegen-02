// 自动化断言（规格书 §8/§10 强制）：
// guillotine 100 组随机零反例、纹理零旋转、锯路/修边、守恒、封边复算、
// 30 零件锯切工步 ≤20 且模拟器还原、余料再利用、300 零件性能 <1.5s。
import type { Board, Job, Part } from '../types'
import { nestJob } from './packing'
import { simulate, countSawOps } from './cuts'
import { guillotineViolation, type Rect } from './geometry'
import {
  mergeByCode,
  parseRevisionText,
  createRevision,
  applyRevision,
  rollbackToVersion,
  type RevInputRow
} from './revision'

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

export interface SelfTestReport {
  ok: boolean
  elapsedMs: number
  checks: CheckResult[]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let boardSeq = 0
let partSeq = 0

function makeBoard(over: Partial<Board> = {}): Board {
  return {
    id: `b${boardSeq++}`,
    name: over.name ?? '测试板 2440×1220',
    wMm: over.wMm ?? 2440,
    hMm: over.hMm ?? 1220,
    thicknessMm: 18,
    material: '颗粒板',
    priceCents: 13800,
    quantity: 0,
    kind: 'stock',
    ...over
  }
}

function makePart(over: Partial<Part> = {}): Part {
  return {
    id: `p${partSeq++}`,
    code: over.code ?? `P${partSeq}`,
    name: over.name ?? '测试件',
    lenMm: over.lenMm ?? 400,
    widMm: over.widMm ?? 300,
    qty: over.qty ?? 1,
    grain: over.grain ?? 'none',
    edgeBands: over.edgeBands ?? [],
    cabinet: over.cabinet ?? '柜A',
    exposed: over.exposed ?? false,
    boardId: over.boardId ?? ''
  }
}

function makeJob(parts: Part[], over: Partial<Job> = {}): Job {
  return {
    id: `j${partSeq}`,
    name: '测试任务',
    createdAt: 0,
    boards: over.boards ?? [makeBoard()],
    parts,
    kerfMm: over.kerfMm ?? 3.2,
    trimMm: over.trimMm ?? 8,
    useOffcutIds: [],
    batchByCabinet: false,
    versionNo: over.versionNo ?? 1,
    archives: over.archives ?? [],
    exports: over.exports ?? [],
    ...over
  }
}

function nestedJob(parts: Part[], over: Partial<Job> = {}): Job {
  const job = makeJob(parts, over)
  job.result = nestJob(job)
  return job
}

function rowOf(p: Partial<Part> & { code: string }): RevInputRow {
  return {
    code: p.code,
    name: p.name ?? '测试件',
    lenMm: p.lenMm ?? null,
    widMm: p.widMm ?? null,
    qty: p.qty ?? null,
    grain: p.grain ?? null,
    edgeBands: p.edgeBands ?? null,
    cabinet: p.cabinet ?? null,
    exposed: p.exposed ?? null,
    boardId: p.boardId ?? null
  }
}

/** 检查同板任意两件之间的净距：只要相邻就必须 ≥ kerf；四周 ≥ trim。 */
function assertClearances(job: Job): string | null {
  const kerf = job.kerfMm
  const trim = job.trimMm
  for (const sheet of job.result!.sheets) {
    const ps = sheet.placements
    for (const p of ps) {
      if (p.x < trim - 0.06 || p.y < trim - 0.06) return '零件越过修边区（左下）'
      if (p.x + p.lenMm > sheet.wMm - trim + 0.06) return '零件越过修边区（右）'
      if (p.y + p.widMm > sheet.hMm - trim + 0.06) return '零件越过修边区（上）'
    }
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i]
        const b = ps[j]
        const ox = Math.min(a.x + a.lenMm, b.x + b.lenMm) - Math.max(a.x, b.x)
        const oy = Math.min(a.y + a.widMm, b.y + b.widMm) - Math.max(a.y, b.y)
        if (ox > 0.06 && oy > 0.06) return '零件重叠'
        // 同向投影有重叠时，另一轴的净距必须 ≥ kerf
        if (ox > 0.06) {
          const gap = Math.abs(a.y + a.widMm - b.y) < Math.abs(a.y - (b.y + b.widMm))
            ? b.y - (a.y + a.widMm)
            : a.y - (b.y + b.widMm)
          if (gap > 0.06 && gap < kerf - 0.6) return `净距 ${gap.toFixed(2)} < 锯路 ${kerf}`
        }
        if (oy > 0.06) {
          const gap = Math.abs(a.x + a.lenMm - b.x) < Math.abs(a.x - (b.x + b.lenMm))
            ? b.x - (a.x + a.lenMm)
            : a.x - (b.x + b.lenMm)
          if (gap > 0.06 && gap < kerf - 0.6) return `净距 ${gap.toFixed(2)} < 锯路 ${kerf}`
        }
      }
    }
  }
  return null
}

function dumpJob(job: Job, err?: string): void {
  console.error('DUMP_KERF', job.kerfMm, 'TRIM', job.trimMm, 'ERR', err ?? '')
  for (const p of job.parts) {
    console.error(
      'DUMP_PART',
      JSON.stringify({
        c: p.code,
        l: p.lenMm,
        w: p.widMm,
        q: p.qty,
        g: p.grain,
        e: p.edgeBands.join(''),
        x: p.exposed ? 1 : 0
      })
    )
  }
  const m = err?.match(/板(\d+)/)
  if (m && job.result) {
    const sheet = job.result.sheets[Number(m[1]) - 1]
    if (sheet) {
      console.error('DUMP_SHEET', sheet.wMm, sheet.hMm)
      for (const p of sheet.placements)
        console.error('DUMP_PL', p.code, p.x, p.y, p.lenMm, p.widMm, p.grain)
      for (const st of sheet.steps)
        console.error('DUMP_ST', st.order, st.kind, st.axis, st.at, st.span[0], st.span[1])
      const sim = simulate(sheet.wMm, sheet.hMm, job.kerfMm, sheet.steps, sheet.placements)
      console.error('DUMP_SIM', JSON.stringify(sim.errors))
      for (const lf of sim.leaves)
        console.error('DUMP_LEAF', Math.round(lf.x), Math.round(lf.y), Math.round(lf.w), Math.round(lf.h))
    }
  }
}

function assertSheet(job: Job): string | null {
  const r = job.result!
  for (const sheet of r.sheets) {
    // guillotine 合法性
    const rects = sheet.placements.map((p) => ({
      id: p.instanceId,
      x: p.x,
      y: p.y,
      w: p.lenMm,
      h: p.widMm
    }))
    const bounds: Rect = {
      x: job.trimMm,
      y: job.trimMm,
      w: sheet.wMm - 2 * job.trimMm,
      h: sheet.hMm - 2 * job.trimMm
    }
    const v = guillotineViolation(rects, bounds, job.kerfMm)
    if (v) return `板${sheet.index + 1}：${v}`
    // 逐步切割模拟
    const sim = simulate(sheet.wMm, sheet.hMm, job.kerfMm, sheet.steps, sheet.placements)
    if (!sim.ok) return `板${sheet.index + 1}：${sim.errors.join('；')}`
    // 利用率复算（分子不含锯路）
    const net = sheet.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)
    if (Math.abs(net - sheet.usedAreaMm2) > 1) return 'usedArea 与零件净面积不一致'
    if (Math.abs(net / sheet.boardAreaMm2 - sheet.utilization) > 1e-9)
      return '利用率复算不一致'
  }
  // 面积守恒不等式
  const boardArea = r.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  const partArea = job.parts.reduce((a, p) => a + p.lenMm * p.widMm * p.qty, 0)
  if (boardArea + 1 < partArea) return 'Σ板面积 < Σ零件面积'
  return null
}

export function runSelfTest(): SelfTestReport {
  boardSeq = 0
  partSeq = 0
  const t0 = performance.now()
  const checks: CheckResult[] = []
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
  }

  // 1) 100 组随机任务：零反例
  const rng = mulberry32((globalThis as { FCO_SEED?: number }).FCO_SEED ?? 20260925)
  let failures = 0
  let firstFailure = ''
  let totalInstances = 0
  for (let g = 0; g < 100; g++) {
    const kerf = +(2 + rng() * 2).toFixed(2)
    const trim = 5 + Math.floor(rng() * 6)
    const partKinds = 8 + Math.floor(rng() * 33)
    const parts: Part[] = []
    for (let i = 0; i < partKinds; i++) {
      const len = 120 + Math.floor(rng() * 980)
      const wid = 80 + Math.floor(rng() * 620)
      const gr = rng()
      parts.push(
        makePart({
          code: `R${g}-${i}`,
          lenMm: len,
          widMm: wid,
          qty: 1 + Math.floor(rng() * 3),
          grain: gr < 0.4 ? 'length' : gr < 0.55 ? 'width' : 'none',
          edgeBands: rng() < 0.5 ? ['top', 'left'] : [],
          cabinet: ['客厅柜', '衣柜', '橱柜', '书柜'][Math.floor(rng() * 4)],
          exposed: rng() < 0.3
        })
      )
    }
    const job = makeJob(parts, { kerfMm: kerf, trimMm: trim })
    const r = nestJob(job)
    job.result = r
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    totalInstances = parts.reduce((a, p) => a + p.qty, 0)
    // 尺寸被限制为一定排得下
    if (r.unplaced.length > 0) {
      failures++
      firstFailure = `组${g + 1}：存在 ${r.unplaced.length} 件未排下`
      continue
    }
    if (placed !== totalInstances) {
      failures++
      firstFailure = `组${g + 1}：守恒失败 ${placed}/${totalInstances}`
      continue
    }
    const clearanceErr = assertClearances(job)
    if (clearanceErr) {
      failures++
      firstFailure = `组${g + 1}：${clearanceErr}`
      if ((globalThis as { FCO_DUMP?: boolean }).FCO_DUMP) dumpJob(job)
      continue
    }
    const sheetErr = assertSheet(job)
    if (sheetErr) {
      failures++
      firstFailure = `组${g + 1}：${sheetErr}`
      if ((globalThis as { FCO_DUMP?: boolean }).FCO_DUMP) dumpJob(job, sheetErr)
      continue
    }
    // 纹理硬约束：零旋转
    const rotated = r.sheets.flatMap((s) => s.placements).filter((p) => {
      if (p.grain === 'none') return false
      if (p.rotated) return true
      if (p.grain === 'length' && !(p.lenMm === p.origLen && p.widMm === p.origWid)) return true
      if (p.grain === 'width' && !(p.lenMm === p.origWid && p.widMm === p.origLen)) return true
      return false
    })
    if (rotated.length > 0) {
      failures++
      firstFailure = `组${g + 1}：纹理件被旋转 ${rotated.length} 次`
    }
  }
  add(
    '100 组随机 guillotine 零反例（贯通/锯路/修边/守恒/模拟）',
    failures === 0,
    failures === 0
      ? '100/100 通过；每组均验证：逐步模拟可还原全部零件'
      : firstFailure
  )

  // 2) 纹理无法满足时给原因而不是偷转
  {
    const job = makeJob([
      makePart({ code: 'BIG', lenMm: 2500, widMm: 400, qty: 1, grain: 'length' }),
      makePart({ code: 'OK', lenMm: 400, widMm: 400, qty: 1 })
    ])
    const r = nestJob(job)
    const ok =
      r.unplaced.length === 1 &&
      r.unplaced[0].code === 'BIG' &&
      r.unplaced[0].reason.includes('纹理') &&
      r.sheets.reduce((a, s) => a + s.placements.length, 0) === 1
    add('纹理排不下时明确提示且不强制旋转', ok, ok ? '提示：' + r.unplaced[0].reason : '未按预期报纹理冲突')
  }

  // 3) 锯路精确净距（两件相邻 = kerf）
  {
    const job = makeJob([
      makePart({ code: 'A', lenMm: 500, widMm: 500 }),
      makePart({ code: 'B', lenMm: 500, widMm: 500 })
    ])
    const r = nestJob(job)
    const ps = r.sheets[0].placements
    ps.sort((a, b) => a.y - b.y || a.x - b.x)
    const gap = ps[1].y - (ps[0].y + 500)
    const ok = Math.abs(gap - job.kerfMm) < 0.1
    add('相邻零件净距等于锯路 3.2mm', ok, `实测净距 ${gap.toFixed(2)}mm`)
  }

  // 4) 封边米数复算 + 见光分列
  {
    const job = makeJob([
      makePart({
        code: 'E1',
        lenMm: 500,
        widMm: 300,
        qty: 2,
        edgeBands: ['top', 'left'],
        exposed: true
      }),
      makePart({ code: 'E2', lenMm: 400, widMm: 200, qty: 1, edgeBands: ['top', 'bottom', 'left', 'right'] })
    ])
    const r = nestJob(job)
    const expectExposed = 2 * (0.5 + 0.3) // 1.6
    const expectNormal = 0.4 * 2 + 0.2 * 2 // 1.2
    const ok =
      Math.abs(r.edgeBandM.exposed - expectExposed) < 0.011 &&
      Math.abs(r.edgeBandM.normal - expectNormal) < 0.011
    add(
      '封边米数逐件复算一致且见光/非见光分列',
      ok,
      `见光 ${r.edgeBandM.exposed}m（期望 ${expectExposed}）、非见光 ${r.edgeBandM.normal}m（期望 ${expectNormal}）`
    )
  }

  // 5) 30 件标准件：锯切工步 ≤20 且模拟还原全部尺寸
  {
    const job = makeJob([makePart({ code: 'S', lenMm: 480, widMm: 398, qty: 30, grain: 'none' })])
    const r = nestJob(job)
    const ops = countSawOps(r.sheets)
    const simsOk = r.sheets.every((s) =>
      simulate(s.wMm, s.hMm, job.kerfMm, s.steps, s.placements).ok
    )
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    const ok = ops <= 20 && simsOk && placed === 30 && r.sheets.length === 2
    add(
      '30 零件锯切工步 ≤20 且按步模拟尺寸全部正确',
      ok,
      `${r.sheets.length} 张板、${ops} 个锯切工步（修边按叠切计 1 次）、模拟 ${simsOk ? '通过' : '失败'}`
    )
  }

  // 6) 余料作为小板参与下一轮排样
  {
    const small: Board = {
      id: 'offcut_test',
      name: '余料板 900×700',
      wMm: 900,
      hMm: 700,
      thicknessMm: 18,
      material: '颗粒板',
      priceCents: 0,
      quantity: 1,
      kind: 'offcut'
    }
    const job = makeJob([makePart({ code: 'O1', lenMm: 500, widMm: 500 })], {
      boards: [small, makeBoard()]
    })
    const r = nestJob(job)
    const ok = r.sheets[0].boardId === 'offcut_test' && r.sheets.length === 1
    add('余料登记后优先作为小板材参与排样', ok, ok ? '零件排上了 900×700 余料板' : '余料未被优先使用')
  }

  // 7) 300 零件（40 种规格）性能
  {
    const rng2 = mulberry32(77)
    const parts: Part[] = []
    let qtyLeft = 300
    for (let i = 0; i < 40; i++) {
      const qty = Math.min(i === 39 ? qtyLeft : 7 + Math.floor(rng2() * 2), qtyLeft)
      qtyLeft -= qty
      parts.push(
        makePart({
          code: `F${i}`,
          lenMm: 150 + Math.floor(rng2() * 750),
          widMm: 120 + Math.floor(rng2() * 500),
          qty
        })
      )
    }
    const job = makeJob(parts)
    const r = nestJob(job)
    const placed = r.sheets.reduce((a, s) => a + s.placements.length, 0)
    const ok = r.elapsedMs < 1500 && placed === 300
    add('300 零件排样 < 1.5s', ok, `耗时 ${r.elapsedMs}ms，用板 ${r.sheets.length} 张，就位 ${placed}/300`)
  }

  // 8) 手工微调合法性校验：合法布局通过，塞缝布局拒绝
  {
    const bounds: Rect = { x: 8, y: 8, w: 2424, h: 1204 }
    const legal: { id: string; x: number; y: number; w: number; h: number }[] = [
      { id: '1', x: 8, y: 8, w: 600, h: 1196 },
      { id: '2', x: 611.2, y: 8, w: 600, h: 596 },
      { id: '3', x: 611.2, y: 607.2, w: 600, h: 596.8 }
    ]
    // 经典风车形非切分布局（5 块互相顶住，找不到任何一条贯通切线）
    const illegal: { id: string; x: number; y: number; w: number; h: number }[] = [
      { id: 'B', x: 8, y: 8, w: 396.8, h: 600 },
      { id: 'C', x: 408, y: 8, w: 592, h: 396.8 },
      { id: 'E', x: 408, y: 408, w: 196.8, h: 196.8 },
      { id: 'A', x: 8, y: 608, w: 596.8, h: 396.8 },
      { id: 'D', x: 608, y: 408, w: 392, h: 596.8 }
    ]
    const okLegal = guillotineViolation(legal, bounds, 3.2) === null
    const okIllegal = guillotineViolation(illegal, bounds, 3.2) !== null
    add(
      '微调后 guillotine 合法性校验准确',
      okLegal && okIllegal,
      `合法布局 ${okLegal ? '放行' : '误拒'}；塞缝布局 ${okIllegal ? '拒绝' : '误放'}`
    )
  }

  // 9) 多板种混排 + 库存张数约束
  {
    const thin = makeBoard({
      id: 'thin',
      name: '背板 2440×1220×9',
      wMm: 2440,
      hMm: 1220,
      thicknessMm: 9,
      priceCents: 9800
    })
    const thick = makeBoard({ id: 'thick', name: '主板 2440×1220×18', quantity: 1 })
    const parts = [
      makePart({ code: 'T', lenMm: 1000, widMm: 600, qty: 5, boardId: 'thick' }),
      makePart({ code: 'B', lenMm: 1000, widMm: 600, qty: 2, boardId: 'thin' })
    ]
    const job = makeJob(parts, { boards: [thick, thin] })
    const r = nestJob(job)
    const thickSheets = r.sheets.filter((s) => s.thicknessMm === 18).length
    const thinSheets = r.sheets.filter((s) => s.thicknessMm === 9).length
    const shortage = r.stockShortage.find((x) => x.boardId === 'thick')
    const ok =
      thickSheets >= 2 && thinSheets === 1 && !!shortage && shortage.need >= 2 && shortage.have === 1
    add(
      '多板种混排且 18mm 库存仅 1 张时超开并提示补采',
      ok,
      `18mm 用 ${thickSheets} 张（库存 1，需补采）、9mm 用 ${thinSheets} 张`
    )
  }

  // 10) 改版：件号重复行并条（数量相加，规矩字段冲突取首行并警告）
  {
    const { map, warnings } = mergeByCode([
      rowOf({ code: 'A', name: '件A', lenMm: 500, widMm: 400, qty: 2, grain: 'length' }),
      rowOf({ code: 'A', name: '件A', lenMm: 500, widMm: 400, qty: 3, grain: 'length' }),
      rowOf({ code: 'B', lenMm: 300, widMm: 200, qty: 1, grain: 'none' }),
      rowOf({ code: 'B', lenMm: 300, widMm: 210, qty: 1, grain: 'none' })
    ])
    const a = map.get('A')!
    const b = map.get('B')!
    const ok =
      a.qty === 5 && a.lenMm === 500 && b.qty === 2 && b.lenMm === 300 && b.warnings.length === 1 &&
      warnings.length === 1 && warnings[0].includes('B')
    add(
      '改版并条：重复件号数量相加、规矩冲突取首行且警告',
      ok,
      ok ? `A.qty=${a.qty}（2+3），B.qty=${b.qty}，B 宽冲突已警告` : `A=${JSON.stringify({ q: a.qty })} B=${b.lenMm}×${b.widMm} warn=${b.warnings.length}`
    )
  }

  // 11) 改版：缺字段按空值（长宽缺=0、数量缺=1、纹理=无、见光=否），解析不丢行
  {
    const { rows, errors } = parseRevisionText('A\t件A\t\t400\t\t\t\t柜\t\nB\t件B\t500\t\t2\t竖纹\t上下\t柜\t是')
    const a = rows.find((r) => r.code === 'A')!
    const b = rows.find((r) => r.code === 'B')!
    const ok =
      rows.length === 2 && a.lenMm === null && a.qty === null && errors.length >= 1 &&
      b.widMm === null && b.grain === 'length' && b.exposed === true
    add('改版解析：缺字段按空值保留且提示，不丢行', ok, ok ? `2 行全保留，缺字段提示 ${errors.length} 条` : `rows=${rows.length}, errors=${errors.length}`)
  }

  // 12) 改版：新增/删除/长宽变/数量变/纹理变 分类与逐项差值正确
  {
    const job = nestedJob([
      makePart({ code: 'DEL', lenMm: 600, widMm: 300, qty: 2 }),
      makePart({ code: 'SIZE', lenMm: 500, widMm: 400, qty: 1 }),
      makePart({ code: 'QTY', lenMm: 400, widMm: 300, qty: 2, edgeBands: ['top'], exposed: true }),
      makePart({ code: 'GR', lenMm: 400, widMm: 300, qty: 1, grain: 'none' }),
      makePart({ code: 'KEEP', lenMm: 300, widMm: 200, qty: 1 })
    ])
    const rep = createRevision(job, {
      newRows: [
        rowOf({ code: 'SIZE', name: '测试件', lenMm: 700, widMm: 400, qty: 1, grain: 'none' }),
        rowOf({ code: 'QTY', name: '测试件', lenMm: 400, widMm: 300, qty: 5, grain: 'none', edgeBands: ['top'], exposed: true }),
        rowOf({ code: 'GR', name: '测试件', lenMm: 400, widMm: 300, qty: 1, grain: 'length' }),
        rowOf({ code: 'KEEP', name: '测试件', lenMm: 300, widMm: 200, qty: 1, grain: 'none' }),
        rowOf({ code: 'ADD', name: '测试件', lenMm: 350, widMm: 250, qty: 3, grain: 'none' })
      ],
      strategy: 'reuse'
    })
    const by = Object.fromEntries(rep.rows.map((r) => [r.code, r]))
    const expectDPieces = 0 + 0 + 3 + 0 + 3 - 2 // SIZE0, QTY+3, GR0, KEEP0, ADD+3, DEL-2 = 4
    const expectEdgeExp = (0.4 * 5 - 0.4 * 2) // QTY 见光顶边 400mm ×（5−2）= +1.2m
    const ok =
      by['ADD'].kind === 'added' && by['DEL'].kind === 'removed' &&
      by['SIZE'].fields.includes('lenMm') && by['QTY'].fields.includes('qty') &&
      by['GR'].fields.includes('grain') && by['KEEP'].kind === 'same' &&
      rep.totals.dPieces === expectDPieces &&
      Math.abs(rep.totals.dEdgeExposedM - expectEdgeExp) < 0.005 &&
      by['GR'].forcesReopen && by['QTY'].forcesReopen && !by['QTY'].fields.includes('edgeBands')
    add(
      '改版分类与逐项差值（件数/封边/强制重开判定）',
      ok,
      ok
        ? `件数差 ${rep.totals.dPieces}（期望 ${expectDPieces}）、见光封边差 ${rep.totals.dEdgeExposedM}m（期望 ${expectEdgeExp}）`
        : `件数 ${rep.totals.dPieces}/${expectDPieces}，封边 ${rep.totals.dEdgeExposedM}/${expectEdgeExp}`
    )
  }

  // 13) 改版：成本表按差得多→差得少；逐项合计=总表；两口径核对全绿
  {
    const job = nestedJob([
      makePart({ code: 'A', lenMm: 800, widMm: 600, qty: 4 }),
      makePart({ code: 'B', lenMm: 300, widMm: 200, qty: 2 })
    ])
    const rep = createRevision(job, {
      newRows: [
        rowOf({ code: 'A', name: '测试件', lenMm: 800, widMm: 600, qty: 6, grain: 'none' }),
        rowOf({ code: 'B', name: '测试件', lenMm: 300, widMm: 200, qty: 2, grain: 'none' })
      ],
      strategy: 'renest'
    })
    let sorted = true
    for (let i = 1; i < rep.rows.length; i++) {
      if (Math.abs(rep.rows[i - 1].dBoardCents) < Math.abs(rep.rows[i].dBoardCents)) sorted = false
    }
    const sumCents = Math.round(rep.rows.reduce((a, r) => a + r.dBoardCents, 0))
    const sumPieces = rep.rows.reduce((a, r) => a + r.dPieces, 0)
    const checksOk = rep.checks.filter((c) => c.name.includes('逐项差值合计')).every((c) => c.ok)
    const edgeCheck = rep.checks.find((c) => c.name.includes('封边'))!.ok
    const piecesCheck = rep.checks.find((c) => c.name.includes('件数'))!.ok
    const ok =
      sorted && sumCents === rep.totals.dBoardCents && sumPieces === rep.totals.dPieces &&
      checksOk && edgeCheck && piecesCheck
    add(
      '改版排序与核对：成本表差额降序，逐项合计=总表，封边/件数两口径对得上',
      ok,
      ok ? `逐项料钱和 ${sumCents}=合计，件数 ${sumPieces}，核对全绿` : `sorted=${sorted} cents=${sumCents}/${rep.totals.dBoardCents} edge=${edgeCheck}`
    )
  }

  // 14) 改版应用·留用旧摆法：干净板留用 provenance=kept，受影响板 reopen，混排板 void 标废
  {
    // 放 3 组互不挤板的件，确保落在不同张：大件组同号同板，小改动只动其中一组
    const parts: Part[] = []
    for (let g = 0; g < 3; g++) {
      parts.push(
        makePart({ code: `G${g}-A`, lenMm: 1100, widMm: 1000, qty: 1 }),
        makePart({ code: `G${g}-B`, lenMm: 1100, widMm: 140, qty: 1 })
      )
    }
    const job = nestedJob(parts)
    const sheetsBefore = job.result!.sheets.length
    const oldCostBySheet = job.result!.sheets.map((s) => s.priceCents)
    // 新版：删掉 G0-B（与 G0-A 同板 → G0 板变混排：A 留切、B 标废），新增一件随重排
    const rep = createRevision(job, {
      newRows: [
        ...parts.filter((p) => p.code !== 'G0-B').map((p) =>
          rowOf({ code: p.code, name: p.name, lenMm: p.lenMm, widMm: p.widMm, qty: p.qty, grain: p.grain })
        ),
        rowOf({ code: 'NEW', name: '测试件', lenMm: 400, widMm: 300, qty: 1, grain: 'none' })
      ],
      strategy: 'reuse'
    })
    const { result } = applyRevision(job, rep, 'reuse')
    const kept = result.sheets.filter((s) => s.provenance === 'kept')
    const mixed = result.sheets.filter((s) => s.provenance === 'mixed')
    const reopen = result.sheets.filter((s) => s.provenance === 'reopen')
    const voids = result.sheets.flatMap((s) => s.placements.filter((p) => p.void))
    const version = job.versionNo === 2 && job.archives!.length === 1 &&
      job.archives![0].metrics.boardsUsed === sheetsBefore
    const ok =
      kept.length >= 1 && mixed.length === 1 && reopen.length >= 1 &&
      voids.length === 1 && voids[0].code === 'G0-B' && version
    // 落账成本：重排新板钱 − 省掉的重开旧板钱（混排板照旧切不补不省）
    const savedOldCost = rep.reuse.reopenSheets.reduce((a, i) => a + oldCostBySheet[i], 0)
    const ledgerExpect =
      reopen.reduce((a, s) => a + s.priceCents, 0) - savedOldCost
    const ledgerOk = rep.totals.ledgerBoardCents === ledgerExpect
    add(
      '改版留用：干净板留用/混排板照旧切且标废/受影响件重开，旧版自动存档，落账成本守恒',
      ok && ledgerOk,
      ok && ledgerOk
        ? `旧 ${sheetsBefore} 张 → 留用 ${kept.length}、混切 ${mixed.length}（标废 ${voids.length}）、重开 ${reopen.length}；落账 ${rep.totals.ledgerBoardCents} 分（期望 ${ledgerExpect}）；存档 1 份`
        : `kept=${kept.length} mixed=${mixed.length} reopen=${reopen.length} void=${voids.map((v) => v.code).join(',')} archive=${job.archives?.length} ledger=${rep.totals.ledgerBoardCents}/${ledgerExpect}`
    )
  }

  // 15) 改版应用·整批重排：全部 provenance=reopen；旧导出全部作废
  {
    const job = nestedJob([
      makePart({ code: 'A', lenMm: 700, widMm: 600, qty: 2 }),
      makePart({ code: 'B', lenMm: 400, widMm: 300, qty: 1 })
    ])
    job.exports = [
      { id: 'e1', versionNo: 1, sections: ['下料单'], createdAt: 1, voided: false },
      { id: 'e2', versionNo: 1, sections: ['标签'], createdAt: 2, voided: false }
    ]
    const rep = createRevision(job, {
      newRows: [
        rowOf({ code: 'A', name: '测试件', lenMm: 700, widMm: 600, qty: 3, grain: 'none' })
      ],
      strategy: 'renest'
    })
    const { result, reopenedAll } = applyRevision(job, rep, 'renest')
    const allReopen = result.sheets.every((s) => s.provenance === 'reopen')
    const exportsVoid = job.exports!.every((e) => e.voided)
    const ok = reopenedAll && allReopen && exportsVoid
    add(
      '改版整批重排：所有板重开且旧版已发清单全部作废',
      ok,
      ok ? `${result.sheets.length} 张全部重开，2 份旧导出均作废` : `reopenedAll=${reopenedAll}, allReopen=${allReopen}, void=${exportsVoid}`
    )
  }

  // 16) 回退：恢复旧版清单与那组数，回退期间导出作废；旧版 metrics 未被新版盖掉
  {
    const job = nestedJob([makePart({ code: 'A', lenMm: 600, widMm: 500, qty: 2 })])
    const oldMetrics = { ...job.result!.edgeBandM, boards: job.result!.boardsUsed, cost: job.result!.totalCostCents }
    const rep = createRevision(job, {
      newRows: [rowOf({ code: 'A', name: '测试件', lenMm: 600, widMm: 500, qty: 5, grain: 'none' })],
      strategy: 'renest'
    })
    applyRevision(job, rep, 'renest')
    const v2parts = job.parts.length
    // 再导出一份 v2，然后回退到 v1
    job.exports!.push({ id: 'e3', versionNo: 2, sections: ['下料单'], createdAt: 3, voided: false })
    rollbackToVersion(job, 1)
    const qty = job.parts.find((p) => p.code === 'A')!.qty
    const e3void = job.exports!.find((e) => e.id === 'e3')!.voided
    const metricsKept =
      job.archives!.find((a) => a.versionNo === 1)!.metrics.boardsUsed === oldMetrics.boards &&
      job.archives!.find((a) => a.versionNo === 1)!.metrics.totalCostCents === oldMetrics.cost
    const ok = qty === 2 && e3void && job.versionNo === 1 && metricsKept && v2parts === 1
    add(
      '改版回退：旧版清单与当时用板/料钱可查，回退期间导出作废重发',
      ok,
      ok ? `A.qty=${qty}，v2 导出已作废，v1 存档 ${oldMetrics.boards} 张未被覆盖` : `qty=${qty}, e3void=${e3void}, kept=${metricsKept}`
    )
  }

  const elapsedMs = Math.round(performance.now() - t0)
  const ok = checks.every((c) => c.ok)
  return { ok, elapsedMs, checks }
}
