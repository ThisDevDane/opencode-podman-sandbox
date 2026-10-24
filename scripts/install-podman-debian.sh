#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPO_URI='https://download.opensuse.org/repositories/home:/alvistack/Debian_13/'
readonly REPO_MARKER='home:/alvistack/Debian_13'
readonly REPO_ORIGIN='obs://build.opensuse.org/home:alvistack/Debian_13'
readonly KEY_URL="${REPO_URI}Release.key"
readonly INRELEASE_URL="${REPO_URI}InRelease"
readonly EXPECTED_FINGERPRINT='789CFFDE0295B8A1F4E5690C4BECC97550D0B1FD'
readonly KEYRING_PATH='/usr/share/keyrings/alvistack-debian13-archive-keyring.gpg'
readonly SOURCE_PATH='/etc/apt/sources.list.d/alvistack-debian13.list'
readonly PREFERENCES_PATH='/etc/apt/preferences.d/alvistack-debian13.pref'
readonly DEBIAN_KEYRING='/usr/share/keyrings/debian-archive-keyring.gpg'
readonly INSTALL_PACKAGES=(podman uidmap fuse-overlayfs passt)

die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

[[ ${EUID:-$(id -u)} -eq 0 ]] || die 'Run this script as root, for example: sudo bash scripts/install-podman-debian.sh'
[[ -t 0 && -t 1 ]] || die 'An interactive terminal is required so apt can ask before installing packages.'

[[ -r /etc/os-release ]] || die 'Cannot identify the operating system.'
# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == debian && ${VERSION_ID:-} == 13 && ${VERSION_CODENAME:-} == trixie ]] || die 'This installer supports Debian 13 (trixie) only.'
[[ $(dpkg --print-architecture) == amd64 ]] || die 'This installer supports amd64 only.'

for command_name in apt-get awk basename cat chmod cmp curl dirname dpkg gpg gpgv grep install ln mkdir mktemp rm; do
	require_command "$command_name"
done
[[ -r $DEBIAN_KEYRING ]] || die "Debian archive keyring not found: $DEBIAN_KEYRING"
[[ -z ${APT_CONFIG:-} ]] || die 'Unset APT_CONFIG before running this installer so apt can use its isolated configuration.'
for apt_directory in /usr/share/keyrings /etc/apt/sources.list.d /etc/apt/preferences.d; do
	[[ -d $apt_directory && ! -L $apt_directory ]] || die "Expected apt directory is missing or is not a real directory: $apt_directory"
done

readonly SOURCE_CONTENT="deb [arch=amd64 signed-by=$KEYRING_PATH] $REPO_URI ./"
readonly PREFERENCES_CONTENT="Package: *
Pin: release o=$REPO_ORIGIN
Pin-Priority: -1

Package: podman buildah catatonit conmon containernetworking containernetworking-plugins containers-common containers-storage crun podman-aardvark-dns podman-netavark skopeo
Pin: release o=$REPO_ORIGIN
Pin-Priority: 990"

TMP_DIR=''
cleanup() {
	if [[ -n $TMP_DIR && -d $TMP_DIR ]]; then
		rm -rf -- "$TMP_DIR"
	fi
}
trap cleanup EXIT

assert_managed_file_or_absent() {
	local destination=$1
	local expected=$2
	if [[ -e $destination || -L $destination ]]; then
		[[ -f $destination && ! -L $destination ]] || die "Refusing to use unexpected file at $destination"
		cmp -s "$destination" "$expected" || die "Refusing to overwrite unexpected existing file: $destination"
	fi
}

