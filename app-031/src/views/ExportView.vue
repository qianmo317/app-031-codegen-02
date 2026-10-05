<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useRoute } from 'vue-router'
import { getJob, exportJobJson, registerJobExport } from '../lib/store'
import { printJob, type PrintSection } from '../lib/print'
import { downloadText } from '../lib/format'
import { toast } from '../lib/ui'

const route = useRoute()
const job = computed(() => getJob(route.params.id as string))
const revision = computed(() => job.value?.revision)

const sections = reactive<Record<PrintSection, boolean>>({
  nest: true,
  cut: true,
  order: true,
  labels: true
})
const sectionDefs: { key: PrintSection; name: string; desc: string }[] = [
  { key: 'nest', name: '排样图', desc: '每张板真实比例图 + 零件编号尺寸（可贴机器旁）' },
  { key: 'order', name: '下料单/领料单', desc: '板材领料、按柜零件明细、封边与五金辅料' },
  { key: 'cut', name: '裁切步骤表', desc: '每一刀的方向/位置/贯通区间，按刀序排列' },
  { key: 'labels', name: '零件标签', desc: 'A4 不干胶，每块零件一张，便于分拣' }
]

const sectionNames: Record<PrintSection, string> = {
  nest: '排样图',
  cut: '裁切步骤表',
  order: '下料单/领料单',
  labels: '零件标签'
}

const activeExports = computed(() => (job.value?.exports ?? []).filter((e) => !e.voided))
const voidedExports = computed(() => (job.value?.exports ?? []).filter((e) => e.voided))

function selected(): PrintSection[] {
  return sectionDefs.filter((d) => sections[d.key]).map((d) => d.key)
}
function doPrint(): void {
  const list = selected()
  if (list.length === 0) {
    toast('至少勾选一项导出内容', 'bad')
    return
  }
  if (!job.value) return
  // 登记本机存档/发出记录：改版或回退时据此作废旧单、要求回退重发
  registerJobExport(job.value, list.map((k) => sectionNames[k]))
  printJob(route.params.id as string, list)
  toast(`已登记：第 ${job.value.versionNo ?? 1} 版下料单发出（改版时将自动作废）`, 'good', 3200)
}
function exportJson(): void {
  if (!job.value) return
  const safe = job.value.name.replace(/[\\/:*?"<>|]/g, '_')
  downloadText(`开料项目_${safe}_${job.value.id.slice(-4)}.json`, exportJobJson(job.value), 'application/json')
  toast('已导出项目 JSON（可在首页导回）', 'good')
}
</script>

<template>
  <div v-if="job">
    <!-- 改版状态条：防止把已作废旧版清单再发出去 -->
    <section class="panel" :class="revision?.status === 'applied' ? 'ver-ok' : revision?.status === 'draft' ? 'ver-draft' : ''" style="margin-bottom: 12px">
      <div class="row wrap">
        <b>下料单版本：第 {{ job.versionNo ?? 1 }} 版</b>
        <span v-if="revision?.status === 'draft'" class="tag warn">
          改版核定还是草稿：现在导出的是旧版清单，应用改版后会自动作废、需要重发
        </span>
        <span v-else-if="revision?.status === 'applied'" class="tag good">
          已应用改版，导出即新版（排样图会标留用/混切/重开，步骤表会标标废件）
        </span>
        <div class="spacer" />
        <router-link class="small" :to="`/revision/${job.id}`">改版核定 →</router-link>
      </div>
    </section>

    <!-- 已作废旧单（必须回退重发） -->
    <section v-if="voidedExports.length > 0" class="panel" style="margin-bottom: 12px; border-color: #eecfcf">
      <h3 style="font-size: 14px; margin-bottom: 6px; color: var(--c-bad)">⚠️ 已发出但已作废的清单（请回退重发）</h3>
      <table class="grid">
        <tbody>
          <tr v-for="e in voidedExports" :key="e.id">
            <td>第 {{ e.versionNo }} 版</td>
            <td class="small">{{ e.sections.join('、') }}</td>
            <td class="small muted">{{ new Date(e.createdAt).toLocaleString('zh-CN') }}</td>
            <td class="small" style="color: var(--c-bad)">{{ e.voidReason }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 当前有效发出记录 -->
    <section v-if="activeExports.length > 0" class="panel" style="margin-bottom: 12px">
      <h3 style="font-size: 14px; margin-bottom: 6px">本机已发出记录（第 {{ job.versionNo ?? 1 }} 版）</h3>
      <div class="row wrap">
        <span v-for="e in activeExports" :key="e.id" class="tag good">
          {{ e.sections.join('、') }} · {{ new Date(e.createdAt).toLocaleString('zh-CN') }}
        </span>
      </div>
    </section>

    <section class="panel">
      <h1 style="font-size: 19px; margin-bottom: 6px">导出与打印</h1>
      <p class="muted">
        勾选要出的内容后点打印/另存 PDF；所有版式按 A4 排好，可直接贴车间或交领料。标签为每块零件一张的不干胶。
      </p>
      <div class="sec-list">
        <label v-for="d in sectionDefs" :key="d.key" class="sec-item">
          <input type="checkbox" v-model="sections[d.key]" />
          <div>
            <b>{{ d.name }}</b>
            <span class="muted small"> — {{ d.desc }}</span>
          </div>
        </label>
      </div>
      <div class="row" style="margin-top: 14px">
        <button class="primary" @click="doPrint">🖨 打印 / 另存 PDF</button>
        <button @click="exportJson">导出项目 JSON（备份/换机）</button>
        <div class="spacer" />
        <router-link :to="`/nest/${job.id}`">← 回排样图</router-link>
      </div>
    </section>

    <section v-if="!job.result" class="panel" style="margin-top: 14px">
      <p class="muted">该项目尚未排样，打印内容将不完整。</p>
      <router-link :to="`/parts/${job.id}`"><button class="primary">去录零件并排样</button></router-link>
    </section>

    <section class="panel" style="margin-top: 14px">
      <h3 style="font-size: 14px; margin-bottom: 8px">导出内容预览（与打印一致）</h3>
      <ul class="small muted">
        <li>排样图：{{ job.result?.sheets.length ?? 0 }} 张板，同柜同色，标注编号与尺寸</li>
        <li>裁切步骤：{{ job.result?.sheets.reduce((a, s) => a + s.steps.length, 0) ?? 0 }} 条刀序（含修边）</li>
        <li>下料单：{{ job.result ? Object.keys(job.result.boardsByType).length : 0 }} 种板材领料 + 按柜明细 + 封边五金</li>
        <li>标签：{{ job.result?.sheets.reduce((a, s) => a + s.placements.length, 0) ?? 0 }} 张（每块零件 1 张）</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.sec-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.sec-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 10px 14px;
  cursor: pointer;
}
.sec-item:hover {
  background: #fafcf9;
}
.sec-item input {
  margin-top: 3px;
}
.ver-ok {
  border-color: #bfe3cc;
  background: var(--c-good-bg);
}
.ver-draft {
  border-color: #f0d9b5;
  background: #fffbeb;
}
</style>
