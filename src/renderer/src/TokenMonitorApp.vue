<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { i18n, resolveAvailableUiLocale, useTheme } from '@navide/plugin-ui/foundation'
import { initSettingsBackend, onSettingsChanged, settingsGet } from '@navide/plugin-ui/shared'
import { createHostGitSettingsPort } from './composables/hostSurfacePorts'
import { useBackend } from './composables/useBackend'
import { useTokenMonitor } from './composables/useTokenMonitor'
import TokenMonitorChart from './components/TokenMonitorChart.vue'
import WindowControls from './components/WindowControls.vue'
import { needsDrawnWindowControls } from '../../shared/osplat'
const drawsOwnTitleBar = needsDrawnWindowControls()
import { comparePeriods, summarizeTokens } from './utils/tokenMonitor'

const { t, locale } = useI18n({ useScope: 'local', messages: {
  'en-US': {
    title: 'Claude Token Monitor', scope: 'Local Claude history · account attribution unknown',
    caveat: 'These tokens are observed usage, not your account token allowance. Local sessions may belong to different accounts. Quota samples cover only the active profile slot while Navide is running; slot identity is not verified account identity. Running turns may be incomplete.',
    refresh: 'Refresh', loading: 'Loading…', days: 'Days', model: 'Model', all: 'All models',
    turns: 'Turns', total: 'Total tokens', mean: 'Mean / turn', median: 'Median / turn', outputMean: 'Mean output / turn',
    empty: 'No local Claude turns found for this period.', connection: 'Backend connection',
    comparison: 'Output comparison: latest 7 days vs previous 7 days', choose: 'Select a single known model to compare.',
    insufficient: 'Insufficient samples: at least 10 turns in each period and a nonzero baseline are required.',
    comparisonNote: 'Descriptive change only. Effort and task difficulty are unknown; a decline does not establish an allowance reduction.',
    samples: 'Samples (recent / previous)', moving: 'accent: trailing 10-turn mean; gray: per turn',
    sequence: 'Horizontal axis: turns in chronological order (equal spacing, not elapsed time).',
    input: 'Input', cacheRead: 'Cache read', cacheWrite: 'Cache write', output: 'Output', calls: 'API calls',
    time: 'Started', session: 'Session / turn', quota: 'Recorded quota usage',
    quotaNone: 'No quota samples yet. Enable Claude usage polling in settings and keep Navide running. Historical limits cannot be reconstructed from token logs.',
    quotaNote: 'Percentages are provider-reported. Each reset window is plotted separately; local tokens cannot be converted to a quota ceiling.',
    quotaObserved: 'Last quota observation',
    quotaSlot: 'Profile slot recorded at refresh',
    asOf: 'As of',
    quotaDisabled: 'Quota polling is disabled. Existing samples are historical; no new snapshots are being recorded.',
    quotaAxis: 'Horizontal axis: samples in recorded order; dots show observed percentages.',
    coverage: 'Sessions scanned / available', partial: 'Partial history: scan limits or read errors affect these results.',
    updated: 'Last successful refresh', previous: 'Previous', next: 'Next', page: 'Page', auto: 'Refreshes every 60 seconds',
  },
  'ja-JP': {
    title: 'Claude トークンモニター', scope: 'ローカルの Claude 履歴 · 所属アカウントは不明',
    caveat: 'ここに表示するトークン数は観測された使用量であり、アカウントのトークン上限ではありません。ローカルセッションには異なるアカウントのものが含まれる場合があります。利用枠の記録は Navide の実行中にアクティブだったプロファイルスロットのみが対象で、スロットは確認済みのアカウント識別情報ではありません。実行中のターンの記録は未完了の場合があります。',
    refresh: '更新', loading: '読み込み中…', days: '日数', model: 'モデル', all: 'すべてのモデル',
    turns: 'ターン数', total: '合計トークン数', mean: 'ターン平均', median: 'ターン中央値', outputMean: 'ターン平均出力',
    empty: 'この期間のローカル Claude ターンは見つかりませんでした。', connection: 'バックエンド接続',
    comparison: '出力の比較：直近 7 日間とその前の 7 日間', choose: '比較するには、既知のモデルを 1 つ選択してください。',
    insufficient: 'サンプルが不足しています。各期間に 10 ターン以上、かつ比較基準がゼロより大きい必要があります。',
    comparisonNote: '観測された変化を示すだけのものです。思考量やタスクの難易度は不明なため、減少していても利用上限が引き下げられたとは判断できません。',
    samples: 'サンプル数（直近／前期）', moving: '強調色：直近 10 ターンの移動平均、グレー：各ターン',
    sequence: '横軸：時系列に並べたターン（等間隔で、経過時間ではありません）。',
    input: '入力', cacheRead: 'キャッシュ読み込み', cacheWrite: 'キャッシュ書き込み', output: '出力', calls: 'API 呼び出し',
    time: '開始日時', session: 'セッション／ターン', quota: '記録された利用枠の使用率',
    quotaNone: '利用枠の記録はまだありません。設定で Claude 使用量の定期取得を有効にし、Navide を起動したままにしてください。トークンログから過去の利用上限を復元することはできません。',
    quotaNote: '割合はプロバイダーが報告した値です。リセット期間ごとに分けて表示します。ローカルトークン数から利用枠の上限を算出することはできません。',
    quotaObserved: '利用枠の最終観測日時',
    quotaSlot: '更新時に記録されたプロファイルスロット',
    asOf: 'データ取得日時',
    quotaDisabled: '利用枠の定期取得は無効です。過去の記録を表示しており、新しいスナップショットは記録されていません。',
    quotaAxis: '横軸：記録順に並べたサンプル。点は観測された割合を示します。',
    coverage: '検索済み／利用可能なセッション', partial: '履歴は一部のみです。検索上限または読み取りエラーが結果に影響しています。',
    updated: '最終更新成功日時', previous: '前へ', next: '次へ', page: 'ページ', auto: '60 秒ごとに更新',
  },
  'zh-TW': {
    title: 'Claude Token 監測', scope: '本機 Claude 歷史 · 帳號歸屬未知',
    caveat: '此處是觀察到的用量，不是帳號 token 額度。本機 session 可能屬於不同帳號；額度快照只涵蓋 Navide 執行期間的目前設定槽，槽位不等於已驗證帳號身分。進行中的輪次可能尚未完整。',
    refresh: '重新整理', loading: '載入中…', days: '天數', model: '模型', all: '全部模型',
    turns: '輪數', total: '總 Token', mean: '每輪平均', median: '每輪中位數', outputMean: '每輪平均輸出',
    empty: '此期間沒有本機 Claude 逐輪紀錄。', connection: '後端連線',
    comparison: '輸出比較：最近 7 天與前 7 天', choose: '請選擇單一已知模型以比較。',
    insufficient: '樣本不足：兩個期間各需至少 10 輪，且基準平均值須大於零。',
    comparisonNote: '僅描述觀察到的變化。Effort 與任務難度未知；下降不能證明額度被縮減。',
    samples: '樣本數（近期 / 前期）', moving: '強調色：最近 10 輪移動平均；灰色：各輪',
    sequence: '橫軸：依時間排序的每一輪（等距，非經過時間）。',
    input: '輸入', cacheRead: '快取讀取', cacheWrite: '快取寫入', output: '輸出', calls: 'API 呼叫',
    time: '開始時間', session: 'Session / 輪次', quota: '額度用量紀錄',
    quotaNone: '尚無額度快照。請在設定啟用 Claude 用量輪詢並保持 Navide 執行。無法從 token 紀錄還原歷史額度上限。',
    quotaNote: '百分比來自供應商。各重置週期分開繪圖；不能把本機 token 換算成帳號額度上限。',
    quotaObserved: '最後額度觀察時間',
    quotaSlot: '更新時記錄的設定槽',
    asOf: '資料截至',
    quotaDisabled: '額度輪詢已停用。目前僅顯示歷史快照，不會持續記錄新的額度資料。',
    quotaAxis: '橫軸：依記錄順序排列的快照；圓點為實際觀察百分比。',
    coverage: '已掃描 / 可用 session', partial: '歷史資料不完整：掃描上限或讀取錯誤影響統計。',
    updated: '上次成功更新', previous: '上一頁', next: '下一頁', page: '頁', auto: '每 60 秒更新',
  }
} })
const backend = useBackend()
initSettingsBackend(createHostGitSettingsPort(backend))
// The local table above covers en-US, zh-TW and ja-JP; any other locale reaches
// en-US through the global fallback chain the local scope inherits.
function applyLocale(value: unknown): void {
  const resolved = resolveAvailableUiLocale(value)
  if (resolved) i18n.global.locale.value = resolved
}
applyLocale(new URLSearchParams(window.location.search).get('locale'))
const days = ref(30)
const model = ref('')
const page = ref(0)
const quotaPage = ref(0)
const api = useTokenMonitor(backend, days)
const models = computed(() => [...new Set(api.data.value?.turns.map(turn => turn.model) ?? [])].sort())
const turns = computed(() => (api.data.value?.turns ?? []).filter(turn => !model.value || turn.model === model.value)
  .slice().sort((a, b) => (Date.parse(a.started_at ?? '') || 0) - (Date.parse(b.started_at ?? '') || 0)))
