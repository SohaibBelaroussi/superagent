/**
 * Shell snippets run with `sh -c SCRIPT sa ARG...`: every value is a positional parameter, never part
 * of the script text. They rely only on a POSIX shell, coreutils, findutils and util-linux's setsid,
 * which Debian-based images have.
 */

/** Exit codes the file snippets use; the runner maps them to error codes. */
export const EXIT = {
  notFound: 44,
  isDirectory: 21,
  notDirectory: 20,
  exists: 17,
  notEmpty: 39,
} as const;

/**
 * Runs $3 in folder $2 as the leader of a new process group (so a kill takes its children too), with
 * its pid in /tmp/.sa/fg/$1/pid.
 */
export const FOREGROUND = `d=/tmp/.sa/fg/$1; mkdir -p "$d" || exit 126; cd -- "$2" || exit 127
exec setsid --wait sh -c 'echo $$ > "$1/pid"; exec sh -c "$2"' sa "$d" "$3"`;

/**
 * Starts $3 in folder $2 in the background: output to /tmp/.sa/bg/$1/{out,err}, the exit status to
 * exit. It outlives the exec that started it, and the runner.
 */
export const BACKGROUND = `d=/tmp/.sa/bg/$1; mkdir -p "$d" || exit 126; printf '%s' "$3" > "$d/cmd"
: > "$d/out"; : > "$d/err"; cd -- "$2" || exit 127
setsid sh -c 'echo $$ > "$1/pid"; sh -c "$2" > "$1/out" 2> "$1/err" < /dev/null; echo $? > "$1/exit"' sa "$d" "$3" > /dev/null 2>&1 &
echo started`;

/** Stops the process group of exec $2 (fg or bg in $1): TERM, then KILL after two seconds. */
export const KILL = `p=$(cat /tmp/.sa/$1/$2/pid 2>/dev/null) || exit 3
kill -TERM -$p 2>/dev/null || exit 3
for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 -$p 2>/dev/null || exit 0; sleep 0.2; done
kill -KILL -$p 2>/dev/null; exit 0`;

/** One background process: state line, command (base64), then size and tail (base64) of out and err. */
export const PROCESS_STATUS = `d=/tmp/.sa/bg/$1; [ -d "$d" ] || exit 44
if [ -f "$d/exit" ]; then echo "exit $(cat "$d/exit")"
elif p=$(cat "$d/pid" 2>/dev/null) && kill -0 -$p 2>/dev/null; then echo running
else echo gone; fi
base64 -w0 < "$d/cmd"; echo
stat -c %s "$d/out" 2>/dev/null || echo 0; tail -c "$2" "$d/out" 2>/dev/null | base64 -w0; echo
stat -c %s "$d/err" 2>/dev/null || echo 0; tail -c "$2" "$d/err" 2>/dev/null | base64 -w0; echo`;

/** Every background process: id, state and command (base64), tab-separated. */
export const PROCESS_LIST = `for d in /tmp/.sa/bg/*/; do [ -d "$d" ] || continue; id=$(basename "$d")
if [ -f "$d/exit" ]; then s="exit $(cat "$d/exit")"
elif p=$(cat "$d/pid" 2>/dev/null) && kill -0 -$p 2>/dev/null; then s=running
else s=gone; fi
printf '%s\\t%s\\t%s\\n' "$id" "$s" "$(base64 -w0 < "$d/cmd")"; done`;

/** Prints live if any background process still runs (the reaper leaves such a sandbox alone). */
export const ANY_LIVE = `for d in /tmp/.sa/bg/*/; do [ -f "$d/exit" ] && continue
p=$(cat "$d/pid" 2>/dev/null) || continue; kill -0 -$p 2>/dev/null && { echo live; exit 0; }; done; echo idle`;

/** File $1: its size on stderr, then at most $2 bytes of it. */
export const READ = `p=$1; [ -e "$p" ] || exit ${EXIT.notFound}; [ -d "$p" ] && exit ${EXIT.isDirectory}
stat -L -c %s -- "$p" >&2 || exit 1; head -c "$2" -- "$p"`;

/** Writes stdin to file $1. $2: overwrite, create (refuse an existing file) or append. */
export const WRITE = `p=$1; [ -d "$p" ] && exit ${EXIT.isDirectory}
if [ "$2" = create ] && { [ -e "$p" ] || [ -L "$p" ]; }; then exit ${EXIT.exists}; fi
dir=$(dirname -- "$p"); if [ -e "$dir" ] && [ ! -d "$dir" ]; then exit ${EXIT.notDirectory}; fi
mkdir -p -- "$dir" || exit ${EXIT.notDirectory}
if [ "$2" = append ]; then cat >> "$p"; else cat > "$p"; fi`;

/** Entries under folder $1 to depth $2, at most $3: type, size, mtime, link target, path; NUL-ended. */
export const LIST = `p=$1; [ -e "$p" ] || exit ${EXIT.notFound}; [ -d "$p" ] || exit ${EXIT.notDirectory}
find "$p" -mindepth 1 -maxdepth "$2" -printf '%y\\t%s\\t%T@\\t%l\\t%P\\0' | head -z -n "$3"`;

/** Type, size and mtime of $1, following symlinks. */
export const STAT = `p=$1; [ -e "$p" ] || exit ${EXIT.notFound}; find -L "$p" -maxdepth 0 -printf '%y\\t%s\\t%T@\\n'`;

/** Makes folder $1; $2 = 1 for parents too (and no error if it exists). */
export const MKDIR = `p=$1; if [ -d "$p" ]; then [ "$2" = 1 ] && exit 0; exit ${EXIT.exists}; fi
[ -e "$p" ] && exit ${EXIT.exists}
if [ "$2" = 1 ]; then mkdir -p -- "$p" || exit ${EXIT.notDirectory}
else [ -d "$(dirname -- "$p")" ] || exit ${EXIT.notFound}; mkdir -- "$p"; fi`;

/** Removes $1. $2: file, directory or any; $3 = 1: folders with their content; $4 = 1: missing is fine. */
export const REMOVE = `p=$1; if [ ! -e "$p" ] && [ ! -L "$p" ]; then [ "$4" = 1 ] && exit 0; exit ${EXIT.notFound}; fi
if [ -d "$p" ] && [ ! -L "$p" ]; then [ "$2" = file ] && exit ${EXIT.isDirectory}
  if [ "$3" = 1 ]; then rm -rf -- "$p"; else rmdir -- "$p" 2>/dev/null || exit ${EXIT.notEmpty}; fi
else [ "$2" = directory ] && exit ${EXIT.notDirectory}; rm -f -- "$p"; fi`;

/** Copies or moves ($4) $1 to $2; $3 = 1 to replace an existing $2. */
export const COPY = `s=$1; d=$2; [ -e "$s" ] || [ -L "$s" ] || exit ${EXIT.notFound}
if { [ -e "$d" ] || [ -L "$d" ]; } && [ "$3" != 1 ]; then exit ${EXIT.exists}; fi
mkdir -p -- "$(dirname -- "$d")" || exit ${EXIT.notDirectory}
if [ "$4" = move ]; then mv -f -- "$s" "$d"; else rm -rf -- "$d" 2>/dev/null; cp -R -- "$s" "$d"; fi`;
