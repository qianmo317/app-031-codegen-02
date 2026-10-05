// 改版影响核定引擎（纯函数，不依赖 Vue / localStorage）
//
// 精度与单位规矩（全应用统一，UI/打印/自检同此口径）：
//   长度   mm，整数（录入即整数；折算过程不四舍五入）
//   面积   内部 mm² 精确累计；展示 m² 保留 2 位小数
//   封边   m，保留 2 位小数（厘米）；边长用零件实际净尺寸（不含锯路）
//   用板   逐项「折算张」= 净面积 ÷ 板毛面积，保留 3 位小数（不含锯路/修边损失）；
//          「排样实算张」为整单重排后的整数张数。两口径并列、必须标注口径差
//   金额   内部以「分」整数存储，展示元保留 2 位小数（取到分）
//   五金   套/个/颗为整数；封边胶 kg 保留 2 位小数
//
// 同源规矩：新旧两版各只跑一次整单排样，明细页/工单页/统计页全部读同一份
// RevisionReport，成本表只由逐项差值汇总一遍，禁止各处各算一版。

import type {
  Board,
  EdgeSide,
  ExportRecord,
  GrainDemand,
  Job,
  NestResult,
  Part,
  RevExactMetrics,
  RevFieldChange,
  RevFieldKind,
  RevKind,
  RevRow,
  RevStrategy,
  RevTotals,
  RevisionReport,
  ReusePlan,
  SheetResult,
  VersionArchive
} from '../types'
import { nestJob } from './packing'
import boardsData from '../data/boards.json'
import { uid } from './format'

export const EDGE_DEC = 2
export const SHEET_EQ_DEC = 3
export const AREA_M2_DEC = 2

// ────────────────────────────── 件号归并 ──────────────────────────────

export interface RevInputRow {
  code: string
  name: string
  lenMm: number | null
  widMm: number | null
  qty: number | null
  grain: GrainDemand | null
  edgeBands: EdgeSide[] | null
  cabinet: string | null
  exposed: boolean | null
  boardId: string | null
}

interface MergedPart {
  code: string
  name: string
  cabinet: string | null
  lenMm: number | null
  widMm: number | null
  qty: number | null
  grain: GrainDemand | null
  edgeBands: EdgeSide[] | null
  exposed: boolean | null
  boardId: string | null
  lines: number
  warnings: string[]
}

/**
 * 件号重复出现两行时的并条规矩（写明，不允许静默吞掉）：
 *  1) 数量相加；
 *  2) 长/宽/纹理/封边/见光/指定板材等「规矩字段」各行必须一致；
 *     不一致 → 并成一条但标「并条冲突」，取首个非空值入账，警告中逐件列明，需人工确认；
 *  3) 名称/柜体取首个非空。
 */
const RULE_FIELDS: { key: keyof RevInputRow; label: string }[] = [
  { key: 'lenMm', label: '长' },
  { key: 'widMm', label: '宽' },
  { key: 'grain', label: '纹理' },
  { key: 'edgeBands', label: '封边' },
  { key: 'exposed', label: '见光' },
  { key: 'boardId', label: '指定板材' }
]

function ruleEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return [...(a as string[])].sort().join(',') === [...(b as string[])].sort().join(',')
  }
  return a === b
}

export function mergeByCode(rows: RevInputRow[]): { map: Map<string, MergedPart>; warnings: string[] } {
  const map = new Map<string, MergedPart>()
  const warnings: string[] = []
  let noCodeSeq = 0
  rows.forEach((r, i) => {
    const code = r.code.trim() || `（无件号·第${i + 1}行）`
    if (!r.code.trim()) noCodeSeq++
    const exist = map.get(code)
    if (!exist) {
      map.set(code, {
        code,
        name: r.name,
        cabinet: r.cabinet,
        lenMm: r.lenMm,
        widMm: r.widMm,
        qty: r.qty,
        grain: r.grain,
        edgeBands: r.edgeBands,
        exposed: r.exposed,
        boardId: r.boardId,
        lines: 1,
        warnings: []
      })
      return
    }
    exist.lines++
    // 数量：相加（空值按 BOM 惯例当 1，见 normQty，归并阶段先保留 null 语义）
    const qa = exist.qty
    const qb = r.qty
    exist.qty = qa === null && qb === null ? null : (qa ?? 1) + (qb ?? 1)
    const ex = exist as unknown as Record<string, unknown>
    for (const f of RULE_FIELDS) {
      const va = ex[f.key]
      const vb = r[f.key]
      if (vb === null || vb === undefined) continue
      if (va === null || va === undefined) {
        ex[f.key] = vb
        continue
      }
      if (!ruleEqual(va, vb)) {
        const w = `件号「${code}」重复 ${exist.lines} 行，${f.label}不一致（${fmtRaw(
          f.key,
          va
        )} / ${fmtRaw(f.key, vb)}），已取首行值入账，请人工确认`
        exist.warnings.push(w)
        if (!warnings.includes(w)) warnings.push(w)
      }
    }
    if (r.name && !exist.name) exist.name = r.name
    if (r.cabinet && !exist.cabinet) exist.cabinet = r.cabinet
  })
  if (noCodeSeq > 0) warnings.push(`${noCodeSeq} 行没有件号，已按「（无件号·第N行）」单列，无法与旧版配对`)
  return { map, warnings }
}

function fmtRaw(key: keyof RevInputRow, v: unknown): string {
  if (v === null || v === undefined) return '空'
  if (key === 'edgeBands') return (v as string[]).length ? (v as string[]).join('') : '无封边'
  if (key === 'grain') return grainLabel(v as GrainDemand | null)
  if (key === 'exposed') return v ? '见光' : '非见光'
  return String(v)
}

export function grainLabel(g: GrainDemand | null): string {
  return g === 'length' ? '竖纹' : g === 'width' ? '横纹' : g === 'none' ? '无要求' : '空'
}