const stats = computed(() => summarizeTokens(turns.value.map(turn => turn.total)))
const outputStats = computed(() => summarizeTokens(turns.value.map(turn => turn.output)))
const comparison = computed(() => comparePeriods(turns.value, Date.parse(api.updatedAt.value) || Date.now()))
const partial = computed(() => api.data.value?.coverage.truncated || !!api.data.value?.coverage.errors)
const comparable = computed(() => model.value && !['mixed', 'unknown'].includes(model.value) && !partial.value)
const rows = computed(() => turns.value.slice().reverse().slice(page.value * 100, (page.value + 1) * 100))
const pages = computed(() => Math.max(1, Math.ceil(turns.value.length / 100)))
watch([days, model], () => { page.value = 0 })
watch(days, () => { quotaPage.value = 0 })
watch(pages, value => { page.value = Math.min(page.value, value - 1) })
const quotaSeries = computed(() => {
  const groups = new Map<string, { label: string; dates: string[]; values: number[] }>()
  const quota = api.data.value?.quota
  for (const sample of [...(quota?.samples ?? [])].sort((a, b) => Date.parse(a.fetched_at) - Date.parse(b.fetched_at))) {
    if (sample.slot_id !== quota?.active_slot_id) continue
    for (const window of sample.windows) {
      // Unknown reset boundaries stay unconnected instead of inventing continuity.
      const key = `${sample.slot_id}:${window.kind}:${window.label}:${window.windowMinutes ?? ""}:${window.resetsAt ?? sample.fetched_at}`
      const group = groups.get(key) ?? { label: `${window.label} · ${window.resetsAt ?? '—'}`, dates: [], values: [] }
      group.dates.push(sample.fetched_at)
      group.values.push(window.usedPercent)
      groups.set(key, group)
    }
  }
  return [...groups.entries()].map(([id, group]) => ({ id, ...group })).reverse()
})
const quotaObserved = computed(() => (api.data.value?.quota.samples ?? []).filter(sample => sample.slot_id === api.data.value?.quota.active_slot_id).map(sample => sample.fetched_at).sort().at(-1) ?? null)
const quotaPages = computed(() => Math.max(1, Math.ceil(quotaSeries.value.length / 6)))
const visibleQuota = computed(() => quotaSeries.value.slice(quotaPage.value * 6, (quotaPage.value + 1) * 6))
watch(quotaPages, value => { quotaPage.value = Math.min(quotaPage.value, value - 1) })
const metrics = ['input', 'cache_read', 'cache_creation', 'output', 'total'] as const
const labels = { input: 'input', cache_read: 'cacheRead', cache_creation: 'cacheWrite', output: 'output', total: 'total' }
const num = (value: number) => value.toLocaleString(locale.value, { maximumFractionDigits: 1 })
const date = (value: string | null) => value ? new Date(value).toLocaleString(locale.value) : '—'
const { loadTheme } = useTheme()
let offSettings: (() => void) | undefined
onMounted(() => {
  loadTheme()
  // This root mounts once per native window; the preload listener lives with it.
  window.agentTeam?.onLanguageChanged?.(applyLocale)
  offSettings = onSettingsChanged(keys => {
    if (keys.some(key => key.startsWith('agent-team:theme'))) loadTheme()
    if (keys.includes('agent-team:language')) {
      applyLocale(settingsGet<string>('agent-team:language', 'en-US'))
    }
  })
})
onUnmounted(() => offSettings?.())
</script>

