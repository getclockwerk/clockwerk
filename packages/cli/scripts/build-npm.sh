#!/bin/bash
set -euo pipefail

# Build Clockwerk CLI for all platforms and stage into npm/ directories.
# Run from repo root: ./scripts/build-npm.sh [version]

VERSION="${1:-0.0.1}"
CLI_ENTRY="packages/cli/src/index.ts"
NPM_DIR="npm"

TARGETS=(
  "bun-linux-x64:clockwerk-linux-x64"
  "bun-linux-arm64:clockwerk-linux-arm64"
  "bun-darwin-x64:clockwerk-darwin-x64"
  "bun-darwin-arm64:clockwerk-darwin-arm64"
)

echo "Building clockwerk v${VERSION} for ${#TARGETS[@]} targets..."

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  pkg="${entry##*:}"
  dir="${NPM_DIR}/${pkg}"

  mkdir -p "${dir}/bin"
  echo "  ${target} -> ${dir}/bin/clockwerk"

  bun build "${CLI_ENTRY}" \
    --compile \
    --target="${target}" \
    --define "__CLOCKWERK_VERSION__='${VERSION}'" \
    --outfile "${dir}/bin/clockwerk"
done

# Update versions in all package.json files
echo ""
echo "Setting version to ${VERSION}..."

for dir in "${NPM_DIR}"/clockwerk*/; do
  pkg_json="${dir}package.json"
  if [ -f "$pkg_json" ]; then
    # Update own version
    tmp=$(mktemp)
    sed "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" "$pkg_json" > "$tmp"
    mv "$tmp" "$pkg_json"
  fi
done

# Update optionalDependencies versions in main package
main_pkg="${NPM_DIR}/clockwerk/package.json"
tmp=$(mktemp)
sed "s/\"@getclockwerk\/cli-[^\"]*\": \"[^\"]*\"/\0/;
     s/\": \"[0-9][^\"]*\"/\": \"${VERSION}\"/g" "$main_pkg" > "$tmp"
mv "$tmp" "$main_pkg"

echo ""
echo "Done. Packages ready in ${NPM_DIR}/:"
for dir in "${NPM_DIR}"/clockwerk*/; do
  name=$(basename "$dir")
  size=$(du -sh "${dir}bin/clockwerk" 2>/dev/null | cut -f1 || echo "no binary")
  echo "  ${name} (${size})"
done

echo ""
echo "To publish:"
echo "  cd npm/clockwerk-linux-x64  && npm publish --access public"
echo "  cd npm/clockwerk-linux-arm64 && npm publish --access public"
echo "  cd npm/clockwerk-darwin-x64  && npm publish --access public"
echo "  cd npm/clockwerk-darwin-arm64 && npm publish --access public"
echo "  cd npm/clockwerk             && npm publish"
