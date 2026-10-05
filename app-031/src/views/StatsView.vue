<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { getJob, activeRevisionReport, currentRevNo } from '../lib/store'
import boardsData from '../data/boards.json'
import { pct, money } from '../lib/format'
import { REPORT_PRECISION } from '../lib/revision'

const route = useRoute()
const job = computed(() => getJob(route.params.id as string))
const result = computed(() => job.value?.result)
const revReport = computed(() => (job.value ? activeRevisionReport(job.value) : null))
const revNo = computed(() => (job.value ? currentRevNo(job.value) : 0))

const delta = computed(() => revReport.value?.deltaTotals)
function signed(v: number, suffix = ''): string {
  return `${v > 0 ? '+' : ''}${v}${suffix}`
}
function signedFixed(v: number, digits: number, suffix = ''): string {
  return signed(Number(v.toFixed(digits)), suffix)
}
const deltaHardware = computed(() => {
  const d = delta.value
  if (!d) return []
  return [
    { name: boardsData.hardware.connectorName, value: signed(d.connectors, ' 套') },
    { name: boardsData.hardware.dowelName, value: signed(d.dowels, ' 个') },
    { name: boardsData.hardware.screwName, value: signed(d.screws, ' 颗') },
    { name: boardsData.hardware.glueName, value: signed(+((d.glueGrams / 1000).toFixed(REPORT_PRECISION.glueKg)), ' kg') }
  ]
})

const totalPieces = computed(
  () => result.value?.sheets.reduce((a, s) => a + s.placements.length, 0) ?? 0
)
const totalEdgeM = computed(
  () => (result.value?.edgeBandM.exposed ?? 0) + (result.value?.edgeBandM.normal ?? 0)
)
const hardware = computed(() => {
  const h = boardsData.hardware
  const n = totalPieces.value
  return [
    { name: h.connectorName, value: n * h.connectorPerPart, unit: '套' },
    { name: h.dowelName, value: n * h.dowelPerPart, unit: '个' },
    { name: h.screwName, value: n * h.screwPerPart, unit: '颗' },
    {
      name: h.glueName,
      value: Number(((totalEdgeM.value * h.glueGramPerEdgeMeter) / 1000).toFixed(2)),
      unit: 'kg'
    }
  ]
})

const usableOffcuts = computed(() => {
  const all = result.value?.sheets.flatMap((s, si) =>
    s.offcuts.filter((o) => o.usable).map((o) => ({ ...o, sheet: si + 1 }))
  ) ?? []
  return { list: all, area: all.reduce((a, o) => a + o.areaMm2, 0) }
})

const overallUtil = computed(() => {
  if (!result.value || result.value.sheets.length === 0) return 0
  const used = result.value.sheets.reduce((a, s) => a + s.usedAreaMm2, 0)
  const total = result.value.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  return total > 0 ? used / total : 0
})
const utilMinMax = computed(() => {
  const us = result.value?.sheets.map((s) => s.utilization) ?? []
  if (us.length === 0) return { min: 0, max: 0 }
  return { min: Math.min(...us), max: Math.max(...us) }
})
</script>

