<script setup lang="ts">
/**
 * Settings > Navide Marketplace > Testplace (DX report §9.5, plan
 * mcp-navide-0-2-27 W5b): the tests the user was invited to.
 *
 * Join with a personal invite or a public test code, see each test build with
 * its expiry and the review it had, install it through the same verified
 * install flow and trust dialog as the Navide Marketplace, and leave. The
 * Registry calls carry the user's Navide Cloud account, which the Host keeps;
 * this page sees listings and errors only.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNotify } from '@navide/plugin-ui/foundation'
import { usePluginInventory } from '../composables/usePluginInventory'
import { ipcErrorMessage, usePluginInstallFlow } from '../composables/usePluginInstallFlow'
import { revealInvisibleText as reveal } from '../../../shared/pluginAgentTools'
import { testplaceDaysLeft } from '../lib/pluginSourceMark'
import type { DeveloperPublicState } from '../../../shared/marketplaceDeveloper'
import MarketplaceIcon from './MarketplaceIcon.vue'
import PluginSourceBadge from './PluginSourceBadge.vue'
import PluginTrustDialog from './PluginTrustDialog.vue'

const { t } = useI18n()
const notify = useNotify()
const { installed, refresh: refreshInstalled } = usePluginInventory()
const installFlow = usePluginInstallFlow()

const account = ref<DeveloperPublicState | null>(null)
const tests = ref<TestplaceListing[]>([])
const code = ref('')
const busy = ref(false)
const error = ref('')

const signedIn = computed(() => !!account.value && (account.value.signedIn.account || account.value.signedIn.publisher))
const installedById = computed(() => new Map(installed.value.map((plugin) => [plugin.id, plugin])))

const ERROR_KEYS: Record<string, string> = {
  NOT_SIGNED_IN: 'notSignedIn',
  TOKEN_MISSING: 'notSignedIn',
  TOKEN_INVALID: 'notSignedIn',
  TOKEN_REVOKED: 'notSignedIn',
  TOKEN_EXPIRED: 'notSignedIn',
  NOT_FOUND: 'notFound',
  CODE_FULL: 'codeFull',
  BAD_CODE: 'badCode',
}

/** The Host's `TESTPLACE_ERROR [code]: message`, translated when the code is known. */
function errorText(err: unknown): string {
  const text = ipcErrorMessage(err)
  const match = /TESTPLACE_ERROR \[([A-Z0-9_]+)\]: ?(.*)$/s.exec(text)
  if (!match) return text
  const key = ERROR_KEYS[match[1]]
  return key ? t(`testplace.error.${key}`) : t('testplace.error.other', { error: `${match[1]} ${match[2]}`.trim() })
}

/** The newest test build this computer can install, if any. */
function newest(test: TestplaceListing): TestplaceListing['versions'][number] | null {
  return test.versions.find((version) => version.installable) ?? null
}

async function refresh(): Promise<void> {
  error.value = ''
  try {
    account.value = (await window.agentTeam?.developer?.state()) ?? null
  } catch {
    account.value = null
  }
  if (!signedIn.value) {
    tests.value = []
    return
  }
  try {
    tests.value = (await window.agentTeam?.plugins?.testplaceList?.()) ?? []
  } catch (err) {
    error.value = errorText(err)
  }
}

async function signIn(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    account.value = (await window.agentTeam?.developer?.signIn('account')) ?? null
  } catch (err) {
    error.value = ipcErrorMessage(err)
  } finally {
    busy.value = false
  }
  await refresh()
}

async function join(): Promise<void> {
  const joinTest = window.agentTeam?.plugins?.testplaceJoin
  if (!joinTest || !code.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    const { id } = await joinTest(code.value)
    code.value = ''
    notify.toast(t('testplace.joined', { id: reveal(id) }), { type: 'success' })
    await refresh()
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = false
  }
}

async function leave(test: TestplaceListing): Promise<void> {
  const leaveTest = window.agentTeam?.plugins?.testplaceLeave
  if (!leaveTest) return
  const confirmed = await notify.confirm(t('testplace.leaveConfirm', { id: reveal(test.id) }), {
    title: t('testplace.leaveTitle'),
    confirmText: t('testplace.leave'),
    danger: true,
  })
  if (!confirmed) return
  busy.value = true
  error.value = ''
  try {
    await leaveTest(test.id)
    await refresh()
  } catch (err) {
    error.value = errorText(err)
  } finally {
    busy.value = false
  }
}

