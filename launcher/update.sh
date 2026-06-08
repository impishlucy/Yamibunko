#!/usr/bin/env bash

set -u

install_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
webapp_dir="$install_dir/webapp"
latest_release_api="https://api.github.com/repos/impishlucy/Yamibunko/releases/latest"
release_url="https://github.com/impishlucy/Yamibunko/releases/latest/download/yamibunko-linux.zip"
temp_dir=""

finish() {
  if [ -n "$temp_dir" ] && [ -d "$temp_dir" ]; then
    rm -rf "$temp_dir"
  fi
}

wait_before_exit() {
  printf "\nPress Enter to close this window..."
  IFS= read -r _
}

fail() {
  printf "\n%s\n" "$1" >&2
  wait_before_exit
  exit 1
}

read_process_command() {
  local pid="$1"

  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' ' ' < "/proc/$pid/cmdline"
    return
  fi

  ps -p "$pid" -o args= 2>/dev/null || true
}

read_process_name() {
  local pid="$1"

  if [ -r "/proc/$pid/comm" ]; then
    head -n 1 "/proc/$pid/comm"
    return
  fi

  ps -p "$pid" -o comm= 2>/dev/null | head -n 1 || true
}

is_yamibunko_process() {
  local pid="$1"
  local name command lower_name lower_command

  if [ "$pid" = "$$" ]; then
    return 1
  fi

  name="$(read_process_name "$pid")"
  command="$(read_process_command "$pid")"
  lower_name="$(printf "%s" "$name" | tr '[:upper:]' '[:lower:]')"
  lower_command="$(printf "%s" "$command" | tr '[:upper:]' '[:lower:]')"

  if [ "$lower_name" = "yamibunko" ]; then
    return 0
  fi

  case "$lower_name" in
    bun|node)
      if printf "%s" "$lower_command" | grep -q "yamibunk" && \
        printf "%s" "$lower_command" | grep -Eq '(^|[[:space:]])run[[:space:]]+start($|[[:space:]]|:)'; then
        return 0
      fi
      ;;
  esac

  return 1
}

find_running_yamibunko_process() {
  local pid process_name

  for process_dir in /proc/[0-9]*; do
    [ -d "$process_dir" ] || continue
    pid="${process_dir##*/}"

    if is_yamibunko_process "$pid"; then
      process_name="$(read_process_name "$pid")"
      if [ -z "$process_name" ]; then
        process_name="unknown"
      fi

      printf "%s\t%s" "$process_name" "$pid"
      return 0
    fi
  done

  return 1
}

extract_package_version() {
  local package_json="$1"

  if [ ! -f "$package_json" ]; then
    return 1
  fi

  sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$package_json" | head -n 1
}

normalize_version() {
  printf "%s" "$1" | sed -E 's/^[^0-9]*//; s/[^0-9.].*$//; s/\.$//'
}

is_version_format_valid() {
  printf "%s" "$1" | grep -Eq '^[0-9]+(\.[0-9]+)*$'
}

is_newer_version() {
  local latest="$1"
  local current="$2"
  local i max latest_part current_part

  IFS='.' read -r -a latest_parts <<< "$latest"
  IFS='.' read -r -a current_parts <<< "$current"

  max="${#latest_parts[@]}"
  if [ "${#current_parts[@]}" -gt "$max" ]; then
    max="${#current_parts[@]}"
  fi

  for ((i = 0; i < max; i++)); do
    latest_part="${latest_parts[$i]:-0}"
    current_part="${current_parts[$i]:-0}"

    if ((10#$latest_part > 10#$current_part)); then
      return 0
    fi

    if ((10#$latest_part < 10#$current_part)); then
      return 1
    fi
  done

  return 1
}

download_to_file() {
  local url="$1"
  local output_path="$2"

  if [ "$downloader" = "curl" ]; then
    curl -fL -H "User-Agent: Yamibunko-Updater" "$url" -o "$output_path"
  else
    wget --header="User-Agent: Yamibunko-Updater" -O "$output_path" "$url"
  fi
}

download_to_stdout() {
  local url="$1"

  if [ "$downloader" = "curl" ]; then
    curl -fsSL -H "Accept: application/vnd.github+json" -H "User-Agent: Yamibunko-Updater" "$url"
  else
    wget -qO- --header="Accept: application/vnd.github+json" --header="User-Agent: Yamibunko-Updater" "$url"
  fi
}

if running_process="$(find_running_yamibunko_process)"; then
  IFS="$(printf '	')" read -r running_name running_pid <<EOF
$running_process
EOF
  fail "Yamibunko is still running ($running_name, PID $running_pid). Close the launcher/server before updating."
fi

if ! command -v unzip >/dev/null 2>&1; then
  fail "Missing dependency: unzip. Install unzip and run this updater again."
fi

if command -v curl >/dev/null 2>&1; then
  downloader="curl"
elif command -v wget >/dev/null 2>&1; then
  downloader="wget"
else
  fail "Missing dependency: curl or wget. Install one of them and run this updater again."
fi

current_version_raw="$(extract_package_version "$webapp_dir/package.json")"
if [ -z "$current_version_raw" ]; then
  fail "Could not read the installed version from webapp/package.json."
fi

current_version="$(normalize_version "$current_version_raw")"
if ! is_version_format_valid "$current_version"; then
  fail "Installed version is invalid: $current_version_raw"
fi

printf "Checking latest Yamibunko version...\n"
latest_release_json="$(download_to_stdout "$latest_release_api")" || fail "Could not check the latest GitHub release."
latest_version_raw="$(printf "%s" "$latest_release_json" | sed -nE 's/^[[:space:]]*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' | head -n 1)"
if [ -z "$latest_version_raw" ]; then
  fail "Could not read the latest GitHub release version."
fi

latest_version="$(normalize_version "$latest_version_raw")"
if ! is_version_format_valid "$latest_version"; then
  fail "Latest GitHub release version is invalid: $latest_version_raw"
fi

printf "Installed version: %s\n" "$current_version_raw"
printf "Latest version: %s\n" "$latest_version_raw"

if ! is_newer_version "$latest_version" "$current_version"; then
  printf "Yamibunko is already up to date.\n"
  wait_before_exit
  exit 0
fi

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/yamibunko-update.XXXXXX")" || fail "Could not create a temporary update folder."
trap finish EXIT

zip_path="$temp_dir/yamibunko-linux.zip"
extract_dir="$temp_dir/extracted"
mkdir -p "$extract_dir" || fail "Could not create the extraction folder."

printf "Downloading latest Yamibunko Linux release...\n"
download_to_file "$release_url" "$zip_path" || fail "Download failed."

printf "Extracting release...\n"
unzip -q -o "$zip_path" -d "$extract_dir" || fail "Could not extract the release zip."

source_dir="$extract_dir/yamibunko-linux"
if [ ! -d "$source_dir" ]; then
  first_entry="$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  entry_count="$(find "$extract_dir" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"

  if [ "$entry_count" = "1" ] && [ -n "$first_entry" ]; then
    source_dir="$first_entry"
  else
    source_dir="$extract_dir"
  fi
fi

printf "Updating files...\n"
cp -a "$source_dir"/. "$install_dir"/ || fail "Could not copy the updated files."

printf "Clearing cached webapp build...\n"
rm -rf "$webapp_dir/.next" || fail "Could not remove webapp/.next. Close any remaining process and run the updater again."

printf "Update done.\n"
wait_before_exit
