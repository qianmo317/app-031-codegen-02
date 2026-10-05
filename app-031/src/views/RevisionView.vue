<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  getJob,
  draftRevision,
  applyRevision,
  rollbackRevision,
  buildRevisionParts,
  currentRevNo,
  activeRevisionReport,
  activeExports,
  voidedExports
} from '../lib/store'
import { parsePartText, money } from '../lib/format'
import { toast } from '../lib/ui'
import { kindLabel, REPORT_PRECISION } from '../lib/revision'
import type { CostRow, NestResult, RevisionRecord, RevisionStrategy } from '../types'

const route = useRoute()
const router = useRouter()
const job = computed(() => getJob(route.params.id as string))

// 第一步：新版明细来源
const importText = ref('')
const parseErr = ref<string[]>([])
const strategy = ref<RevisionStrategy>('reuse')
const label = ref('')
const calculating = ref(false)

// 试算结果（内存态；三处页面同源的数据本体，未应用前不落库）
const draftRecord = ref<RevisionRecord | null>(null)
const draftResult = ref<NestResult | null>(null)
const draftNewParts = ref<ReturnType<typeof buildRevisionParts>>([])

const revNo = computed(() => (job.value ? currentRevNo(job.value) : 0))
const liveReport = computed(() => (job.value ? activeRevisionReport(job.value) : null))
const activeDocs = computed(() => (job.value ? activeExports(job.value) : []))
const voidDocs = computed(() => (job.value ? voidedExports(job.value) : []))

const report = computed(() => draftRecord.value?.report ?? liveReport.value)

function loadCurrentAsNew(): void {
  if (!job.value) return
  const grainCn = (g: string): string => (g === 'length' ? '竖纹' : g === 'width' ? '横纹' : '无')
  const edgeCn = (es: string[]): string => {
    const m: Record<string, string> = { top: '上', bottom: '下', left: '左', right: '右' }
    return es.map((e) => m[e] ?? '').join('')
  }
  importText.value = job.value.parts
    .map(
      (p) =>
        [p.code, p.name, p.lenMm, p.widMm, p.qty, grainCn(p.grain), edgeCn(p.edgeBands), p.cabinet, p.exposed ? '是' : '否'].join('\t')
    )
    .join('\n')
  toast('已把当前清单填入新版，改动后再核定', 'good')
}

async function calculate(): Promise<void> {
  const j = job.value
  if (!j) return
  if (!j.result) {
    toast('当前版本还没排过样，旧版没有可对比的用板/封边底数，请先排样', 'bad')
    return
  }
  parseErr.value = []
  let newParts = draftNewParts.value
  if (importText.value.trim()) {
    const { rows, errors } = parsePartText(importText.value)
    parseErr.value = errors
    if (rows.length === 0) {
      toast('新版明细没有可解析的行', 'bad')
      return
    }
    newParts = buildRevisionParts(j, rows)
  } else if (!newParts.length) {
    toast('请粘贴新版明细，或点「以当前清单为底」', 'bad')
    return
  }
  draftNewParts.value = newParts
  calculating.value = true
  try {
    await new Promise((r) => setTimeout(r, 30))
    const draft = draftRevision(j, {
      newParts,
      strategy: strategy.value,
      label: label.value || `第 ${currentRevNo(j) + 1} 版改图`
    })
    if (!draft) {
      toast('核定失败', 'bad')
      return
    }
    draftRecord.value = draft.record
    draftResult.value = draft.previewResult
    const rep = draft.record.report
    if (rep.costReconcileOk) toast('改版核定完成：逐项差值与两版总差已对平', 'good')
    else toast('核定完成但存在对账不平项，请看对账区红字', 'bad', 4000)
  } finally {
    calculating.value = false
  }
}

