#!/usr/bin/env bash
# Builds Save to Pigeon for Safari on macOS: the web extension (dist/safari),
# then the ad-hoc signed container app that carries it, into
# dist/safari-app/Save to Pigeon.app. Local only: CI does not run it.
#
# Usage: scripts/build-safari.sh [--open]
#   --open   launch the app afterwards (registers the extension with Safari)
#
# Needs Xcode and xcodegen (brew install xcodegen). Loading the result needs
# Safari's Develop > Allow Unsigned Extensions; see README.md.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

open_app=0
for arg in "$@"; do
	case "$arg" in
		--open) open_app=1 ;;
		*) echo "Unknown option: $arg (known: --open)" >&2; exit 2 ;;
	esac
done

command -v xcodegen >/dev/null || { echo "xcodegen is missing: brew install xcodegen" >&2; exit 1; }
command -v xcodebuild >/dev/null || { echo "xcodebuild is missing: install Xcode" >&2; exit 1; }

node scripts/build.mjs --browser safari

version="$(node -p "require('./package.json').version")"
# A rising build number lets Safari notice a rebuilt extension.
build_number="$(git rev-list --count HEAD 2>/dev/null || echo 1)"

(cd safari && xcodegen generate --quiet)

derived="$here/safari/build"
log="$derived/xcodebuild.log"
mkdir -p "$derived"
echo "Building the Safari container app (log: $log)…"
if ! xcodebuild build \
	-project safari/PigeonSafari.xcodeproj \
	-scheme PigeonSafari \
	-configuration Release \
	-destination 'generic/platform=macOS' \
	-derivedDataPath "$derived" \
	MARKETING_VERSION="$version" \
	CURRENT_PROJECT_VERSION="$build_number" \
	>"$log" 2>&1; then
	grep -E "error:|\*\* BUILD FAILED" "$log" >&2 || tail -40 "$log" >&2
	exit 1
fi

product="$derived/Build/Products/Release/Save to Pigeon.app"
out="$here/dist/safari-app"
app="$out/Save to Pigeon.app"
appex="$app/Contents/PlugIns/Save to Pigeon Extension.appex"
rm -rf "$out"
mkdir -p "$out"
# Move rather than copy, and drop the build folder's registration: two
# registered copies of the same extension confuse Safari.
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$lsregister" -u "$product" 2>/dev/null || true
mv "$product" "$app"
"$lsregister" -f "$app" 2>/dev/null || true

# The appex must carry the web extension at the root of its Resources.
for file in manifest.json background.js extract.js options.html options.js; do
	[ -f "$appex/Contents/Resources/$file" ] || { echo "Missing $file in $appex/Contents/Resources" >&2; exit 1; }
done
codesign --verify --deep --strict "$app"

echo "Built $app (version $version, build $build_number)"
if [ "$open_app" = 1 ]; then
	open "$app"
else
	echo "Run it once to register the extension: open \"$app\""
fi
