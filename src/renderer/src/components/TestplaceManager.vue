<script setup lang="ts">
/**
 * The Testplace manager on Settings > Navide Marketplace > Developer: a
 * package's test builds, sending one to Navide Marketplace review (promote),
 * and its public test codes (create, revoke). Every call is the user's own
 * press; no agent tool reaches it. A created code is shown here once and goes
 * nowhere else.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNotify } from '@navide/plugin-ui/foundation'
import { ipcErrorMessage } from '../composables/usePluginInstallFlow'
import type { DeveloperCallResult, TestplaceManageRequest } from '../../../shared/marketplaceDeveloper'

const { t, te, locale } = useI18n()
const notify = useNotify()

interface TestBuild { version: string; target: string; revoked: boolean; expiresAt: string | null; promotion: string | null; promotionReason: string | null }
interface TestCode { id: string; state: string; testers: number; maxTesters: number; reviewReason: string | null }

const pluginId = ref('')
const loadedId = ref('')
const builds = ref<TestBuild[]>([])
const codes = ref<TestCode[]>([])
const maxTesters = ref(20)
/** The code just created: the Registry returns it once. */
const createdCode = ref('')
const busy = ref(false)
const error = ref('')
const errorDoc = ref<string | null>(null)
watch(error, (text) => {
  if (!text) errorDoc.value = null
}, { flush: 'sync' })

const validId = computed(() => /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(pluginId.value.trim()))
const promotableVersions = computed(() => {
  const seen = new Set<string>()
  return builds.value.filter((b) => !b.revoked && !b.promotion && !seen.has(b.version) && seen.add(b.version))
    .map((b) => b.version)
})

function message(result: DeveloperCallResult): string {
  if (result.ok) return ''
  errorDoc.value = result.doc ?? null
  if (result.code === 'NOT_SIGNED_IN' || result.status === 401) return t('testplace.error.notSignedIn')
  if (result.code === 'QUALIFICATION_REQUIRED' || result.code === 'NAMESPACE_FROZEN') return t('marketplace-developer.error.qualification')
  return t('marketplace-developer.error.registry', { status: result.status, code: result.code ?? '', message: result.message })
}

async function call(id: string, request: TestplaceManageRequest): Promise<Extract<DeveloperCallResult, { ok: true }> | null> {
  const manage = window.agentTeam?.plugins?.testplaceManage
  if (!manage) {
    error.value = t('marketplace-developer.unavailable')
    return null
  }
  try {
    const result = await manage(id, request)
    if (result.ok) return result
    error.value = message(result)
    return null
  } catch (err) {
    error.value = ipcErrorMessage(err)
    return null
  }
}

function formatDate(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(locale.value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

async function load(id = pluginId.value.trim()): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(id)) return
  busy.value = true
  error.value = ''
  createdCode.value = ''
  try {
    const [versions, list] = [await call(id, { action: 'versions' }), await call(id, { action: 'codes' })]
    if (!versions || !list) return
    loadedId.value = id
    const rows = (versions.body as { versions?: Array<Record<string, unknown>> } | null)?.versions ?? []
    builds.value = rows.flatMap((v) => typeof v.version === 'string' ? [{
      version: v.version,
      target: text(v.target) ?? 'universal',
      revoked: v.yanked === true,
      expiresAt: text(v.expires_at),
      promotion: text(v.promotion_status),
      promotionReason: text(v.promotion_reason),
    }] : [])
    const codeRows = (list.body as { codes?: Array<Record<string, unknown>> } | null)?.codes ?? []
    codes.value = codeRows.map((c) => ({
      id: String(c.id ?? ''),
      state: text(c.state) ?? '',
      testers: typeof c.testers === 'number' ? c.testers : 0,
      maxTesters: typeof c.max_testers === 'number' ? c.max_testers : 0,
      reviewReason: text(c.review_reason),
    }))
  } finally {
    busy.value = false
  }
}

async function promote(version: string): Promise<void> {
  const id = loadedId.value
  const confirmed = await notify.confirm(
    t('testplace.manage.promoteConfirm', { plugin: id, version }),
    { title: t('testplace.manage.promote'), confirmText: t('testplace.manage.promote') },
  )
  if (!confirmed) return
  busy.value = true
  error.value = ''
  try {
    if (!(await call(id, { action: 'promote', version }))) return
    notify.toast(t('testplace.manage.promoted', { plugin: id, version }), { type: 'success' })
  } finally {
    busy.value = false
  }
  await load(id)
}

async function createCode(): Promise<void> {
  const id = loadedId.value
  const count = Number(maxTesters.value)
  if (!Number.isInteger(count) || count < 1) return
  busy.value = true
  error.value = ''
  let code = ''
  try {
    const result = await call(id, { action: 'code-create', maxTesters: count })
    if (!result) return
    code = text((result.body as { code?: unknown } | null)?.code) ?? ''
  } finally {
    busy.value = false
  }
  await load(id)
  createdCode.value = code
}

async function revokeCode(row: TestCode): Promise<void> {
  const id = loadedId.value
  const confirmed = await notify.confirm(
    t('testplace.manage.revokeConfirm', { code: row.id }),
    { title: t('testplace.manage.revoke'), confirmText: t('testplace.manage.revoke'), danger: true },
  )
  if (!confirmed) return
  busy.value = true
  error.value = ''
  try {
    if (!(await call(id, { action: 'code-revoke', codeId: row.id }))) return
  } finally {
    busy.value = false
  }
  await load(id)
}