<template>
  <div class="monitor-shell">
  <div v-if="drawsOwnTitleBar" class="monitor-titlebar"><WindowControls /></div>
  <main class="monitor">
    <header><h1>{{ t('title') }}</h1><p>{{ t('scope') }}</p></header>
    <p class="notice">{{ t('caveat') }}</p>
    <nav>
      <label>{{ t('days') }} <select v-model="days" data-act="days"><option :value="14">14</option><option :value="30">30</option><option :value="90">90</option></select></label>
      <label>{{ t('model') }} <select v-model="model" data-act="model"><option value="">{{ t('all') }}</option><option v-for="name in models" :key="name" :value="name">{{ name }}</option></select></label>
      <button :disabled="api.loading.value || backend.status.value !== 'connected'" @click="api.refresh">{{ api.loading.value ? t('loading') : t('refresh') }}</button>
      <span>{{ t('auto') }}</span>
    </nav>
    <p v-if="backend.status.value !== 'connected'" role="status">{{ t('connection') }}: {{ backend.status.value }} {{ backend.lastError.value }}</p>
    <p v-if="api.error.value" role="alert">{{ api.error.value }}</p>
    <template v-if="api.data.value">
      <p class="muted">{{ t('coverage') }}: {{ api.data.value.coverage.sessions_scanned }} / {{ api.data.value.coverage.sessions_available }} · {{ t('updated') }}: {{ date(api.updatedAt.value) }}</p>
      <p v-if="api.data.value.coverage.truncated || api.data.value.coverage.errors" role="status">{{ t('partial') }} ({{ api.data.value.coverage.errors }})</p>
      <section class="stats" data-part="stats">
        <div v-for="[label, value] in [[t('turns'), stats.count], [t('total'), stats.total], [t('mean'), stats.mean], [t('median'), stats.median], [t('outputMean'), outputStats.mean]]" :key="label"><span>{{ label }}</span><strong>{{ num(Number(value)) }}</strong></div>
      </section>
      <section><h2>{{ t('comparison') }}</h2><p v-if="partial">{{ t('partial') }}</p><p v-else-if="!comparable">{{ t('choose') }}</p><template v-else><p>{{ t('samples') }}: {{ comparison.recent.count }} / {{ comparison.baseline.count }}</p><p>{{ t('mean') }}: {{ num(comparison.recent.mean) }} / {{ num(comparison.baseline.mean) }} · {{ t('median') }}: {{ num(comparison.recent.median) }} / {{ num(comparison.baseline.median) }}</p><strong v-if="comparison.change !== null" data-part="change">{{ comparison.change > 0 ? '+' : '' }}{{ num(comparison.change) }}%</strong><p v-else>{{ t('insufficient') }}</p></template><p class="muted">{{ t('comparisonNote') }}</p></section>
      <p v-if="!turns.length" role="status">{{ t('empty') }}</p>
      <template v-else>
        <p class="muted">{{ t('sequence') }} {{ date(turns[0].started_at) }} → {{ date(turns[turns.length - 1].started_at) }}</p>
        <section class="charts"><TokenMonitorChart v-for="metric in metrics" :key="metric" :values="turns.map(turn => turn[metric])" :label="t(labels[metric])" :average-label="t('moving')" /></section>
        <div class="table-wrap"><table><thead><tr><th>{{ t('time') }}</th><th>{{ t('session') }}</th><th>{{ t('model') }}</th><th v-for="metric in metrics" :key="metric">{{ t(labels[metric]) }}</th><th>{{ t('calls') }}</th></tr></thead><tbody><tr v-for="turn in rows" :key="`${turn.session_id}:${turn.turn_index}`" data-row="turn"><td>{{ date(turn.started_at) }}</td><td :title="turn.session_id">{{ turn.session_id.slice(0, 8) }} / {{ turn.turn_index }}</td><td>{{ turn.model }}</td><td v-for="metric in metrics" :key="metric">{{ num(turn[metric]) }}</td><td>{{ num(turn.calls) }}</td></tr></tbody></table></div>
        <nav><button :disabled="page === 0" @click="page--">{{ t('previous') }}</button><span>{{ t('page') }} {{ page + 1 }} / {{ pages }}</span><button :disabled="page + 1 >= pages" @click="page++">{{ t('next') }}</button></nav>
      </template>
      <section><h2>{{ t('quota') }}</h2><p class="notice" data-part="quota-slot">{{ t('quotaSlot') }}: <strong>{{ api.data.value.quota.active_slot_id }}</strong> · {{ t('asOf') }}: {{ date(api.updatedAt.value) }}</p><p v-if="quotaObserved">{{ t('quotaObserved') }}: {{ date(quotaObserved) }}</p><p v-if="!api.data.value.quota.enabled" role="status">{{ t('quotaDisabled') }}</p><p>{{ t('quotaNote') }}</p><p v-if="api.data.value.quota.error" role="alert">{{ api.data.value.quota.error }}</p><p v-else-if="!quotaSeries.length">{{ t('quotaNone') }}</p><template v-else><p class="muted">{{ t('quotaAxis') }}</p><figure v-for="series in visibleQuota" :key="series.id"><figcaption>{{ series.label }}</figcaption><svg viewBox="0 0 800 130" role="img" :aria-label="series.label"><text x="0" y="14">100%</text><text x="0" y="120">0%</text><circle v-for="(value, index) in series.values" :key="index" :cx="45 + (series.values.length > 1 ? index / (series.values.length - 1) : .5) * 730" :cy="115 - value" r="3"><title>{{ date(series.dates[index]) }}: {{ value }}%</title></circle></svg></figure><nav><button :disabled="quotaPage === 0" @click="quotaPage--">{{ t('previous') }}</button><span>{{ t('page') }} {{ quotaPage + 1 }} / {{ quotaPages }}</span><button :disabled="quotaPage + 1 >= quotaPages" @click="quotaPage++">{{ t('next') }}</button></nav></template></section>
    </template>
  </main>
  </div>
