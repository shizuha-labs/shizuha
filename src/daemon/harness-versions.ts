/**
 * HIVE-600: report the fleet's harness/runtime image so Hive can track and
 * upgrade CLI versions across the whole fleet.
 *
 * The authoritative version source is the AGENT-RUNTIME image's OCI labels
 * (org.shizuha.harness.*), which Hive reads from the registry — the daemon
 * cannot introspect the agent image's filesystem (separate container), and its
 * OWN CLIs may differ from the agent image's. So the daemon simply reports which
 * agent-runtime image it manages; Hive resolves the versions from that image.
 *
 * A best-effort snapshot of the daemon's own CLIs is included as a secondary
 * hint only (labelled "daemon host" in the UI), never as the fleet source.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canonicalRuntimeImage,
  desiredRuntimeRelease,
  loadDesiredRuntimeReleaseDocument,
  parseDesiredRuntimeReleaseDocument,
  type DesiredRuntimeRelease,
} from './runtime-release.js';

export interface HarnessReport {
  /** The agent-runtime image this daemon spawns fleet agents from (SoT ref). */
  agent_runtime_image: string | null;
  /** SCLI-331: reviewed rt-fleet release record. Hive stores/returns this as a
   * read-only projection; it is never allowed to author a competing image. */
  desired_runtime_release: DesiredRuntimeRelease | null;
  /** Authoritative: harness versions resolved from that image's OCI labels
   *  (org.shizuha.harness.*), read from the node-local registry by the daemon —
   *  Hive is behind default-deny egress and can't reach the registry itself. */
  image_harness: Record<string, string> | null;
  /** Secondary hint: CLI versions on the DAEMON host (may differ from agents). */
  daemon_cli: Record<string, string | null>;
  detected_at: string;
}

function versionFromCli(bin: string, args: string[] = ['--version']): string | null {
  let probeHome: string | null = null;
  try {
    // Third-party CLIs may initialize config/cache state even for --version.
    // The runtime-fleet container intentionally cannot write the mounted host
    // HOME, so Gemini emitted EACCES traces on every daemon start. Isolate all
    // best-effort probes in a private writable HOME and pass no provider keys.
    probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-harness-probe-'));
    const out = execFileSync(bin, args, {
      timeout: 4000,
      encoding: 'utf-8',
      cwd: probeHome,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: probeHome,
        XDG_CONFIG_HOME: path.join(probeHome, '.config'),
        XDG_CACHE_HOME: path.join(probeHome, '.cache'),
        NO_COLOR: '1',
        TERM: 'dumb',
      },
    });
    const m = out.match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*/);
    return m ? m[0] : null;
  } catch {
    return null;
  } finally {
    if (probeHome) {
      try {
        fs.rmSync(probeHome, { recursive: true, force: true });
      } catch {
        // Version reporting is best-effort; cleanup trouble must not stop the daemon.
      }
    }
  }
}

export function __versionFromCliForTest(bin: string, args: string[] = ['--version']): string | null {
  if (process.env.NODE_ENV !== 'test') throw new Error('__versionFromCliForTest is test-only');
  return versionFromCli(bin, args);
}

/** Synchronous GET of a registry endpoint via curl (available in the runtime;
 *  the daemon is on-node so `localhost:30500` reaches the registry). */
function curlJson(url: string, accept?: string): unknown {
  const args = ['-sf', '--max-time', '5', url];
  if (accept) args.push('-H', `Accept: ${accept}`);
  try {
    return JSON.parse(execFileSync('curl', args, { timeout: 6000, encoding: 'utf-8' }));
  } catch {
    return null;
  }
}

const _MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',');

/** Resolve org.shizuha.harness.* labels from the agent-runtime image's registry
 *  manifest config. Best-effort; returns null on any failure. */
