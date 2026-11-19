#!/bin/bash
# Clipper — one-click setup + run for Mac.
# First run: downloads its own Node.js (LTS), the Clipper code, installs
# everything and opens the app. Later runs: just opens the app.
# Nothing here touches the system Node or any other app.

set -u
WORK="$HOME/ClipperApp"
mkdir -p "$WORK"
cd "$WORK" || exit 1

say() { echo ""; echo "== $* =="; }
fail() {
  echo ""
  echo "MASLA: $1"
  echo "Internet check karo aur is file ko dobara double-click karo — kaam wahi se aage barhe ga."
  read -r -p "Band karne ke liye Enter dabao..."
  exit 1
}

# ---------- 1) Own Node.js LTS (v24) ----------
if [ ! -x "$WORK/node/bin/node" ]; then
  say "Node.js download ho raha hai (sirf pehli dafa)..."
  ARCH="$(uname -m)"
  if [ "$ARCH" = "arm64" ]; then NARCH="arm64"; else NARCH="x64"; fi
  TARBALL="$(curl -s https://nodejs.org/dist/latest-v24.x/ | grep -o "node-v24[^\"]*darwin-$NARCH\.tar\.gz" | head -1)"
  [ -n "$TARBALL" ] || fail "Node ka download link nahi mila."
  curl -L -o node.tar.gz "https://nodejs.org/dist/latest-v24.x/$TARBALL" || fail "Node download fail ho gaya."
  rm -rf node-extract node
  mkdir -p node-extract
  tar -xzf node.tar.gz -C node-extract --strip-components=1 || fail "Node khul nahi saka."
  mv node-extract node
  rm -f node.tar.gz
fi
export PATH="$WORK/node/bin:$PATH"
echo "Node: $(node -v)"

# ---------- 2) Clipper code from GitHub ----------
if [ ! -f "$WORK/clipper-main/package.json" ]; then
  say "Clipper download ho raha hai..."
  curl -L -o clipper.zip "https://github.com/Danyalmalik2770/clipper/archive/refs/heads/main.zip" || fail "Clipper download fail ho gaya."
  rm -rf clipper-main
  unzip -q clipper.zip || fail "Clipper khul nahi saka."
  rm -f clipper.zip
fi
cd "$WORK/clipper-main" || fail "Clipper folder nahi mila."

# ---------- 3) Install (first time / after an interrupted install) ----------
if [ ! -f node_modules/.clipper-setup-done ]; then
  say "Clipper install ho raha hai — kuch minute lage ge. Window band mat karna."
  npm install || fail "Install fail ho gaya."

  # Electron binary (agar postinstall reh gaya ho)
  if [ ! -f node_modules/electron/path.txt ]; then
    node node_modules/electron/install.js || true
  fi
  # ffmpeg binary (agar postinstall reh gaya ho)
  if [ ! -f node_modules/ffmpeg-static/ffmpeg ]; then
    node node_modules/ffmpeg-static/install.js || true
  fi
  # better-sqlite3 ko Electron ke hisab se ready karo
  EV="$(node -p "require('./node_modules/electron/package.json').version" 2>/dev/null || true)"
  if [ -n "$EV" ]; then
    ( cd node_modules/better-sqlite3 && npx --yes prebuild-install --runtime electron --target "$EV" ) || true
  fi
  touch node_modules/.clipper-setup-done
  say "Install mukammal."
fi

# ---------- 4) Run ----------
say "Clipper khul raha hai..."
npm run dev
echo ""
echo "Clipper band ho gaya. Dobara kholne ke liye bas is file ko phir double-click karna hai."
read -r -p "Band karne ke liye Enter dabao..."
