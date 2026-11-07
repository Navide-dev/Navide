import { randomBytes } from 'node:crypto'
import { realpath, readFile, stat } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'

export const PLUGIN_FRAME_SCHEME = 'navide-plugin-frame'

export type PluginFrameAssetMount = {
  artifactId: string
  packageId: string
  packageVersion: string
  root: string
  /** `permissions.network.hosts` of the package: the only hosts the frame's
   *  `connect-src` admits. Absent or empty keeps `connect-src 'none'`. */
  connectHosts?: readonly string[]
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

/** A loopback host gets the plain schemes too: a local dev server or a local
 *  model runtime rarely has TLS, and the traffic never leaves the machine. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** CSP `connect-src` sources for a package's declared hosts: TLS schemes for
 *  every host, plus the plain ones for loopback and IPv4 literals. A host is
 *  used exactly as declared (the manifest validated the spelling), so a
 *  wildcard `*.example.com` becomes `https://*.example.com`, which CSP reads
 *  as every subdomain. */
export function pluginFrameConnectSources(hosts: readonly string[] | undefined): string[] {
  const sources: string[] = []
  for (const host of hosts ?? []) {
    sources.push(`https://${host}`, `wss://${host}`)
    if (LOOPBACK_HOSTS.has(host) || IPV4_LITERAL.test(host)) sources.push(`http://${host}`, `ws://${host}`)
  }
  return sources
}

/** The frame's Content-Security-Policy. Everything but the declared network
 *  hosts is fixed: scripts and styles from the package only, no plugins, no
 *  workers, no form posts, no navigation base. */
export function pluginFrameCsp(connectHosts: readonly string[] | undefined): string {
  const connect = pluginFrameConnectSources(connectHosts)
  return [
    "default-src 'none'",
    "base-uri 'none'",
    `connect-src ${connect.length ? connect.join(' ') : "'none'"}`,
    "form-action 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'none'",
  ].join('; ')
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !path.includes(`..${sep}`)
}

function response(status: number): Response {
  return new Response(null, { status })
}

/** Maps one verified package artifact to one unguessable, revocable frame origin. */
export class PluginFrameAssetProtocol {
  private readonly mounts = new Map<string, PluginFrameAssetMount & { canonicalRoot: string; csp: string }>()

  async mount(mount: PluginFrameAssetMount): Promise<string> {
    const canonicalRoot = await realpath(mount.root)
    const hostname = randomBytes(32).toString('hex')
    const connectHosts = [...(mount.connectHosts ?? [])]
    this.mounts.set(hostname, { ...mount, connectHosts, canonicalRoot, csp: pluginFrameCsp(connectHosts) })
    return `${PLUGIN_FRAME_SCHEME}://${hostname}/`
  }

  revoke(origin: string): void {
    try {
      const hostname = new URL(origin).hostname
      this.mounts.delete(hostname)
    } catch {
      // Invalid origins cannot name a mount.
    }
  }

  /** The mount a frame URL belongs to (its package, version and declared
   *  hosts), or null for any URL that is not a live frame origin. Used to
   *  attribute the frame's network requests to its package. */
  mountOf(frameUrl: string | undefined): PluginFrameAssetMount | null {
    if (!frameUrl) return null
    let url: URL
    try {
      url = new URL(frameUrl)
    } catch {
      return null
    }
    if (url.protocol !== `${PLUGIN_FRAME_SCHEME}:`) return null
    const mount = this.mounts.get(url.hostname)
    if (!mount) return null
    const { canonicalRoot: _root, csp: _csp, ...publicMount } = mount
    return publicMount
  }

  async handle(request: Request): Promise<Response> {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return response(400)
    }
    if (url.protocol !== `${PLUGIN_FRAME_SCHEME}:` || request.method !== 'GET') return response(404)
    const mount = this.mounts.get(url.hostname)
    // The Host-generated locator carries a load-time context query
    // (`workspace_path`, `v2`, `contribution`). Resolution is by path only, so
    // the query cannot escape the mount; credentials, ports and fragments still
    // name something other than the mounted package and are refused.
    if (!mount || url.username || url.password || url.port || url.hash) return response(404)

    let decodedPath: string
    try {
      decodedPath = decodeURIComponent(url.pathname)
    } catch {
      return response(400)
    }
    if (!decodedPath.startsWith('/') || decodedPath.includes('\\') || decodedPath.includes('\0')) return response(404)
    const candidate = resolve(mount.canonicalRoot, `.${decodedPath}`)
    if (!isWithin(mount.canonicalRoot, candidate)) return response(404)

    let canonicalFile: string
    try {
      canonicalFile = await realpath(candidate)
      if (!isWithin(mount.canonicalRoot, canonicalFile) || !(await stat(canonicalFile)).isFile()) return response(404)
    } catch {
      return response(404)
    }
    const contentType = MIME_TYPES[extname(canonicalFile).toLowerCase()]
    if (!contentType) return response(404)
    try {
      return new Response(await readFile(canonicalFile), {
        headers: {
          'Content-Security-Policy': mount.csp,
          'Content-Type': contentType,
          'Cross-Origin-Resource-Policy': 'same-origin',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return response(404)
    }
  }
}