function apply(): void {
  const j = job.value
  if (!j || !draftRecord.value || !draftResult.value) return
  const rep = draftRecord.value.report
  const activeCount = activeDocs.value.length
  const msg =
    `应用后当前清单与排样将切到第 ${draftRecord.value.newRevNo} 版，旧版整版留档可回看。` +
    (activeCount > 0
      ? `本机台账里已有 ${activeCount} 份导出/下发清单将自动标记作废，需要到导出页重发。`
      : '') +
    (rep.reconcile.some((r) => !r.ok) ? '\n\n注意：存在对账不平项，仍要应用吗？' : '')
  if (!window.confirm(msg)) return
  applyRevision(j, draftRecord.value, draftResult.value, draftNewParts.value)
  toast(
    activeCount > 0
      ? `已切到新版，${activeCount} 份旧清单已作废，请重发下料单`
      : '已切到新版，旧版已留档',
    'good',
    3600
  )
  draftRecord.value = null
  draftResult.value = null
  importText.value = ''
}

function cancelDraft(): void {
  draftRecord.value = null
  draftResult.value = null
}

function rollback(rec: RevisionRecord): void {
  const j = job.value
  if (!j) return
  const reason = window.prompt(`回退第 ${rec.newRevNo} 版：作废原因（将写入台账并随重发清单说明）`, '客户取消该次改图，按上一版下料')
  if (reason === null) return
  rollbackRevision(j, rec.id, reason || '改图作废，回退上一版')
  toast('已回退：该版存档结果与已发清单均标记作废，当前恢复为上一版', 'good', 3600)
  if (draftRecord.value?.id === rec.id) cancelDraft()
}

// —— 展示辅助 ——
const d = report.value
const delta = computed(() => report.value?.deltaTotals)
const summaryRows = computed(() => {
  const r = report.value
  if (!r) return []
  const dt = r.deltaTotals
  return [
    { name: '用板张数（实际排样）', old: `${r.oldTotals.actualBoardsUsed} 张`, neu: `${r.newTotals.actualBoardsUsed} 张`, delta: signed(dt.actualBoardsUsed, ' 张'), bad: false },
    { name: '板材料钱（实际排样）', old: money(r.oldTotals.actualCostCents), neu: money(r.newTotals.actualCostCents), delta: moneyDelta(dt.actualCostCents), bad: false },
    { name: '用板张数（折算毛口径，逐项可加）', old: `${r.oldTotals.boardSheets.toFixed(REPORT_PRECISION.sheets)} 张`, neu: `${r.newTotals.boardSheets.toFixed(REPORT_PRECISION.sheets)} 张`, delta: signed(+dt.boardSheets.toFixed(REPORT_PRECISION.sheets), ' 张'), bad: false },
    { name: '封边·见光边', old: edgeM(r.oldTotals.edgeExposedMm), neu: edgeM(r.newTotals.edgeExposedMm), delta: signed(+(dt.edgeExposedMm / 1000).toFixed(REPORT_PRECISION.edgeM), ' m'), bad: false },
    { name: '封边·非见光边', old: edgeM(r.oldTotals.edgeNormalMm), neu: edgeM(r.newTotals.edgeNormalMm), delta: signed(+(dt.edgeNormalMm / 1000).toFixed(REPORT_PRECISION.edgeM), ' m'), bad: false },
    { name: '封边合计', old: edgeM(r.oldTotals.edgeMm), neu: edgeM(r.newTotals.edgeMm), delta: signed(+(dt.edgeMm / 1000).toFixed(REPORT_PRECISION.edgeM), ' m'), bad: false },
    { name: '三合一连接件', old: `${r.oldTotals.connectors} 套`, neu: `${r.newTotals.connectors} 套`, delta: signed(dt.connectors, ' 套'), bad: false },
    { name: '木榫', old: `${r.oldTotals.dowels} 个`, neu: `${r.newTotals.dowels} 个`, delta: signed(dt.dowels, ' 个'), bad: false },
    { name: '自攻螺丝', old: `${r.oldTotals.screws} 颗`, neu: `${r.newTotals.screws} 颗`, delta: signed(dt.screws, ' 颗'), bad: false },
    { name: '封边热熔胶', old: `${(r.oldTotals.glueGrams / 1000).toFixed(REPORT_PRECISION.glueKg)} kg`, neu: `${(r.newTotals.glueGrams / 1000).toFixed(REPORT_PRECISION.glueKg)} kg`, delta: signed(+((dt.glueGrams / 1000).toFixed(REPORT_PRECISION.glueKg)), ' kg'), bad: false },
    { name: '零件总件数', old: `${r.oldTotals.pieces} 件`, neu: `${r.newTotals.pieces} 件`, delta: signed(dt.pieces, ' 件'), bad: false }
  ]
})

