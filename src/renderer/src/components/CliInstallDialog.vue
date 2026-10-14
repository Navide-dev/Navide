<script setup lang="ts">
/**
 * Guided CLI install — the single wizard behind every "this CLI is missing"
 * moment: the backend's pre-spawn probe finding no executable (Open Agent,
 * Resume, Handle Issue, a pipeline stage), a pane exiting 127, picking a
 * not-installed CLI in the spawn dropdown, or the Install button in CLI
 * management.
 *
 * Shaped like the first-run onboarding wizard on purpose — check → install →
 * verify — because the situation is the same one: the environment is not ready
 * and the user needs to be walked through making it ready, not handed a
 * yes/no confirm that goes quiet afterwards. Prerequisites are shown during
 * the check step (not only after an install has already failed), and every
 * failure mode has its own message and its own next action.
 *
 * Everything runnable still comes from the backend registry — this component
 * never composes an install command of its own.
 */
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import type { useBackend } from '../composables/useBackend'
import { useOnboarding, type InstallResult, type OnboardDep } from '../composables/useOnboarding'
import { orderInstalls, providerFor } from '../lib/installPlan'
import InstallTerminal from './InstallTerminal.vue'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  depId: string
  /** Where the prompt came from; only 'pane' offers to start the CLI again. */
  origin?: 'pane' | 'spawn' | 'settings'
  /** Label to show before the backend status arrives (avoids an empty title). */
  fallbackLabel?: string
  /**
   * Sign-in state of this CLI's active account. Three named states, not a
   * boolean: 'unknown' means the CLI keeps no credential file Navide can read,
   * and collapsing that into "signed out" would put a false sign-in step on
   * every CLI Navide cannot inspect.
   *
   * A string rather than `boolean | null` for a second reason: Vue casts an
   * ABSENT boolean prop to `false`, so every caller that omitted it would be
   * declared signed out.
   *
   * Reactive from the opener: when a login lands, this flips and the derived
   * phase below moves to 'done' on its own.
   */
  signInState?: 'signed-in' | 'signed-out' | 'unknown'
}>()

const emit = defineEmits<{
  close: []
  installed: [depId: string]
  relaunch: [depId: string]
  /** Installed but signed out: the opener spawns the vendor's sign-in flow. */
  login: [depId: string]
  /** So the opener can update its own copy without re-running a full probe. */
  'dismiss-changed': [payload: { depId: string; dismissed: boolean }]
}>()

const onboarding = useOnboarding(props.backend)
const {
  deps, installing, installElapsedSec, loading, installPromptDismissed, run, runBusy, runFallback,
} = onboarding

const result = ref<InstallResult | null>(null)
const dontAsk = ref(false)

onMounted(() => { void onboarding.refresh() })
onBeforeUnmount(() => { onboarding.dispose() })

/** Set once the user toggles the box; from then on their choice is the truth. */
let dontAskTouched = false

// Reflect the stored opt-out once status arrives, so the box isn't shown
// unticked to someone who already switched this CLI's prompt off. A status
// answered before the user's own toggle landed must not undo it.
watch(installPromptDismissed, (dismissed) => {
  if (!dontAskTouched) dontAsk.value = dismissed.has(props.depId)
})

const dep = computed<OnboardDep | undefined>(() => deps.value.find((d) => d.id === props.depId))
const label = computed(() => dep.value?.label || props.fallbackLabel || props.depId)
/**
 * Whether the "don't ask again" box applies. A pane or spawn prompt is only
 * ever opened for an agent CLI, so it need not wait for status to say so —
 * waiting left the box missing while status loaded (or forever, if it failed),
 * and "Not now" in that window saved no opt-out at all.
 */
const offersDontAsk = computed(() => dep.value
  ? dep.value.group === 'agent_cli'
  : props.origin === 'pane' || props.origin === 'spawn')

const blockers = computed(() => result.value?.missing_requirements ?? [])

function requirementDep(binary: string): OnboardDep | undefined {
  return providerFor(binary, deps.value)
}

/**
 * Everything that has to be installed, prerequisites first — on a bare Mac,
 * picking a CLI means Homebrew → Node → that CLI. Derived from status, so each
 * finished step drops off the front and `nextStep` becomes the following one
 * without any bookkeeping.
 */