function imageHarnessLabels(imageRef: string | null): Record<string, string> | null {
  if (!imageRef || !imageRef.includes('/')) return null;
  try {
    const [host, rest] = [imageRef.slice(0, imageRef.indexOf('/')), imageRef.slice(imageRef.indexOf('/') + 1)];
    const colon = rest.lastIndexOf(':');
    const repo = colon > 0 ? rest.slice(0, colon) : rest;
    const tag = colon > 0 ? rest.slice(colon + 1) : 'latest';
    const base = `http://${host}`;
    let man = curlJson(`${base}/v2/${repo}/manifests/${tag}`, _MANIFEST_ACCEPT) as
      { manifests?: Array<{ digest: string; platform?: { architecture?: string } }>; config?: { digest?: string } } | null;
    if (man?.manifests?.length) {
      const child = man.manifests.find((m) => m.platform?.architecture === 'amd64') ?? man.manifests[0];
      man = curlJson(`${base}/v2/${repo}/manifests/${child!.digest}`, _MANIFEST_ACCEPT) as typeof man;
    }
    const configDigest = man?.config?.digest;
    if (!configDigest) return null;
    const cfg = curlJson(`${base}/v2/${repo}/blobs/${configDigest}`) as { config?: { Labels?: Record<string, string> } } | null;
    const labels = cfg?.config?.Labels ?? {};
    const prefix = 'org.shizuha.harness.';
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) {
      if (k.startsWith(prefix) && v) out[k.slice(prefix.length)] = String(v);
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/** The daemon's OWN scli version — <pkgver>.<distBuildStampUTC>, the same scheme
 *  the agent-runtime image bakes into org.shizuha.harness.scli (HIVE-600).
 *  The daemon runs the freshest dist (bind-mounted host build of master), so this
 *  is the fleet's "latest available" for our own harness; the image label is
 *  "current". Both are numerically semver-comparable. Uses the running bundle's
 *  mtime — no npm registry, works offline. */
function scliOwnVersion(): string | null {
  try {
    const bundle = fs.realpathSync(process.argv[1] ?? '');
    const stat = fs.statSync(bundle);
    let pkgVersion = '0.0.0';
    try {
      const pkgPath = path.join(path.dirname(bundle), '..', 'package.json');
      pkgVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version || pkgVersion;
    } catch { /* dist-only layout — keep 0.0.0 prefix, the stamp still orders */ }
    const d = stat.mtime;
    const stamp = [
      d.getUTCFullYear(),
      String(d.getUTCMonth() + 1).padStart(2, '0'),
      String(d.getUTCDate()).padStart(2, '0'),
      String(d.getUTCHours()).padStart(2, '0'),
      String(d.getUTCMinutes()).padStart(2, '0'),
    ].join('');
    return `${pkgVersion}.${stamp}`;
  } catch {
    return null;
  }
}

let _convergedAgentRuntimeImage: string | null = null;
let _cached: HarnessReport | null = null;
let _persistedImageLoaded = false;

function convergenceStatePath(): string | null {
  const explicit = process.env['SHIZUHA_HARNESS_CONVERGENCE_STATE_FILE']?.trim();
  if (explicit) return explicit;
  // Unit tests must not write into the developer's real daemon state. Tests
  // that exercise persistence opt in with the explicit path above.
  if (process.env.NODE_ENV === 'test') return null;
  return path.join(process.env['HOME'] ?? os.homedir(), '.shizuha', 'harness-convergence.json');
}

function loadPersistedConvergedImage(): void {
  if (_persistedImageLoaded) return;
  _persistedImageLoaded = true;
  const statePath = convergenceStatePath();
  if (!statePath) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { agent_runtime_image?: unknown };
    const image = typeof parsed.agent_runtime_image === 'string'
      ? parsed.agent_runtime_image.trim()
      : '';
    if (image.includes('shizuha-agent-runtime')) _convergedAgentRuntimeImage = image;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(`[daemon][runtime-roll] could not read convergence state: ${(error as Error).message}`);
    }
  }
}