function edgeM(mm: number): string {
  return `${(mm / 1000).toFixed(REPORT_PRECISION.edgeM)} m`
}
function signed(v: number, suffix: string): string {
  return `${v > 0 ? '+' : v < 0 ? '' : '±'}${v}${suffix}`
}
function moneyDelta(cents: number): string {
  const s = money(Math.abs(cents))
  return cents > 0 ? `+${s}` : cents < 0 ? `-${s}` : '±¥0.00'
}

const counts = computed(() => {
  const r = report.value
  if (!r) return { added: 0, removed: 0, changed: 0, unchanged: 0 }
  const c = { added: 0, removed: 0, changed: 0, unchanged: 0 }
  for (const row of r.rows) {
    if (row.kinds.includes('added')) c.added++
    else if (row.kinds.includes('removed')) c.removed++
    else if (row.kinds.length === 1 && row.kinds[0] === 'unchanged') c.unchanged++
    else c.changed++
  }
  return c
})

const costRows = computed(() => report.value?.rows ?? [])

function kindClass(row: CostRow): string {
  if (row.kinds.includes('added')) return 'k-added'
  if (row.kinds.includes('removed')) return 'k-removed'
  if (row.kinds.length === 1 && row.kinds[0] === 'unchanged') return 'k-same'
  return 'k-changed'
}

const filter = ref<'all' | 'affected' | 'cost'>('all')
const shownRows = computed(() => {
  if (filter.value === 'affected') return costRows.value.filter((r) => !(r.kinds.length === 1 && r.kinds[0] === 'unchanged'))
  if (filter.value === 'cost') return costRows.value.filter((r) => r.deltaCostRoundedCents !== 0)
  return costRows.value
})

const history = computed(() => job.value?.revisions ?? [])

function fmtSheet(v: number): string {
  return v.toFixed(REPORT_PRECISION.sheets)
}

function goExport(): void {
  if (job.value) router.push(`/export/${job.value.id}`)
}
function stateText(s: string): string {
  return s === 'kept' ? '整板留用' : s === 'mixed' ? '新旧混排·重开' : s === 'reopened' ? '整板重开' : '新版新开'
}
function numClass(text: string): string {
  return text.startsWith('+') ? 'up' : text.startsWith('-') ? 'down' : ''
}
void d
</script>