const chain = computed<OnboardDep[]>(() => {
  if (!dep.value) return []
  // An install can report a prerequisite the probe did not know about. Feed
  // those in too, so a late discovery joins the chain instead of falling
  // between the chain and the manual list.
  const late = blockers.value
    .map((name) => requirementDep(name))
    .filter((d): d is OnboardDep => !!d && d.status !== 'ok')
  return orderInstalls([...late, dep.value], deps.value)
})
const nextStep = computed<OnboardDep | undefined>(() => chain.value[0])
/** Position of the pending step in the chain, for "2 of 3" style labels. */
const chainTotal = computed(() => chain.value.length)
/** True while the chain has prerequisites beyond the CLI the user asked for. */
const hasPrerequisites = computed(() => chainTotal.value > 1)

/**
 * The chain link currently installing, if any. This dialog owns its own
 * onboarding instance, so anything in flight there is a link of this chain —
 * often a prerequisite rather than the CLI itself.
 */
const activeLinkId = computed(() => installing.value)
/** Label of the link in progress, falling back to the last one tried. */
const progressLabel = computed(
  () => deps.value.find((d) => d.id === activeLinkId.value)?.label || lastAttemptedLabel.value
)

/**
 * The one place that decides what the user is looking at. Derived rather than
 * assigned, so a re-detect can move the dialog to 'done' without any explicit
 * transition.
 */
const phase = computed<
  'intro' | 'installing' | 'blocked' | 'failed' | 'signin' | 'done'
>(() => {
  // Any link, not only the CLI: while a prerequisite ran the dialog used to
  // sit at 'intro' with Install enabled, and a second press opened a second
  // terminal for the same prerequisite.
  if (installing.value) return 'installing'
  // Installed is not the same as ready. A signed-out CLI passes every check
  // here and then opens its own sign-in prompt in the pane, with nothing in
  // Navide explaining why — so the last step asks for the login instead of
  // declaring success. Only an explicit 'signed-out' qualifies (see the prop).
  if (dep.value?.status === 'ok') return props.signInState === 'signed-out' ? 'signin' : 'done'
  if (blockers.value.length) return 'blocked'
  if (result.value && !result.value.ok) return 'failed'
  return 'intro'
})

const failureText = computed(() => result.value?.error || result.value?.output || '')

// ── Steps (check → install → verify) ────────────────────────────────────────
const STEPS = ['check', 'install', 'verify'] as const
type Step = (typeof STEPS)[number]

/**
 * Prerequisites with their state. The probe reports them up front; a failed
 * install can also name one the probe did not know about, so the two are
 * merged rather than one replacing the other.
 */
const requirementRows = computed<{ name: string; ok: boolean }[]>(() => {
  const rows = (dep.value?.requirements ?? []).map((r) => ({ name: r.name, ok: r.ok }))
  for (const name of blockers.value) {
    const known = rows.find((r) => r.name === name)
    if (known) known.ok = false
    else rows.push({ name, ok: false })
  }
  return rows
})
/**
 * Unmet prerequisites no registry dep provides (`curl`). Everything the app can
 * install itself appears in the ordered chain instead, so the two lists never
 * describe the same thing twice.
 */
const manualRequirements = computed(() => {
  const inChain = new Set(chain.value.map((d) => d.id))
  return requirementRows.value.filter((r) => {
    if (r.ok) return false
    const provider = requirementDep(r.name)
    return !provider || !inChain.has(provider.id)
  })
})

/** Step the user last navigated to; the derived one below can overrule it. */
const requestedStep = ref<Step>('check')

/**
 * Which step is on screen. Derived from what is actually happening, so the
 * wizard follows the install rather than needing to be clicked along: a
 * running install is always the install step, a detected CLI is always verify.
 */
const step = computed<Step>(() => {
  if (dep.value?.status === 'ok') return 'verify'
  if (phase.value === 'installing' || phase.value === 'failed') {
    return 'install'
  }
  return requestedStep.value
})
const stepIndex = computed(() => STEPS.indexOf(step.value))

/**
 * Set once the user starts the chain, so finished steps continue into the next
 * one by themselves. Cleared by any failure — an unattended chain must stop at
 * the first thing that went wrong rather than running on past it.
 */
const advancing = ref(false)
/**
 * Links already tried in this run. A step can report success without becoming
 * detectable (it landed outside PATH, or needs a fresh shell) — without this
 * the chain would see the same unfinished link as "next" and retry it forever.
 * Cleared when the user starts a run, so Retry genuinely retries.
 */