function persistConvergedImage(image: string): void {
  const statePath = convergenceStatePath();
  if (!statePath) return;
  const dir = path.dirname(statePath);
  const temporary = `${statePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify({
      agent_runtime_image: image,
      recorded_at: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    fs.renameSync(temporary, statePath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
    console.warn(`[daemon][runtime-roll] could not persist convergence state: ${(error as Error).message}`);
  }
}

export function fleetConvergedToImage(
  deployments: Array<{ currentImage?: string; currentWorkspaceInitImage?: string }>,
  desiredImage: string,
): boolean {
  if (!desiredImage || deployments.length === 0) return false;
  // Only deployments that report an agent image count as evidence. Missing
  // image fields are incomplete reads, not proof of drift.
  const withImage = deployments.filter((d) => !!d.currentImage);
  return withImage.length > 0
    && withImage.every((deployment) => (
      deployment.currentImage === desiredImage
      && (!deployment.currentWorkspaceInitImage
        || deployment.currentWorkspaceInitImage === desiredImage)
    ));
}

/** PLAT-5589: which images the reviewed release document admits as a reportable
 * baseline.
 *
 * `unreviewed` is the legacy fleet that has no release document at all — the
 * document's ABSENCE (ENOENT) is the only thing that restores the old
 * unconditional behaviour. A document that exists but cannot be read or does
 * not validate is `unreadable`: the authority is present and we simply cannot
 * consult it, which is disagreement, not permission (same fail-closed reading
 * as `validateRuntimeReleaseProjections`). */
export type ReviewedRuntimeReleaseAdmission =
  | { mode: 'unreviewed' }
  | { mode: 'reviewed'; images: Set<string>; desiredGeneration: number }
  | { mode: 'unreadable'; reason: string };

/** Single resolution point for the reviewed release document — two readers in
 * this file and one in `k8s-backend.ts` must never drift onto different files,
 * or the gate below would consult a document the roller does not apply. */
function reviewedReleaseDocumentPath(): string {
  return process.env['SHIZUHA_DESIRED_RUNTIME_RELEASE_PATH']
    ?? '/etc/shizuha/runtime-release/desired.json';
}

export function reviewedRuntimeReleaseAdmission(): ReviewedRuntimeReleaseAdmission {
  const filename = reviewedReleaseDocumentPath();
  let raw: string;
  try {
    raw = fs.readFileSync(filename, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 'unreviewed' };
    return { mode: 'unreadable', reason: (error as Error).message };
  }
  try {
    const document = parseDesiredRuntimeReleaseDocument(JSON.parse(raw));
    const images = new Set<string>();
    for (const release of document.releases) {
      const tag = release.display_tag.trim();
      if (tag) images.add(tag);
      // The roller may apply a release by immutable digest; both spellings of
      // the same reviewed release are admissible.
      images.add(canonicalRuntimeImage(release));
    }
    return { mode: 'reviewed', images, desiredGeneration: document.desired_generation };
  } catch (error) {
    return { mode: 'unreadable', reason: (error as Error).message };
  }
}

let _lastRefusedDominantImage: string | null = null;

/** Report the DOMINANT running agent-runtime image — the modal `currentImage`
 * across READY deployments.
 *
 * The daemon reported only its startup image (or a strict-100%-converged one),
 * so with several builds a day and a paced idle-gated roller the reported
 * baseline froze on the last image that ever fully converged (2026-08-02) and
 * the harness UI showed "rolling" forever (operator 2026-08-06). The honest
 * baseline is what most agents actually run right now; the per-agent progress
 * bar carries the tail. Only READY deployments count — an unready pod on the
 * new image is mid-roll, not "running". The daemon can read image labels from
 * the node-local registry (Hive cannot — default-deny egress), so advancing
 * here is what makes the whole read model correct.
 *
 * PLAT-5589: this vote is a DESCRIPTION of the fleet, and it is published
 * through a channel Hive reads as an AUTHORITY — `harnessReport()` populates
 * `DaemonRegistry.agent_runtime_image`, which Hive's `_live_fleet_image()`
 * feeds straight back into every agent Deployment it writes. That closes a
 * loop: an image is desired because it is dominant, and dominant because it is
 * desired. The loop is self-reinforcing by construction, because this branch
 * runs exactly when the fleet has DIVERGED and its answer to divergence was to
 * ratify the divergent image — a never-reviewed image reached 55/59 seats and
 * the reviewed generation could not take it back.
 *
 * So the vote may only ever elect an image the reviewed release document
 * already admits. During a normal generation N -> N+1 roll the dominant image
 * IS a reviewed release, so the 2026-08-06 forever-"rolling" fix is preserved
 * intact; only an image no one ever approved is refused.
 */
export function noteDominantAgentRuntimeImage(
  deployments: Array<{ currentImage?: string; readyReplicas?: number; replicas?: number }>,
): void {
  const counts = new Map<string, number>();
  for (const d of deployments) {
    const image = (d.currentImage || '').trim();
    if (!image.includes('shizuha-agent-runtime')) continue;
    // Ready = the pod is actually serving this image. A scaled-to-zero
    // Deployment (replicas 0) reports its template image and counts too: it is
    // what the agent WILL run and would otherwise never advance the baseline.
    const ready = (d.replicas ?? 0) === 0 || (d.readyReplicas ?? 0) > 0;
    if (!ready) continue;
    counts.set(image, (counts.get(image) ?? 0) + 1);
  }
  if (counts.size === 0) return;
  let dominant = '';
  let best = -1;
  for (const [image, n] of counts) {
    if (n > best) { best = n; dominant = image; }
  }

  const admission = reviewedRuntimeReleaseAdmission();
  if (admission.mode !== 'unreviewed'
    && !(admission.mode === 'reviewed' && admission.images.has(dominant))) {
    // Throttled by image, not by tick: the reconciler runs on every lifecycle
    // pass, and one line per distinct refused image is the signal. Refusing
    // leaves the previously proven baseline standing — never a fabricated one.
    if (_lastRefusedDominantImage !== dominant) {
      _lastRefusedDominantImage = dominant;
      const why = admission.mode === 'unreadable'
        ? `reviewed release document unreadable: ${admission.reason}`
        : `not admitted by reviewed release document (desired generation ${admission.desiredGeneration})`;
      console.warn(
        `[daemon][runtime-roll] refusing to report dominant image ${dominant} (${best} deployments): ${why}`,
      );
    }
    return;
  }
  _lastRefusedDominantImage = null;
  noteConvergedAgentRuntimeImage(dominant);
}

/** Record the image that every observable k8s fleet Deployment has converged
 * to. The roller calls this only after its full deployment-state set agrees;
 * reporting Hive's desired target earlier would make the dashboard claim an
 * upgrade finished while agents were still on the previous image. */
export function noteConvergedAgentRuntimeImage(image: string): void {
  const normalized = image.trim();
  if (!normalized.includes('shizuha-agent-runtime')) return;
  loadPersistedConvergedImage();
  if (normalized === _convergedAgentRuntimeImage) return;
  _convergedAgentRuntimeImage = normalized;
  persistConvergedImage(normalized);
  _cached = null;
}

function desiredReleaseFromReviewedDocument(): DesiredRuntimeRelease | null {
  const filename = reviewedReleaseDocumentPath();
  try {
    return desiredRuntimeRelease(loadDesiredRuntimeReleaseDocument(filename));
  } catch {
    return null;
  }
}

export function harnessReport(): HarnessReport {
  if (_cached) return _cached;
  loadPersistedConvergedImage();
  const image = _convergedAgentRuntimeImage
    ?? process.env['SHIZUHA_AGENT_RUNTIME_IMAGE']
    ?? process.env['FLEET_AGENT_IMAGE']
    ?? null;
  _cached = {
    agent_runtime_image: image,
    desired_runtime_release: desiredReleaseFromReviewedDocument(),
    image_harness: imageHarnessLabels(image),
    daemon_cli: {
      codex: versionFromCli('codex'),
      claude_code: versionFromCli('claude'),
      antigravity: versionFromCli('agy') ?? versionFromCli('antigravity'),
      // Our own harness: the daemon host runs the newest dist build of scli.
      scli: scliOwnVersion(),
    },
    detected_at: new Date().toISOString(),
  };
  return _cached;
}

export function __resetConvergenceStateForTest(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('__resetConvergenceStateForTest is test-only');
  _convergedAgentRuntimeImage = null;
  _persistedImageLoaded = false;
  _lastRefusedDominantImage = null;
  _cached = null;
}