</template>

<style scoped>
.monitor-shell { height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
.monitor-titlebar { flex-shrink: 0; height: var(--titlebar-height, 32px); -webkit-app-region: drag; background: var(--bg-subtle); }
.monitor { flex: 1; min-height: 0; overflow: auto; width: 100%; box-sizing: border-box; padding: 32px; max-width: 1500px; margin: auto; color: var(--text-primary); font: 13px/1.5 var(--font-sans, sans-serif); }
header { padding-top: 10px; } h1 { font-size: 24px; margin: 0; color: var(--text-bright); } h2 { font-size: 16px; }
header p, .muted, nav span { color: var(--text-muted); } .notice { padding: 12px 16px; background: var(--accent-subtle); border-radius: 6px; }
nav { display: flex; align-items: center; flex-wrap: wrap; gap: 16px; margin: 20px 0; }
button, select { background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: 4px; padding: 6px 10px; color: var(--text-primary); }
button:disabled { opacity: .5; } button:not(:disabled) { cursor: pointer; } section { margin: 24px 0; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; } .stats div { background: var(--bg-subtle); padding: 16px; border-radius: 6px; } .stats span { display: block; color: var(--text-muted); } .stats strong { display: block; font-size: 23px; font-variant-numeric: tabular-nums; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 24px; }
.table-wrap { overflow: auto; max-height: 480px; } table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; white-space: nowrap; } th, td { padding: 7px 12px; border-bottom: 1px solid var(--border-muted); text-align: right; } th { position: sticky; top: 0; background: var(--bg-subtle); } th:first-child, td:first-child { text-align: left; }
figure { margin: 16px 0; } figure svg { width: 100%; max-height: 180px; } figure circle { fill: var(--accent-fg); } figure text { fill: var(--text-muted); font-size: 12px; } [role='alert'] { color: var(--text-danger, #d9534f); }
</style>