function buildState(build: TestBuild): string {
  if (build.revoked) return t('testplace.manage.state.revoked')
  if (build.promotion) {
    const key = `marketplace-developer.versions.status.${build.promotion}`
    return t('testplace.manage.state.promotion', { status: te(key) ? t(key) : build.promotion })
  }
  return t('testplace.manage.state.expires', { date: formatDate(build.expiresAt) })
}

async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    // The code stays on screen to copy by hand.
  }
}

function openDoc(url: string): void {
  void window.agentTeam?.openExternal?.(url)
}
</script>

<template>
  <div class="tp-manage" data-testid="testplace-manager">
    <div class="dev-field">
      <label for="tp-manage-id">{{ $t('testplace.manage.plugin') }}</label>
      <div class="dev-actions">
        <input id="tp-manage-id" v-model="pluginId" class="nv-input" type="text" placeholder="namespace.name" @keydown.enter="load()" />
        <button class="nv-btn nv-btn--sm" data-testid="testplace-manage-load" :disabled="busy || !validId" @click="load()">{{ $t('testplace.manage.load') }}</button>
      </div>
    </div>

    <template v-if="loadedId">
      <h3 class="tp-manage-title">{{ $t('testplace.manage.builds') }}</h3>
      <p v-if="builds.length === 0" class="dev-muted">{{ $t('testplace.manage.noBuilds') }}</p>
      <table v-else class="dev-table" data-testid="testplace-manage-builds">
        <tbody>
          <tr v-for="build in builds" :key="`${build.version}/${build.target}`">
            <td>{{ build.version }}</td>
            <td>{{ build.target }}</td>
            <td>
              {{ buildState(build) }}
              <div v-if="build.promotionReason" class="dev-muted">{{ build.promotionReason }}</div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="promotableVersions.length" class="dev-actions">
        <button
          v-for="version in promotableVersions"
          :key="version"
          class="nv-btn nv-btn--sm"
          data-testid="testplace-manage-promote"
          :disabled="busy"
          @click="promote(version)"
        >{{ $t('testplace.manage.promoteVersion', { version }) }}</button>
      </div>

      <h3 class="tp-manage-title">{{ $t('testplace.manage.codes') }}</h3>
      <p class="dev-muted">{{ $t('testplace.manage.codesHint') }}</p>
      <table v-if="codes.length" class="dev-table" data-testid="testplace-manage-codes">
        <tbody>
          <tr v-for="row in codes" :key="row.id">
            <td>#{{ row.id }}</td>
            <td>{{ $t('testplace.manage.testers', { count: row.testers, max: row.maxTesters }) }}</td>
            <td>
              {{ row.state }}
              <div v-if="row.reviewReason" class="dev-muted">{{ row.reviewReason }}</div>
            </td>
            <td>
              <button
                v-if="row.state !== 'revoked'"
                class="nv-btn nv-btn--ghost nv-btn--sm"
                data-testid="testplace-manage-revoke"
                :disabled="busy"
                @click="revokeCode(row)"
              >{{ $t('testplace.manage.revoke') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="dev-field">
        <label for="tp-manage-max">{{ $t('testplace.manage.maxTesters') }}</label>
        <div class="dev-actions">
          <input id="tp-manage-max" v-model.number="maxTesters" class="nv-input tp-manage-max" type="number" min="1" step="1" />
          <button class="nv-btn nv-btn--sm" data-testid="testplace-manage-create" :disabled="busy || !(maxTesters >= 1)" @click="createCode">{{ $t('testplace.manage.create') }}</button>
        </div>
      </div>
      <p v-if="createdCode" class="dev-notice" role="status" data-testid="testplace-manage-created">
        {{ $t('testplace.manage.created') }}
        <code class="tp-manage-code">{{ createdCode }}</code>
        <button class="nv-btn nv-btn--ghost nv-btn--sm" @click="copy(createdCode)">{{ $t('testplace.invite.copy') }}</button>
      </p>
    </template>

    <p v-if="error" class="dev-error" role="alert">
      {{ error }}
      <button v-if="errorDoc" class="nv-btn nv-btn--ghost nv-btn--sm" @click="openDoc(errorDoc)">{{ $t('marketplace-developer.error.doc') }}</button>
    </p>
  </div>
</template>

<style scoped>
.tp-manage { display: flex; flex-direction: column; gap: var(--space-2); }
.tp-manage-title { margin: var(--space-2) 0 0; font-size: var(--font-sm); color: var(--text-bright); }
.tp-manage-max { width: 8em; }
.tp-manage-code { word-break: break-all; }
.dev-muted { margin: 0; color: var(--text-secondary); font-size: var(--font-xs); }
.dev-notice { margin: 0; font-size: var(--font-xs); color: var(--text-primary); }
.dev-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.dev-field { display: flex; flex-direction: column; gap: var(--space-1, 4px); font-size: var(--font-xs); }
.dev-field label { color: var(--text-secondary); }
.dev-error { margin: 0; color: var(--danger-bright); font-size: var(--font-xs); white-space: pre-wrap; }
.dev-table { width: 100%; border-collapse: collapse; font-size: var(--font-xs); }
.dev-table td { text-align: left; padding: var(--space-2); border-bottom: 1px solid var(--border-muted); vertical-align: top; }
</style>