<template>
  <div v-if="job && result">
    <!-- 改版差值（与明细页/工单页同源，不在此页另算两版） -->
    <section v-if="revReport && delta" class="panel rev-delta">
      <div class="row" style="margin-bottom: 8px">
        <h3 style="font-size: 14px; margin: 0">第 {{ revNo }} 版改版差值（实际排样口径）</h3>
        <span class="tag">逐项对账 {{ revReport.costReconcileOk ? '已对平 ✅' : '不平 ❌' }}</span>
        <div class="spacer" />
        <router-link class="small" :to="`/revision/${job.id}`">查看逐项成本表 →</router-link>
      </div>
      <div class="delta-grid">
        <div class="d-box">
          <b :class="delta.actualBoardsUsed > 0 ? 'up' : delta.actualBoardsUsed < 0 ? 'down' : ''">
            {{ signed(delta.actualBoardsUsed, ' 张') }}
          </b>
          <span>用板：{{ revReport.oldTotals.actualBoardsUsed }} → {{ revReport.newTotals.actualBoardsUsed }}</span>
        </div>
        <div class="d-box">
          <b :class="delta.actualCostCents > 0 ? 'up' : delta.actualCostCents < 0 ? 'down' : ''">
            {{ signed(+(delta.actualCostCents / 100).toFixed(2), ' 元') }}
          </b>
          <span>板钱（实际）：{{ money(revReport.oldTotals.actualCostCents) }} → {{ money(revReport.newTotals.actualCostCents) }}</span>
        </div>
        <div class="d-box">
          <b :class="delta.edgeMm > 0 ? 'up' : delta.edgeMm < 0 ? 'down' : ''">
            {{ signedFixed(delta.edgeMm / 1000, REPORT_PRECISION.edgeM, ' m') }}
          </b>
          <span>封边：{{ (revReport.oldTotals.edgeMm / 1000).toFixed(2) }} → {{ (revReport.newTotals.edgeMm / 1000).toFixed(2) }} m</span>
        </div>
        <div class="d-box">
          <b :class="delta.pieces > 0 ? 'up' : delta.pieces < 0 ? 'down' : ''">{{ signed(delta.pieces, ' 件') }}</b>
          <span>零件总数</span>
        </div>
      </div>
      <p class="small muted" style="margin: 8px 0 0">
        折算毛口径（逐项可加）：用板 {{ signed(+delta.boardSheets.toFixed(REPORT_PRECISION.sheets), ' 张') }}、
        板钱（到分）{{ signed(Math.round(delta.boardCostCents), ' 分') }}；
        毛口径与实际口径的差为排样整数化/锯路损益，已在核定页对账列出。
      </p>
    </section>

    <!-- 师傅最关心的一句话 -->
    <section class="panel headline">
      <div class="hl-text">
        <h2>
          本方案用 <b>{{ result.boardsUsed }}</b> 张板，
          比随手排省 <b class="hl">{{ result.savedBoards }}</b> 张
          <span class="hl-money">约 {{ money(result.savedCents) }}</span>
        </h2>
        <p class="muted">
          朴素顺板需要 {{ result.baselineBoards }} 张（原清单顺序、不旋转、货架式摆法）；
          本方案综合利用率 {{ pct(overallUtil) }}，
          单板区间 {{ pct(utilMinMax.min) }} ~ {{ pct(utilMinMax.max) }}。
        </p>
      </div>
    </section>

    <div v-if="result.stockShortage.length > 0" class="alert">
      ⚠️ 需补采：
      <span v-for="s in result.stockShortage" :key="s.boardId">
        {{ s.boardName }} {{ s.need - s.have }} 张；
      </span>
    </div>

    <div class="stat-grid">
      <section class="panel">
        <h3>板材领料</h3>
        <table class="grid">
          <thead>
            <tr><th>板材</th><th>张数</th><th>单价</th><th>小计</th></tr>
          </thead>
          <tbody>
            <tr v-for="(n, name) in result.boardsByType" :key="name">
              <td>{{ name }}</td>
              <td>{{ n }}</td>
              <td>{{ money(result.sheets.find((x) => x.boardName === name)?.priceCents ?? 0) }}</td>
              <td>{{ money((result.sheets.find((x) => x.boardName === name)?.priceCents ?? 0) * Number(n)) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr><td colspan="3"><b>板材成本合计</b></td><td><b>{{ money(result.totalCostCents) }}</b></td></tr>
          </tfoot>
        </table>
        <p class="small muted" style="margin-top: 8px">排样计算耗时 {{ result.elapsedMs }}ms。</p>
      </section>

      <section class="panel">
        <h3>封边（按实际零件边长）</h3>
        <div class="edge-bars">
          <div class="edge-box">
            <b>{{ result.edgeBandM.exposed.toFixed(2) }} m</b>
            <span>见光边</span>
          </div>
          <div class="edge-box">
            <b>{{ result.edgeBandM.normal.toFixed(2) }} m</b>
            <span>非见光边</span>
          </div>
          <div class="edge-box total">
            <b>{{ totalEdgeM.toFixed(2) }} m</b>
            <span>合计</span>
          </div>
        </div>
        <p class="small muted">按零件开料后的实际净尺寸逐边累加（不含锯路）。</p>
      </section>

      <section class="panel">
        <h3>五金与胶量（按零件数估算）</h3>
        <table class="grid">
          <thead>
            <tr><th>辅料</th><th>本版用量</th><th v-if="revReport">改版差值</th></tr>
          </thead>
          <tbody>
            <tr v-for="(h, i) in hardware" :key="i">
              <td>{{ h.name }}</td>
              <td style="text-align: right; font-variant-numeric: tabular-nums">
                {{ h.value }} {{ h.unit }}
              </td>
              <td v-if="revReport" style="text-align: right" :class="deltaHardware[i]?.value.startsWith('+') || deltaHardware[i]?.value.startsWith('-') ? deltaHardware[i]?.value.startsWith('+') ? 'up' : 'down' : ''">
                {{ deltaHardware[i]?.value }}
              </td>
            </tr>
          </tbody>
        </table>
        <p class="small muted">共 {{ totalPieces }} 件零件。</p>
      </section>

      <section class="panel">
        <h3>可再利用余料（≥300×300mm）</h3>
        <p>{{ usableOffcuts.list.length }} 块，合计 {{ (usableOffcuts.area / 1e6).toFixed(2) }}m²</p>
        <table class="grid">
          <thead>
            <tr><th>所在板</th><th>尺寸(mm)</th><th>面积</th></tr>
          </thead>
          <tbody>
            <tr v-for="(o, i) in usableOffcuts.list.slice(0, 8)" :key="i">
              <td>第 {{ o.sheet }} 张</td>
              <td>{{ o.wMm }}×{{ o.hMm }}</td>
              <td>{{ (o.areaMm2 / 1e6).toFixed(2) }}m²</td>
            </tr>
          </tbody>
        </table>
        <router-link v-if="usableOffcuts.list.length > 0" :to="`/nest/${job.id}`" class="small">
          去排样页一键登记余料 →
        </router-link>
      </section>
    </div>
  </div>
  <div v-else class="panel empty">
    <p>该项目还没有排样结果。</p>
    <router-link :to="`/parts/${route.params.id}`"><button class="primary">去排样</button></router-link>
  </div>
</template>

<style scoped>
.rev-delta {
  margin-bottom: 14px;
  background: linear-gradient(135deg, #f0faf8, #fff);
  border-color: #9ad6c4;
}
.delta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
}
.d-box {
  background: #fff;
  border: 1px solid var(--c-line-soft);
  border-radius: 8px;
  padding: 10px 12px;
}
.d-box b {
  display: block;
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}
.d-box b.up {
  color: var(--c-bad);
}
.d-box b.down {
  color: var(--c-accent);
}
.d-box span {
  font-size: 11px;
  color: var(--c-ink-2);
}
.up {
  color: var(--c-bad);
}
.down {
  color: var(--c-accent);
}
.headline {
  margin-bottom: 14px;
  background: linear-gradient(135deg, #fff7ed, #fff);
}
.hl-text h2 {
  font-size: 19px;
}
.hl {
  color: var(--c-primary);
  font-size: 26px;
}
.hl-money {
  color: var(--c-primary);
  font-size: 15px;
  font-weight: 600;
}
.alert {
  background: #fffbeb;
  border: 1px solid #f0d9b5;
  color: #92600a;
  border-radius: 8px;
  padding: 9px 14px;
  margin-bottom: 12px;
  font-size: 13px;
}
.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
}
.stat-grid h3 {
  font-size: 14px;
  margin-bottom: 10px;
}
.edge-bars {
  display: flex;
  gap: 8px;
}
.edge-box {
  flex: 1;
  background: #f4f7f3;
  border-radius: 8px;
  padding: 12px;
  text-align: center;
}
.edge-box b {
  display: block;
  font-size: 19px;
}
.edge-box span {
  font-size: 12px;
  color: var(--c-ink-2);
}
.edge-box.total {
  background: #1f2a26;
  color: #fff;
}
.edge-box.total span {
  color: #9fb0a7;
}
.empty {
  text-align: center;
  padding: 50px;
}
</style>