async function install(test: TestplaceListing, version: string): Promise<void> {
  await installFlow.install(test.namespace, test.name, version, { testplace: true })
  if (installFlow.error.value) installFlow.error.value = errorText(installFlow.error.value)
  await refreshInstalled()
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <div class="tp-pane">
    <section class="tp-section">
      <h2 class="tp-title">{{ $t('testplace.title') }}</h2>
      <p class="tp-muted">{{ $t('testplace.intro') }}</p>
      <div v-if="account && !signedIn" class="tp-row">
        <p class="tp-notice">{{ $t('testplace.signInNeeded') }}</p>
        <button class="nv-btn nv-btn--primary nv-btn--sm" :disabled="busy" @click="signIn">
          {{ busy ? $t('marketplace-developer.account.waiting') : $t('marketplace-developer.account.sign-in') }}
        </button>
      </div>
      <form v-else-if="signedIn" class="tp-join" @submit.prevent="join">
        <label class="tp-label" for="tp-join-code">{{ $t('testplace.joinLabel') }}</label>
        <div class="tp-row">
          <input
            id="tp-join-code"
            v-model="code"
            class="nv-input tp-join-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :placeholder="$t('testplace.joinPlaceholder')"
          />
          <button class="nv-btn nv-btn--primary nv-btn--sm" type="submit" :disabled="busy || !code.trim()">{{ $t('testplace.join') }}</button>
          <button class="nv-btn nv-btn--ghost nv-btn--sm" type="button" :disabled="busy" @click="refresh">{{ $t('testplace.refresh') }}</button>
        </div>
      </form>
    </section>

    <p v-if="error" class="tp-error" role="alert">{{ error }}</p>
    <p v-if="installFlow.error.value" class="tp-error" role="alert">{{ installFlow.error.value }}</p>

    <ul v-if="signedIn" class="tp-list">
      <li v-for="test in tests" :key="test.id" class="tp-card" :data-testplace-id="test.id">
        <MarketplaceIcon :namespace="test.namespace" :name="test.name" :label="test.displayName || test.name" :size="36" />
        <div class="tp-card-main">
          <div class="tp-card-title">
            <span class="tp-name">{{ reveal(test.displayName || test.id) }}</span>
            <span class="tp-muted">{{ reveal(test.publisher) }}</span>
            <span v-if="test.via" class="tp-chip">{{ $t(test.via === 'invite' ? 'testplace.viaInvite' : 'testplace.viaCode') }}</span>
          </div>
          <p v-if="test.description" class="tp-muted">{{ reveal(test.description) }}</p>
          <template v-if="newest(test)">
            <PluginSourceBadge row source="testplace" :expires-at="newest(test)!.expiresAt" :via="test.via" />
            <p v-if="testplaceDaysLeft(newest(test)!.expiresAt) !== null" class="tp-notice" role="status">
              {{ $t('testplace.expiring', { days: testplaceDaysLeft(newest(test)!.expiresAt), date: (newest(test)!.expiresAt ?? '').slice(0, 10) }) }}
            </p>
          </template>
          <p v-else-if="test.versions.length" class="tp-muted">{{ $t('testplace.notForThisComputer') }}</p>
          <p v-else class="tp-muted">{{ $t('testplace.noVersion') }}</p>
        </div>
        <div class="tp-actions">
          <span v-if="installedById.get(test.id)?.packageVersion" class="tp-chip">
            {{ $t('testplace.installedVersion', { version: installedById.get(test.id)!.packageVersion }) }}
          </span>
          <button
            v-if="newest(test) && installedById.get(test.id)?.packageVersion !== newest(test)!.version"
            class="nv-btn nv-btn--primary nv-btn--sm"
            :disabled="busy || installFlow.busy.value"
            @click="install(test, newest(test)!.version)"
          >{{ $t('testplace.install', { version: newest(test)!.version }) }}</button>
          <button class="nv-btn nv-btn--ghost nv-btn--sm" :disabled="busy" @click="leave(test)">{{ $t('testplace.leave') }}</button>
        </div>
      </li>
      <li v-if="tests.length === 0" class="tp-muted tp-empty">{{ $t('testplace.empty') }}</li>
    </ul>

    <PluginTrustDialog
      v-if="installFlow.pendingConfirm.value"
      :pending="installFlow.pendingConfirm.value"
      :step="installFlow.pendingStep.value"
      @confirm-replace="installFlow.confirmReplace"
      @confirm-publisher="installFlow.confirmPublisher"
      @confirm-risk="installFlow.confirmRisk"
      @cancel="installFlow.cancel"
    />
  </div>
</template>

<style scoped>
.tp-pane { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-4) var(--space-5); }
.tp-section { display: flex; flex-direction: column; gap: var(--space-2); }
.tp-title { margin: 0; font-size: var(--font-md); color: var(--text-bright); }
.tp-muted { margin: 0; color: var(--text-secondary); font-size: var(--font-xs); }
.tp-notice { margin: 0; font-size: var(--font-xs); color: var(--text-primary); }
.tp-error { margin: 0; color: var(--danger-bright); font-size: var(--font-xs); white-space: pre-wrap; }
.tp-row { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.tp-join { display: flex; flex-direction: column; gap: var(--space-1, 4px); }
.tp-label { font-size: var(--font-xs); color: var(--text-secondary); }
.tp-join-input { flex: 1 1 260px; min-width: 0; }
.tp-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--space-2); }
.tp-card { display: flex; gap: var(--space-3); align-items: flex-start; padding: var(--space-3); border: 1px solid var(--border-default); border-radius: var(--radius-md); }
.tp-card-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: var(--space-1, 4px); }
.tp-card-title { display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap; }
.tp-name { font-weight: 600; color: var(--text-bright); }
.tp-actions { display: flex; flex-direction: column; align-items: flex-end; gap: var(--space-1, 4px); }
.tp-chip { font-size: var(--font-2xs); padding: 0 6px; border-radius: var(--radius-sm); border: 1px solid var(--border-muted); color: var(--text-secondary); white-space: nowrap; }
.tp-empty { padding: var(--space-2) 0; }
</style>