<template>
  <div v-if="job">
    <!-- 当前版本条 -->
    <section class="panel ver-bar">
      <div>
        <h2 style="font-size: 17px">改版影响核定</h2>
        <p class="muted small" style="margin: 4px 0 0">
          当前为 <b>第 {{ revNo }} 版{{ revNo === 0 ? '（原始版）' : '' }}</b>
          <template v-if="liveReport">· 基于「{{ liveReport.strategy === 'reuse' ? '留用旧摆法' : '整批重排' }}」核定</template>
          · 明细页 / 开料工单页 / 材料统计页共用本处算出的同一份差值
        </p>
      </div>
      <div class="spacer" />
      <router-link class="sm btn-like" :to="`/parts/${job.id}`">回零件清单</router-link>
    </section>

    <!-- 第 1 步：给新版 -->
    <section class="panel" style="margin-bottom: 14px">
      <h3 style="font-size: 14px">第 1 步｜放入客户改后的新版明细</h3>
      <p class="small muted">
        从 Excel 直接粘贴（制表符分隔），列同零件清单页：编号/名称/长/宽/数量/纹理(竖|横|无)/封边(上下左右)/柜体/见光。
        两版按<b>件号</b>认件；件号重复的行会按并件规矩合成一条（规格冲突的不并，单列异常）；缺失字段按空值处理，不臆造。
      </p>
      <textarea v-model="importText" rows="7" class="newbom" placeholder="编号	名称	长	宽	数量	纹理	封边	柜体	见光&#10;WR-M	衣柜门板	2180	446	4	竖纹	上下左右	衣柜	是"></textarea>
      <p v-for="(e, i) in parseErr" :key="i" class="small" style="color: var(--c-bad)">{{ e }}</p>
      <div class="row wrap" style="margin-top: 8px; align-items: flex-end">
        <label class="field" style="width: 220px">
          <span>新版说明（存档用）</span>
          <input v-model="label" :placeholder="`第 ${revNo + 1} 版改图`" />
        </label>
        <div class="strategy-box">
          <label class="strat" :class="{ on: strategy === 'reuse' }">
            <input type="radio" value="reuse" v-model="strategy" />
            <div>
              <b>留用旧摆法（推荐小改）</b>
              <span class="muted small">未变的板不动，只重开受影响板、把新版件插进空档；省工时省料，代价是新旧混排板要多几次回头切。</span>
            </div>
          </label>
          <label class="strat" :class="{ on: strategy === 'rerun' }">
            <input type="radio" value="rerun" v-model="strategy" />
            <div>
              <b>整批重排（大改选它）</b>
              <span class="muted small">摆法与刀路全部重算，结果最干净；代价是旧版已摆好的摆法/刀路（及已切板）全白做，多花一遍工时。</span>
            </div>
          </label>
        </div>
      </div>
      <div class="row" style="margin-top: 10px">
        <button class="sm" @click="loadCurrentAsNew">以当前清单为底填入</button>
        <div class="spacer" />
        <button class="primary" :disabled="calculating" @click="calculate">
          {{ calculating ? '核定计算中…' : '核定改版影响 →' }}
        </button>
      </div>
    </section>

    <template v-if="report">
      <!-- 一句话结论 -->
      <section class="panel headline">
        <h2 style="font-size: 16px; margin: 0 0 6px">
          这一改：实际用板
          <b :class="delta && delta.actualBoardsUsed > 0 ? 'up' : delta && delta.actualBoardsUsed < 0 ? 'down' : ''">
            {{ delta ? signed(delta.actualBoardsUsed, ' 张') : '' }}
          </b>，
          板钱
          <b :class="delta && delta.actualCostCents > 0 ? 'up' : delta && delta.actualCostCents < 0 ? 'down' : ''">
            {{ delta ? moneyDelta(delta.actualCostCents) : '' }}
          </b>，
          封边 <b>{{ delta ? signed(+(delta.edgeMm / 1000).toFixed(2), ' m') : '' }}</b>，
          零件 <b>{{ delta ? signed(delta.pieces, ' 件') : '' }}</b>
        </h2>
        <p class="small muted">
          认件结果：新增 {{ counts.added }} 件号 · 删除 {{ counts.removed }} · 内容变化 {{ counts.changed }} · 未变 {{ counts.unchanged }}。
          下方成本表按「差得多 → 差得少」排序。
        </p>
        <div v-if="report.warnings.length" class="warn-box">
          <div v-for="(w, i) in report.warnings" :key="i">⚠️ {{ w }}</div>
        </div>
      </section>

      <!-- 汇总（同一组数） -->
      <section class="panel" style="margin-bottom: 14px">
        <h3 style="font-size: 14px">两版汇总对比（材料统计页同一组数）</h3>
        <table class="grid">
          <thead>
            <tr><th>项目</th><th>旧版</th><th>新版</th><th>差值（新-旧）</th></tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in summaryRows" :key="i">
              <td>{{ r.name }}</td><td>{{ r.old }}</td><td>{{ r.neu }}</td>
              <td class="delta-cell" :class="numClass(r.delta)">{{ r.delta }}</td>
            </tr>
          </tbody>
        </table>
        <p class="small muted" style="margin-top: 8px">
          口径：长度 mm（输入取整）；封边换算 1m=1000mm，展示 {{ REPORT_PRECISION.edgeM }} 位小数；
          面积 1m²=1,000,000mm²，展示 {{ REPORT_PRECISION.areaM2 }} 位；用板折算张数展示 {{ REPORT_PRECISION.sheets }} 位；
          金额以「分」存储、展示到分（¥0.01）；胶 1kg=1000g，{{ REPORT_PRECISION.glueKg }} 位。
        </p>
      </section>

      <!-- 留用/重排取舍 + 工单 -->
      <section class="panel" style="margin-bottom: 14px">
        <h3 style="font-size: 14px">接下去怎么排（开料工单页同一结论）</h3>
        <p class="small" style="margin: 4px 0 8px">{{ report.strategyNote }}</p>
        <table class="grid">
          <thead>
            <tr><th>旧板</th><th>板种</th><th>处置</th><th>说明</th><th>留用件号</th><th>回头切</th></tr>
          </thead>
          <tbody>
            <tr v-for="(s, i) in report.sheetPlan" :key="i">
              <td>{{ s.oldSheetIndex !== null ? `第 ${s.oldSheetIndex + 1} 张` : '—' }}</td>
              <td>{{ s.boardName }}</td>
              <td><span class="state-tag" :class="s.state">{{ stateText(s.state) }}</span></td>
              <td class="small">{{ s.reason }}</td>
              <td class="small">{{ s.retainedCodes.slice(0, 6).join('、') }}{{ s.retainedCodes.length > 6 ? '…' : '' }}</td>
              <td>{{ s.extraBackCuts > 0 ? `+${s.extraBackCuts} 刀` : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- 逐件成本表 -->
      <section class="panel" style="margin-bottom: 14px">
        <div class="row" style="margin-bottom: 8px">
          <h3 style="font-size: 14px">逐件差值成本表</h3>
          <span class="tag">按料钱差绝对值降序</span>
          <div class="spacer" />
          <div class="seg">
            <button :class="{ on: filter === 'all' }" @click="filter = 'all'">全部</button>
            <button :class="{ on: filter === 'affected' }" @click="filter = 'affected'">只看改动</button>
            <button :class="{ on: filter === 'cost' }" @click="filter = 'cost'">只看料钱差</button>
          </div>
        </div>
        <div class="table-scroll">
          <table class="grid cost-table">
            <thead>
              <tr>
                <th>件号</th><th>名称</th><th>结论</th><th>变化说明</th>
                <th class="num">件数差</th>
                <th class="num">面积差(m²)</th>
                <th class="num">封边差(m)</th>
                <th class="num">折算板差(张)</th>
                <th class="num">料钱差</th>
                <th class="num">连接件差(套)</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in shownRows" :key="r.code" :class="kindClass(r)">
                <td><b>{{ r.code }}</b></td>
                <td class="small">{{ r.name }}</td>
                <td>
                  <span v-for="k in r.kinds" :key="k" class="kind-tag" :class="k">{{ kindLabel(k) }}</span>
                </td>
                <td class="small muted">{{ r.reasons.join('；') }}</td>
                <td class="num">{{ signed(r.delta.pieces, '') }}</td>
                <td class="num">{{ (r.delta.areaMm2 / 1e6).toFixed(REPORT_PRECISION.areaM2) }}</td>
                <td class="num">{{ ((r.delta.edgeExposedMm + r.delta.edgeNormalMm) / 1000).toFixed(REPORT_PRECISION.edgeM) }}</td>
                <td class="num">{{ fmtSheet(r.delta.boardSheets) }}</td>
                <td class="num" :class="r.deltaCostRoundedCents > 0 ? 'up' : r.deltaCostRoundedCents < 0 ? 'down' : ''">
                  {{ r.deltaCostRoundedCents > 0 ? '+' : '' }}{{ money(r.deltaCostRoundedCents).replace('¥', '¥') }}
                </td>
                <td class="num">{{ signed(r.delta.connectors, '') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 对账 -->
      <section class="panel" style="margin-bottom: 14px">
        <h3 style="font-size: 14px">对账（逐项差值合计 vs 两版合计之差）</h3>
        <table class="grid">
          <tbody>
            <tr v-for="(c, i) in report.reconcile" :key="i" :class="{ badrow: !c.ok }">
              <td style="width: 30px">{{ c.ok ? '✅' : '❌' }}</td>
              <td><b>{{ c.metric }}</b></td>
              <td class="small" :class="c.ok ? 'muted' : 'bad-text'">{{ c.detail }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!report.costReconcileOk" class="bad-text small" style="margin-top: 6px">
          存在对不上的项目：请勿据此下料，先修正上方警告里的缺字段/冲突件号后重新核定。
        </p>
      </section>

      <!-- 应用 -->
      <section v-if="draftRecord" class="panel apply-bar">
        <div>
          <b>核定的是尚未应用的草案。</b>
          <span class="muted small"> 应用后明细页/工单页/统计页全部切到这一版；旧版那组数原样留档，翻回旧版仍能看到当时的用板与封边。</span>
        </div>
        <div class="spacer" />
        <button @click="cancelDraft">放弃草案</button>
        <button class="primary" @click="apply">确认应用这一版 →</button>
      </section>
    </template>

    <!-- 导出/下发台账 -->
    <section class="panel" style="margin-bottom: 14px">
      <div class="row" style="margin-bottom: 8px">
        <h3 style="font-size: 14px">本机存档与下料单台账</h3>
        <div class="spacer" />
        <button class="sm" @click="goExport">去导出/打印下料单 →</button>
      </div>
      <p class="small muted" style="margin: 0 0 8px">
        已导出并下发的清单若被改版盖掉，会自动作废；重发用新文号，旧文号留痕。走错的版一旦存档并发单，在这里回退，旧结果与清单一并作废。
      </p>
      <table v-if="activeDocs.length || voidDocs.length" class="grid">
        <thead>
          <tr><th>文号</th><th>版号</th><th>导出时间</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="doc in activeDocs" :key="doc.id">
            <td><b>{{ doc.documentId }}</b></td>
            <td>第 {{ doc.revNo }} 版</td>
            <td class="small">{{ new Date(doc.at).toLocaleString('zh-CN') }}</td>
            <td><span class="state-tag kept">现行有效</span></td>
            <td class="small muted">当前版本文书</td>
          </tr>
          <tr v-for="doc in voidDocs" :key="doc.id" class="voidrow">
            <td><s>{{ doc.documentId }}</s></td>
            <td>第 {{ doc.revNo }} 版</td>
            <td class="small">{{ new Date(doc.at).toLocaleString('zh-CN') }}</td>
            <td><span class="state-tag reopened">已作废</span><span v-if="doc.supersededBy" class="small muted"> → 重发 {{ doc.supersededBy }}</span></td>
            <td class="small muted">{{ doc.voidReason }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="small muted">还没有导出记录。</p>
    </section>

    <!-- 改版档案 -->
    <section class="panel">
      <h3 style="font-size: 14px; margin-bottom: 8px">改版档案（旧版那组数留住，不被新版盖掉）</h3>
      <table v-if="history.length" class="grid">
        <thead>
          <tr><th>新版</th><th>说明</th><th>策略</th><th>核定时间</th><th>状态</th><th>旧底数（留档）</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="rec in history" :key="rec.id" :class="{ voidrow: rec.rolledBack }">
            <td><b>第 {{ rec.newRevNo }} 版</b><span class="small muted">（自第 {{ rec.baseRevNo }} 版）</span></td>
            <td>{{ rec.label }}</td>
            <td>{{ rec.strategy === 'reuse' ? '留用旧摆法' : '整批重排' }}</td>
            <td class="small">{{ new Date(rec.createdAt).toLocaleString('zh-CN') }}</td>
            <td>
              <span v-if="rec.rolledBack" class="state-tag reopened">已回退作废</span>
              <span v-else-if="rec.applied && job.activeRevisionId === rec.id" class="state-tag kept">当前版</span>
              <span v-else class="state-tag mixed">已归档（旧版）</span>
            </td>
            <td class="small muted">
              {{ rec.oldSnapshot.result?.boardsUsed ?? '—' }} 张板 ·
              封边 {{ rec.oldSnapshot.result ? ((rec.oldSnapshot.result.edgeBandM.exposed + rec.oldSnapshot.result.edgeBandM.normal).toFixed(2)) : '—' }}m ·
              {{ money(rec.oldSnapshot.result?.totalCostCents ?? 0) }}
            </td>
            <td>
              <button v-if="rec.applied && !rec.rolledBack && job.activeRevisionId === rec.id" class="sm ghost-danger" @click="rollback(rec)">回退到第 {{ rec.baseRevNo }} 版</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="small muted">还没有改版记录。</p>
      <p class="small muted" style="margin-top: 8px">
        回退会把当前清单与排样恢复成旧版留底（不是重算），并把这一版已导出的清单标记作废；请随后重发下料单。
      </p>
    </section>
  </div>
</template>

<style scoped>
.ver-bar {
  display: flex;
  align-items: center;
  margin-bottom: 14px;
}
.btn-like {
  border: 1px solid var(--c-line);
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 12px;
  text-decoration: none;
}
.newbom {
  width: 100%;
  font-family: ui-monospace, Menlo, monospace;
  font-size: 12px;
}
.strategy-box {
  display: flex;
  gap: 8px;
  flex: 1;
  min-width: 280px;
}
.strat {
  flex: 1;
  display: flex;
  gap: 8px;
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 8px 10px;
  cursor: pointer;
  background: #fff;
}
.strat.on {
  border-color: var(--c-primary);
  background: #fff7ed;
}
.strat b {
  font-size: 13px;
  display: block;
}
.headline {
  background: linear-gradient(135deg, #f0faf8, #fff);
}
.headline b.up {
  color: var(--c-bad);
}
.headline b.down {
  color: var(--c-accent);
}
.warn-box {
  border: 1px solid #f0d9b5;
  background: #fffbeb;
  color: #92600a;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
  margin-top: 8px;
}
.delta-cell,
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.up {
  color: var(--c-bad);
}
.down {
  color: var(--c-accent);
}
.bad-text {
  color: var(--c-bad);
}
.badrow {
  background: #fef2f2;
}
.state-tag {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11px;
  font-weight: 600;
}
.state-tag.kept {
  background: #e7f6ee;
  color: #15803d;
}
.state-tag.mixed {
  background: #fef3c7;
  color: #92400e;
}
.state-tag.reopened {
  background: #fee2e2;
  color: #b91c1c;
}
.state-tag.new {
  background: #e0e7ff;
  color: #3730a3;
}
.kind-tag {
  display: inline-block;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 10px;
  margin: 1px 2px 1px 0;
  border: 1px solid var(--c-line);
  background: #f4f7f3;
}
.kind-tag.added {
  background: #dcfce7;
  border-color: #86efac;
}
.kind-tag.removed {
  background: #fee2e2;
  border-color: #fca5a5;
}
.kind-tag.size,
.kind-tag.qty,
.kind-tag.grain,
.kind-tag.edge,
.kind-tag.board {
  background: #fef9c3;
  border-color: #fde047;
}
.table-scroll {
  overflow-x: auto;
}
.cost-table {
  font-size: 12px;
}
.cost-table td,
.cost-table th {
  padding: 4px 8px;
}
tr.k-removed {
  background: #fff7f7;
}
tr.k-added {
  background: #f4fdf6;
}
tr.k-same {
  color: var(--c-ink-2);
}
.seg {
  display: inline-flex;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  overflow: hidden;
}
.seg button {
  border: none;
  background: #fff;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.seg button.on {
  background: #1f2a26;
  color: #fff;
}
.apply-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #fff7ed;
  border-color: #fdba74;
}
.voidrow {
  opacity: 0.7;
}
.field span {
  font-size: 12px;
  color: var(--c-ink-2);
}
</style>