// 缺字段入账规矩：长宽缺 → 0（该行不计面积并警告）；数量缺 → 1（BOM 惯例，警告）；
// 纹理缺 → 无要求；封边缺 → 无边；见光缺 → 否；指定板材缺 → 自动。
const normLen = (v: number | null): number => v ?? 0
const normQty = (v: number | null): number => v ?? 1
const normGrain = (v: GrainDemand | null): GrainDemand => v ?? 'none'
const normEdges = (v: EdgeSide[] | null): EdgeSide[] => v ?? []
const normExp = (v: boolean | null): boolean => v ?? false

// ────────────────────────────── 文本解析（缺字段按空值，不丢行） ──────────────────────────────

/** 改版专用解析：与明细页导入同列序，但缺长/宽/数量的行保留为空值而不是丢弃。 */
export function parseRevisionText(text: string): { rows: RevInputRow[]; errors: string[] } {
  const errors: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return { rows: [], errors: ['没有可解析的内容'] }
  const splitLine = (l: string): string[] => {
    const sep = l.includes('\t')
      ? '\t'
      : l.includes(',')
        ? ','
        : /[;；]/.test(l)
          ? /[;；]/.source
          : '\t'
    return l.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''))
  }
  let startIdx = 0
  const headerMap: Record<string, number> = {}
  const headerHints: Record<string, string[]> = {
    code: ['编号', '编码', '代码', '件号', 'code'],
    name: ['名称', '零件', 'name'],
    lenMm: ['长', '长度', 'len', 'length'],
    widMm: ['宽', '宽度', 'wid', 'width'],
    qty: ['数量', '数', 'qty', 'count'],
    grain: ['纹理', '纹路', 'grain'],
    edges: ['封边', '封边边', 'edge'],
    cabinet: ['柜体', '房间', '柜', 'cabinet'],
    exposed: ['见光', 'exposed']
  }
  const cols0 = splitLine(lines[0]).map((c) => c.toLowerCase())
  if (cols0.some((c) => /长|len|length/.test(c))) {
    startIdx = 1
    for (const key of Object.keys(headerHints)) {
      const idx = cols0.findIndex((c) => headerHints[key].some((h) => c.includes(h.toLowerCase())))
      if (idx >= 0) headerMap[key] = idx
    }
  } else {
    ;['code', 'name', 'lenMm', 'widMm', 'qty', 'grain', 'edges', 'cabinet', 'exposed'].forEach(
      (k, i) => (headerMap[k] = i)
    )
  }
  const numOrNull = (s: string): number | null => {
    if (s === '') return null
    const n = Number(s)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const rows: RevInputRow[] = []
  lines.slice(startIdx).forEach((line, li) => {
    const c = splitLine(line)
    const get = (k: string): string => {
      const i = headerMap[k]
      return i === undefined || i >= c.length ? '' : c[i]
    }
    const len = numOrNull(get('lenMm'))
    const wid = numOrNull(get('widMm'))
    const qtyRaw = get('qty')
    const qty = qtyRaw === '' ? null : Math.max(0, Math.floor(Number(qtyRaw)))
    const grainRaw = get('grain')
    const grain: GrainDemand | null =
      grainRaw === ''
        ? null
        : /竖|长|length/.test(grainRaw)
          ? 'length'
          : /横|宽|width/.test(grainRaw)
            ? 'width'
            : 'none'
    const edgesRaw = get('edges')
    if ((len === null) !== (wid === null) || len === null) {
      errors.push(
        `第 ${li + startIdx + 1} 行「${get('code') || get('name') || '?'}」长宽不全，按空值（0）入账，不计用料`
      )
    }
    if (qtyRaw !== '' && (!Number.isFinite(Number(qtyRaw)) || (qty ?? 0) <= 0)) {
      errors.push(`第 ${li + startIdx + 1} 行「${get('code') || '?'}」数量无效，按空值（1）入账`)
    }
    rows.push({
      code: get('code'),
      name: get('name') || `零件${li + 1}`,
      lenMm: len,
      widMm: wid,
      qty: qtyRaw === '' || !(qty !== null && qty > 0) ? null : qty,
      grain,
      edgeBands: edgesRaw === '' ? null : parseEdgeTokens(edgesRaw),
      cabinet: get('cabinet') || null,
      exposed: get('exposed') === '' ? null : /是|true|1|y|见/.test(get('exposed')),
      boardId: null
    })
  })
  return { rows, errors }
}

function parseEdgeTokens(t: string): EdgeSide[] {
  const sides = new Set<EdgeSide>()
  for (const ch of t) {
    if (ch === '上' || ch === '顶') sides.add('top')
    if (ch === '下' || ch === '底') sides.add('bottom')
    if (ch === '左') sides.add('left')
    if (ch === '右') sides.add('right')
  }
  const tokens = t.toLowerCase().match(/\b(top|bottom|left|right|[tblr]|[1-4])\b/g) ?? []
  for (const tok of tokens) {
    if (tok === 'top' || tok === 't' || tok === '1') sides.add('top')
    if (tok === 'bottom' || tok === 'b' || tok === '2') sides.add('bottom')
    if (tok === 'left' || tok === 'l' || tok === '3') sides.add('left')
    if (tok === 'right' || tok === 'r' || tok === '4') sides.add('right')
  }
  if (/^(无|none|0|-+)$/i.test(t.trim())) return []
  return [...sides]
}

function rowsFromParts(parts: Part[]): RevInputRow[] {
  return parts.map((p) => ({
    code: p.code,
    name: p.name,
    lenMm: p.lenMm || null,
    widMm: p.widMm || null,
    qty: p.qty ?? null,
    grain: p.grain,
    edgeBands: p.edgeBands,
    cabinet: p.cabinet || null,
    exposed: p.exposed,
    boardId: p.boardId || null
  }))
}

// ────────────────────────────── 指纹（核定是否过期） ──────────────────────────────