const attempted = ref(new Set<string>())
/**
 * The link the last result belongs to. In a chain that is often a prerequisite
 * rather than the CLI the dialog is titled after, and messages about it must
 * name what was actually installed.
 */
const lastAttemptedId = ref('')
const lastAttempted = computed<OnboardDep | undefined>(
  () => deps.value.find((d) => d.id === lastAttemptedId.value)
)
const lastAttemptedLabel = computed(() => lastAttempted.value?.label || label.value)

/** Install one link of the chain and, when it lands cleanly, the next. */
async function installStep(target: OnboardDep | undefined): Promise<void> {
  if (!target || installing.value) return
  if (attempted.value.has(target.id)) {
    advancing.value = false
    return
  }
  attempted.value.add(target.id)
  lastAttemptedId.value = target.id
  result.value = null
  requestedStep.value = 'install'
  // Resolves once the command has exited in the embedded terminal and a fresh
  // re-detect has run, so what follows judges the machine as it is now.
  const r = await onboarding.install(target)
  result.value = r
  if (!r?.ok) {
    advancing.value = false
    // A blocked install belongs back at the check step: what is wrong is the
    // environment, not the install itself.
    if (r?.missing_requirements?.length) requestedStep.value = 'check'
    return
  }
  if (dep.value?.status === 'ok') {
    emit('installed', props.depId)
    return
  }
  // "Installed" and "detectable" are not the same thing. Carrying on would run
  // the next command against a machine that still cannot see this one — which
  // is exactly the exit-127 failure the chain exists to avoid. Stop instead and
  // let the 'installed but not detected' notice explain it.
  if (deps.value.find((d) => d.id === target.id)?.status !== 'ok') {
    advancing.value = false
    return
  }
  if (advancing.value && nextStep.value) await installStep(nextStep.value)
}

async function runInstall(): Promise<void> {
  // The button is disabled meanwhile; this covers a click landing before the
  // re-render. Starting over here would clear `attempted` and re-run a link.
  if (activeLinkId.value) return
  advancing.value = true
  attempted.value = new Set()
  await installStep(nextStep.value ?? dep.value)
}

/** Closing mid-run would orphan a prompt nobody can answer: Cancel first. */
function close(): void {
  if (runBusy.value) return
  emit('close')
}

async function toggleDontAsk(): Promise<void> {
  dontAskTouched = true
  const ok = await onboarding.dismissInstallPrompt(props.depId, dontAsk.value)
  if (!ok) {
    dontAsk.value = !dontAsk.value
    return
  }
  emit('dismiss-changed', { depId: props.depId, dismissed: dontAsk.value })
}

function relaunch(): void {
  emit('relaunch', props.depId)
  emit('close')
}

/**
 * Hand the sign-in to the opener, which owns the login-pane spawn.
 *
 * The dialog closes: the login runs in a real pane the user has to watch (the
 * vendor opens a browser and waits), and leaving a modal over it would hide
 * exactly the thing they need to see.
 */
function signIn(): void {
  emit('login', props.depId)
  emit('close')
}
</script>

