#!/bin/sh
set -e

REPO="getclockwerk/clockwerk"
INSTALL_DIR="${CLOCKWERK_INSTALL_DIR:-/usr/local/bin}"
BINARY_NAME="clockwerk"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux*)  OS="linux" ;;
  Darwin*) OS="darwin" ;;
  *)       echo "Unsupported OS: $OS"; exit 1 ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

ARTIFACT="clockwerk-${OS}-${ARCH}"

# Get latest version if not specified
if [ -z "$CLOCKWERK_VERSION" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"//;s/".*//')"
  if [ -z "$VERSION" ]; then
    echo "Failed to determine latest version"
    exit 1
  fi
else
  VERSION="$CLOCKWERK_VERSION"
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ARTIFACT}"

curl -fsSL -X POST "https://getclockwerk.com/api/v1/download" \
  -H "Content-Type: application/json" \
  -d "{\"os\":\"$OS\",\"arch\":\"$ARCH\",\"version\":\"$VERSION\"}" \
  >/dev/null 2>&1 || true

echo "Installing clockwerk ${VERSION} (${OS}-${ARCH})..."

# Download
TMPFILE="$(mktemp)"
curl -fsSL "$DOWNLOAD_URL" -o "$TMPFILE"
chmod +x "$TMPFILE"

# Install
if [ -w "$INSTALL_DIR" ]; then
  mv "$TMPFILE" "${INSTALL_DIR}/${BINARY_NAME}"
else
  echo "Installing to ${INSTALL_DIR} (requires sudo)..."
  sudo mv "$TMPFILE" "${INSTALL_DIR}/${BINARY_NAME}"
fi

echo "Installed clockwerk to ${INSTALL_DIR}/${BINARY_NAME}"
echo ""
echo "Get started:"
echo "  clockwerk login"
echo "  clockwerk init <project-token>"
echo "  clockwerk up"
