<script setup lang="ts">
import { computed } from 'vue'
import { printState } from '../lib/print'
import { getJob } from '../lib/store'
import boardsData from '../data/boards.json'
import SheetDiagram from './SheetDiagram.vue'
import { money, mm } from '../lib/format'

const job = computed(() => (printState.jobId ? getJob(printState.jobId) : undefined))
const sections = computed(() => new Set(printState.sections))
const now = computed(() => new Date().toLocaleString('zh-CN'))

const allInstances = computed(() => {
  if (!job.value?.result) return []
  // 改版混排板上的标废件不再列入下料/标签，避免车间切到废弃件
  return job.value.result.sheets.flatMap((s) => s.placements.filter((p) => !p.void))
})
const voidInstances = computed(() => {
  if (!job.value?.result) return []
  return job.value.result.sheets.flatMap((s) => s.placements.filter((p) => p.void))
})
const revision = computed(() => job.value?.revision)
function sgn(v: number): string {
  return v > 0 ? `+${v}` : `${v}`
}
function sgnMoney(c: number): string {
  return c > 0 ? `+${money(c)}` : money(c)
}
const provenanceText: Record<string, string> = {
  kept: '旧单留用（刀路不变）',
  mixed: '混排照旧切（红叉件标废勿切，其余回头切）',
  reopen: '改版重开新单'
}

interface OrderRow {
  code: string
  name: string
  origLen: number
  origWid: number
  qty: number
  grain: string
  edgeCount: number
  exposed: boolean
}
const cabinetGroups = computed(() => {
  const map = new Map<string, OrderRow[]>()
  for (const p of allInstances.value) {
    const arr = map.get(p.cabinet) ?? []
    const cur = arr.find((r) => r.code === p.code)
    if (cur) cur.qty++
    else
      arr.push({
        code: p.code,
        name: p.name,
        origLen: p.origLen,
        origWid: p.origWid,
        qty: 1,
        grain: p.grain,
        edgeCount: p.edgeBands.length,
        exposed: p.exposed
      })
    map.set(p.cabinet, arr)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))
})

const grainText = (g: string): string =>
  g === 'length' ? '竖纹' : g === 'width' ? '横纹' : '无要求'

const boardByName = (name: string) =>
  job.value?.result?.sheets.find((x) => x.boardName === name)
</script>

