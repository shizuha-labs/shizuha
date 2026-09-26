#!/usr/bin/env bash
# Cross-package darwin-arm64 and darwin-x64 on a Linux builder.
#
# The public installer reads latest.json. Linux CI used to be the only writer,
# so darwin-arm64 was absent and install.sh refused to fall back. This script
# runs inside the linux-x64 publish job, after that job's own npm run build,
# and uploads both Darwin archives into the SAME immutable release id.
#
# Native pieces cannot be compiled here (no macOS SDK). They come from the
# Origin generic registry, same rule as the Linux Node tarball (PLAT-4678,
# no WAN from the build pod):
#   actions/generic/node/v<NODE_VERSION>/node-v<NODE_VERSION>-darwin-<arch>.tar.xz
#   actions/generic/better-sqlite3/v<ver>/better-sqlite3-v<ver>-node-v<ABI>-darwin-<arch>.tar.gz
#   actions/generic/sqlite-vec/v<ver>/sqlite-vec-darwin-<arch>-<ver>.tgz
# A better-sqlite3 or Node ABI bump 404s this job until those objects are uploaded.
#
# Required env (set by build-publish-scli.yml):
#   VERSION BUILD_ABI NODE_VERSION REGISTRY_BASE FORGEJO_TOKEN
#   CI_SOURCE_SHA CI_SOURCE_REF CI_RUN_NUMBER
set -euo pipefail

: "${VERSION:?}"
: "${BUILD_ABI:?}"
: "${NODE_VERSION:?}"
: "${REGISTRY_BASE:?}"
: "${FORGEJO_TOKEN:?}"
: "${CI_SOURCE_SHA:?}"
: "${CI_SOURCE_REF:?}"
: "${CI_RUN_NUMBER:?}"

SRC_DIR="${SRC_DIR:-/src}"
OUT_DIR="${OUT_DIR:-/out}"
PKG_BASE="${PKG_BASE:-http://forgejo-http.origin.svc.cluster.local/api/packages/actions/generic}"
NPM_REGISTRY="${NPM_REGISTRY:-http://npm-cache.registry.svc.cluster.local:4873}"

cd "$SRC_DIR"
test -f dist/shizuha.js
test -f node_modules/better-sqlite3/package.json

BSQL_VER="$(node -p "require('./node_modules/better-sqlite3/package.json').version")"
case "$BSQL_VER" in
  ''|*[!0-9A-Za-z._+-]*) echo "FATAL: unsafe better-sqlite3 version '$BSQL_VER'" >&2; exit 1 ;;
esac

# Host node ABI must be the ABI the vendored prebuild was built for.
# linux-x64 already asserts this equals the bundled Node 22.14.0 ABI.
HOST_ABI="$(node -p 'process.versions.modules')"
test "$HOST_ABI" = "$BUILD_ABI"

assert_macho() {
  # $1 file  $2 decimal cputype (CPU_TYPE_ARM64=16777228, CPU_TYPE_X86_64=16777223)
  node -e '
    const fs = require("fs");
    const [file, want] = process.argv.slice(1);
    const b = fs.readFileSync(file);
    const magic = b.length >= 8 ? b.readUInt32LE(0) : 0;
    const cpu = b.length >= 8 ? b.readUInt32LE(4) : 0;
    if (magic !== 0xFEEDFACF || cpu !== Number(want)) {
      console.error("FATAL: Mach-O mismatch", file, "magic", magic.toString(16), "cpu", cpu.toString(16), "want", Number(want).toString(16));
      process.exit(1);
    }
  ' "$1" "$2"
}

