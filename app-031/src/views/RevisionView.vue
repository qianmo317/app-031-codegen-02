<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  getJob,
  createRevision,
  applyRevision,
  setRevisionStrategy,
  clearRevision,
  rollbackJob
} from '../lib/store'
import { parseRevisionText, revisionSignature } from '../lib/revision'
import { money } from '../lib/format'
import { toast } from '../lib/ui'
import type { RevRow } from '../types'

const route = useRoute()
const router = useRouter()
const job = computed(() => getJob(route.params.id as string))
const report = computed(() => job.value?.revision)

const inputMode = ref<'paste' | 'current'>('paste')
const pasteText = ref('')
const parseErrors = ref<string[]>([])
const strategy = ref<'renest' | 'reuse'>('reuse')
const applying = ref(false)
const showArchives = ref(false)

const stale = computed(() => {
  const j = job.value
  const r = report.value
  if (!j || !r || r.status === 'applied') return false
  return revisionSignature(j.parts, j.kerfMm, j.trimMm) !== r.signature
})

const changedRows = computed(() => report.value?.rows.filter((r) => r.kind !== 'same') ?? [])
const sortedRows = computed(() => report.value?.rows ?? [])

const kindLabel: Record<RevRow['kind'], string> = {
  added: '新增',
  removed: '删除',
  changed: '修改',
  same: '未变'
}

function prefIllNew(): string {
  const j = job.value
  if (!j) return ''
  const head = ['件号', '名称', '长', '宽', '数量', '纹理', '封边', '柜体', '见光'].join('\t')
  const grain = (g: string) => (g === 'length' ? '竖纹' : g === 'width' ? '横纹' : '无')
  const edgeMap: Record<string, string> = { top: '上', bottom: '下', left: '左', right: '右' }
  const lines = j.parts.map((p) =>
    [
      p.code,
      p.name,
      p.lenMm,
      p.widMm,
      p.qty,
      grain(p.grain),
      p.edgeBands.map((e) => edgeMap[e]).join(''),
      p.cabinet,
      p.exposed ? '是' : '否'
    ].join('\t')
  )
  return [head, ...lines].join('\n')
}

function doAnalyze(): void {
  const j = job.value
  if (!j) return
  if (!j.result) {
    toast('旧版还没有排样结果，请先排样再做改版核定', 'bad')
    return
  }
  let rows
  if (inputMode.value === 'current') {
    rows = parseRevisionText(prefIllNew()).rows
  } else {
    if (!pasteText.value.trim()) {
      toast('请粘贴新版板件明细', 'bad')
      return
    }
    const parsed = parseRevisionText(pasteText.value)
    rows = parsed.rows
    parseErrors.value = parsed.errors
    if (rows.length === 0) {
      toast('没有解析出有效行', 'bad')
      return
    }
  }
  const r = createRevision(j, rows, strategy.value)
  toast(
    `核定完成：新增 ${r.rows.filter((x) => x.kind === 'added').length}、删除 ${
      r.rows.filter((x) => x.kind === 'removed').length
    }、修改 ${r.rows.filter((x) => x.kind === 'changed').length}；${
      strategy.value === 'reuse' ? '留用路线落账' : '整批重排'
    }用板 ${signedNum(r.totals.ledgerSheets ?? r.totals.dSheetsExact)} 张、料钱 ${signedMoney(
      r.totals.ledgerBoardCents ?? r.totals.dBoardCentsExact
    )}`,
    r.checks.some((c) => c.level === 'bad') ? 'bad' : 'good',
    4200
  )
}

function chooseStrategy(s: 'renest' | 'reuse'): void {
  strategy.value = s
  if (job.value && report.value) setRevisionStrategy(job.value, s)
}

