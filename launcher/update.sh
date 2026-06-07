#!/usr/bin/env bash

set -u

install_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
webapp_dir="$install_dir/webapp"
pid_file="$install_dir/server.pid"
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

is_process_alive() {
  local pid="$1"

  if [ -z "$pid" ]; then
    return 1
  fi

  kill -0 "$pid" 2>/dev/null
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
    cat "/proc/$pid/comm"
    return
  fi

  ps -p "$pid" -o comm= 2>/dev/null || true
}

read_process_cwd() {
  local pid="$1"

  if [ -L "/proc/$pid/cwd" ]; then
    readlink "/proc/$pid/cwd" 2>/dev/null || true
  fi
}

is_yamibunko_process() {
  local pid="$1"
  local name command cwd lower_name lower_command

  if [ "$pid" = "$$" ]; then
    return 1
  fi

  name="$(read_process_name "$pid")"
  command="$(read_process_command "$pid")"
  cwd="$(read_process_cwd "$pid")"
  lower_name="$(printf "%s" "$name" | tr '[:upper:]' '[:lower:]')"
  lower_command="$(printf "%s" "$command" | tr '[:upper:]' '[:lower:]')"

  if [ "$lower_name" = "launcher" ] || [ "$lower_name" = "launcher.exe" ]; then
    case "$cwd" in
      "$install_dir"|"$install_dir"/*) return 0 ;;
    esac

    case "$command" in
      *"$install_dir"*) return 0 ;;
    esac
  fi

  case "$lower_name" in
    bun|bun.exe|node|node.exe|next|next.exe)
      case "$cwd" in
        "$webapp_dir"|"$webapp_dir"/*) return 0 ;;
      esac

      case "$command" in
        *"$webapp_dir"*) return 0 ;;
      esac

      if printf "%s" "$lower_command" | grep -q "yamibunko" && printf "%s" "$lower_command" | grep -Eq "(next|bun|node|run start)"; then
        return 0
      fi
      ;;
  esac

  return 1
}

find_running_yamibunko_process() {
  local pid

  if [ -f "$pid_file" ]; then
    pid="$(tr -cd '0-9' < "$pid_file")"
    if is_process_alive "$pid" && is_yamibunko_process "$pid"; then
      printf "%s" "$pid"
      return 0
    fi
  fi

  for process_dir in /proc/[0-9]*; do
    [ -d "$process_dir" ] || continue
    pid="${process_dir##*/}"

    if is_yamibunko_process "$pid"; then
      printf "%s" "$pid"
      return 0
    fi
  done

  return 1
}

if running_pid="$(find_running_yamibunko_process)"; then
  fail "Yamibunko is still running (PID $running_pid). Close the launcher/server before updating."
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

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/yamibunko-update.XXXXXX")" || fail "Could not create a temporary update folder."
trap finish EXIT

zip_path="$temp_dir/yamibunko-linux.zip"
extract_dir="$temp_dir/extracted"
mkdir -p "$extract_dir" || fail "Could not create the extraction folder."

printf "Downloading latest Yamibunko Linux release...\n"
if [ "$downloader" = "curl" ]; then
  curl -fL "$release_url" -o "$zip_path" || fail "Download failed."
else
  wget -O "$zip_path" "$release_url" || fail "Download failed."
fi

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

if [ -d "$webapp_dir/.next" ]; then
  rm -rf "$webapp_dir/.next" || fail "Could not delete webapp/.next."
fi

printf "Update done.\n"
wait_before_exit