package_one() {
  local target="$1" cpu="$2"
  local arch="${target#darwin-}"
  local name="shizuha-${VERSION}-${target}"
  local stage="${OUT_DIR}/${name}"
  echo "Cross-packaging ${name}"
  rm -rf "$stage" /tmp/node-darwin.tar /tmp/node-darwin-root /tmp/bsql-darwin.tgz /tmp/bsql-darwin /tmp/vec-darwin.tgz
  mkdir -p "${stage}/bin" "${stage}/lib" /tmp/node-darwin-root /tmp/bsql-darwin

  local node_url="${PKG_BASE}/node/v${NODE_VERSION}/node-v${NODE_VERSION}-${target}.tar.xz"
  # Token: a newly uploaded generic package is not necessarily world-readable
  # the way the original public Node package is.
  curl -fSL -H "Authorization: token ${FORGEJO_TOKEN}" "$node_url" -o /tmp/node-darwin.tar
  local sd="node-v${NODE_VERSION}-${target}"
  tar xJf /tmp/node-darwin.tar -C /tmp/node-darwin-root \
    "${sd}/bin/node" "${sd}/bin/npm" "${sd}/bin/npx" "${sd}/lib/"
  mv "/tmp/node-darwin-root/${sd}/bin/node" "${stage}/bin/node"
  mv "/tmp/node-darwin-root/${sd}/bin/npm" "${stage}/bin/npm"
  mv "/tmp/node-darwin-root/${sd}/bin/npx" "${stage}/bin/npx"
  cp -a "/tmp/node-darwin-root/${sd}/lib/." "${stage}/lib/"
  # The Darwin node is Mach-O. npm ci must use the Linux node on PATH.
  cp dist/shizuha.js "${stage}/lib/shizuha.js"
  if [ -d dist/web ]; then cp -a dist/web "${stage}/lib/web"; fi
  if [ -d dist/templates ]; then cp -a dist/templates "${stage}/lib/templates"; fi
  cp package.json "${stage}/lib/package.json"
  cp package-lock.json "${stage}/lib/package-lock.json"
  (
    cd "${stage}/lib"
    npm ci --ignore-scripts --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY"
  )

  local pre_url="${PKG_BASE}/better-sqlite3/v${BSQL_VER}/better-sqlite3-v${BSQL_VER}-node-v${BUILD_ABI}-${target}.tar.gz"
  if ! curl -fSL -H "Authorization: token ${FORGEJO_TOKEN}" "$pre_url" -o /tmp/bsql-darwin.tgz; then
    echo "FATAL: vendored better-sqlite3 prebuild missing: ${pre_url}" >&2
    echo "Upload that object before shipping a better-sqlite3 or Node ABI bump." >&2
    exit 1
  fi
  tar xzf /tmp/bsql-darwin.tgz -C /tmp/bsql-darwin
  mkdir -p "${stage}/lib/node_modules/better-sqlite3/build/Release"
  cp /tmp/bsql-darwin/build/Release/better_sqlite3.node \
    "${stage}/lib/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  test -f "${stage}/lib/node_modules/pino/package.json"
  test -f "${stage}/lib/node_modules/better-sqlite3/package.json"

  # npm ci on Linux installs sqlite-vec-linux-*, which darwin cannot load.
  # The loader asks for sqlite-vec-darwin-<arch>/vec0.dylib (optional at startup,
  # required for the same vector index Linux ships).
  local vec_pkg="sqlite-vec-darwin-${arch}"
  local vec_ver
  vec_ver="$(node -p "require('${stage}/lib/node_modules/sqlite-vec/package.json').optionalDependencies['${vec_pkg}']")"
  case "$vec_ver" in
    ''|*[!0-9A-Za-z._+-]*) echo "FATAL: unsafe sqlite-vec version '$vec_ver'" >&2; exit 1 ;;
  esac
  local vec_url="${PKG_BASE}/sqlite-vec/v${vec_ver}/${vec_pkg}-${vec_ver}.tgz"
  curl -fSL -H "Authorization: token ${FORGEJO_TOKEN}" "$vec_url" -o /tmp/vec-darwin.tgz
  rm -rf "${stage}/lib/node_modules/sqlite-vec-linux-x64" \
         "${stage}/lib/node_modules/sqlite-vec-linux-arm64" \
         "${stage}/lib/node_modules/${vec_pkg}"
  mkdir -p "${stage}/lib/node_modules/${vec_pkg}"
  tar xzf /tmp/vec-darwin.tgz -C "${stage}/lib/node_modules/${vec_pkg}" --strip-components=1
  test -f "${stage}/lib/node_modules/${vec_pkg}/vec0.dylib"

  cat > "${stage}/bin/shizuha" <<'WRAP'
#!/usr/bin/env bash
SHIZUHA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$SHIZUHA_ROOT/bin:$PATH"
exec "$SHIZUHA_ROOT/bin/node" "$SHIZUHA_ROOT/lib/shizuha.js" "$@"
WRAP
  chmod +x "${stage}/bin/shizuha"
  echo "$VERSION" > "${stage}/VERSION"

  assert_macho "${stage}/bin/node" "$cpu"
  assert_macho "${stage}/lib/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "$cpu"
  grep -qi cortex "${stage}/lib/shizuha.js"
  # Do not exec the Mach-O. A text/HTML error page or an ELF would fail above.

  tar czf "${OUT_DIR}/${name}.tar.gz" -C "$OUT_DIR" "$name"
  local sha size published_at
  sha="$(sha256sum "${OUT_DIR}/${name}.tar.gz" | cut -d' ' -f1)"
  size="$(stat -c%s "${OUT_DIR}/${name}.tar.gz")"
  published_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  JSON_OUT="${OUT_DIR}/${target}.json" \
  JSON_PLATFORM="$target" \
  JSON_VERSION="$VERSION" \
  JSON_BASE_VERSION="$(node -p "require('./package.json').version")" \
  JSON_URL="https://shizuha.com/builds/releases/${name}.tar.gz" \
  JSON_SHA256="$sha" \
  JSON_SIZE="$size" \
  JSON_SOURCE_SHA="$CI_SOURCE_SHA" \
  JSON_SOURCE_REF="$CI_SOURCE_REF" \
  JSON_RUN_NUMBER="${CI_RUN_NUMBER:-}" \
  JSON_PUBLISHED_AT="$published_at" \
  node -e 'const fs=require("fs"); const e=process.env; fs.writeFileSync(e.JSON_OUT, JSON.stringify({platform:e.JSON_PLATFORM, version:e.JSON_VERSION, baseVersion:e.JSON_BASE_VERSION, url:e.JSON_URL, sha256:e.JSON_SHA256, size:Number(e.JSON_SIZE), sourceSha:e.JSON_SOURCE_SHA, sourceRef:e.JSON_SOURCE_REF, runNumber:e.JSON_RUN_NUMBER, publishedAt:e.JSON_PUBLISHED_AT}) + "\n")'

  for f in "${name}.tar.gz" "${target}.json"; do
    curl -sSf -X PUT -H "Authorization: token ${FORGEJO_TOKEN}" \
      -T "${OUT_DIR}/${f}" "${REGISTRY_BASE}/${f}"
  done
  echo "PUBLISHED ${name}.tar.gz sha=${sha} size=${size}"
  rm -rf "$stage" "${OUT_DIR}/${name}.tar.gz" /tmp/node-darwin.tar /tmp/node-darwin-root /tmp/bsql-darwin.tgz /tmp/bsql-darwin /tmp/vec-darwin.tgz
}

# CPU_TYPE_ARM64 = 0x0100000C, CPU_TYPE_X86_64 = 0x01000007
package_one darwin-arm64 16777228
package_one darwin-x64 16777223