export function revisionSignature(parts: Part[], kerfMm: number, trimMm: number): string {
  const body = JSON.stringify({
    k: kerfMm,
    t: trimMm,
    p: parts
      .map((p) => [
        p.code,
        p.lenMm,
        p.widMm,
        p.qty,
        p.grain,
        [...p.edgeBands].sort().join(''),
        p.exposed ? 1 : 0,
        p.boardId ?? '',
        p.cabinet,
        p.name
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  })
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < body.length; i++) {
    const ch = body.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

// ────────────────────────────── 板材解析与逐项折算 ──────────────────────────────

function resolveBoard(m: MergedPart, boards: Board[]): Board {
  const explicit = boards.find((b) => b.id === m.boardId)
  if (explicit) return explicit
  // 自动：选装得下该件的最小常规板；装不下/无尺寸时退回最小常规板，再退第一张
  const stock = boards.filter((b) => b.kind !== 'offcut')
  const L = normLen(m.lenMm)
  const W = normLen(m.widMm)
  const viable = stock.filter(
    (b) => (L === 0 || b.wMm >= L) && (W === 0 || b.hMm >= W || b.wMm >= W)
  )
  return (
    viable.sort((a, b) => a.wMm * a.hMm - b.wMm * b.hMm)[0] ??
    stock.sort((a, b) => a.wMm * a.hMm - b.wMm * b.hMm)[0] ??
    boards[0]
  )
}

interface PartMetrics {
  areaMm2: number
  sheetsEq: number // 折算张（未取整）
  cents: number // 折算料钱（分，未取整）
  edgeExposedM: number
  edgeNormalM: number
  pieces: number
  board: Board
}

function edgeMeters(m: MergedPart): { exposed: number; normal: number } {
  const L = normLen(m.lenMm)
  const W = normLen(m.widMm)
  const edges = normEdges(m.edgeBands)
  const nTB = edges.filter((e) => e === 'top' || e === 'bottom').length
  const nLR = edges.filter((e) => e === 'left' || e === 'right').length
  const metersPerPiece = (L * nTB + W * nLR) / 1000
  const total = metersPerPiece * normQty(m.qty)
  return normExp(m.exposed) ? { exposed: total, normal: 0 } : { exposed: 0, normal: total }
}

function metricsOf(m: MergedPart, boards: Board[]): PartMetrics {
  const board = resolveBoard(m, boards)
  const qty = normQty(m.qty)
  const area = normLen(m.lenMm) * normLen(m.widMm) * qty
  const sheetsEq = board.wMm * board.hMm > 0 ? area / (board.wMm * board.hMm) : 0
  const edge = edgeMeters(m)
  return {
    areaMm2: area,
    sheetsEq,
    cents: sheetsEq * board.priceCents,
    edgeExposedM: edge.exposed,
    edgeNormalM: edge.normal,
    pieces: qty,
    board
  }
}

// ────────────────────────────── 逐件对照 ──────────────────────────────

const FIELD_LABELS: Record<RevFieldKind, string> = {
  lenMm: '长',
  widMm: '宽',
  qty: '数量',
  grain: '纹理',
  edgeBands: '封边',
  exposed: '见光',
  boardId: '板材',
  name: '名称',
  cabinet: '柜体'
}

function edgesLabel(e: EdgeSide[] | null): string {
  if (e === null) return '空'
  if (e.length === 0) return '无封边'
  const map: Record<EdgeSide, string> = { top: '上', bottom: '下', left: '左', right: '右' }
  return e.map((x) => map[x]).join('')
}

function fieldValue(key: RevFieldKind, m: MergedPart | null, boards: Board[]): string | null {
  if (!m) return null
  switch (key) {
    case 'lenMm':
      return m.lenMm === null ? null : `${m.lenMm}`
    case 'widMm':
      return m.widMm === null ? null : `${m.widMm}`
    case 'qty':
      // 缺数量按 1 件入账（解析阶段已警告）
      return `${m.qty ?? 1}`
    case 'grain':
      // 缺纹理按「无要求」入账
      return m.grain === null ? '无要求' : grainLabel(m.grain)
    case 'edgeBands':
      // 缺封边按「无封边」入账
      return edgesLabel(m.edgeBands === null ? [] : m.edgeBands)
    case 'exposed':
      // 缺见光按「非见光」入账，不把 null→false 报成变化
      return m.exposed === null ? '非见光' : m.exposed ? '见光' : '非见光'
    case 'boardId':
      return resolveBoard(m, boards).name
    case 'name':
      return m.name || null
    case 'cabinet':
      return m.cabinet
  }
}

function diffFields(
  o: MergedPart | null,
  n: MergedPart | null,
  boards: Board[]
): { fields: RevFieldKind[]; changes: RevFieldChange[] } {
  const keys: RevFieldKind[] = [
    'lenMm',
    'widMm',
    'qty',
    'grain',
    'edgeBands',
    'exposed',
    'boardId',
    'name',
    'cabinet'
  ]
  const fields: RevFieldKind[] = []
  const changes: RevFieldChange[] = []
  for (const key of keys) {
    const va = fieldValue(key, o, boards)
    const vb = fieldValue(key, n, boards)
    if ((va ?? null) !== (vb ?? null)) {
      fields.push(key)
      const unit =
        key === 'lenMm' || key === 'widMm' ? 'mm' : key === 'qty' ? '' : ''
      changes.push({
        field: key,
        label: FIELD_LABELS[key],
        old: va === null ? null : `${va}${unit}`,
        now: vb === null ? null : `${vb}${unit}`
      })
    }
  }
  return { fields, changes }
}

// ────────────────────────────── 排样实算（两版各一次） ──────────────────────────────

function codeHash(code: string): string {
  let h = 0
  for (let i = 0; i < code.length; i++) h = ((h << 5) - h + code.charCodeAt(i)) | 0
  return `c${(h >>> 0).toString(36)}`
}

function exactMetricsOf(result: NestResult): RevExactMetrics {  return {
    boardsUsed: result.boardsUsed,
    totalCostCents: result.totalCostCents,
    edgeExposedM: result.edgeBandM.exposed,
    edgeNormalM: result.edgeBandM.normal,
    pieces: result.sheets.reduce((a, s) => a + s.placements.length, 0)
  }
}

function runExact(job: Job, parts: Part[], boards: Board[]): NestResult {
  return nestJob({ ...job, parts, boards, useOffcutIds: [] })
}

function nestBoardIdsHas(boards: Board[], id: string): boolean {
  return boards.some((b) => b.id === id)
}

// ────────────────────────────── 留用方案 ──────────────────────────────

/**
 * 旧版每张板三分类：
 *  - kept   干净板：板上没有任何受影响件号 → 板与刀路原样留用
 *  - mixed  混排板：板上既有受影响件也有未受影响件 → 板已耗；未受影响件按旧刀路
 *           回头切（extraBackCuts+1），受影响件标废并重新排到新板
 *  - reopen 整板作废：板上全部是受影响件 → 板不开，整块随受影响件重排
 */
function buildReusePlan(rows: RevRow[], oldResult: NestResult): ReusePlan {
  const affected = new Set(rows.filter((r) => r.forcesReopen).map((r) => r.code))
  const keptSheets: number[] = []
  const reopenSheets: number[] = []
  const mixedSheets: number[] = []
  let keptPieces = 0
  let reopenPieces = 0
  let backCutPieces = 0
  let voidPieces = 0
  const carryOver: ReusePlan['carryOverPieces'] = []
  for (const sheet of oldResult.sheets) {
    const affectedPl = sheet.placements.filter((p) => affected.has(p.code))
    if (affectedPl.length === 0) {
      keptSheets.push(sheet.index)
      keptPieces += sheet.placements.length
      continue
    }
    if (affectedPl.length === sheet.placements.length) {
      reopenSheets.push(sheet.index)
      reopenPieces += sheet.placements.length
      continue
    }
    mixedSheets.push(sheet.index)
    const unaffected = sheet.placements.filter((p) => !affected.has(p.code))
    backCutPieces += unaffected.length
    voidPieces += affectedPl.length
    reopenPieces += affectedPl.length
    const byCode = new Map<string, (typeof carryOver)[number]>()
    for (const p of unaffected) {
      const cur = byCode.get(p.code)
      if (cur) cur.qty++
      else
        byCode.set(p.code, {
          code: p.code,
          name: p.name,
          lenMm: p.origLen,
          widMm: p.origWid,
          qty: 1,
          cabinet: p.cabinet,
          oldSheetIndex: sheet.index
        })
    }
    carryOver.push(...byCode.values())
  }
  return {
    keptSheets,
    reopenSheets,
    mixedSheets,
    keptPieces,
    reopenPieces,
    backCutPieces,
    voidPieces,
    affectedCodes: [...affected].sort(),
    extraBackCuts: mixedSheets.length,
    carryOverPieces: carryOver.sort(
      (a, b) => a.oldSheetIndex - b.oldSheetIndex || a.code.localeCompare(b.code)
    )
  }
}

// ────────────────────────────── 主入口：做改版核定 ──────────────────────────────

export interface CreateRevisionInput {
  newRows: RevInputRow[]
  strategy: RevStrategy
  /** 参与排样的额外小板（已登记余料），由 store 注入，保持引擎不碰全局状态 */
  extraBoards?: Board[]
}

export function createRevision(job: Job, input: CreateRevisionInput): RevisionReport {
  if (!job.result) throw new Error('请先对旧版排样，再做改版影响核定')
  const oldMerge = mergeByCode(rowsFromParts(job.parts))
  const newMerge = mergeByCode(input.newRows)
  const warnings = [...oldMerge.warnings, ...newMerge.warnings]

  const boards = cloneBoards(job.boards)
  // 旧版件直接沿用本机已存档排样；新版件 boardId 由明细页粘贴时不带，走自动
  const newParts = finalizeParts(newMerge.map, boards, [])

  // 两版各只算一次，且三处同源：旧版直接取本机已存档的排样结果（不再重算，
  // 保证「改版以前算出来的那组数」就是师傅当时看到的数）；新版只跑这一次整单排样。
  // 若旧版实际排上了登记余料，把那块板（id/尺寸/0 元）按旧结果补进可用板列表，
  // 指定该板的件才不会失配；不额外注入 job.useOffcutIds 里旧版没用上的余料。
  const oldOffcutBoards: Board[] = []
  for (const s of job.result.sheets) {
    if (!s.boardId.startsWith('offcut_') || nestBoardIdsHas(boards, s.boardId)) continue
    if (oldOffcutBoards.some((b) => b.id === s.boardId)) continue
    oldOffcutBoards.push({
      id: s.boardId,
      name: s.boardName,
      wMm: s.wMm,
      hMm: s.hMm,
      thicknessMm: s.thicknessMm,
      material: s.material,
      priceCents: 0,
      quantity: 1,
      kind: 'offcut'
    })
  }
  const nestBoards = [...(input.extraBoards ?? []), ...oldOffcutBoards, ...boards]
  const oldResult: NestResult = job.result
  const newResult = runExact(job, newParts, nestBoards)
  const oldExact = exactMetricsOf(oldResult)
  const newExact = exactMetricsOf(newResult)

  // 逐件对照
  const codes = new Set<string>([...oldMerge.map.keys(), ...newMerge.map.keys()])
  const rows: RevRow[] = []
  const eqByBoard = new Map<string, number>()
  let dCents = 0
  let dEdgeExp = 0
  let dEdgeNorm = 0
  let dPieces = 0
  let dArea = 0
  for (const code of codes) {
    const o = oldMerge.map.get(code) ?? null
    const n = newMerge.map.get(code) ?? null
    const kind: RevKind = !o ? 'added' : !n ? 'removed' : isSameRule(o, n) ? 'same' : 'changed'
    const { fields, changes } = diffFields(o, n, boards)
    const mo = o ? metricsOf(o, boards) : zeroMetrics(boards)
    const mn = n ? metricsOf(n, boards) : zeroMetrics(boards)
    const forcesReopen =
      kind === 'added' ||
      kind === 'removed' ||
      fields.includes('lenMm') ||
      fields.includes('widMm') ||
      fields.includes('qty') ||
      fields.includes('grain')
    // 折算张按板种有符号累计（板材换种：旧板种 −、新板种 +）
    eqByBoard.set(mn.board.name, (eqByBoard.get(mn.board.name) ?? 0) + mn.sheetsEq)
    eqByBoard.set(mo.board.name, (eqByBoard.get(mo.board.name) ?? 0) - mo.sheetsEq)
    const row: RevRow = {
      code,
      kind,
      fields,
      changes,
      name: n?.name ?? o?.name ?? code,
      boardName: n ? mn.board.name : mo.board.name,
      old: {
        lenMm: o?.lenMm ?? null,
        widMm: o?.widMm ?? null,
        qty: o?.qty ?? null,
        grain: o?.grain ?? null,
        edgeBands: o?.edgeBands ?? null,
        exposed: o?.exposed ?? null,
        boardId: o?.boardId ?? null
      },
      now: {
        lenMm: n?.lenMm ?? null,
        widMm: n?.widMm ?? null,
        qty: n?.qty ?? null,
        grain: n?.grain ?? null,
        edgeBands: n?.edgeBands ?? null,
        exposed: n?.exposed ?? null,
        boardId: n?.boardId ?? null
      },
      dAreaMm2: mn.areaMm2 - mo.areaMm2,
      // 行内一律不取整，只在合计行与展示时取整，保证逐项和=合计（对不上会被核对项指出）
      dSheetsEq: mn.sheetsEq - mo.sheetsEq,
      dBoardCents: mn.cents - mo.cents,
      dEdgeExposedM: mn.edgeExposedM - mo.edgeExposedM,
      dEdgeNormalM: mn.edgeNormalM - mo.edgeNormalM,
      dPieces: mn.pieces - mo.pieces,
      forcesReopen,
      mergeWarnings: n?.warnings ?? o?.warnings ?? []
    }
    dCents += mn.cents - mo.cents
    dEdgeExp += mn.edgeExposedM - mo.edgeExposedM
    dEdgeNorm += mn.edgeNormalM - mo.edgeNormalM
    dPieces += mn.pieces - mo.pieces
    dArea += mn.areaMm2 - mo.areaMm2
    rows.push(row)
  }

  const dSheetsByType = [...eqByBoard.entries()]
    .map(([boardName, d]) => ({ boardName, dSheetsEq: roundTo(d, SHEET_EQ_DEC) }))
    .filter((x) => Math.abs(x.dSheetsEq) >= 0.0005)
    .sort((a, b) => Math.abs(b.dSheetsEq) - Math.abs(a.dSheetsEq))
  const dSheetsEq = roundTo(
    dSheetsByType.reduce((a, x) => a + x.dSheetsEq, 0),
    SHEET_EQ_DEC
  )

  const hw = boardsData.hardware
  const dEdgeM = roundTo(dEdgeExp + dEdgeNorm, EDGE_DEC)
  const totals: RevTotals = {
    dSheetsByType,
    dSheetsEq,
    dSheetsExact: newExact.boardsUsed - oldExact.boardsUsed,
    dBoardCents: Math.round(dCents),
    dBoardCentsExact: newExact.totalCostCents - oldExact.totalCostCents,
    dEdgeExposedM: roundTo(dEdgeExp, EDGE_DEC),
    dEdgeNormalM: roundTo(dEdgeNorm, EDGE_DEC),
    dEdgeM,
    dPieces,
    dHardware: [
      { name: hw.connectorName, value: dPieces * hw.connectorPerPart, unit: '套' },
      { name: hw.dowelName, value: dPieces * hw.dowelPerPart, unit: '个' },
      { name: hw.screwName, value: dPieces * hw.screwPerPart, unit: '颗' },
      {
        name: hw.glueName,
        value: Number(((dEdgeM * hw.glueGramPerEdgeMeter) / 1000).toFixed(EDGE_DEC)),
        unit: 'kg'
      }
    ]
  }

  // 成本表排序：差得多 → 差得少（料钱差绝对值优先，其次面积差）
  rows.sort(
    (a, b) =>
      Math.abs(Math.round(b.dBoardCents)) - Math.abs(Math.round(a.dBoardCents)) ||
      Math.abs(b.dAreaMm2) - Math.abs(a.dAreaMm2) ||
      a.code.localeCompare(b.code)
  )

  const plan = buildReusePlan(rows, oldResult)

  // 按选定路线的落账成本：整批重排=全新−旧；留用=重排新板−省掉的重开旧板（混排板照旧切，不补不省）
  if (input.strategy === 'renest') {
    totals.ledgerBoardCents = totals.dBoardCentsExact
    totals.ledgerSheets = totals.dSheetsExact
  } else {
    const backCutCodes = new Set(plan.carryOverPieces.map((x) => x.code))
    const keptSet = new Set(plan.keptSheets)
    const subParts = newParts.filter(
      (p) => !backCutCodes.has(p.code) && !isWholeCodeOnKeptSheets(p.code, oldResult, keptSet)
    )
    const sub = nestJob({ ...job, parts: subParts, boards: nestBoards })
    const savedOldSheets = oldResult.sheets.filter((s) => plan.reopenSheets.includes(s.index))
    const savedCents = savedOldSheets.reduce((a, s) => a + s.priceCents, 0)
    totals.ledgerBoardCents = sub.totalCostCents - savedCents
    totals.ledgerSheets = sub.sheets.length - savedOldSheets.length
  }

  const checks = buildChecks({
    rows,
    totals,
    oldExact,
    newExact,
    oldResult,
    newResult,
    warnings
  })

  return {
    id: uid('rev'),
    createdAt: Date.now(),
    strategy: input.strategy,
    status: 'draft',
    newParts,
    newBoards: boards,
    workBoards: nestBoards,
    rows,
    totals,
    reuse: plan,
    checks,
    warnings,
    oldExact,
    newExact,
    signature: revisionSignature(job.parts, job.kerfMm, job.trimMm),
    newSignature: revisionSignature(newParts, job.kerfMm, job.trimMm)
  }
}

function zeroMetrics(boards: Board[]): PartMetrics {
  return {
    areaMm2: 0,
    sheetsEq: 0,
    cents: 0,
    edgeExposedM: 0,
    edgeNormalM: 0,
    pieces: 0,
    board: boards.find((b) => b.kind !== 'offcut') ?? boards[0]
  }
}

function isSameRule(o: MergedPart, n: MergedPart): boolean {
  return (
    normLen(o.lenMm) === normLen(n.lenMm) &&
    normLen(o.widMm) === normLen(n.widMm) &&
    normQty(o.qty) === normQty(n.qty) &&
    normGrain(o.grain) === normGrain(n.grain) &&
    JSON.stringify(normEdges(o.edgeBands).sort()) === JSON.stringify(normEdges(n.edgeBands).sort()) &&
    normExp(o.exposed) === normExp(n.exposed) &&
    (o.boardId ?? '') === (n.boardId ?? '')
  )
}

function cloneBoards(boards: Board[]): Board[] {
  return boards.map((b) => ({ ...b }))
}

/** 归并结果转 Part[]；保留旧件原 id（同件号连续改版时引用不断），新件用确定性 id。 */
function finalizeParts(map: Map<string, MergedPart>, boards: Board[], oldParts: Part[]): Part[] {
  const oldByCode = new Map(oldParts.map((p) => [p.code, p]))
  const out: Part[] = []
  for (const [code, m] of map) {
    const resolved = m.boardId && boards.some((b) => b.id === m.boardId) ? m.boardId : ''
    out.push({
      id: oldByCode.get(code)?.id ?? `rev_${codeHash(code)}`,
      code,
      name: m.name || code,
      lenMm: normLen(m.lenMm),
      widMm: normLen(m.widMm),
      qty: Math.max(0, normQty(m.qty)),
      grain: normGrain(m.grain),
      edgeBands: normEdges(m.edgeBands),
      cabinet: m.cabinet ?? '未分组',
      exposed: normExp(m.exposed),
      boardId: resolved
    })
  }
  return out
}

function roundTo(v: number, dec: number): number {
  const f = 10 ** dec
  return Math.round((v + Number.EPSILON) * f) / f
}

// ────────────────────────────── 核对（对不上要指出来） ──────────────────────────────

function buildChecks(args: {
  rows: RevRow[]
  totals: RevTotals
  oldExact: RevExactMetrics
  newExact: RevExactMetrics
  oldResult: NestResult
  newResult: NestResult
  warnings: string[]
}): RevisionReport['checks'] {
  const { rows, totals, oldExact, newExact, oldResult, newResult, warnings } = args
  const checks: RevisionReport['checks'] = []

  // 1) 逐项合计 = 合计行（行内不取整、合计行统一取整；舍入误差内必须相等）
  const rawSumCents = rows.reduce((a, r) => a + r.dBoardCents, 0)
  const sumCents = Math.round(rawSumCents)
  const sumEdgeExp = roundTo(rows.reduce((a, r) => a + r.dEdgeExposedM, 0), EDGE_DEC)
  const sumEdgeNorm = roundTo(rows.reduce((a, r) => a + r.dEdgeNormalM, 0), EDGE_DEC)
  const sumPieces = rows.reduce((a, r) => a + r.dPieces, 0)
  const sumEq = roundTo(
    rows.reduce((a, r) => a + r.dSheetsEq, 0),
    SHEET_EQ_DEC
  )
  const internalOk =
    sumCents === totals.dBoardCents &&
    Math.abs(sumEdgeExp - totals.dEdgeExposedM) < 0.005 &&
    Math.abs(sumEdgeNorm - totals.dEdgeNormalM) < 0.005 &&
    sumPieces === totals.dPieces &&
    Math.abs(sumEq - totals.dSheetsEq) < 0.0005 &&
    // 分账合计与逐行和一致（各板种差值合到总账）
    Math.abs(roundTo(totals.dSheetsByType.reduce((a, x) => a + x.dSheetsEq, 0), SHEET_EQ_DEC) - sumEq) < 0.0005
  checks.push({
    name: '逐项差值合计与总表一致',
    ok: internalOk,
    level: internalOk ? 'ok' : 'bad',
    detail: internalOk
      ? `料钱 ${sumCents} 分、见光封边 ${sumEdgeExp}m、非见光 ${sumEdgeNorm}m、件数 ${sumPieces}、折算 ${sumEq} 张，逐项相加=合计`
      : `对不上：逐项和（${sumCents}分/${sumEdgeExp}m/${sumEdgeNorm}m/${sumPieces}件/${sumEq}张）≠ 合计（${totals.dBoardCents}分/${totals.dEdgeExposedM}m/${totals.dEdgeNormalM}m/${totals.dPieces}件/${totals.dSheetsEq}张）`
  })

  // 2) 封边两口径核对：逐项和 vs 两版整单排样实算差（线性量，必须对得上，±0.02m 舍入）
  const exactEdgeExp = roundTo(newExact.edgeExposedM - oldExact.edgeExposedM, EDGE_DEC)
  const exactEdgeNorm = roundTo(newExact.edgeNormalM - oldExact.edgeNormalM, EDGE_DEC)
  const edgeOk =
    Math.abs(exactEdgeExp - totals.dEdgeExposedM) <= 0.02 &&
    Math.abs(exactEdgeNorm - totals.dEdgeNormalM) <= 0.02
  checks.push({
    name: '封边：逐项折算差与两版排样实算差对得上',
    ok: edgeOk,
    level: edgeOk ? 'ok' : 'bad',
    detail: `逐项 见光${signed(totals.dEdgeExposedM)}m/非见光${signed(totals.dEdgeNormalM)}m；实算 见光${signed(
      exactEdgeExp
    )}m/非见光${signed(exactEdgeNorm)}m`
  })

  // 3) 件数差两口径核对（五金口径），必须分毫不差
  const exactPieces = newExact.pieces - oldExact.pieces
  const piecesOk = exactPieces === totals.dPieces
  checks.push({
    name: '件数：逐项与两版实算一致（五金用量口径）',
    ok: piecesOk,
    level: piecesOk ? 'ok' : 'bad',
    detail: `逐项 ${signed(totals.dPieces)} 件，实算 ${signed(exactPieces)} 件`
  })

  // 4) 用板张数：折算口径 vs 排样实算（不同口径，差值必须显式指出）
  const sheetGap = roundTo(totals.dSheetsEq - totals.dSheetsExact, SHEET_EQ_DEC)
  checks.push({
    name: '用板：折算口径与排样实算口径差已标注',
    ok: true,
    level: Math.abs(sheetGap) < 1 ? 'ok' : 'warn',
    detail: `逐项折算 ${signed(totals.dSheetsEq)} 张（净面积/板毛面积，不含锯路修边损耗）；整单重排实算 ${signed(
      totals.dSheetsExact
    )} 张（${oldExact.boardsUsed}→${newExact.boardsUsed}）；口径差 ${signed(sheetGap)} 张，领料以实算整数张为准`
  })

  // 5) 料钱两口径差（折算未计排版损耗、余料板 0 元）
  const costGap = totals.dBoardCents - totals.dBoardCentsExact
  checks.push({
    name: '板材花费：折算口径与实算口径差已标注',
    ok: true,
    level: Math.abs(costGap) >= 10000 ? 'warn' : 'ok',
    detail: `逐项折算 ${signedC(totals.dBoardCents)}；实算 ${signedC(
      totals.dBoardCentsExact
    )}（${formatC(oldExact.totalCostCents)}→${formatC(newExact.totalCostCents)}）；口径差 ${signedC(
      costGap
    )}，成本表以实算为准`
  })

  // 6) 未排下：任一版排不下必须明确指出，不许当 0 蒙混
  const unplaced = [...oldResult.unplaced, ...newResult.unplaced]
  checks.push({
    name: '两版排样均无未排下件',
    ok: unplaced.length === 0,
    level: unplaced.length === 0 ? 'ok' : 'bad',
    detail:
      unplaced.length === 0
        ? '旧版、新版全部件均排下'
        : `存在未排下件：${unplaced.map((u) => `${u.code}×${u.qty}(${u.reason})`).join('；')}`
  })

  // 7) 归并/缺字段警告
  checks.push({
    name: '件号并条与缺字段',
    ok: warnings.length === 0,
    level: warnings.length === 0 ? 'ok' : 'warn',
    detail: warnings.length === 0 ? '无重复件号冲突，无缺字段' : `${warnings.length} 条：${warnings.join('；')}`
  })

  return checks
}

function signed(v: number): string {
  return v > 0 ? `+${v}` : `${v}`
}
function signedC(v: number): string {
  return v > 0 ? `+${formatC(v)}` : formatC(v)
}
function formatC(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`
}

// ────────────────────────────── 应用改版（二选一：整批重排 / 留用旧摆法） ──────────────────────────────

export interface ApplyResult {
  result: NestResult
  reopenedAll: boolean
}

/**
 * 应用改版。strategy 与核定时不同会先按新策略重算排样（两条路只能选一条）。
 * 旧版自动存档（metrics 独立留存，不被新版盖掉），此前已导出清单全部作废。
 */
export function applyRevision(
  job: Job,
  report: RevisionReport,
  strategy: RevStrategy
): ApplyResult {
  if (!job.result) throw new Error('旧版尚无排样结果，不能做改版应用')
  const boards = report.newBoards.map((b) => ({ ...b }))
  const workBoards = (report.workBoards ?? report.newBoards).map((b) => ({ ...b }))
  archiveCurrent(job, `改版应用（${strategy === 'renest' ? '整批重排' : '留用旧摆法'}）→ 第 ${(job.versionNo ?? 1) + 1} 版`)

  let result: NestResult
  let reopenedAll: boolean
  if (strategy === 'renest') {
    // 整批重排：干净，但旧摆法/刀路全废
    result = nestJob({ ...job, parts: report.newParts, boards: workBoards })
    result.sheets.forEach((s) => (s.provenance = 'reopen'))
    reopenedAll = true
  } else {
    // 留用旧摆法：未受影响的板原样保留，受影响件抽出与新增件一起重排
    result = buildReuseResult(job, report, workBoards)
    reopenedAll = false
  }

  job.parts = report.newParts.map((p) => ({ ...p }))
  job.boards = boards
  job.result = result
  job.versionNo = (job.versionNo ?? 1) + 1
  job.revision = { ...report, strategy, status: 'applied', appliedAt: Date.now() }
  // 旧版存档/已发清单一律作废，提示回退重发
  for (const e of job.exports ?? []) {
    if (!e.voided) {
      e.voided = true
      e.voidReason = `第 ${job.versionNo - 1} 版已改版，下料单作废，请按第 ${job.versionNo} 版重发`
    }
  }
  return { result, reopenedAll }
}

/**
 * 留用旧摆法：
 *  - 干净留用板（kept）：原样保留，板与刀路不重做；
 *  - 混排板（mixed）：旧板照旧切（刀路上多出几次回头切），受影响件在板上标废勿切，
 *    未受影响件按旧刀路切出可用；受影响件的用量改由新板补；
 *  - 整板重排（reopen）：板不开，受影响件 + 新增件一起重排到新板。
 */
function buildReuseResult(job: Job, report: RevisionReport, boards: Board[]): NestResult {
  const old = job.result!
  const plan = report.reuse
  const keptSet = new Set<number>(plan.keptSheets)
  const mixedSet = new Set<number>(plan.mixedSheets)
  const affected = new Set(plan.affectedCodes)
  const backCutCodes = new Set(plan.carryOverPieces.map((x) => x.code))

  // 重排用件 = 新版清单中，既不在干净留用板上、也不是混排板回头切件的部分
  const subParts = report.newParts.filter(
    (p) => !backCutCodes.has(p.code) && !isWholeCodeOnKeptSheets(p.code, old, keptSet)
  )
  const sub = nestJob({ ...job, parts: subParts, boards })

  // 干净留用板：原样深拷
  const keptSheets = old.sheets
    .filter((s) => keptSet.has(s.index))
    .map((s) => cloneSheet(s))
  keptSheets.forEach((s) => (s.provenance = 'kept'))

  // 混排板：整板照旧，受影响件标废（板已耗，料钱照计），其余回头切
  const mixedSheets = old.sheets
    .filter((s) => mixedSet.has(s.index))
    .map((s) => {
      const c = cloneSheet(s)
      c.provenance = 'mixed'
      for (const p of c.placements) {
        if (affected.has(p.code)) {
          p.void = true
          p.voidReason = '改版废弃件，本板照旧切时勿切/已标废，用量由新板补'
        }
      }
      return c
    })

  // 重排新板（受影响件 + 新增件）
  const newSheets = sub.sheets.map((s) => {
    const c = cloneSheet(s)
    c.provenance = 'reopen'
    return c
  })

  // 重新连续编号
  const sheets = [...keptSheets, ...mixedSheets, ...newSheets].map((s, i) => reindex(s, i))

  return assembleCombined(sheets, report, sub)
}

function isWholeCodeOnKeptSheets(code: string, old: NestResult, keptSet: Set<number>): boolean {
  return old.sheets
    .filter((s) => keptSet.has(s.index))
    .some((s) => s.placements.some((p) => p.code === code))
}

function cloneSheet(s: SheetResult): SheetResult {
  return JSON.parse(JSON.stringify(s)) as SheetResult
}

function reindex(s: SheetResult, i: number): SheetResult {
  return { ...s, index: i, placements: s.placements.map((p) => ({ ...p, boardIndex: i })) }
}

function assembleCombined(sheets: SheetResult[], report: RevisionReport, sub: NestResult): NestResult {
  const boardsByType: Record<string, number> = {}
  for (const s of sheets) boardsByType[s.boardName] = (boardsByType[s.boardName] ?? 0) + 1
  const totalCostCents = sheets.reduce((a, s) => a + s.priceCents, 0)
  const combinedBoards = sheets.length
  const baselineBoards = Math.max(report.newExact.boardsUsed, combinedBoards)
  const usedPrices = sheets.filter((s) => s.priceCents > 0).map((s) => s.priceCents)
  const avg = usedPrices.length ? usedPrices.reduce((a, b) => a + b, 0) / usedPrices.length : 0
  return {
    sheets,
    boardsUsed: combinedBoards,
    boardsByType,
    // 旧板照切 + 新板重切，覆盖新版全部件；封边按新版实际净尺寸（=核定实算那组数）
    edgeBandM: {
      exposed: report.newExact.edgeExposedM,
      normal: report.newExact.edgeNormalM
    },
    unplaced: sub.unplaced,
    baselineBoards,
    savedBoards: Math.max(0, baselineBoards - combinedBoards),
    savedCents: Math.round(Math.max(0, baselineBoards - combinedBoards) * avg),
    totalCostCents,
    // 留用路径下库存只按新开的重排板补采
    stockShortage: sub.stockShortage,
    elapsedMs: sub.elapsedMs,
    generatedAt: Date.now()
  }
}

// ────────────────────────────── 存档 / 回退 / 导出台账 ──────────────────────────────

export function metricsFromJob(job: Job): VersionArchive['metrics'] {
  const r = job.result
  return {
    boardsUsed: r?.boardsUsed ?? 0,
    totalCostCents: r?.totalCostCents ?? 0,
    edgeExposedM: r?.edgeBandM.exposed ?? 0,
    edgeNormalM: r?.edgeBandM.normal ?? 0,
    pieces: r ? r.sheets.reduce((a, s) => a + s.placements.length, 0) : 0
  }
}

export function archiveCurrent(job: Job, reason: string): void {
  if (!job.archives) job.archives = []
  const versionNo = job.versionNo ?? 1
  job.archives.forEach((a) => {
    if (a.status === 'active') a.status = 'superseded'
  })
  job.archives.unshift({
    versionNo,
    archivedAt: Date.now(),
    reason,
    label: `第 ${versionNo} 版`,
    parts: JSON.parse(JSON.stringify(job.parts)),
    boards: JSON.parse(JSON.stringify(job.boards)),
    kerfMm: job.kerfMm,
    trimMm: job.trimMm,
    useOffcutIds: [...job.useOffcutIds],
    batchByCabinet: job.batchByCabinet,
    result: job.result ? JSON.parse(JSON.stringify(job.result)) : undefined,
    metrics: metricsFromJob(job),
    status: 'active',
    revisionId: job.revision?.id
  })
}

/**
 * 回退到指定历史版本：当前版先存档；被回退版本期间发出的清单全部作废、提示重发。
 * 回退后 revision 核定失效（清单指纹已变），需要时重新核定。
 */
export function rollbackToVersion(job: Job, versionNo: number): void {
  const target = job.archives?.find((a) => a.versionNo === versionNo)
  if (!target) throw new Error(`找不到第 ${versionNo} 版存档`)
  archiveCurrent(job, `回退前自动存档（退回第 ${versionNo} 版）`)
  job.parts = JSON.parse(JSON.stringify(target.parts))
  job.boards = JSON.parse(JSON.stringify(target.boards))
  job.kerfMm = target.kerfMm
  job.trimMm = target.trimMm
  job.useOffcutIds = [...target.useOffcutIds]
  job.batchByCabinet = target.batchByCabinet
  job.result = target.result ? JSON.parse(JSON.stringify(target.result)) : undefined
  job.versionNo = versionNo
  job.revision = undefined
  job.archives?.forEach((a) => {
    a.status = a.versionNo === versionNo ? 'active' : a.versionNo > versionNo ? 'voided' : 'superseded'
  })
  for (const e of job.exports ?? []) {
    if (!e.voided && e.versionNo > versionNo) {
      e.voided = true
      e.voidReason = `已回退到第 ${versionNo} 版，该清单作废，请按第 ${versionNo} 版重发`
    }
  }
}

export function recordExport(
  job: Job,
  sections: string[]
): ExportRecord {
  if (!job.exports) job.exports = []
  const rec: ExportRecord = {
    id: uid('exp'),
    versionNo: job.versionNo ?? 1,
    sections,
    createdAt: Date.now(),
    voided: false
  }
  job.exports.unshift(rec)
  return rec
}

export function activeExports(job: Job): ExportRecord[] {
  return (job.exports ?? []).filter((e) => !e.voided)
}
