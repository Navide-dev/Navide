import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { readdir, readlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process'
import {
  BackendPluginError,
  type BackendPluginLaunchSpec,
} from './pluginBackendSupervisor'
import {
  PlansBridgeError,
  type BackendBridgeDispatcher,
  type PlansBridgeContext,
  type PlansBridgePort,
  type PlansBridgeRequest,
  type PlansFilesystemPort,
} from './plansBridge'
import { firstPartyBridgePorts, isFirstPartyAgentToolActivation, isFirstPartyAgentToolPlugin } from './pluginFirstPartyBackends'
import {
  createHostSandboxProbe,
  resolveBackendSandbox,
  sandboxedSpawnProcess,
  type BackendSandboxProbe,
} from './pluginBackendSandbox'
import {
  killEscapedSandboxProcesses,
  defaultStdoutPendingThreshold,
  killSandboxProcessesSync,
  sandboxIdentity,
  watchBackendResources,
  type BackendResourceStatus,
  type BackendResourceWatch,
  type ResourceExceeded,
  type ResourceNotifyMode,
  type ResourceViolation,
  type SandboxIdentity,
} from './pluginBackendResourceWatchdog'
import type { PluginResourceDecision, PluginResourceDecisionRow } from '../../shared/pluginResourceDecision'
import type { NativeBackendStore } from './pluginNativeBackendStore'
import { OFFICIAL_RECEIPT_NAME, type PluginActivationCatalogEntry } from './installedPlugins'
import {
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_RECEIPT_NAME,
  REGISTRY_TRUST_SNAPSHOT_NAME,
} from './pluginInstalledTrust'
import { PLUGIN_QUARANTINE_MARKER } from './pluginInstallPaths'
import { isManifestV2, parseInstalledManifest } from './pluginManifest'
import { parseManifestJson } from './pluginManifestJson'
import type { PluginManifestV2, PluginSystemNamespace } from './pluginManifestV2'
import { HOST_SHELL_EXECUTABLE_ALLOWLIST } from './pluginCapabilityCatalog'
import { canonicalExistingDirectory } from './workspacePathPolicy'
import { revealInvisibleText, validateAgentTools } from '../../shared/pluginAgentTools'
import {
  canonicalContractJson,
  computeDisclosure,
  type DisclosureAgentTool,
  type DisclosureManifestInput,
} from '../../shared/pluginDisclosure'
import type { JsonValue } from './pluginBackendSupervisor'
import { hostStrings, type HostStringTable, type SupportedLocale } from '../hostLocale'

/**
 * Admission control for third-party package backends (every package backend
 * not on the first-party list, pluginFirstPartyBackends.ts: Plans and the
 * browser start outside this gate).
 *
 * A third-party child starts only when ALL of these hold, checked again before
 * every (re)spawn: the global switch is on, the user has not disabled the
 * plugin, the user consented to this exact binary and permission set, the
 * platform sandbox is available, and the crash breaker is closed. The child
 * then runs under the OS sandbox and the resource watchdog, and reaches the
 * Host only through a filesystem bridge limited to its bound workspace and,
 * when it declares `shell: "allowlist"`, the Host shell broker (DB5). The
 * backend never executes anything itself: the broker runs git/gh/glab under the
 * same rules as a view's shell.run. Declared agent tools are part of what the
 * user consents to (backendPermissionsKey) and are listed in the consent
 * dialog. MCP agents reach a third-party method only through a consented agent
 * tool, and only while the "let agents call tools from third-party Navide
 * plugins" switch is on: `agentMethods` stays empty here and agent-tool
 * bindings get their methods from the Host's agent-tool catalog
 * (pluginAgentToolsHost.ts).
 */

export type ThirdPartyBackendInfo = NonNullable<BackendPluginLaunchSpec['thirdParty']>

export type ThirdPartyLaunchSpec = BackendPluginLaunchSpec & { thirdParty: ThirdPartyBackendInfo }

export function isThirdPartyLaunchSpec(activation: BackendPluginLaunchSpec): activation is ThirdPartyLaunchSpec {
  return activation.thirdParty !== undefined
}

/** Read the Host-owned manifest of an installed v2 package. */
export function readInstalledManifestV2(packageDir: string): PluginManifestV2 {
  const manifest = parseInstalledManifest(parseManifestJson(readFileSync(join(packageDir, 'manifest.json'), 'utf8')))
  if (!isManifestV2(manifest)) throw new Error('third-party backend requires a Manifest v2 package')
  return manifest
}

/**
 * The agent tools a manifest declares, with their disclosure `permissions`,
 * or null when it declares none. `backend.agentTools` is read defensively
 * from the parsed manifest: a package whose declaration fails any contract
 * rule (validateAgentTools) contributes no tools at all.
 */
export function declaredAgentTools(manifest: PluginManifestV2): Pick<ThirdPartyBackendInfo, 'agentTools' | 'permissions'> | null {
  const declared = (manifest.backend as { agentTools?: unknown } | undefined)?.agentTools
  if (declared === undefined) return null
  const errors = validateAgentTools({ id: manifest.id, backend: manifest.backend })
  if (errors.length > 0 || !Array.isArray(declared) || declared.length === 0) {
    if (errors.length > 0) {
      console.warn(`[plugin-backend] ${manifest.id} declares invalid agent tools: ${errors.map((error) => error.code).join(', ')}`)
    }
    return null
  }
  const disclosure = computeDisclosure(manifest as unknown as DisclosureManifestInput)
  return { agentTools: disclosure.agentTools, permissions: disclosure.permissions }
}

/** Project one installed package's backend into a sandboxed launch spec. The
 * method/event allowlists come from the manifest; the bridge ports are the
 * workspace filesystem when the package declares `fs`, and the Host shell
 * broker when it declares `shell: "allowlist"`. A backend that declares no
 * methods can never be called, so it is never started. */
export function thirdPartyBackendLaunchSpec(
  activation: PluginActivationCatalogEntry,
  manifest: PluginManifestV2 = readInstalledManifestV2(activation.packageDir),
): ThirdPartyLaunchSpec | null {
  if (!activation.backend || !manifest.backend || manifest.id !== activation.pluginId) return null
  if (!manifest.backend.methods?.length) return null
  const system = [...(manifest.permissions.system ?? [])]
  const agentTools = declaredAgentTools(manifest)
  return {
    pluginId: activation.pluginId,
    packageVersion: activation.packageVersion,
    packageDir: activation.packageDir,
    entryFile: activation.backend.entryFile,
    protocolVersion: activation.backend.protocolVersion,
    activation: activation.backend.activation,
    approvedMethods: [...(manifest.backend.methods ?? [])],
    agentMethods: [],
    approvedEvents: [...(manifest.backend.events ?? [])],
    approvedBridgePorts: [
      ...(system.includes('fs') ? ['filesystem' as const] : []),
      ...(manifest.permissions.shell === 'allowlist' ? ['shell' as const] : []),
    ],
    thirdParty: {
      name: manifest.name,
      system,
      ...(manifest.permissions.shell ? { shell: manifest.permissions.shell } : {}),
      ...(agentTools ?? {}),
    },
  }
}

/** The DB3 record of a first-party agent tool stands in this field for the
 *  native-backend consent time a third-party one is bound to. It is never a
 *  timestamp, so no consent ever matches it. */
const FIRST_PARTY_WRITE_GRANT = 'first-party'

/** The system permission a first-party bridge port needs in the manifest. */
const FIRST_PARTY_PORT_NAMESPACE: Partial<Record<PlansBridgePort, PluginSystemNamespace>> = {
  filesystem: 'fs',
  web: 'web',
}

/**
 * Project a first-party package backend other than Plans (pluginFirstPartyBackends.ts)
 * into a launch spec. It has no `thirdParty` part, so it never goes through
 * the third-party admission gate: it starts like Plans, without the global
 * switch, per-version consent or OS sandbox. Its methods and events come from
 * its manifest; its bridge ports are the ones the first-party list gives it,
 * each only when the manifest declares the matching system permission. Agents
 * reach it only through agent tools: `agentMethods` stays empty. Only a
 * package the Official Registry installed is projected; any other yields null.
 */
export function firstPartyBackendLaunchSpec(
  activation: PluginActivationCatalogEntry,
  manifest?: PluginManifestV2,
): BackendPluginLaunchSpec | null {
  if (!isFirstPartyAgentToolActivation(activation) || !activation.backend) return null
  const parsed = manifest ?? readInstalledManifestV2(activation.packageDir)
  if (!parsed.backend || parsed.id !== activation.pluginId || !parsed.backend.methods?.length) return null
  const system = parsed.permissions.system ?? []
  return {
    pluginId: activation.pluginId,
    packageVersion: activation.packageVersion,
    packageDir: activation.packageDir,
    entryFile: activation.backend.entryFile,
    protocolVersion: activation.backend.protocolVersion,
    activation: activation.backend.activation,
    approvedMethods: [...parsed.backend.methods],
    agentMethods: [],
    approvedEvents: [...(parsed.backend.events ?? [])],
    approvedBridgePorts: (firstPartyBridgePorts(activation.pluginId) ?? []).filter((port) => {
      const namespace = FIRST_PARTY_PORT_NAMESPACE[port]
      return namespace !== undefined && system.includes(namespace)
    }),
  }
}

/**
 * The agent-tool catalog entry of a first-party backend (PluginAgentToolsHost):
 * its launch spec plus the name, system permissions and declared agent tools
 * the catalog and the per-call checks read. It describes the package only;
 * the backend actually registered is {@link firstPartyBackendLaunchSpec}, and
 * the Host never admits this object through the third-party gate.
 */
export function firstPartyAgentToolSpec(
  activation: PluginActivationCatalogEntry,
  manifest?: PluginManifestV2,
): ThirdPartyLaunchSpec | null {
  if (!isFirstPartyAgentToolActivation(activation) || !activation.backend) return null
  const parsed = manifest ?? readInstalledManifestV2(activation.packageDir)
  const launch = firstPartyBackendLaunchSpec(activation, parsed)
  const agentTools = launch ? declaredAgentTools(parsed) : null
  if (!launch || !agentTools) return null
  return {
    ...launch,
    thirdParty: { name: parsed.name, system: [...(parsed.permissions.system ?? [])], ...agentTools },
  }
}

/**
 * The methods an MCP agent may reach on one third-party backend: the methods
 * of its declared agent tools, and only while the master switch is on and the
 * user's consent matches this exact package. Anything else yields `[]`, which
 * is what every third-party backend has on main.
 */
export function consentedAgentMethods(
  spec: ThirdPartyLaunchSpec,
  gates: { masterSwitch: boolean; consentMatches: boolean },
): string[] {
  if (!gates.masterSwitch || !gates.consentMatches) return []
  return [...new Set((spec.thirdParty.agentTools ?? []).map((tool) => tool.method))].sort()
}

/** SHA-256 of the canonical spelling of the disclosure's `agentTools` array.
 * Any change to any tool (name, method, risk, text, schema, timeout) changes it. */
export function agentToolsDigest(agentTools: readonly DisclosureAgentTool[]): string {
  return createHash('sha256').update(canonicalContractJson(agentTools)).digest('hex')
}

/** Canonical permission set a consent is bound to. The agent tools digest is
 * part of it only when the package declares tools, so a package without them
 * keeps the key (and the consent records) it had before agent tools existed. */
export function backendPermissionsKey(spec: ThirdPartyLaunchSpec): string {
  const agentTools = spec.thirdParty.agentTools ?? []
  return JSON.stringify({
    system: [...spec.thirdParty.system].sort(),
    shell: spec.thirdParty.shell ?? null,
    methods: [...spec.approvedMethods].sort(),
    events: [...spec.approvedEvents].sort(),
    ...(agentTools.length > 0 ? { agentTools: agentToolsDigest(agentTools) } : {}),
  })
}

/** A declared agent tool whose name an earlier package already holds. */
export interface AgentToolNameCollision {
  name: string
  /** Plugin id of the package that holds the name. */
  heldBy: string
}

export interface AgentToolNameClaimant {
  pluginId: string
  /** When the package began declaring agent tools (ISO 8601); unknown sorts last. */
  since?: string
  /** Per name, when a consented version first declared it; overrides `since`. */
  sinceByName?: Readonly<Record<string, string>>
  names: readonly string[]
}

/**
 * DB1: when two packages declare the same tool name, the one whose consent
 * first covered that name holds it and the later one's tool stays offline
 * (sync state `name-collision`). The order is per name, so a name an update
 * adds ranks from that update and cannot take over one another package
 * already holds. Ties fall back to plugin id order, so the answer never
 * depends on the order the packages are listed in.
 */
export function agentToolNameCollisions(
  claimants: readonly AgentToolNameClaimant[],
): Map<string, AgentToolNameCollision[]> {
  const byName = new Map<string, Array<{ pluginId: string; since?: string }>>()
  for (const claimant of claimants) {
    for (const name of claimant.names) {
      const since = claimant.sinceByName?.[name] ?? claimant.since
      byName.set(name, [...(byName.get(name) ?? []), { pluginId: claimant.pluginId, since }])
    }
  }
  const collisions = new Map<string, AgentToolNameCollision[]>()
  for (const claimant of claimants) {
    for (const name of claimant.names) {
      const [holder] = [...(byName.get(name) ?? [])].sort((left, right) => {
        if (left.since !== right.since) {
          if (left.since === undefined) return 1
          if (right.since === undefined) return -1
          return left.since < right.since ? -1 : 1
        }
        return left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 : 0
      })
      if (holder && holder.pluginId !== claimant.pluginId) {
        collisions.set(claimant.pluginId, [...(collisions.get(claimant.pluginId) ?? []), { name, heldBy: holder.pluginId }])
      }
    }
  }
  return collisions
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** Files the Host itself writes into an installed package directory. They
 * are not author content (the installer refuses them in an archive). */
const HOST_OWNED_PACKAGE_FILES = new Set([
  OFFICIAL_RECEIPT_NAME,
  REGISTRY_RECEIPT_NAME,
  REGISTRY_ARTIFACT_NAME,
  REGISTRY_TRUST_SNAPSHOT_NAME,
  PLUGIN_QUARANTINE_MARKER,
  '.navide-backend-activation.json',
])

/**
 * Digest of the whole package: every regular file's relative path and
 * content, sorted. Consent binds to this. A narrower "native files only"
 * digest is not enough: a backend can read any package file (an asset, a
 * script, bytecode), decode it into its data directory and load it as code,
 * so any changed file can change what runs. A version that only changes
 * frontend files therefore asks again too.
 */
export async function packageContentDigest(packageDir: string): Promise<string> {
  const entries: Array<[string, string]> = []
  const pending = ['']
  while (pending.length > 0) {
    const relative = pending.pop()!
    for (const entry of await readdir(join(packageDir, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (!relative && HOST_OWNED_PACKAGE_FILES.has(entry.name)) continue
      if (entry.isDirectory()) {
        // Directory names are author content too (the installer extracts
        // empty directories), so they count even when empty.
        entries.push([child, 'dir'])
        pending.push(child)
      } else if (entry.isSymbolicLink()) {
        // The installer refuses links; should one exist, its target counts.
        entries.push([child, `link:${await readlink(join(packageDir, child))}`])
      } else if (entry.isFile()) {
        entries.push([child, await sha256File(join(packageDir, child))])
      } else {
        entries.push([child, 'special'])
      }
    }
  }
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

export type NativeBackendStatus =
  | 'ready'
  | 'disabled-globally'
  | 'disabled'
  | 'needs-consent'
  | 'sandbox-unavailable'
  | 'shell-not-allowed'
  | 'stopped-after-crashes'
  | 'unavailable'

/** One declared agent tool as the Extensions page shows it. */
export interface NativeBackendAgentToolRow {
  name: string
  title: string
  description: string
  risk: DisclosureAgentTool['risk']
  timeoutMs: number
  method: string
  /** The whole input schema the agent reads in tools/list. */
  inputSchema: Record<string, unknown>
  /** Set when an earlier package holds this name: the tool stays offline. */
  collidesWith?: string
  /** On the holder: the later packages that also declare this name. */
  sharedWith?: string[]
}

export interface NativeBackendStatusRow {
  pluginId: string
  packageVersion: string
  name: string
  status: NativeBackendStatus
  reason?: string
  /** Declared agent tools; absent when the package declares none. */
  agentTools?: NativeBackendAgentToolRow[]
  /** Consent exists but for another binary or permission set. */
  changedSinceConsent: boolean
  canWriteWorkspace: boolean
  workspaceWrite: string[]
  lastViolation?: ResourceViolation
  /** Declared shell mode, so the panel keeps the high-risk grant visible. */
  shell?: 'allowlist' | 'full'
}

/** One view's child stdout waiting for a newline, from the backend usage
 *  (#375 adds `views[].child.stdoutPending`); 0 where the field is absent or
 *  malformed, so it reads nothing before #375 lands. Each child has its own
 *  watch, so only that view's child is read (review MED-1 on #386). */
export function stdoutPendingOf(
  usage: { views: ReadonlyArray<{ pluginId: string; instanceId: string; child: unknown }> },
  pluginId: string,
  instanceId: string,
): number {
  const view = usage.views.find((entry) => entry.pluginId === pluginId && entry.instanceId === instanceId)
  if (!view || typeof view.child !== 'object' || view.child === null) return 0
  const pending = (view.child as { stdoutPending?: unknown }).stdoutPending
  const bytes = typeof pending === 'object' && pending !== null ? (pending as { bytes?: unknown }).bytes : undefined
  return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : 0
}

/** A third-party backend went over a resource threshold and waits for the
 *  user's Stop or Keep running (contract 5.2). It stays listed until answered
 *  or until that backend exits; it is not kept across a restart. */
export interface BackendResourceNotice {
  id: string
  pluginId: string
  name: string
  packageVersion: string
  item: ResourceViolation
  /** memory and disk in bytes, processes a count, cpu in cores. */
  usage: number
  threshold: number
  at: number
}

export interface NativeBackendConsentPrompt {
  pluginId: string
  name: string
  packageVersion: string
  system: PluginSystemNamespace[]
  /** Declared shell mode; `allowlist` is disclosed as high risk (DB5). */
  shell?: 'allowlist' | 'full'
  methods: string[]
  /** Declared agent tools, listed in the dialog; empty when there are none. */
  agentTools: DisclosureAgentTool[]
  /** A consent existed for a different binary or permission set. */
  update: boolean
}

interface NativeBackendConsentStrings {
  title: string
  messageNew: (name: string) => string
  messageUpdate: (name: string, version: string) => string
  sandbox: string
  sandboxWithShell: string
  readFiles: string
  readFilesSeparateWrite: string
  noFiles: string
  shell: string
  methods: (list: string) => string
  noMethods: string
  disable: string
  notNow: string
  allow: string
  separator: string
  agentToolsIntro: (count: number, name: string, bytes: number) => string
  agentTool: (tool: string, method: string, write: boolean, seconds: number, description: string) => string
  agentToolSchema: string
  agentToolsOutro: string
}

/** Plan B D-g: the dialog in the user's language (main has no i18n of its
 * own; see menuStrings.ts), now also listing the methods the backend serves.
 * The en-US wording is unchanged except the Settings page name. */
const NATIVE_BACKEND_CONSENT_STRINGS: HostStringTable<NativeBackendConsentStrings> = {
  'en-US': {
    title: 'Native code',
    messageNew: (name) => `${name} contains native code that runs on your computer. Allow it to run?`,
    messageUpdate: (name, version) => `${name} ${version} changed its native code or permissions. Allow it to run?`,
    sandbox: 'Navide runs it in a sandbox: it has no network access and cannot read your home folder.',
    sandboxWithShell: 'Navide runs it in a sandbox: it cannot open network connections itself and cannot read your home folder.',
    readFiles: 'It asks to read files in the workspace you open it in.',
    readFilesSeparateWrite: 'It asks to read files in the workspace you open it in. Changing files needs your separate permission.',
    noFiles: 'It asks for no access to your files.',
    shell: 'High risk: it also asks to run git, gh and glab commands in that workspace through the Navide command broker. '
      + 'Through them it can contact network hosts (for example git push or fetch to any URL, or gh api) and send data from '
      + 'this workspace to them, and it can change the repository. '
      + 'Through git it can read and change files tracked in this workspace and delete untracked files, without the separate file-change permission. '
      + 'Commands it has already started when you disable it or revoke its permission run to completion (up to about 30 seconds).',
    methods: (list) => `Methods it serves: ${list}.`,
    noMethods: 'It declares no methods.',
    disable: 'You can disable it at any time in Settings → Navide Plugins.',
    agentToolsIntro: (count, name, bytes) =>
      `Agents will be able to call these ${count} tools of ${name} (their text and input schemas total ${bytes} bytes):`,
    agentTool: (tool, method, write, seconds, description) =>
      `• ${tool} → ${method} (declared ${write ? 'as changing data' : 'read-only'}, times out after ${seconds} s): ${description}`,
    agentToolSchema: 'Input schema: ',
    agentToolsOutro: 'What these tools return is shown to the agent, which may pass it on elsewhere.',
    notNow: 'Not now',
    allow: 'Allow',
    separator: ', ',
  },
  'zh-TW': {
    title: '原生程式',
    messageNew: (name) => `${name} 含有會在你電腦上執行的原生程式。要允許它執行嗎？`,
    messageUpdate: (name, version) => `${name} ${version} 的原生程式或權限有變更。要允許它執行嗎？`,
    sandbox: 'Navide 會在沙盒裡執行它：它不能連網，也不能讀取你的家目錄。',
    sandboxWithShell: 'Navide 會在沙盒裡執行它：它自己不能建立網路連線，也不能讀取你的家目錄。',
    readFiles: '它要求讀取你開啟它的工作區裡的檔案。',
    readFilesSeparateWrite: '它要求讀取你開啟它的工作區裡的檔案。修改檔案需要你另外允許。',
    noFiles: '它沒有要求存取你的檔案。',
    shell: '高風險：它也要求透過 Navide 的指令仲介，在這個工作區執行 git、gh、glab 指令。'
      + '透過這些指令，它可以連到網路主機（例如 git push 或 fetch 到任何網址，或 gh api），把這個工作區的資料送過去，也可以修改儲存庫。'
      + '透過 git，它不需要另外的修改檔案權限，就能讀取、修改這個工作區裡受版本控制的檔案，並刪除未受版本控制的檔案。'
      + '你停用它或撤銷權限時，已經開始執行的指令會執行完畢（最多約 30 秒）。',
    methods: (list) => `它提供的方法：${list}。`,
    noMethods: '它沒有宣告任何方法。',
    disable: '你隨時可以在「設定 → Navide 外掛」停用它。',
    agentToolsIntro: (count, name, bytes) =>
      `agent 將可以呼叫 ${name} 的這 ${count} 個工具（文字和輸入結構描述共 ${bytes} 位元組）：`,
    agentTool: (tool, method, write, seconds, description) =>
      `• ${tool} → ${method}（外掛宣告為${write ? '寫入' : '唯讀'}，${seconds} 秒後逾時）：${description}`,
    agentToolSchema: '輸入結構描述：',
    agentToolsOutro: '這些工具回傳的內容會交給 agent，agent 可能再把它傳到別處。',
    notNow: '暫不',
    allow: '允許',
    separator: '、',
  },
  'ja-JP': {
    title: 'ネイティブコード',
    messageNew: (name) => `${name} にはこのコンピューターで実行されるネイティブコードが含まれています。実行を許可しますか？`,
    messageUpdate: (name, version) => `${name} ${version} のネイティブコードまたは権限が変更されました。実行を許可しますか？`,
    sandbox: 'Navide はこれをサンドボックスで実行します。ネットワークには接続できず、ホームフォルダも読み取れません。',
    sandboxWithShell: 'Navide はこれをサンドボックスで実行します。自分ではネットワーク接続を開けず、ホームフォルダも読み取れません。',
    readFiles: '開いたワークスペース内のファイルの読み取りを求めています。',
    readFilesSeparateWrite: '開いたワークスペース内のファイルの読み取りを求めています。ファイルの変更には別途あなたの許可が必要です。',
    noFiles: 'ファイルへのアクセスは求めていません。',
    shell: '高リスク：Navide のコマンド仲介を通じて、このワークスペースで git・gh・glab コマンドを実行することも求めています。'
      + 'これらを通じてネットワーク上のホストに接続し（例：任意の URL への git push や fetch、gh api）、このワークスペースのデータを送ったり、リポジトリを変更したりできます。'
      + 'git を通じて、別途のファイル変更の許可なしに、このワークスペースで追跡されているファイルを読み取り・変更し、追跡されていないファイルを削除できます。'
      + '無効化や権限の取り消しの時点ですでに開始したコマンドは、最後まで実行されます（最大約 30 秒）。',
    methods: (list) => `提供するメソッド：${list}。`,
    noMethods: 'メソッドを宣言していません。',
    disable: '「設定 → Navide プラグイン」でいつでも無効にできます。',
    agentToolsIntro: (count, name, bytes) =>
      `agent は ${name} のこれら ${count} 個のツールを呼び出せるようになります（テキストと入力スキーマの合計 ${bytes} バイト）：`,
    agentTool: (tool, method, write, seconds, description) =>
      `• ${tool} → ${method}（プラグインの宣言：${write ? '書き込み' : '読み取り専用'}、${seconds} 秒でタイムアウト）：${description}`,
    agentToolSchema: '入力スキーマ：',
    agentToolsOutro: 'これらのツールが返す内容は agent に渡され、agent がそれを別の場所に渡すことがあります。',
    notNow: '今はしない',
    allow: '許可',
    separator: '、',
  },
}

/** The declared agent tools, each with the method it calls, its full
 * description, the plugin's own read/write claim, its timeout and its whole
 * input schema: allowing the backend also allows agents to call these. */
function nativeBackendAgentToolsText(prompt: NativeBackendConsentPrompt, s: NativeBackendConsentStrings): string {
  if (prompt.agentTools.length === 0) return ''
  return [
    s.agentToolsIntro(prompt.agentTools.length, prompt.name, Buffer.byteLength(JSON.stringify(prompt.agentTools))),
    ...prompt.agentTools.map((tool) => [
      s.agentTool(tool.name, tool.method, tool.risk === 'write', tool.timeoutMs / 1000, tool.description),
      // Keys and enum values may hold invisible characters (never refused):
      // spelled out so they cannot reorder or hide the dialog's text.
      `  ${s.agentToolSchema}${revealInvisibleText(JSON.stringify(tool.inputSchema))}`,
    ].join('\n')),
    s.agentToolsOutro,
  ].join('\n')
}

/** The native-backend consent dialog's text. A package that declares shell
 * reaches the network through git/gh/glab (push, fetch, `gh api`), so the
 * "no network access" sentence is only true without shell: saying it there
 * would deceive the user (anti-deception, not a restriction). */
export function nativeBackendConsentText(
  prompt: NativeBackendConsentPrompt,
  locale: SupportedLocale = 'en-US'
): { title: string; message: string; detail: string; buttons: [string, string] } {
  const s = hostStrings(NATIVE_BACKEND_CONSENT_STRINGS, locale)
  // With shell, git reads and changes workspace files without the separate
  // file-change grant, so neither "no access" nor "separate permission" holds.
  const access = prompt.shell
    ? prompt.system.includes('fs') ? s.readFiles : ''
    : prompt.system.includes('fs')
      ? s.readFilesSeparateWrite
      : s.noFiles
  const sandbox = prompt.shell ? s.sandboxWithShell : s.sandbox
  // DB5: shell is allowed for a backend and disclosed as high risk.
  const shell = prompt.shell ? s.shell : ''
  const methods = [...prompt.methods].sort()
  return {
    title: s.title,
    message: prompt.update ? s.messageUpdate(prompt.name, prompt.packageVersion) : s.messageNew(prompt.name),
    detail: [
      sandbox,
      access,
      shell,
      methods.length ? s.methods(methods.join(s.separator)) : s.noMethods,
      nativeBackendAgentToolsText(prompt, s),
      s.disable,
    ].filter(Boolean).join('\n\n'),
    buttons: [s.notNow, s.allow],
  }
}

export interface NativeBackendWritePrompt {
  pluginId: string
  name: string
  workspacePath: string
}

/** DB3: an agent called a write-risk tool of this package in this workspace. */
export interface AgentToolWritePrompt {
  pluginId: string
  name: string
  packageVersion: string
  workspacePath: string
  tool: { name: string; title: string }
}

export interface ThirdPartyAdmission {
  spawnProcess: (entryFile: string, options: SpawnOptions) => ChildProcessWithoutNullStreams
  bridgeDispatcher: BackendBridgeDispatcher
  /** Re-check every gate immediately before each (re)spawn. */
  beforeSpawn: () => Promise<void>
  /** Record a child failure; returns the restart delay, or null to stay down. */
  noteFailure: () => number | null
  /** Canonical workspace root for the filesystem bridge, when granted. */
  workspaceRoot?: string
}

export interface ThirdPartyBackendControllerOptions {
  store: NativeBackendStore
  /** Root for per-plugin private data directories. */
  dataRoot: string
  probe?: BackendSandboxProbe
  /** Ask the user to run this backend. Absent = never prompt (deny). */
  promptConsent?: (prompt: NativeBackendConsentPrompt) => Promise<boolean>
  /** Ask the user to allow file changes in one workspace. Absent = deny. */
  promptWorkspaceWrite?: (prompt: NativeBackendWritePrompt) => Promise<boolean>
  /** Host filesystem service port (the same service Plans uses). */
  filesystemPort?: () => PlansFilesystemPort | undefined
  /** Host shell broker port (the same broker a view's shell.run uses). */
  shellPort?: () => PackageShellPort | undefined
  /** Stop running children: one plugin, or every third-party plugin (null). */
  stopBackends?: (pluginId: string | null) => Promise<void>
  watchResources?: (
    pid: number,
    dataDir: string,
    onViolation: (violation: ResourceViolation) => void,
    notify?: ResourceNotifyMode,
  ) => BackendResourceWatch
  /** Plan B watchdog option C: send one decision row (notified, continue,
   *  terminate) to the backend's audit. Failures are only logged. */
  recordResourceDecision?: (row: PluginResourceDecisionRow) => void
  /** The list of unanswered resource notices changed (show it to the user). */
  onResourceNoticesChanged?: () => void
  /** One view's child stdout waiting for a newline (#375's
   *  `stdoutPending.bytes`, see `stdoutPendingOf`); absent = not watched. */
  stdoutPendingBytes?: (pluginId: string, instanceId: string) => number
  /** A consent was granted from the first-use dialog (the agent-tool catalog follows it). */
  onConsentGranted?: (pluginId: string) => void
  /** DB3: ask before an agent's first write-risk tool call in a workspace. Absent = deny. */
  promptAgentToolWrite?: (prompt: AgentToolWritePrompt) => Promise<boolean>
  /** The agent-tool call an agent initiator id belongs to, while it runs; the
   * bridge lets an agent write only inside a call made through a write tool. */
  agentToolCall?: (initiatorId: string) => { pluginId: string; risk: 'read' | 'write'; workspaceRoot: string } | undefined
  /** Digest the consent binds to (default: packageContentDigest). */
  digestBackend?: (spec: ThirdPartyLaunchSpec) => Promise<string>
  /** Kill what is left of one sandbox after its child exits (default: killSandboxProcessesSync). */
  killSandbox?: (rootPid: number | null, identity: SandboxIdentity) => void
  /** Remove escapees left by earlier launches, before a spawn (default: killEscapedSandboxProcesses). */
  sweepEscapees?: (identity: SandboxIdentity) => Promise<unknown>
  /** The user's real home, whose sensitive entries are hidden from stat. */
  homeDir?: string
  now?: () => number
  spawnImpl?: Parameters<typeof sandboxedSpawnProcess>[2]
}

/** Restart delays after consecutive failures; the next one stays down. */
export const BACKEND_RESTART_DELAYS_MS = [1_000, 5_000, 30_000] as const
export const BACKEND_CRASH_WINDOW_MS = 10 * 60_000

/** Record one child failure for `key` and return the restart delay, or null
 * once more failures than restart delays fell inside the crash window. */
export function noteBackendFailure(failures: Map<string, number[]>, key: string, now: number): number | null {
  const recent = (failures.get(key) ?? []).filter((at) => now - at < BACKEND_CRASH_WINDOW_MS)
  recent.push(now)
  failures.set(key, recent)
  if (recent.length > BACKEND_RESTART_DELAYS_MS.length) return null
  return BACKEND_RESTART_DELAYS_MS[recent.length - 1]
}

/** The Host shell broker as a third-party backend reaches it. `run` is given
 * a command already checked against the Host executable allowlist; the broker
 * re-checks it (argv rules, auth subcommands, -c/-C overrides) and answers
 * `{exitCode, stdout, stderr}`, or throws a PlansBridgeError. */
export interface PackageShellPort {
  run(command: string, context: PlansBridgeContext): Promise<JsonValue>
}

/** Shell syntax the Host broker refuses (host_shell.py `_SHELL_SYNTAX`). */
const SHELL_SYNTAX = /[;&|<>`\n\r]/u

/** Lexical pre-check before the broker: one plain command whose first token
 * is a Host-allowlisted executable, with no shell syntax. */
function isAllowlistedShellCommand(command: string): boolean {
  if (SHELL_SYNTAX.test(command)) return false
  const executable = command.trim().split(/\s+/u)[0] ?? ''
  return HOST_SHELL_EXECUTABLE_ALLOWLIST.includes(executable)
}

/** Read-only VCS commands an agent call made through a `read` tool may run
 * (plan B1-b, risk enforcement). Deliberately small and fail-closed: one
 * simple command, the subcommand right after the executable (no global
 * options), and no option that writes a file. Anything else needs a
 * write-risk tool and the user's DB3 answer. */
const READ_ONLY_VCS_SUBCOMMANDS: Readonly<Record<string, Readonly<Record<string, readonly string[] | null>>>> = {
  // null: any arguments (still subject to the forbidden options below).
  git: {
    status: null, log: null, diff: null, show: null, 'rev-parse': null, 'ls-files': null, 'merge-base': null,
    describe: null, blame: null,
    branch: ['--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--show-current', '--no-color'],
    remote: ['-v', '--verbose', 'get-url'],
  },
  gh: { pr: ['view', 'list', 'status', 'checks', 'diff'], issue: ['view', 'list', 'status'], repo: ['view'], run: ['view', 'list'] },
  glab: { mr: ['view', 'list', 'diff'], issue: ['view', 'list'], repo: ['view'] },
}

export function isReadOnlyVcsCommand(command: string): boolean {
  if (SHELL_SYNTAX.test(command) || /[$()]/u.test(command)) return false
  const tokens = command.trim().split(/\s+/u)
  const rules = READ_ONLY_VCS_SUBCOMMANDS[tokens[0] ?? '']
  const allowed = rules?.[tokens[1] ?? '']
  if (!rules || allowed === undefined) return false
  if (tokens.some((token) => /^--(output|ext-diff|exec|upload-pack|receive-pack)/u.test(token) || /^-[A-Za-z]*o$/u.test(token))) {
    return false
  }
  if (allowed === null) return true
  if (tokens[0] === 'git') {
    // branch/remote: listing flags only, and `remote get-url <name>`.
    if (tokens[1] === 'remote' && tokens[2] === 'get-url') return tokens.length === 4
    return tokens.slice(2).every((token) => allowed.includes(token))
  }
  // gh/glab: the sub-subcommand must be a read verb.
  return tokens.length >= 3 && allowed.includes(tokens[2])
}

const PACKAGE_FS_READ_OPERATIONS = new Set(['read_file', 'read_range', 'list_dir', 'stat_path'])
const PACKAGE_FS_WRITE_OPERATIONS = new Set([
  'write_file', 'write_part', 'write_commit', 'write_abort', 'delete', 'rename',
])

/** The sandbox profile matches canonical paths, so the entry must resolve
 * inside the canonical package directory. */
function canonicalSandboxPaths(spec: ThirdPartyLaunchSpec, dataDir: string) {
  const packageDir = realpathSync(spec.packageDir)
  const entryFile = realpathSync(spec.entryFile)
  if (!entryFile.startsWith(`${packageDir}/`)) {
    throw unavailable('backend entry resolves outside its package')
  }
  return { packageDir, dataDir, entryFile }
}

function unavailable(message: string): BackendPluginError {
  return new BackendPluginError('BACKEND_UNAVAILABLE', message)
}

export class ThirdPartyBackendController {
  private readonly store: NativeBackendStore
  private readonly dataRoot: string
  private readonly probe: BackendSandboxProbe
  private readonly options: ThirdPartyBackendControllerOptions
  private readonly digestBackend: (spec: ThirdPartyLaunchSpec) => Promise<string>
  private readonly now: () => number
  /** Per-session "not now" answers: no prompt again for the same identity. */
  private readonly declinedConsent = new Set<string>()
  private readonly declinedWrite = new Set<string>()
  private readonly pendingPrompts = new Map<string, Promise<boolean>>()
  private readonly failures = new Map<string, number[]>()
  private readonly tripped = new Set<string>()
  private readonly lastViolation = new Map<string, ResourceViolation>()
  private readonly resourceNoticeMap = new Map<string, { notice: BackendResourceNotice; watch: BackendResourceWatch }>()
  /** The watch of each running third-party backend, for the activity page. */
  private readonly runningWatches = new Map<BackendResourceWatch, ThirdPartyLaunchSpec>()

  constructor(options: ThirdPartyBackendControllerOptions) {
    this.options = options
    this.store = options.store
    this.dataRoot = options.dataRoot
    this.probe = options.probe ?? createHostSandboxProbe()
    this.digestBackend = options.digestBackend ?? ((spec) => packageContentDigest(spec.packageDir))
    this.now = options.now ?? Date.now
  }

  dataDirFor(pluginId: string): string {
    return join(this.dataRoot, pluginId)
  }

  private sandboxFor(spec: ThirdPartyLaunchSpec) {
    return resolveBackendSandbox(
      { packageDir: spec.packageDir, dataDir: this.dataDirFor(spec.pluginId), entryFile: spec.entryFile },
      this.probe,
    )
  }

  /** Static gates (no prompt, no hashing). */
  private staticRefusal(spec: ThirdPartyLaunchSpec): { status: NativeBackendStatus; reason: string } | null {
    if (spec.thirdParty.shell === 'full') {
      return { status: 'shell-not-allowed', reason: 'third-party backends cannot declare full shell access' }
    }
    if (this.store.record(spec.pluginId).disabled) {
      return { status: 'disabled', reason: 'the native backend is disabled for this plugin' }
    }
    const sandbox = this.sandboxFor(spec)
    if (!sandbox.available) return { status: 'sandbox-unavailable', reason: sandbox.reason }
    if (this.tripped.has(spec.pluginId)) {
      return { status: 'stopped-after-crashes', reason: 'the native backend failed repeatedly and was stopped' }
    }
    return null
  }

  /** The gates that can change at any moment: switches, breaker, sandbox. */
  private assertAdmissible(spec: ThirdPartyLaunchSpec): void {
    // The global switch first: while it is off, that is the answer.
    if (!this.store.isEnabled()) throw unavailable('third-party native backends are turned off')
    const refusal = this.staticRefusal(spec)
    if (refusal) throw unavailable(refusal.reason)
  }

  private consentMatches(spec: ThirdPartyLaunchSpec, digest: string): boolean {
    const consent = this.store.record(spec.pluginId).consent
    return consent?.binarySha256 === digest && consent.permissionsKey === backendPermissionsKey(spec)
  }

  /** True when the user's consent covers this exact package content and
   * permission set (never prompts). Unreadable content reads as "no". */
  async hasConsent(spec: ThirdPartyLaunchSpec): Promise<boolean> {
    try {
      return this.consentMatches(spec, await this.digestBackend(spec))
    } catch {
      return false
    }
  }

  /** True when the consent covers this exact package and its current tool set
   * (B1-a binds the tools' digest into the permissions key) and the DB1 time
   * is recorded: like the listing, a package without it holds no names. */
  async hasAgentToolsConsent(spec: ThirdPartyLaunchSpec): Promise<boolean> {
    if (!spec.thirdParty.agentTools?.length || !this.agentToolsConsented(spec)) return false
    if (this.store.record(spec.pluginId).agentToolsSince === undefined) return false
    return this.hasConsent(spec)
  }

  /** DB3: ask once per (package, version, consent, workspace) before an agent's
   * first write-risk tool call there. This is its own record, separate from
   * the view's "allow file changes" grant, and the dialog says an agent asked.
   * A "no" is kept for the session. */
  async confirmAgentToolWrite(
    spec: ThirdPartyLaunchSpec,
    workspacePath: string,
    tool: { name: string; title: string },
  ): Promise<boolean> {
    const consent = this.store.record(spec.pluginId).consent
    if (!consent) return false
    return this.confirmWriteFor(spec, workspacePath, tool, consent.grantedAt, () =>
      this.store.record(spec.pluginId).consent?.grantedAt)
  }

  /** DB3 for a first-party agent tool (navide.browser): the same question,
   * asked once per (package, version, workspace). A first-party package has
   * no native-backend consent, so the answer is bound to the version alone. */
  async confirmFirstPartyAgentToolWrite(
    spec: ThirdPartyLaunchSpec,
    workspacePath: string,
    tool: { name: string; title: string },
  ): Promise<boolean> {
    if (!isFirstPartyAgentToolPlugin(spec.pluginId)) return false
    return this.confirmWriteFor(spec, workspacePath, tool, FIRST_PARTY_WRITE_GRANT, () => FIRST_PARTY_WRITE_GRANT)
  }

  private async confirmWriteFor(
    spec: ThirdPartyLaunchSpec,
    workspacePath: string,
    tool: { name: string; title: string },
    grantedAt: string,
    currentGrantedAt: () => string | undefined,
  ): Promise<boolean> {
    if (this.store.allowsAgentToolWrite(spec.pluginId, spec.packageVersion, grantedAt, workspacePath)) return true
    const identity = `agent-write\n${spec.pluginId}\n${spec.packageVersion}\n${grantedAt}\n${workspacePath}`
    if (this.declinedWrite.has(identity) || !this.options.promptAgentToolWrite) return false
    let pending = this.pendingPrompts.get(identity)
    if (!pending) {
      pending = this.options.promptAgentToolWrite({
        pluginId: spec.pluginId,
        name: spec.thirdParty.name,
        packageVersion: spec.packageVersion,
        workspacePath,
        tool: { name: tool.name, title: tool.title },
      }).catch(() => false)
      this.pendingPrompts.set(identity, pending)
      void pending.finally(() => this.pendingPrompts.delete(identity))
    }
    if (!(await pending)) {
      this.declinedWrite.add(identity)
      return false
    }
    // The consent may have changed while the dialog was open.
    if (currentGrantedAt() !== grantedAt) return false
    this.store.setAgentToolWrite(spec.pluginId, spec.packageVersion, grantedAt, workspacePath)
    return true
  }

  /** Decide whether the child may start; asks for consent when `prompt`
   * allows it. The global switch is never turned on from here: off means off. */
  async admit(
    spec: ThirdPartyLaunchSpec,
    workspacePath?: string,
    options: { prompt?: boolean; instanceId?: string } = {},
  ): Promise<ThirdPartyAdmission> {
    this.forgetDroppedAgentTools(spec)
    this.assertAdmissible(spec)
    const digest = await this.digestBackend(spec)
    if (!this.consentMatches(spec, digest)) {
      if (options.prompt === false) throw unavailable('the native backend has not been allowed')
      await this.requestConsent(spec, digest)
    }
    // Hashing and the consent dialog both wait; check the switches again.
    this.assertAdmissible(spec)
    const sandbox = this.sandboxFor(spec)
    if (!sandbox.available) throw unavailable(sandbox.reason)

    const dataDir = this.dataDirFor(spec.pluginId)
    mkdirSync(join(dataDir, 'tmp'), { recursive: true, mode: 0o700 })
    const canonicalDataDir = realpathSync(dataDir)
    const paths = { ...canonicalSandboxPaths(spec, canonicalDataDir), homeDir: this.options.homeDir ?? homedir() }
    const resolved = resolveBackendSandbox(paths, this.probe)
    if (!resolved.available) throw unavailable(resolved.reason)
    const spawnSandboxed = sandboxedSpawnProcess(resolved, paths, this.options.spawnImpl)
    const identity = sandboxIdentity(paths.packageDir, canonicalDataDir)
    const killSandbox = this.options.killSandbox ?? ((rootPid, id) => {
      killSandboxProcessesSync(rootPid, id)
    })

    const workspaceRoot = (spec.thirdParty.system.includes('fs') || spec.thirdParty.shell === 'allowlist') && workspacePath
      ? canonicalExistingDirectory(workspacePath) ?? undefined
      : undefined
    const instanceId = options.instanceId

    return {
      spawnProcess: (entryFile, options) => {
        const child = spawnSandboxed(entryFile, options)
        if (typeof child.pid === 'number') {
          const rootPid = child.pid
          const report = (violation: ResourceViolation): void => {
            this.lastViolation.set(spec.pluginId, violation)
            console.warn(`[plugin-backend] ${spec.pluginId} exceeded its ${violation} limit and was stopped`)
          }
          // Option C: over a threshold the user is told and decides; the
          // backend keeps running meanwhile (contract 5.2). Pending stdout is
          // read for this view's child only; a preflight has no view.
          const stdoutPendingBytes = this.options.stdoutPendingBytes
          const notify: ResourceNotifyMode = {
            onExceeded: (exceeded) => this.raiseResourceNotice(spec, watch, exceeded),
            ...(stdoutPendingBytes && instanceId !== undefined
              ? { stdoutPending: { bytes: () => stdoutPendingBytes(spec.pluginId, instanceId), threshold: defaultStdoutPendingThreshold() } }
              : {}),
          }
          const watch: BackendResourceWatch = this.options.watchResources
            ? this.options.watchResources(rootPid, canonicalDataDir, report, notify)
            : watchBackendResources(rootPid, canonicalDataDir, report, undefined, undefined, identity, notify)
          this.runningWatches.set(watch, spec)
          // Registered before the supervisor's own listener, so the whole
          // sandbox is gone before a stop, idle close or quit completes.
          child.once('exit', () => {
            watch.dispose()
            killSandbox(rootPid, identity)
            this.runningWatches.delete(watch)
            this.dropResourceNotices(watch)
          })
        }
        return child
      },
      bridgeDispatcher: this.packageBridgeDispatcher(spec),
      beforeSpawn: async () => {
        // Processes left over from an earlier launch (or an earlier Host run)
        // that escaped to launchd are removed before a new child starts,
        // without blocking the main thread.
        await (this.options.sweepEscapees ?? killEscapedSandboxProcesses)(identity)
        this.assertAdmissible(spec)
        const digest = await this.digestBackend(spec)
        // The switches may have changed while the package was being hashed.
        this.assertAdmissible(spec)
        if (!this.consentMatches(spec, digest)) {
          throw unavailable('the native backend changed since it was allowed')
        }
      },
      noteFailure: () => this.noteFailure(spec.pluginId),
      ...(workspaceRoot ? { workspaceRoot } : {}),
    }
  }

  private async requestConsent(spec: ThirdPartyLaunchSpec, digest: string): Promise<void> {
    const identity = `${spec.pluginId}\n${digest}\n${backendPermissionsKey(spec)}`
    if (this.declinedConsent.has(identity) || !this.options.promptConsent) {
      throw unavailable('the native backend has not been allowed')
    }
    // One prompt per identity at a time: concurrent binds share the answer.
    let pending = this.pendingPrompts.get(identity)
    if (!pending) {
      const consent = this.store.record(spec.pluginId).consent
      pending = this.options.promptConsent({
        pluginId: spec.pluginId,
        name: spec.thirdParty.name,
        packageVersion: spec.packageVersion,
        system: [...spec.thirdParty.system],
        ...(spec.thirdParty.shell ? { shell: spec.thirdParty.shell } : {}),
        methods: [...spec.approvedMethods],
        agentTools: [...(spec.thirdParty.agentTools ?? [])],
        update: consent !== undefined,
      }).catch(() => false)
      this.pendingPrompts.set(identity, pending)
      void pending.finally(() => this.pendingPrompts.delete(identity))
    }
    if (!(await pending)) {
      this.declinedConsent.add(identity)
      throw unavailable('the user did not allow the native backend')
    }
    if (!this.store.isEnabled()) throw unavailable('third-party native backends are turned off')
    if (!this.consentMatches(spec, digest)) {
      this.store.grantConsent(spec.pluginId, {
        binarySha256: digest,
        permissionsKey: backendPermissionsKey(spec),
        packageVersion: spec.packageVersion,
      })
      this.noteAgentTools(spec)
      this.options.onConsentGranted?.(spec.pluginId)
    }
  }

  /** Record when the user first allowed a version of this package that
   * declares agent tools (the DB1 order; unique across packages, so there is
   * never a tie). Bookkeeping only: a failed save never affects admission. */
  private noteAgentTools(spec: ThirdPartyLaunchSpec): void {
    if (!spec.thirdParty.agentTools?.length) return
    try {
      this.store.noteAgentToolsSince(
        spec.pluginId,
        new Date(this.now()),
        spec.thirdParty.agentTools.map((tool) => tool.name),
      )
    } catch {
      // The package then holds no names until its next consent.
    }
  }

  /** A version that declares no tools gives up its place in the DB1 order:
   * declaring tools again later counts from that later consent. */
  private forgetDroppedAgentTools(spec: ThirdPartyLaunchSpec): void {
    if (spec.thirdParty.agentTools?.length) return
    try {
      this.store.clearAgentToolsSince(spec.pluginId)
    } catch {
      // Retried on the next admission or listing.
    }
  }

  /** Whether the user's consent covers this exact tool set. */
  private agentToolsConsented(spec: ThirdPartyLaunchSpec): boolean {
    return this.store.record(spec.pluginId).consent?.permissionsKey === backendPermissionsKey(spec)
  }

  private noteFailure(pluginId: string): number | null {
    const delay = noteBackendFailure(this.failures, pluginId, this.now())
    if (delay === null) this.tripped.add(pluginId)
    return delay
  }

  /** Workspace filesystem bridge for one third-party backend: reads inside the
   * bound workspace; writes only after a per-workspace user grant. With
   * `shell: "allowlist"`, also the Host shell broker at the bound workspace. */
  private packageBridgeDispatcher(spec: ThirdPartyLaunchSpec): BackendBridgeDispatcher {
    return Object.freeze({
      dispatch: async (request: PlansBridgeRequest, context: PlansBridgeContext) => {
        if (context.signal.aborted) throw new PlansBridgeError('USER_CANCELLED')
        if (request.port === 'shell') return this.dispatchShell(spec, request, context)
        if (request.port !== 'filesystem' || !spec.thirdParty.system.includes('fs')) {
          throw new PlansBridgeError('CAPABILITY_DENIED')
        }
        const port = this.options.filesystemPort?.()
        if (!port) throw new PlansBridgeError('BACKEND_UNAVAILABLE')
        const root = context.authorizedPlanRoot
        if (!root) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
        if (PACKAGE_FS_WRITE_OPERATIONS.has(request.operation)) {
          if (context.runtime.initiator.kind === 'agent') {
            // An agent writes only inside a call made through a write-risk
            // tool, where the user answered the DB3 question; never prompts.
            if (!this.agentToolWriteAllowed(spec, context.runtime.initiator.id, root)) {
              throw new PlansBridgeError('CAPABILITY_DENIED')
            }
          } else if (!(await this.ensureWorkspaceWrite(spec, root))) throw new PlansBridgeError('CAPABILITY_DENIED')
        } else if (!PACKAGE_FS_READ_OPERATIONS.has(request.operation)) {
          throw new PlansBridgeError('METHOD_NOT_FOUND')
        }
        switch (request.operation) {
          case 'read_file': return port.readFile(request.arguments, context)
          case 'read_range': return port.readRange(request.arguments, context)
          case 'list_dir': return port.listDir(request.arguments, context)
          case 'stat_path': return port.statPath(request.arguments, context)
          case 'write_file': return port.writeFile(request.arguments, context)
          case 'write_part': return port.writePart(request.arguments, context)
          case 'write_commit': return port.writeCommit(request.arguments, context)
          case 'write_abort': return port.writeAbort(request.arguments, context)
          case 'delete': return port.delete(request.arguments, context)
          case 'rename': return port.rename(request.arguments, context)
        }
        throw new PlansBridgeError('METHOD_NOT_FOUND')
      },
    })
  }

  private agentToolWriteAllowed(spec: ThirdPartyLaunchSpec, initiatorId: string, root: string): boolean {
    const call = this.options.agentToolCall?.(initiatorId)
    const consent = this.store.record(spec.pluginId).consent
    return Boolean(
      call &&
      call.pluginId === spec.pluginId &&
      call.risk === 'write' &&
      call.workspaceRoot === root &&
      consent &&
      this.store.allowsAgentToolWrite(spec.pluginId, spec.packageVersion, consent.grantedAt, root),
    )
  }

  private async dispatchShell(
    spec: ThirdPartyLaunchSpec,
    request: PlansBridgeRequest,
    context: PlansBridgeContext,
  ): Promise<JsonValue> {
    if (spec.thirdParty.shell !== 'allowlist') throw new PlansBridgeError('CAPABILITY_DENIED')
    if (request.operation !== 'run') throw new PlansBridgeError('METHOD_NOT_FOUND')
    const args = request.arguments
    if (
      args === null || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).length !== 1 || typeof args.command !== 'string'
    ) {
      throw new PlansBridgeError('INVALID_ARGUMENT', 'shell.run takes exactly { command }')
    }
    if (!context.authorizedPlanRoot) throw new PlansBridgeError('WORKSPACE_SCOPE_VIOLATION')
    if (!isAllowlistedShellCommand(args.command)) {
      throw new PlansBridgeError('CAPABILITY_DENIED', 'shell executable is not Host-allowlisted')
    }
    if (context.runtime.initiator.kind === 'agent') {
      // Agent calls: only inside an admitted agent-tool call; a read tool
      // runs read-only VCS commands only, anything else needs a write tool
      // with the user's DB3 answer.
      //
      // Not in effect in 0.2.25: the real port below
      // (FrontendPluginManager.thirdPartyShellGrantAllows) serves only a
      // user-initiated call from a live view, so every agent call that gets
      // past these checks is still refused there (CAPABILITY_DENIED). Opening
      // it widens what agents can do, so it needs decisions first: whether
      // agents get shell at all, what a read tool may run, whether DB3
      // covers shell writes, and how the consent dialog discloses it.
      // Contract: plugin-agent-tools-contract.md, after the call checks.
      const call = this.options.agentToolCall?.(context.runtime.initiator.id)
      if (!call || call.pluginId !== spec.pluginId || call.workspaceRoot !== context.authorizedPlanRoot) {
        throw new PlansBridgeError('CAPABILITY_DENIED')
      }
      if (
        !isReadOnlyVcsCommand(args.command) &&
        !this.agentToolWriteAllowed(spec, context.runtime.initiator.id, context.authorizedPlanRoot)
      ) throw new PlansBridgeError('CAPABILITY_DENIED', 'a read tool may run only read-only commands')
    }
    const port = this.options.shellPort?.()
    if (!port) throw new PlansBridgeError('BACKEND_UNAVAILABLE')
    return port.run(args.command, context)
  }

  private async ensureWorkspaceWrite(spec: ThirdPartyLaunchSpec, workspacePath: string): Promise<boolean> {
    if (this.store.allowsWorkspaceWrite(spec.pluginId, workspacePath)) return true
    const identity = `${spec.pluginId}\n${workspacePath}`
    if (this.declinedWrite.has(identity) || !this.options.promptWorkspaceWrite) return false
    let pending = this.pendingPrompts.get(`write\n${identity}`)
    if (!pending) {
      pending = this.options.promptWorkspaceWrite({
        pluginId: spec.pluginId,
        name: spec.thirdParty.name,
        workspacePath,
      }).catch(() => false)
      this.pendingPrompts.set(`write\n${identity}`, pending)
      void pending.finally(() => this.pendingPrompts.delete(`write\n${identity}`))
    }
    if (!(await pending)) {
      this.declinedWrite.add(identity)
      return false
    }
    this.store.setWorkspaceWrite(spec.pluginId, workspacePath, true)
    return true
  }

  async status(spec: ThirdPartyLaunchSpec): Promise<NativeBackendStatusRow> {
    const record = this.store.record(spec.pluginId)
    let digest: string | null = null
    try {
      digest = await this.digestBackend(spec)
    } catch {
      digest = null
    }
    const matches = digest !== null && this.consentMatches(spec, digest)
    const refusal = this.staticRefusal(spec)
    let status: NativeBackendStatus
    let reason: string | undefined
    if (digest === null) {
      status = 'unavailable'
      reason = 'the backend executable cannot be read'
    } else if (!this.store.isEnabled()) {
      status = 'disabled-globally'
    } else if (refusal) {
      status = refusal.status
      reason = refusal.reason
    } else {
      status = matches ? 'ready' : 'needs-consent'
    }
    const lastViolation = this.lastViolation.get(spec.pluginId)
    return {
      pluginId: spec.pluginId,
      packageVersion: spec.packageVersion,
      name: spec.thirdParty.name,
      status,
      ...(reason ? { reason } : {}),
      changedSinceConsent: record.consent !== undefined && !matches,
      canWriteWorkspace: spec.thirdParty.system.includes('fs'),
      workspaceWrite: record.workspaceWrite ?? [],
      ...(lastViolation ? { lastViolation } : {}),
      ...(spec.thirdParty.agentTools?.length
        ? {
            agentTools: spec.thirdParty.agentTools.map((tool) => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              risk: tool.risk,
              timeoutMs: tool.timeoutMs,
              method: tool.method,
              inputSchema: tool.inputSchema,
            })),
          }
        : {}),
      ...(spec.thirdParty.shell ? { shell: spec.thirdParty.shell } : {}),
    }
  }

  /** Rows for every listed package, with DB1 name collisions marked in both
   * rows. Only a package whose consent covers its current tool set, that the
   * user has not disabled and that has its consent time recorded holds names;
   * a package that declares tools no longer gives its place up. */
  async statuses(specs: readonly ThirdPartyLaunchSpec[]): Promise<NativeBackendStatusRow[]> {
    for (const spec of specs) this.forgetDroppedAgentTools(spec)
    const rows = await Promise.all(specs.map((spec) => this.status(spec)))
    const claimants = specs.flatMap((spec, index) => {
      const row = rows[index]
      const record = this.store.record(spec.pluginId)
      return row.agentTools && !record.disabled && record.agentToolsSince !== undefined && this.agentToolsConsented(spec)
        ? [{
            pluginId: row.pluginId,
            since: record.agentToolsSince,
            sinceByName: record.agentToolNamesSince,
            names: row.agentTools.map((tool) => tool.name),
          }]
        : []
    })
    const collisions = agentToolNameCollisions(claimants)
    const sharedWith = new Map<string, Map<string, string[]>>()
    for (const [loser, lost] of collisions) {
      for (const { name, heldBy } of lost) {
        const byName = sharedWith.get(heldBy) ?? new Map<string, string[]>()
        byName.set(name, [...(byName.get(name) ?? []), loser].sort())
        sharedWith.set(heldBy, byName)
      }
    }
    return rows.map((row) => {
      const lost = collisions.get(row.pluginId)
      const shared = sharedWith.get(row.pluginId)
      if ((!lost && !shared) || !row.agentTools) return row
      return {
        ...row,
        agentTools: row.agentTools.map((tool) => {
          const collision = lost?.find((entry) => entry.name === tool.name)
          const others = shared?.get(tool.name)
          return {
            ...tool,
            ...(collision ? { collidesWith: collision.heldBy } : {}),
            ...(others ? { sharedWith: others } : {}),
          }
        }),
      }
    })
  }

  /** User consent from the Extensions page (no prompt). */
  async allow(spec: ThirdPartyLaunchSpec): Promise<void> {
    const digest = await this.digestBackend(spec)
    this.store.grantConsent(spec.pluginId, {
      binarySha256: digest,
      permissionsKey: backendPermissionsKey(spec),
      packageVersion: spec.packageVersion,
    })
    this.noteAgentTools(spec)
    this.resetFailures(spec.pluginId)
    this.options.onConsentGranted?.(spec.pluginId)
  }

  /** Each running third-party backend's usage against its thresholds
   *  (contract 5.2); read only. */
  resourceStatus(): Array<BackendResourceStatus & { pluginId: string; name: string; packageVersion: string }> {
    const out: Array<BackendResourceStatus & { pluginId: string; name: string; packageVersion: string }> = []
    for (const [watch, spec] of this.runningWatches) {
      const status = watch.status?.()
      if (!status) continue
      out.push({ pluginId: spec.pluginId, name: spec.thirdParty.name, packageVersion: spec.packageVersion, ...status })
    }
    return out
  }

  /** Unanswered resource notices, oldest first. */
  resourceNotices(): BackendResourceNotice[] {
    return [...this.resourceNoticeMap.values()].map((entry) => ({ ...entry.notice }))
  }

  /** The user's answer to one notice: `terminate` runs the stop that used to
   *  happen on its own; `continue` raises that item's notice level (contract
   *  5.2). False for an unknown or already answered notice. */
  async answerResourceNotice(id: string, choice: 'terminate' | 'continue'): Promise<boolean> {
    const entry = this.resourceNoticeMap.get(id)
    if (!entry) return false
    this.resourceNoticeMap.delete(id)
    this.noticesChanged()
    this.recordResourceDecision(entry.notice, choice)
    if (choice === 'terminate') await entry.watch.terminate(entry.notice.item)
    else entry.watch.keepRunning(entry.notice.item)
    return true
  }

  private raiseResourceNotice(spec: ThirdPartyLaunchSpec, watch: BackendResourceWatch, exceeded: ResourceExceeded): void {
    const notice: BackendResourceNotice = {
      id: randomUUID(),
      pluginId: spec.pluginId,
      name: spec.thirdParty.name,
      packageVersion: spec.packageVersion,
      item: exceeded.item,
      usage: exceeded.usage,
      threshold: exceeded.threshold,
      at: (this.options.now ?? Date.now)(),
    }
    this.resourceNoticeMap.set(notice.id, { notice, watch })
    this.recordResourceDecision(notice, 'notified')
    this.noticesChanged()
  }

  /** Tell the window the list changed; a failing hook is logged and never
   *  holds up an answer or a later notice (review LOW3 on #386). */
  private noticesChanged(): void {
    try {
      this.options.onResourceNoticesChanged?.()
    } catch (error) {
      console.warn('[plugin-backend] resource notice change hook failed', error)
    }
  }

  /** A backend that exited has nothing left to decide about. */
  private dropResourceNotices(watch: BackendResourceWatch): void {
    let dropped = false
    for (const [id, entry] of this.resourceNoticeMap) {
      if (entry.watch !== watch) continue
      this.resourceNoticeMap.delete(id)
      dropped = true
    }
    if (dropped) this.noticesChanged()
  }

  private recordResourceDecision(notice: BackendResourceNotice, decision: PluginResourceDecision): void {
    try {
      this.options.recordResourceDecision?.({
        plugin_id: notice.pluginId,
        plugin_version: notice.packageVersion,
        item: notice.item,
        usage: notice.usage,
        threshold: notice.threshold,
        decision,
        at: (this.options.now ?? Date.now)(),
      })
    } catch (error) {
      console.warn(`[plugin-backend] resource decision for ${notice.pluginId} not recorded: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  resetFailures(pluginId: string): void {
    this.failures.delete(pluginId)
    this.tripped.delete(pluginId)
    this.lastViolation.delete(pluginId)
    for (const identity of [...this.declinedConsent]) {
      if (identity.startsWith(`${pluginId}\n`)) this.declinedConsent.delete(identity)
    }
  }

  /** Global kill switch. Turning it off stops every third-party child. */
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      this.store.setEnabled(true)
      return
    }
    // Fail closed: the store applies "off" in memory before saving, and the
    // children stop even when the save throws (the error still reaches the UI).
    try {
      this.store.setEnabled(false)
    } finally {
      await this.options.stopBackends?.(null)
    }
  }

  /** Per-plugin kill switch; fails closed like the global one. */
  async setDisabled(pluginId: string, disabled: boolean): Promise<void> {
    if (!disabled) {
      this.store.setDisabled(pluginId, false)
      this.resetFailures(pluginId)
      return
    }
    try {
      this.store.setDisabled(pluginId, true)
    } finally {
      await this.options.stopBackends?.(pluginId)
    }
  }

  async setWorkspaceWrite(pluginId: string, workspacePath: string, allowed: boolean): Promise<void> {
    this.store.setWorkspaceWrite(pluginId, workspacePath, allowed)
    if (!allowed) this.declinedWrite.delete(`${pluginId}\n${workspacePath}`)
  }

  /** Install-time health check: exactly the admission a real spawn needs -
   * switch, not disabled, breaker, sandbox, and consent for THIS content and
   * permission set - without ever prompting, and under the same watchdog and
   * cleanup. Null means the candidate is only staged, never executed. */
  async preflightAdmission(spec: ThirdPartyLaunchSpec): Promise<ThirdPartyAdmission | null> {
    try {
      return await this.admit(spec, undefined, { prompt: false })
    } catch {
      return null
    }
  }
}