<template>
  <div v-if="job" class="print-doc print-only">
    <!-- 改版影响核定页（三处同源那组数；已应用后随下料单一并发出） -->
    <div v-if="revision && sections.has('order')">
      <section class="print-page">
        <h2>改版影响核定 · 第 {{ job.versionNo ?? 1 }} 版</h2>
        <p class="doc-meta">
          项目：{{ job.name }} ｜ 核定时间：{{ new Date(revision.createdAt).toLocaleString('zh-CN') }} ｜
          路线：{{ revision.strategy === 'renest' ? '整批重排（旧摆法/刀路全废）' : '留用旧摆法（混排板回头切）' }}
        </p>
        <table class="pgrid">
          <thead>
            <tr><th>项目</th><th>旧版</th><th>新版</th><th>差值（新−旧）</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>用板张数（领料实算）</td>
              <td>{{ revision.oldExact.boardsUsed }}</td>
              <td>{{ revision.newExact.boardsUsed }}</td>
              <td><b>{{ sgn(revision.totals.dSheetsExact) }} 张</b></td>
            </tr>
            <tr>
              <td>板材花费</td>
              <td>{{ money(revision.oldExact.totalCostCents) }}</td>
              <td>{{ money(revision.newExact.totalCostCents) }}</td>
              <td><b>{{ sgnMoney(revision.totals.dBoardCentsExact) }}</b></td>
            </tr>
            <tr>
              <td>见光边封边(m)</td>
              <td>{{ revision.oldExact.edgeExposedM.toFixed(2) }}</td>
              <td>{{ revision.newExact.edgeExposedM.toFixed(2) }}</td>
              <td>{{ sgn(revision.totals.dEdgeExposedM) }}</td>
            </tr>
            <tr>
              <td>非见光边封边(m)</td>
              <td>{{ revision.oldExact.edgeNormalM.toFixed(2) }}</td>
              <td>{{ revision.newExact.edgeNormalM.toFixed(2) }}</td>
              <td>{{ sgn(revision.totals.dEdgeNormalM) }}</td>
            </tr>
            <tr v-for="h in revision.totals.dHardware" :key="h.name">
              <td>{{ h.name }}</td><td>—</td><td>—</td>
              <td>{{ sgn(h.value) }} {{ h.unit }}</td>
            </tr>
          </tbody>
        </table>
        <h3>工单处置（与明细页、统计页同源）</h3>
        <table class="pgrid">
          <tbody>
            <tr>
              <td>旧单留用</td>
              <td>{{ revision.reuse.keptSheets.length }} 张 / {{ revision.reuse.keptPieces }} 件，板与刀路不动</td>
            </tr>
            <tr>
              <td>混排照旧切</td>
              <td>{{ revision.reuse.mixedSheets.length }} 张；{{ revision.reuse.backCutPieces }} 件回头切（返机 {{ revision.reuse.extraBackCuts }} 次），{{ revision.reuse.voidPieces }} 件标废勿切</td>
            </tr>
            <tr>
              <td>必须重开</td>
              <td>{{ revision.strategy === 'renest' ? '整批全部重开' : `${revision.reuse.reopenSheets.length} 张 / ${revision.reuse.reopenPieces} 件 + 新增件` }}</td>
            </tr>
          </tbody>
        </table>
        <p class="doc-meta" style="margin-top: 6px">
          单位精度：长度 mm；面积 m² 两位；封边 m 两位（净边长）；折算张三位（净面积/板毛面积）；
          金额元取到分。领料与成本以整单重排实算为准；逐项折算合计已与总表核对一致。
        </p>
      </section>
    </div>

    <!-- 排样图 -->
    <div v-if="sections.has('nest')">
      <section
        v-for="s in job.result?.sheets ?? []"
        :key="'pn' + s.index"
        class="print-page"
      >
        <h2>
          排样图 · 第 {{ s.index + 1 }} 张 / 共 {{ job.result?.sheets.length }} 张
          <span v-if="s.provenance" class="prov-badge" :class="s.provenance">
            {{ provenanceText[s.provenance] }}
          </span>
        </h2>
        <p class="doc-meta">
          {{ s.boardName }}（{{ s.material }} {{ s.thicknessMm }}mm） · 尺寸
          {{ s.wMm }}×{{ s.hMm }}mm · 利用率 {{ (s.utilization * 100).toFixed(1) }}% ·
          锯路 {{ job.kerfMm }}mm · 修边 {{ job.trimMm }}mm ·
          版本 第 {{ job.versionNo ?? 1 }} 版
        </p>
        <div class="print-sheet-wrap">
          <SheetDiagram :sheet="s" :show-cuts="false" print-mode />
        </div>
        <table class="pgrid">
          <thead>
            <tr>
              <th>序号</th><th>编号</th><th>名称</th><th>柜体</th>
              <th>尺寸(mm)</th><th>纹理</th><th>封边</th><th>见光</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in s.placements" :key="p.instanceId" :class="{ 'void-row': p.void }">
              <td>{{ p.seq }}</td>
              <td>{{ p.code }}{{ p.void ? '（废）' : '' }}</td>
              <td>{{ p.name }}</td>
              <td>{{ p.cabinet }}</td>
              <td>{{ mm(p.origLen) }}×{{ mm(p.origWid) }}</td>
              <td>{{ grainText(p.grain) }}</td>
              <td>{{ p.edgeBands.length }} 边</td>
              <td>{{ p.exposed ? '是' : '' }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 裁切步骤表 -->
    <div v-if="sections.has('cut')">
      <section
        v-for="s in job.result?.sheets ?? []"
        :key="'pc' + s.index"
        class="print-page"
      >
        <h2>
          裁切步骤表 · 第 {{ s.index + 1 }} 张（{{ s.boardName }}）
          <span v-if="s.provenance" class="prov-badge" :class="s.provenance">{{ provenanceText[s.provenance] }}</span>
        </h2>
        <p class="doc-meta">
          按顺序下锯；同向刀已连续排程（减少推台翻转）；修边刀可多板叠切。
          <template v-if="s.placements.some((p) => p.void)">本板含改版标废件，下锯跳过标废位置。</template>
        </p>
        <table class="pgrid">
          <thead>
            <tr><th>刀序</th><th>类型</th><th>方向</th><th>位置(mm)</th><th>贯通区间(mm)</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="st in s.steps" :key="st.order">
              <td>{{ st.order + 1 }}</td>
              <td>{{ st.kind === 'trim' ? '修边' : '裁切' }}</td>
              <td>{{ st.axis === 'v' ? '竖刀' : '横刀' }}</td>
              <td>{{ Math.round(st.at) }}</td>
              <td>{{ st.span[0] }} ~ {{ st.span[1] }}</td>
              <td>{{ st.label }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 下料单 / 领料单 -->
    <div v-if="sections.has('order')">
      <section class="print-page">
        <h2>下料单 / 领料单（第 {{ job.versionNo ?? 1 }} 版）</h2>
        <p class="doc-meta">
          项目：{{ job.name }} ｜ 版本：第 {{ job.versionNo ?? 1 }} 版 ｜ 打印时间：{{ now }}
          <template v-if="revision"> ｜ 改版路线：{{ revision.strategy === 'renest' ? '整批重排' : '留用旧摆法' }}</template>
        </p>

        <h3>一、板材领料</h3>
        <table class="pgrid">
          <thead>
            <tr><th>板材</th><th>规格(mm)</th><th>厚度</th><th>张数</th><th>单价</th><th>小计</th></tr>
          </thead>
          <tbody>
            <tr v-for="(n, name) in job.result?.boardsByType" :key="name">
              <td>{{ name }}</td>
              <td>{{ boardByName(String(name))?.wMm }}×{{ boardByName(String(name))?.hMm }}</td>
              <td>{{ boardByName(String(name))?.thicknessMm }}</td>
              <td>{{ n }}</td>
              <td>{{ money(boardByName(String(name))?.priceCents ?? 0) }}</td>
              <td>{{ money((boardByName(String(name))?.priceCents ?? 0) * Number(n)) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="5">板材合计</td>
              <td>{{ money(job.result?.totalCostCents ?? 0) }}</td>
            </tr>
          </tfoot>
        </table>

        <h3>二、零件明细（按柜体分拣）</h3>
        <div v-for="[cab, list] in cabinetGroups" :key="cab" class="avoid-break">
          <h4>柜体/房间：{{ cab }}（{{ list.reduce((a, r) => a + r.qty, 0) }} 件）</h4>
          <table class="pgrid">
            <thead>
              <tr><th>编号</th><th>名称</th><th>尺寸(mm)</th><th>数量</th><th>纹理</th><th>封边</th><th>见光</th></tr>
            </thead>
            <tbody>
              <tr v-for="g in list" :key="g.code">
                <td>{{ g.code }}</td>
                <td>{{ g.name }}</td>
                <td>{{ mm(g.origLen) }}×{{ mm(g.origWid) }}</td>
                <td>{{ g.qty }}</td>
                <td>{{ grainText(g.grain) }}</td>
                <td>{{ g.edgeCount }} 边</td>
                <td>{{ g.exposed ? '是' : '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 v-if="voidInstances.length > 0" style="color: #991b1b">三、混排板标废件（下锯跳过，勿发料）</h3>
        <table v-if="voidInstances.length > 0" class="pgrid" style="margin-bottom: 8px">
          <thead>
            <tr><th>件号</th><th>名称</th><th>所在板</th><th>尺寸(mm)</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="(p, i) in voidInstances" :key="'v' + i" class="void-row">
              <td>{{ p.code }}</td>
              <td>{{ p.name }}</td>
              <td>第 {{ p.boardIndex + 1 }} 张</td>
              <td>{{ mm(p.origLen) }}×{{ mm(p.origWid) }}</td>
              <td>{{ p.voidReason ?? '改版废弃件' }}</td>
            </tr>
          </tbody>
        </table>

        <h3>四、封边与五金辅料</h3>
        <table class="pgrid">
          <tbody>
            <tr><td>见光边封边</td><td>{{ job.result?.edgeBandM.exposed }} m</td></tr>
            <tr><td>非见光边封边</td><td>{{ job.result?.edgeBandM.normal }} m</td></tr>
            <tr><td>{{ boardsData.hardware.connectorName }}</td><td>{{ allInstances.length * boardsData.hardware.connectorPerPart }}</td></tr>
            <tr><td>{{ boardsData.hardware.dowelName }}</td><td>{{ allInstances.length * boardsData.hardware.dowelPerPart }}</td></tr>
            <tr><td>{{ boardsData.hardware.screwName }}</td><td>{{ allInstances.length * boardsData.hardware.screwPerPart }}</td></tr>
            <tr>
              <td>{{ boardsData.hardware.glueName }}</td>
              <td>{{ ((((job.result?.edgeBandM.exposed ?? 0) + (job.result?.edgeBandM.normal ?? 0)) * boardsData.hardware.glueGramPerEdgeMeter) / 1000).toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 标签（A4 不干胶，每块一张） -->
    <div v-if="sections.has('labels')">
      <section class="print-page labels-page">
        <div
          v-for="(p, i) in allInstances"
          :key="'lb' + i"
          class="label-card avoid-break"
        >
          <div class="lb-code">{{ p.code }} <span class="lb-seq">#{{ p.seq }}</span></div>
          <div class="lb-name">{{ p.name }}</div>
          <div class="lb-dims">{{ mm(p.origLen) }} × {{ mm(p.origWid) }} mm</div>
          <div class="lb-meta">{{ p.cabinet }} ｜ {{ grainText(p.grain) }} ｜ 封边 {{ p.edgeBands.length }} 边{{ p.exposed ? ' ｜ 见光' : '' }}</div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.print-doc {
  color: #000;
  font-size: 12px;
}
.print-doc h2 {
  font-size: 17px;
  margin-bottom: 6px;
}
.print-doc h3 {
  font-size: 14px;
  margin: 14px 0 6px;
}
.print-doc h4 {
  font-size: 13px;
  margin: 10px 0 4px;
}
.doc-meta {
  color: #333;
  margin: 0 0 8px;
  font-size: 11px;
}
.prov-badge {
  font-size: 11px;
  font-weight: 400;
  border: 1px solid;
  border-radius: 3px;
  padding: 1px 5px;
  margin-left: 8px;
}
.prov-badge.kept {
  color: #166534;
  border-color: #166534;
}
.prov-badge.mixed {
  color: #92600a;
  border-color: #92600a;
}
.prov-badge.reopen {
  color: #991b1b;
  border-color: #991b1b;
}
table.pgrid tr.void-row {
  background: #f3d9d9 !important;
  color: #991b1b;
  text-decoration: line-through;
}
.print-sheet-wrap {
  border: 1px solid #888;
  padding: 6px;
  margin-bottom: 10px;
}
table.pgrid {
  width: 100%;
  border-collapse: collapse;
  font-size: 10.5px;
}
table.pgrid th,
table.pgrid td {
  border: 1px solid #555;
  padding: 2.5px 5px;
  text-align: left;
}
table.pgrid th {
  background: #eee;
}
.labels-page {
  display: grid;
  grid-template-columns: repeat(2, 94mm);
  gap: 4mm 6mm;
  justify-content: center;
}
.label-card {
  border: 1.5px solid #000;
  border-radius: 3px;
  padding: 3mm 3.5mm;
  height: 38mm;
  overflow: hidden;
}
.lb-code {
  font-size: 15px;
  font-weight: 700;
}
.lb-seq {
  font-weight: 400;
  font-size: 11px;
}
.lb-name {
  font-size: 12px;
  margin: 1mm 0;
}
.lb-dims {
  font-size: 18px;
  font-weight: 700;
  margin: 1mm 0;
}
.lb-meta {
  font-size: 10.5px;
}
</style>