function doApply(): void {
  const j = job.value
  const r = report.value
  if (!j || !r) return
  if (stale.value) {
    toast('清单在核定后又被改动，核定已过期，请重新核定', 'bad')
    return
  }
  const s = strategy.value
  const tip =
    s === 'renest'
      ? `整批重排：旧摆法与刀路全部作废，结果干净，但已排好的工时与已切料全部白费；料钱变化 ${signedMoney(
          r.totals.dBoardCentsExact
        )}（${money(r.oldExact.totalCostCents)}→${money(r.newExact.totalCostCents)}）。确认应用？`
      : `留用旧摆法：${r.reuse.keptSheets.length} 张干净留用、${r.reuse.mixedSheets.length} 张混排板照旧切（${r.reuse.extraBackCuts} 次回头切、标废 ${r.reuse.voidPieces} 件）、重开 ${r.reuse.reopenSheets.length} 张；落账料钱变化 ${signedMoney(
          r.totals.ledgerBoardCents ?? 0
        )}、净 ${signedNum(r.totals.ledgerSheets ?? 0)} 张板。确认应用？`
  if (!window.confirm(tip)) return
  applying.value = true
  try {
    applyRevision(j, s)
    toast(`已按第 ${j.versionNo} 版落库；旧版已存档，旧下料单已作废，请重发`, 'good', 4200)
    router.push(`/nest/${j.id}`)
  } catch (e) {
    toast((e as Error).message, 'bad')
  } finally {
    applying.value = false
  }
}

function discardDraft(): void {
  const j = job.value
  if (!j || !report.value) return
  if (window.confirm('放弃本次改版核定？（旧版清单与排样不动）')) {
    clearRevision(j)
    toast('核定已作废，旧版保持不变')
  }
}

function startNextRevision(): void {
  // 已应用的核定归档为历史，下一轮以当前版（已落库的新版）为旧版重新核定
  if (job.value) job.value.revision = undefined
  inputMode.value = 'current'
  pasteText.value = prefIllNew()
  strategy.value = 'reuse'
  toast('已以当前版作为旧版，请粘贴下一版明细后重新核定', 'info', 3200)
}

function doRollback(versionNo: number): void {
  const j = job.value
  if (!j) return
  if (
    window.confirm(
      `回退到第 ${versionNo} 版？当前版会先存档；该版之后已发出的下料单全部作废，需要按第 ${versionNo} 版重新导出重发。`
    )
  ) {
    rollbackJob(j, versionNo)
    toast(`已回退到第 ${versionNo} 版，请重新导出下料单`, 'good', 4200)
  }
}

function signedNum(v: number): string {
  return v > 0 ? `+${v}` : `${v}`
}
function signedStr(v: string): string {
  return v.startsWith('-') ? v : /\d/.test(v[0]) ? `+${v}` : v
}
function fmtSigned(v: number, dec: number): string {
  if (Math.abs(v) < 0.5 * 10 ** -dec) return (0).toFixed(dec)
  return signedStr(v.toFixed(dec))
}
function moneySigned(rawCents: number): string {
  const rounded = Math.round(rawCents)
  return signedMoney(rounded)
}
function signedMoney(c: number): string {
  return c > 0 ? `+${money(c)}` : money(c)
}
function cls(v: number): 'pos' | 'neg' | '' {
  return v > 0 ? 'pos' : v < 0 ? 'neg' : ''
}
function kindCls(k: RevRow['kind']): string {
  return k === 'added' ? 'good' : k === 'removed' ? 'bad' : k === 'changed' ? 'warn' : ''
}
function fmtSheets(idxs: number[]): string {
  if (idxs.length === 0) return '—'
  return idxs.map((i) => i + 1).join('、')
}
function m2(mm2: number): string {
  return `${(mm2 / 1e6).toFixed(2)}`
}

const sampleTsv = `件号\t名称\t长\t宽\t数量\t纹理\t封边\t柜体\t见光
DC-M\t地柜门(竖纹见光)\t700\t346\t2\t竖纹\t上下左右\t地柜\t是
WR-P\t衣柜层板\t564\t560\t7\t无\t上下\t衣柜\t否
NEW-1\t新增拉条\t560\t80\t2\t无\t\t衣柜\t否`
</script>