<template>
  <div class="ci-page nv-modal-overlay" @click.self="close">
    <section class="ci-dialog nv-modal-shell nv-modal-shell--standard" role="dialog" aria-modal="true">
      <header class="ci-top">
        <div>
          <div class="ci-kicker">{{ $t('cli-install.kicker') }}</div>
          <h1>{{ $t('cli-install.title', { label }) }}</h1>
        </div>
        <!-- Same step rail as the first-run wizard: the user is in the same
             situation (environment not ready) and gets the same shape of help. -->
        <ol class="ci-steps">
          <li
            v-for="(name, index) in STEPS"
            :key="name"
            :class="{ active: step === name, done: index < stepIndex }"
          >
            <span>{{ index < stepIndex ? '✓' : index + 1 }}</span>
            {{ $t(`cli-install.step.${name}`) }}
          </li>
        </ol>
      </header>

      <main class="ci-main">
        <!-- Step 1 · Check ---------------------------------------------------->
        <template v-if="step === 'check'">
          <h2>{{ $t('cli-install.check-title', { label }) }}</h2>
          <p class="ci-lead">{{ $t('cli-install.lead', { label }) }}</p>

          <section class="ci-card">
            <div class="ci-card-head">
              <strong>{{ label }}</strong>
              <span v-if="dep" :class="['ci-badge', dep.status]">
                {{ $t(`cli-install.status.${dep.status}`) }}
              </span>
              <span v-else class="ci-badge">{{ $t('label.detecting') }}</span>
            </div>
            <p v-if="dep?.description" class="ci-note">{{ dep.description }}</p>
          </section>

          <!-- The whole chain, in order. On a machine that has nothing yet this
               is where the user learns that a CLI means Homebrew → Node → CLI,
               instead of meeting each prerequisite one failure at a time. -->
          <section v-if="hasPrerequisites" class="ci-card">
            <div class="ci-card-label">{{ $t('cli-install.chain-label') }}</div>
            <ol class="ci-chain">
              <li
                v-for="(link, linkIndex) in chain"
                :key="link.id"
                :class="{ next: link.id === nextStep?.id }"
              >
                <span class="ci-chain-index">{{ linkIndex + 1 }}</span>
                <span class="ci-chain-label">{{ link.label }}</span>
                <span class="ci-note">{{ $t('cli-install.requirement-missing') }}</span>
              </li>
            </ol>
            <p class="ci-note">{{ $t('cli-install.chain-desc', { label, count: chainTotal }) }}</p>
          </section>

          <!-- Only prerequisites this app cannot install for the user. Anything
               it can install is a numbered link in the chain above, so the two
               never state the same requirement twice. -->
          <section v-if="manualRequirements.length" class="ci-card blocked">
            <div class="ci-card-label">{{ $t('cli-install.requirements-label') }}</div>
            <ul class="ci-reqs">
              <li v-for="req in manualRequirements" :key="req.name" class="missing">
                <span class="ci-req-mark">!</span>
                <code>{{ req.name }}</code>
                <span class="ci-note">{{ $t('cli-install.requirement-manual', { name: req.name }) }}</span>
              </li>
            </ul>
          </section>

          <!-- What will run, verbatim ---------------------------------------->
          <section v-if="dep && dep.can_install" class="ci-card">
            <div class="ci-card-label">{{ $t('cli-install.command-label') }}</div>
            <code class="ci-command">{{ result?.command || dep.install_cmd }}</code>
            <p class="ci-note">{{ $t('cli-install.note-terminal') }}</p>
          </section>
          <!-- Until the first status arrives `dep` is undefined; without this
               the card claimed the CLI had no install command at all. -->
          <section v-else-if="!dep" class="ci-card">
            <p class="ci-note">{{ $t('label.detecting') }}</p>
          </section>
          <section v-else class="ci-card">
            <p class="ci-note">{{ $t('cli-install.no-install-command', { label }) }}</p>
            <a
              v-if="dep.docs_url"
              class="ci-btn ghost"
              :href="dep.docs_url"
              target="_blank"
              rel="noreferrer"
            >{{ $t('cli-install.docs') }}</a>
          </section>
        </template>

        <!-- Step 2 · Install -------------------------------------------------->
        <template v-else-if="step === 'install'">
          <h2>{{ $t('cli-install.install-title', { label: progressLabel }) }}</h2>

          <section v-if="phase === 'failed'" class="ci-card failed">
            <strong>{{ $t('cli-install.failed-title') }}</strong>
            <pre v-if="failureText" class="ci-error">{{ failureText }}</pre>
            <a
              v-if="dep?.docs_url || result?.docs_url"
              class="ci-btn ghost"
              :href="dep?.docs_url || result?.docs_url"
              target="_blank"
              rel="noreferrer"
            >{{ $t('cli-install.docs') }}</a>
          </section>

          <section v-else-if="!run" class="ci-card">
            <div class="ci-card-label">{{ $t('cli-install.command-label') }}</div>
            <code class="ci-command">{{ result?.command || dep?.install_cmd }}</code>
          </section>

          <!-- The live command: output, prompts, and how it ended. -->
          <InstallTerminal v-if="run || runFallback" :onboarding="onboarding" />

          <!-- Names the link that stayed undetected, which in a chain is often
               a prerequisite rather than the CLI this dialog is titled after. -->
          <p
            v-if="result?.ok && lastAttempted && lastAttempted.status !== 'ok'"
            class="ci-warn"
          >
            {{ $t('cli-install.installed-not-detected', { label: lastAttemptedLabel }) }}
          </p>
        </template>

        <!-- Step 3 · Verify --------------------------------------------------->
        <template v-else>
          <!-- Installed, but with no account behind it. Same step, different
               verdict: the CLI is there, it just cannot do anything yet. -->
          <div v-if="phase === 'signin'" class="ci-verdict">
            <div class="ci-check signin">→</div>
            <h2>{{ $t('cli-install.signin-title', { label }) }}</h2>
            <p class="ci-lead">{{ $t('cli-install.signin-desc', { label }) }}</p>
            <code v-if="dep?.binary_path" class="ci-command">{{ dep.binary_path }}</code>
            <div class="ci-row center">
              <button class="ci-btn primary ci-signin nv-btn nv-btn--primary" @click="signIn">
                {{ $t('cli-install.signin', { label }) }}
              </button>
            </div>
            <p class="ci-hint">{{ $t('cli-install.signin-hint') }}</p>
          </div>
          <div v-else class="ci-verdict">
            <div class="ci-check">✓</div>
            <h2>{{ $t('cli-install.done-title', { label }) }}</h2>
            <p class="ci-lead">
              {{ dep?.version
                ? $t('cli-install.done-desc', { version: dep.version })
                : $t('cli-install.done-desc-no-version') }}
            </p>
            <code v-if="dep?.binary_path" class="ci-command">{{ dep.binary_path }}</code>
            <div class="ci-row center">
              <button
                v-if="origin === 'pane'"
                class="ci-btn primary ci-relaunch nv-btn nv-btn--primary"
                @click="relaunch"
              >
                {{ $t('cli-install.relaunch', { label }) }}
              </button>
            </div>
          </div>
        </template>
      </main>

      <footer class="ci-footer">
        <label v-if="offersDontAsk" class="ci-dont-ask">
          <input v-model="dontAsk" type="checkbox" @change="toggleDontAsk" />
          {{ $t('cli-install.dont-ask', { label }) }}
        </label>
        <span />
        <button class="ci-btn ghost ci-redetect nv-btn" :disabled="loading || !!installing" @click="onboarding.refresh({ fresh: true })">
          {{ loading ? $t('label.detecting') : $t('action.re-detect') }}
        </button>
        <button class="ci-btn ghost ci-close nv-btn" :disabled="runBusy" @click="close">
          {{ step === 'verify' ? $t('cli-install.close') : $t('cli-install.not-now') }}
        </button>
        <button
          v-if="step !== 'verify' && dep && dep.can_install"
          class="ci-btn primary ci-install nv-btn nv-btn--primary"
          :disabled="!!installing || runBusy"
          @click="runInstall"
        >
          <template v-if="phase === 'installing'">
            {{ $t('cli-install.installing', { seconds: installElapsedSec }) }}
          </template>
          <template v-else-if="result">{{ $t('cli-install.retry') }}</template>
          <!-- Name the link being installed, so a chain never asks the user to
               press "Install <the CLI>" and then install something else. -->
          <template v-else-if="hasPrerequisites && nextStep">
            {{ $t('cli-install.install-step', { label: nextStep.label, total: chainTotal }) }}
          </template>
          <template v-else>{{ $t('cli-install.install') }}</template>
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.ci-page {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 142);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
  color: var(--text-primary);
  -webkit-app-region: no-drag;
}
.ci-dialog {
  width: min(var(--modal-w-standard), 92vw);
  max-height: min(680px, calc(100vh - 56px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-base);
  box-shadow: var(--shadow-modal);
}
.ci-top {
  display: flex; align-items: center; justify-content: space-between; gap: 24px;
  padding: 22px 28px 18px; border-bottom: 1px solid var(--border-muted); flex-wrap: wrap;
}
.ci-kicker { color: var(--accent-bright); font-size: var(--font-xs); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.ci-steps { display: flex; gap: 16px; margin: 0; padding: 0; list-style: none; color: var(--text-muted); font-size: var(--font-xs); }
.ci-steps li { display: flex; align-items: center; gap: 6px; }
.ci-steps li span { display: grid; place-items: center; width: 21px; height: 21px; border: 1px solid var(--border-default); border-radius: 50%; }
.ci-steps li.active { color: var(--text-bright); }
.ci-steps li.active span { border-color: var(--accent-bright); color: var(--accent-bright); }
.ci-steps li.done span { border-color: var(--success-emphasis); background: var(--success-emphasis); color: var(--text-on-emphasis); }
.ci-card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ci-badge { font-size: var(--font-2xs); border-radius: 99px; padding: 1px 9px; background: var(--bg-base); color: var(--text-muted); }
.ci-badge.ok { color: var(--success-fg, #2b8a3e); }
.ci-badge.outdated { color: var(--attention-fg); }
.ci-reqs { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ci-reqs li { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; font-size: 12.5px; }
.ci-reqs .ci-note { margin: 0; }
.ci-req-mark {
  display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%;
  background: var(--success-emphasis); color: var(--text-on-emphasis); font-size: var(--font-2xs); flex: none;
}
.ci-reqs li.missing .ci-req-mark { background: var(--attention-fg); }
.ci-chain { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ci-chain li { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--text-muted); }
.ci-chain li.next { color: var(--text-bright); }
.ci-chain .ci-note { margin: 0; margin-left: auto; }
.ci-chain-index {
  display: grid; place-items: center; width: 18px; height: 18px; flex: none;
  border: 1px solid var(--border-default); border-radius: 50%; font-size: 10.5px;
}
.ci-chain li.next .ci-chain-index { border-color: var(--accent-bright); color: var(--accent-bright); }
.ci-btn.small { padding: 3px 9px; font-size: var(--font-xs); margin-left: auto; }
.ci-row.center { justify-content: center; }
h1 { margin: 6px 0 0; color: var(--text-bright); font-size: 22px; }
.ci-desc { margin: 6px 0 0; color: var(--text-muted); font-size: 12.5px; }
.ci-main { padding: 22px 28px; overflow: auto; }
.ci-lead { margin: 0 0 18px; color: var(--text-secondary); line-height: 1.6; }
.ci-card { padding: 14px 16px; margin-bottom: 12px; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-subtle); }
.ci-card.blocked { border-color: var(--attention-fg); }
.ci-card.failed { border-color: var(--danger-fg); }
.ci-card-label { color: var(--text-muted); font-size: var(--font-2xs); letter-spacing: .06em; text-transform: uppercase; }
.ci-command { display: block; margin-top: 8px; color: var(--text-bright); font-size: var(--font-xs); overflow-wrap: anywhere; }
.ci-note { margin: 8px 0 0; color: var(--text-secondary); font-size: 12.5px; line-height: 1.6; }
.ci-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 12px; }
.ci-error {
  margin: 10px 0 12px; padding: 10px 12px; max-height: 180px; overflow: auto;
  border-radius: 8px; background: var(--bg-base); color: var(--text-secondary);
  font-size: 11.5px; line-height: var(--lh-base); white-space: pre-wrap; overflow-wrap: anywhere;
}
.ci-warn { margin: 10px 0 0; color: var(--attention-fg); font-size: 12.5px; line-height: 1.6; }
.ci-verdict { text-align: center; padding: 20px 0 8px; }
.ci-check { display: grid; place-items: center; width: 50px; height: 50px; margin: 0 auto 16px; border-radius: 50%; background: var(--success-emphasis); color: var(--text-on-emphasis); font-size: 24px; }
/* Same medallion, different verdict: installed but not yet usable is a
   next step, not a success — so it must not wear the success green. */
.ci-check.signin { background: var(--accent-emphasis, var(--success-emphasis)); }
.ci-hint { margin: 14px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
h2 { margin: 0 0 8px; color: var(--text-bright); font-size: 19px; }
.ci-footer { display: flex; align-items: center; gap: 10px; margin-top: auto; padding: 14px 28px; border-top: 1px solid var(--border-muted); flex-wrap: wrap; }
.ci-footer span { flex: 1; }
.ci-dont-ask { display: flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: var(--font-xs); cursor: pointer; }
.ci-btn { border: 1px solid var(--border-default); border-radius: var(--radius-sm); padding: 8px 13px; cursor: pointer; color: var(--text-primary); background: var(--bg-subtle); text-decoration: none; font-size: var(--font-sm); transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
.ci-btn.primary { border-color: var(--accent-emphasis); background: var(--accent-emphasis); color: var(--text-on-emphasis); }
.ci-btn.ghost { background: transparent; }
.ci-btn:hover:not(:disabled) { background: var(--bg-hover-strong); border-color: var(--border-strong); }
.ci-btn.primary:hover:not(:disabled) { background: var(--accent-focus); border-color: var(--accent-focus); }
.ci-btn:disabled { opacity: .5; cursor: not-allowed; }
@media (max-width: 620px) {
  .ci-page { padding: 14px; }
  .ci-dialog { width: calc(100vw - 28px); }
  .ci-top, .ci-main, .ci-footer { padding-left: 18px; padding-right: 18px; }
}
</style>