assert_no_unmanaged_repo_reference() {
	local directory=$1
	local managed_path=$2
	local reference=$3
	local candidate
	local -a candidates=()
	[[ -f $directory ]] && candidates+=("$directory")
	if [[ -d $directory ]]; then
		shopt -s nullglob
		candidates+=("$directory"/*)
		shopt -u nullglob
	fi
	for candidate in "${candidates[@]}"; do
		[[ -f $candidate ]] || continue
		[[ $candidate == "$managed_path" ]] && continue
		if grep -Fq "$reference" "$candidate"; then
			die "Found an existing AlviStack reference in $candidate; review it before continuing."
		fi
	done
}

# Root must use the sticky system temp directory, not a user-owned parent directory.
TMP_DIR=$(mktemp -d /tmp/alvistack-podman.XXXXXX)
chmod 0700 "$TMP_DIR"
mkdir -m 0700 "$TMP_DIR/gnupg"

printf '%s\n' "$SOURCE_CONTENT" >"$TMP_DIR/source.list.expected"
printf '%s\n' "$PREFERENCES_CONTENT" >"$TMP_DIR/preferences.expected"
assert_managed_file_or_absent "$SOURCE_PATH" "$TMP_DIR/source.list.expected"
assert_managed_file_or_absent "$PREFERENCES_PATH" "$TMP_DIR/preferences.expected"
assert_no_unmanaged_repo_reference /etc/apt/sources.list "$SOURCE_PATH" "$REPO_MARKER"
assert_no_unmanaged_repo_reference /etc/apt/sources.list.d "$SOURCE_PATH" "$REPO_MARKER"
assert_no_unmanaged_repo_reference /etc/apt/preferences "$PREFERENCES_PATH" "$REPO_ORIGIN"
assert_no_unmanaged_repo_reference /etc/apt/preferences.d "$PREFERENCES_PATH" "$REPO_ORIGIN"

curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
	--output "$TMP_DIR/Release.key" "$KEY_URL"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
	--output "$TMP_DIR/InRelease" "$INRELEASE_URL"

fingerprint_from_key() {
	gpg --batch --homedir "$TMP_DIR/gnupg" --show-keys --with-colons "$1" |
		awk -F: '
			$1 == "pub" { public_keys++ }
			$1 == "fpr" && public_keys == 1 && fingerprint == "" { fingerprint = toupper($10) }
			END {
				if (public_keys != 1 || fingerprint == "") exit 1
				print fingerprint
			}
		'
}

key_fingerprint=$(fingerprint_from_key "$TMP_DIR/Release.key") || die 'Could not read the published repository signing key.'
[[ $key_fingerprint == "$EXPECTED_FINGERPRINT" ]] || die "Unexpected repository key fingerprint: $key_fingerprint"
gpg --batch --homedir "$TMP_DIR/gnupg" --dearmor --output "$TMP_DIR/repo-keyring.gpg" "$TMP_DIR/Release.key"
gpgv --homedir "$TMP_DIR/gnupg" --keyring "$TMP_DIR/repo-keyring.gpg" \
	--output "$TMP_DIR/Release" "$TMP_DIR/InRelease"
grep -Fxq 'Archive: Debian_13' "$TMP_DIR/Release" || die 'Repository metadata has an unexpected archive name.'
grep -Fxq "Origin: $REPO_ORIGIN" "$TMP_DIR/Release" || die 'Repository metadata has an unexpected origin.'
grep -Fxq 'Architectures: amd64' "$TMP_DIR/Release" || die 'Repository metadata does not advertise amd64.'
printf 'Verified AlviStack InRelease with signing key %s.\n' "$key_fingerprint"

if [[ -e $KEYRING_PATH || -L $KEYRING_PATH ]]; then
	[[ -f $KEYRING_PATH && ! -L $KEYRING_PATH ]] || die "Refusing to use unexpected file at $KEYRING_PATH"
	existing_fingerprint=$(fingerprint_from_key "$KEYRING_PATH") || die "Could not inspect existing keyring: $KEYRING_PATH"
	[[ $existing_fingerprint == "$EXPECTED_FINGERPRINT" ]] || die "Existing keyring has an unexpected fingerprint: $KEYRING_PATH"
fi
# Match persistence's stricter conflict rule before apt can change any packages.
assert_managed_file_or_absent "$KEYRING_PATH" "$TMP_DIR/repo-keyring.gpg"

mkdir -m 0700 "$TMP_DIR/lists" "$TMP_DIR/lists/partial" "$TMP_DIR/archives" "$TMP_DIR/archives/partial"
mkdir -m 0700 "$TMP_DIR/sourceparts" "$TMP_DIR/preferencesparts" "$TMP_DIR/apt.conf.d"
: >"$TMP_DIR/apt.conf"
cat >"$TMP_DIR/sources.list" <<EOF
deb [arch=amd64 signed-by=$TMP_DIR/repo-keyring.gpg] $REPO_URI ./
deb [arch=amd64 signed-by=$DEBIAN_KEYRING] https://deb.debian.org/debian trixie main
deb [arch=amd64 signed-by=$DEBIAN_KEYRING] https://deb.debian.org/debian trixie-updates main
deb [arch=amd64 signed-by=$DEBIAN_KEYRING] https://security.debian.org/debian-security trixie-security main
EOF
printf '%s\n' "$PREFERENCES_CONTENT" >"$TMP_DIR/preferences"

APT_OPTIONS=(
	-o "Dir::Etc::main=$TMP_DIR/apt.conf"
	-o "Dir::Etc::parts=$TMP_DIR/apt.conf.d"
	-o "Dir::Etc::sourcelist=$TMP_DIR/sources.list"
	-o "Dir::Etc::sourceparts=$TMP_DIR/sourceparts"
	-o "Dir::Etc::preferences=$TMP_DIR/preferences"
	-o "Dir::Etc::preferencesparts=$TMP_DIR/preferencesparts"
	-o "Dir::State::lists=$TMP_DIR/lists"
	-o 'Dir::State::status=/var/lib/dpkg/status'
	-o "Dir::Cache::archives=$TMP_DIR/archives"
	-o "Dir::Cache::pkgcache=$TMP_DIR/pkgcache.bin"
	-o "Dir::Cache::srcpkgcache=$TMP_DIR/srcpkgcache.bin"
	-o 'APT::Get::List-Cleanup=0'
	-o 'APT::Architecture=amd64'
)

printf '\nRefreshing package indexes in a temporary apt state directory...\n'
apt-get "${APT_OPTIONS[@]}" update

printf "\nSimulated transaction (review before accepting apt's install prompt):\n"
if ! apt-get "${APT_OPTIONS[@]}" -s --no-install-recommends --no-remove install "${INSTALL_PACKAGES[@]}" >"$TMP_DIR/install-plan" 2>&1; then
	cat "$TMP_DIR/install-plan" >&2
	die 'Could not resolve the Podman package transaction; no packages or apt configuration were changed.'
fi
cat "$TMP_DIR/install-plan"

printf '\nInstalling only Podman and the rootless helpers shown above. No full upgrade or removals are requested.\n'
apt-get "${APT_OPTIONS[@]}" --no-install-recommends --no-remove install "${INSTALL_PACKAGES[@]}"

persist_managed_file() {
	local source=$1
	local destination=$2
	local mode=$3
	local directory
	local base
	local staged

	if [[ -e $destination || -L $destination ]]; then
		[[ -f $destination && ! -L $destination ]] || die "Refusing to write unexpected file at $destination"
		cmp -s "$destination" "$source" || die "Refusing to overwrite unexpected existing file: $destination"
		return
	fi

	directory=$(dirname "$destination")
	base=$(basename "$destination")
	[[ -d $directory && ! -L $directory ]] || die "Expected apt directory is missing or is not a real directory: $directory"
	staged=$(mktemp "$directory/.${base}.tmp.XXXXXX")
	install -m "$mode" "$source" "$staged"
	if ! ln -T -- "$staged" "$destination"; then
		rm -f -- "$staged"
		die "Could not safely create $destination (it may have appeared during installation)."
	fi
	rm -f -- "$staged"
}

persist_managed_file "$TMP_DIR/repo-keyring.gpg" "$KEYRING_PATH" 0644
persist_managed_file "$TMP_DIR/source.list.expected" "$SOURCE_PATH" 0644
persist_managed_file "$TMP_DIR/preferences.expected" "$PREFERENCES_PATH" 0644

printf '\nPodman installation complete. No service or socket was enabled.\n'
podman --version