<template>
  <div v-if="job">
    <!-- 头部 -->
    <section class="panel" style="margin-bottom: 12px">
      <div class="row wrap">
        <h2 style="font-size: 17px">改版影响核定</h2>
        <span class="tag">当前：{{ job.name }} · 第 {{ job.versionNo ?? 1 }} 版</span>
        <span v-if="report?.status === 'draft'" class="tag warn">核定草稿（尚未应用）</span>
        <span v-else-if="report?.status === 'applied'" class="tag good">已应用第 {{ job.versionNo }} 版</span>
        <div class="spacer" />
        <button class="sm" @click="showArchives = !showArchives">
          历史版本与本机存档（{{ job.archives?.length ?? 0 }}）
        </button>
        <router-link class="sm btn-like" :to="`/parts/${job.id}`">← 回明细页</router-link>
      </div>
      <p class="small muted" style="margin: 8px 0 0">
        客户改图后，把新版板件明细放进来，按件号认出新增/删除/修改（长宽、数量、纹理、封边、见光、板材），
        逐项算用板、料钱、封边与五金的差，明细页、开料工单、材料统计三处共用这一份核定，不会各算一版。
      </p>
    </section>

    <!-- 过期警告 -->
    <div v-if="stale" class="alert bad">
      ⚠️ 旧版清单在核定之后又被改动，本核定已过期。请用最新清单重新核定，否则三处页面会不一致。
    </div>

    <!-- 历史版本存档 -->
    <section v-if="showArchives" class="panel" style="margin-bottom: 12px">
      <h3 style="font-size: 14px; margin-bottom: 8px">历史版本（改版以前的数独立留存，不被新版盖掉）</h3>
      <div v-if="(job.archives?.length ?? 0) === 0" class="small muted">还没有历史存档；应用改版时会自动把当前版存入这里。</div>
      <table v-else class="grid">
        <thead>
          <tr>
            <th>版本</th><th>存档原因</th><th>用板(张)</th><th>料钱</th><th>封边(m)</th><th>件数</th>
            <th>存档时间</th><th>状态</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in job.archives" :key="a.versionNo">
            <td><b>{{ a.label }}</b></td>
            <td class="small">{{ a.reason }}</td>
            <td>{{ a.metrics.boardsUsed }}</td>
            <td>{{ money(a.metrics.totalCostCents) }}</td>
            <td>{{ (a.metrics.edgeExposedM + a.metrics.edgeNormalM).toFixed(2) }}</td>
            <td>{{ a.metrics.pieces }}</td>
            <td class="small">{{ new Date(a.archivedAt).toLocaleString('zh-CN') }}</td>
            <td>
              <span :class="['tag', a.status === 'active' ? 'good' : a.status === 'voided' ? 'bad' : '']">
                {{ a.status === 'active' ? '当前' : a.status === 'voided' ? '已作废' : '已被取代' }}
              </span>
            </td>
            <td>
              <button
                v-if="a.status !== 'active'"
                class="sm ghost-danger"
                @click="doRollback(a.versionNo)"
              >回退到此版并重发</button>
              <span v-else class="tag">翻回旧版可查当时的用板与封边</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 已发出但作废的清单 -->
    <section
      v-if="(job.exports?.filter((e) => e.voided).length ?? 0) > 0"
      class="panel alert-warn"
      style="margin-bottom: 12px"
    >
      <b>⚠️ 以下已导出下料单已作废，必须回退重发：</b>
      <table class="grid" style="margin-top: 6px">
        <thead>
          <tr><th>版本</th><th>内容</th><th>导出时间</th><th>作废原因</th></tr>
        </thead>
        <tbody>
          <tr v-for="e in job.exports!.filter((x) => x.voided)" :key="e.id">
            <td>第 {{ e.versionNo }} 版</td>
            <td class="small">{{ e.sections.join('、') }}</td>
            <td class="small">{{ new Date(e.createdAt).toLocaleString('zh-CN') }}</td>
            <td class="small" style="color: var(--c-bad)">{{ e.voidReason }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 输入新版明细 -->
    <section v-if="!report || report.status === 'draft'" class="panel" style="margin-bottom: 12px">
      <h3 style="font-size: 14px; margin-bottom: 8px">① 放入新版板件明细（件号必须与旧版对应）</h3>
      <div class="row" style="margin-bottom: 8px">
        <label class="row small"><input type="radio" value="paste" v-model="inputMode" /> 粘贴新版明细（Excel/TSV/CSV，缺字段按空值）</label>
        <label class="row small"><input type="radio" value="current" v-model="inputMode" /> 以当前清单为基础（去明细页直接改后再回来核）</label>
      </div>
      <textarea
        v-if="inputMode === 'paste'"
        v-model="pasteText"
        rows="9"
        :placeholder="sampleTsv"
      ></textarea>
      <p v-else class="small muted">将以明细页当前保存的 {{ job.parts.length }} 种件号作为新版进行核定。</p>
      <p v-for="(e, i) in parseErrors" :key="i" class="small" style="color: var(--c-warn); margin: 4px 0 0">
        ⚠ {{ e }}
      </p>

      <h3 style="font-size: 14px; margin: 14px 0 8px">
        ② 两条路只能选一条
        <span v-if="report?.status === 'draft'" class="tag" style="margin-left: 6px">
          已按「{{ strategy === 'renest' ? '整批重排' : '留用旧摆法' }}」核定，可改选后结果实时重算
        </span>
      </h3>
      <div class="strategy-box">
        <label class="strategy" :class="{ on: strategy === 'renest' }">
          <input
            type="radio"
            :checked="strategy === 'renest'"
            :disabled="false"
            @change="chooseStrategy('renest')"
          />
          <div>
            <b>整批重排</b>
            <p class="small muted" style="margin: 4px 0 0">
              结果干净统一；代价是已经排好的摆法与刀路全白做，多花一遍工时（也可能多费料）。
            </p>
          </div>
        </label>
        <label class="strategy" :class="{ on: strategy === 'reuse' }">
          <input
            type="radio"
            :checked="strategy === 'reuse'"
            @change="chooseStrategy('reuse')"
          />
          <div>
            <b>留用旧摆法</b>
            <p class="small muted" style="margin: 4px 0 0">
              省时间：不受影响的板不重开；代价是新旧混排的板要单独挑出，刀路上多出几次回头切、
              混排板上废弃件的料已耗。
            </p>
          </div>
        </label>
      </div>

      <div class="row" style="margin-top: 12px">
        <button class="primary" @click="doAnalyze">
          {{ report?.status === 'draft' ? '按当前新版重新核定' : '开始核定（新旧两版各只算一遍）' }}
        </button>
        <button v-if="report?.status === 'draft'" @click="discardDraft">放弃核定</button>
      </div>
    </section>

    <!-- 已应用后：下一次改版入口 -->
    <section v-if="report?.status === 'applied'" class="panel" style="margin-bottom: 12px; background: #fafcf9">
      <div class="row wrap">
        <b>要在第 {{ job.versionNo ?? 1 }} 版基础上再次改图？</b>
        <span class="small muted">粘贴下一版明细即可，当前版会先自动存档，那组数继续可查。</span>
        <div class="spacer" />
        <button class="sm primary" @click="startNextRevision">开始下一版核定</button>
      </div>
    </section>

    <template v-if="report">
      <!-- 总差 KPI -->
      <section class="panel" style="margin-bottom: 12px">
        <div class="row wrap" style="margin-bottom: 8px">
          <h3 style="font-size: 14px">③ 这一改差多少（旧 → 新）</h3>
          <span class="tag">核定时间 {{ new Date(report.createdAt).toLocaleString('zh-CN') }}</span>
          <span :class="['tag', strategy === 'renest' ? 'good' : 'warn']">
            选定路线：{{ strategy === 'renest' ? '整批重排' : '留用旧摆法' }}
          </span>
        </div>
        <div class="kpi-grid">
          <div class="kpi">
            <span>用板（{{ strategy === 'reuse' ? '留用路线落账：新板−省掉的旧板' : '排样实算领料' }}）</span>
            <b :class="cls(strategy === 'reuse' ? report.totals.ledgerSheets ?? 0 : report.totals.dSheetsExact)">
              {{ signedNum(strategy === 'reuse' ? report.totals.ledgerSheets ?? 0 : report.totals.dSheetsExact) }} 张
            </b>
            <small v-if="strategy === 'reuse'">
              留用 {{ report.reuse.keptSheets.length }} + 混切 {{ report.reuse.mixedSheets.length }} 张照旧开，
              新开 − 省掉旧板 = {{ signedNum(report.totals.ledgerSheets ?? 0) }}
            </small>
            <small v-else>{{ report.oldExact.boardsUsed }} → {{ report.newExact.boardsUsed }} 张（领料口径）</small>
            <small class="muted">逐项折算 {{ signedNum(report.totals.dSheetsEq) }} 张（净面积口径）；若整批重排则 {{ signedNum(report.totals.dSheetsExact) }} 张</small>
          </div>
          <div class="kpi">
            <span>板材花费（{{ strategy === 'reuse' ? '留用路线落账' : '整批重排实算' }}）</span>
            <b :class="cls(report.totals.ledgerBoardCents ?? report.totals.dBoardCentsExact)">
              {{ signedMoney(report.totals.ledgerBoardCents ?? report.totals.dBoardCentsExact) }}
            </b>
            <small v-if="strategy === 'reuse'">
              重开新板料钱 − 省掉的 {{ report.reuse.reopenSheets.length }} 张旧板；混排板照旧切、不补不省
            </small>
            <small v-else>{{ money(report.oldExact.totalCostCents) }} → {{ money(report.newExact.totalCostCents) }}</small>
            <small class="muted">
              逐项折算 {{ signedMoney(report.totals.dBoardCents) }}；整批重排口径 {{ signedMoney(report.totals.dBoardCentsExact) }}
            </small>
          </div>
          <div class="kpi">
            <span>封边总长</span>
            <b :class="cls(report.totals.dEdgeM)">{{ signedNum(report.totals.dEdgeM) }} m</b>
            <small>见光 {{ signedNum(report.totals.dEdgeExposedM) }}m · 非见光 {{ signedNum(report.totals.dEdgeNormalM) }}m</small>
          </div>
          <div class="kpi">
            <span>零件件数（五金口径）</span>
            <b :class="cls(report.totals.dPieces)">{{ signedNum(report.totals.dPieces) }} 件</b>
            <small v-for="h in report.totals.dHardware" :key="h.name">
              {{ h.name }} {{ signedNum(h.value) }} {{ h.unit }}
            </small>
          </div>
        </div>
      </section>

      <!-- 留用方案 -->
      <section class="panel" style="margin-bottom: 12px">
        <h3 style="font-size: 14px; margin-bottom: 8px">④ 改完接着往下排：哪些必须重排、哪些可以留用</h3>
        <div class="reuse-grid">
          <div class="rz kept">
            <b>干净留用 {{ report.reuse.keptSheets.length }} 张 / {{ report.reuse.keptPieces }} 件</b>
            <p class="small muted" style="margin: 4px 0 0">板与刀路原样可用，不用重开：第 {{ fmtSheets(report.reuse.keptSheets) }} 张</p>
          </div>
          <div class="rz mixed">
            <b>新旧混排 {{ report.reuse.mixedSheets.length }} 张</b>
            <p class="small muted" style="margin: 4px 0 0">
              旧板照旧切：{{ report.reuse.backCutPieces }} 件按旧刀路回头切（返机 {{ report.reuse.extraBackCuts }} 次），
              {{ report.reuse.voidPieces }} 件标废、用量由新板补。
            </p>
          </div>
          <div class="rz reopen">
            <b>必须重开 {{ strategy === 'renest' ? report.oldExact.boardsUsed : report.reuse.reopenSheets.length }} 张</b>
            <p class="small muted" style="margin: 4px 0 0">
              {{ strategy === 'renest'
                ? '整批重排路线：旧板全部重开，工单全部重开。'
                : `留用路线：第 ${fmtSheets(report.reuse.reopenSheets)} 张上的 ${report.reuse.reopenPieces} 件 + 新增件一起重排，工单据此重开。` }}
            </p>
          </div>
        </div>
        <div v-if="report.reuse.carryOverPieces.length > 0" style="margin-top: 8px">
          <b class="small">回头切件清单（混排板上照旧刀路切，别切到标废件）：</b>
          <div class="row wrap" style="margin-top: 4px">
            <span v-for="c in report.reuse.carryOverPieces" :key="c.code + c.oldSheetIndex" class="tag">
              {{ c.code }} ×{{ c.qty }}（旧第 {{ c.oldSheetIndex + 1 }} 张）
            </span>
          </div>
        </div>
      </section>

      <!-- 逐项成本表 -->
      <section class="panel" style="margin-bottom: 12px">
        <div class="row" style="margin-bottom: 8px">
          <h3 style="font-size: 14px">⑤ 逐项成本表（按差得多 → 差得少）</h3>
          <div class="spacer" />
          <span class="tag">改动 {{ changedRows.length }} 个件号 / 共 {{ report.rows.length }} 个</span>
        </div>
        <div class="table-scroll">
          <table class="grid cost-table">
            <thead>
              <tr>
                <th>件号</th><th>名称</th><th>判定</th><th>变化点（旧→新）</th>
                <th class="num">面积差(m²)</th><th class="num">折算张差</th><th class="num">料钱差</th>
                <th class="num">见光封边差(m)</th><th class="num">非见光封边差(m)</th><th class="num">件数差</th>
                <th>工单</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in sortedRows" :key="r.code" :class="['kind-' + r.kind, { dim: r.kind === 'same' }]">
                <td><b>{{ r.code }}</b></td>
                <td class="small">{{ r.name }}</td>
                <td><span :class="['tag', kindCls(r.kind)]">{{ kindLabel[r.kind] }}</span></td>
                <td class="small change-cell">
                  <span v-for="c in r.changes" :key="c.field" class="chg">
                    {{ c.label }}：{{ c.old ?? '—' }}→{{ c.now ?? '—' }}
                  </span>
                  <span v-if="r.changes.length === 0" class="muted">—</span>
                  <span v-for="(w, i) in r.mergeWarnings" :key="'w' + i" class="merge-warn" :title="w">⚠并条</span>
                </td>
                <td class="num" :class="cls(r.dAreaMm2)">{{ fmtSigned(Number(m2(r.dAreaMm2)), 2) }}</td>
                <td class="num" :class="cls(r.dSheetsEq)">{{ fmtSigned(r.dSheetsEq, 3) }}</td>
                <td class="num" :class="cls(Math.round(r.dBoardCents))">{{ moneySigned(r.dBoardCents) }}</td>
                <td class="num" :class="cls(r.dEdgeExposedM)">{{ fmtSigned(r.dEdgeExposedM, 2) }}</td>
                <td class="num" :class="cls(r.dEdgeNormalM)">{{ fmtSigned(r.dEdgeNormalM, 2) }}</td>
                <td class="num" :class="cls(r.dPieces)">{{ signedNum(r.dPieces) }}</td>
                <td>
                  <span v-if="r.forcesReopen" class="tag bad">重开</span>
                  <span v-else-if="r.kind !== 'same'" class="tag warn">仅封边/属性变，板不重开</span>
                  <span v-else class="tag good">不动</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 核对 -->
      <section class="panel" style="margin-bottom: 12px">
        <h3 style="font-size: 14px; margin-bottom: 8px">⑥ 核对（逐项合计必须与总表对得上，对不上直接指出）</h3>
        <table class="grid">
          <tbody>
            <tr v-for="(c, i) in report.checks" :key="i">
              <td style="width: 34px; text-align: center">
                {{ c.level === 'ok' ? '✅' : c.level === 'warn' ? '⚠️' : '❌' }}
              </td>
              <td style="width: 240px"><b>{{ c.name }}</b></td>
              <td class="small" :style="c.level === 'bad' ? 'color:var(--c-bad)' : ''">{{ c.detail }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="report.warnings.length > 0" style="margin-top: 8px">
          <b class="small" style="color: var(--c-warn)">并条/缺字段提示：</b>
          <p v-for="(w, i) in report.warnings" :key="i" class="small" style="color: var(--c-warn); margin: 2px 0">• {{ w }}</p>
        </div>
      </section>

      <!-- 应用 -->
      <section v-if="report.status === 'draft'" class="panel apply-bar">
        <div>
          <b>⑦ 应用改版</b>
          <p class="small muted" style="margin: 4px 0 0">
            应用后：旧版自动存入历史版本（当时的用板/封边仍可查），旧版本机存档与已导出下料单一律作废并要求回退重发；
            明细页、工单页、统计页随即同源切到新版。
          </p>
        </div>
        <div class="spacer" />
        <button :disabled="applying || stale" class="primary" @click="doApply">
          {{ applying ? '处理中…' : strategy === 'renest' ? '整批重排并应用' : '留用旧摆法并应用' }}
        </button>
      </section>
      <section v-else class="panel" style="margin-bottom: 12px; border-color: #bfe3cc">
        <div class="row">
          <b style="color: var(--c-good)">本核定已应用（第 {{ job.versionNo }} 版）</b>
          <span class="tag good">三处页面已同源</span>
          <div class="spacer" />
          <router-link class="sm btn-like" :to="`/parts/${job.id}`">看明细标记</router-link>
          <router-link class="sm btn-like" :to="`/cut/${job.id}`">看工单重开</router-link>
          <router-link class="sm btn-like primary-link" :to="`/stats/${job.id}`">看材料统计变化</router-link>
        </div>
      </section>
    </template>

    <!-- 精度与单位规矩 -->
    <section class="panel precision">
      <b class="small">单位与精度（全应用统一）：</b>
      <span class="small muted">
        长度 mm 整数；面积内部 mm²、展示 m² 保留 2 位；封边 m 保留 2 位（按零件净边长，不含锯路）；
        逐项折算用板=净面积÷板毛面积，保留 3 位小数，领料/成本以整单重排实算整数张与实算金额为准；
        金额内部按「分」整数计，展示元取到分；五金套/个/颗为整数，封边胶 kg 保留 2 位。
      </span>
    </section>
  </div>
</template>

<style scoped>
.alert {
  border-radius: 8px;
  padding: 9px 14px;
  margin-bottom: 10px;
  font-size: 13px;
}
.alert.bad {
  background: var(--c-bad-bg);
  border: 1px solid #eecfcf;
  color: var(--c-bad);
}
.alert-warn {
  border-color: #f0d9b5;
  background: #fffbeb;
}
.btn-like {
  border: 1px solid var(--c-line);
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 12px;
  text-decoration: none;
}
.primary-link {
  background: var(--c-primary);
  color: #fff !important;
  border-color: var(--c-primary);
}
.strategy-box {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.strategy {
  display: flex;
  gap: 10px;
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 10px 14px;
  cursor: pointer;
}
.strategy.on {
  border-color: var(--c-primary);
  background: #fff7ed;
}
.strategy input {
  width: auto;
  margin-top: 3px;
}
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 10px;
}
.kpi {
  background: #f4f7f3;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kpi > span {
  font-size: 12px;
  color: var(--c-ink-2);
}
.kpi b {
  font-size: 21px;
  font-variant-numeric: tabular-nums;
}
.kpi small {
  font-size: 11px;
  color: var(--c-ink-2);
}
.pos {
  color: var(--c-bad);
}
.neg {
  color: var(--c-good);
}
.reuse-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
}
.rz {
  border-radius: 8px;
  padding: 10px 12px;
  border: 1px solid;
}
.rz.kept {
  background: var(--c-good-bg);
  border-color: #bfe3cc;
}
.rz.mixed {
  background: #fffbeb;
  border-color: #f0d9b5;
}
.rz.reopen {
  background: var(--c-bad-bg);
  border-color: #eecfcf;
}
.table-scroll {
  overflow-x: auto;
}
.cost-table th,
.cost-table td {
  padding: 4px 7px;
  font-size: 12px;
  white-space: nowrap;
}
.cost-table td.num,
.cost-table th.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.cost-table tr.dim {
  opacity: 0.55;
}
.change-cell {
  max-width: 320px;
  white-space: normal;
}
.chg {
  display: inline-block;
  margin-right: 6px;
  padding: 0 5px;
  border-radius: 4px;
  background: #f1f5f0;
}
.merge-warn {
  color: var(--c-warn);
  cursor: help;
}
.apply-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #fff7ed;
  border-color: #f0d9b5;
}
.precision {
  font-size: 12px;
  background: #fafcf9;
}
textarea {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12px;
}
</style>
