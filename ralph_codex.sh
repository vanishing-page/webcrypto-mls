#!/usr/bin/env bash
#
# ralph_codex.sh -- agentic loop driving the Codex CLI over PROMPT.md.
#
# Each iteration = one non-interactive Codex session = ideally one task
# plus a commit. The bash loop owns the cadence and the escalation.
#
# Usage:  ./ralph_codex.sh [MAX_ITERATIONS]
#
set -uo pipefail   # NOT -e: per-iteration failures are handled below.

# --- Config -----------------------------------------------------------------
PROMPT_FILE="PROMPT.md"
PRD_FILE="specs/prd.json"
MODEL="gpt-5.6-luna"
MAX_ITERATIONS=${1:-10}
STALL_LIMIT=4          # bail after this many no-progress iterations
ITERATION=0
STALLED_COUNT=0
TMP_OUT=""             # global so the EXIT trap can clean it up

# Reasoning effort ladder, indexed by the stall count, clamped at the last
# entry. Progress resets STALLED_COUNT to 0, which drops the effort back to
# the baseline on its own -- no separate reset is needed.
EFFORT_TIERS=("low" "medium" "high")

# --- UI ---------------------------------------------------------------------
BLUE='\033[1;34m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
RED='\033[0;31m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}[*] $1${NC}"; }
log_step()    { echo -e "${YELLOW}[>] $1${NC}"; }
log_success() { echo -e "${GREEN}[+] $1${NC}"; }
log_warn()    { echo -e "${YELLOW}[!] $1${NC}"; }
log_error()   { echo -e "${RED}[x] $1${NC}"; }

cleanup() { rm -f "${TMP_OUT:-}" 2>/dev/null || true; }
trap cleanup EXIT
trap 'echo; log_warn "Stopping Ralph loop..."; exit 130' INT

# --- Preflight --------------------------------------------------------------
case "$MAX_ITERATIONS" in
    ''|*[!0-9]*)
        log_error "MAX_ITERATIONS must be a whole number (got '$MAX_ITERATIONS')."
        exit 1 ;;
esac
[ "$MAX_ITERATIONS" -gt 0 ] || {
    log_error "MAX_ITERATIONS must be greater than 0."; exit 1; }

for bin in codex git jq; do
    command -v "$bin" >/dev/null 2>&1 || {
        log_error "'$bin' not found in PATH."; exit 1; }
done
for f in "$PROMPT_FILE" "$PRD_FILE"; do
    [ -f "$f" ] || { log_error "Missing required file: $f"; exit 1; }
done
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
    log_error "This script requires a git repository."; exit 1; }

# --- Helpers ----------------------------------------------------------------
# Is the PRD parseable and shaped as expected? A corrupted file must never
# read as a finished one.
prd_ok() {
    jq -e 'has("userStories") and (.userStories | type == "array")' \
        "$PRD_FILE" >/dev/null 2>&1
}

# Tasks not yet passing, excluding manual:true (those need an attended
# session). Returns -1 on parse failure.
count_pending() {
    jq -r '[.userStories[]
            | select((.passes == false or .passes == null)
                     and (.manual != true))] | length' \
        "$PRD_FILE" 2>/dev/null || echo "-1"
}

effort_for_stall() {
    local n="$1" last=$(( ${#EFFORT_TIERS[@]} - 1 ))
    [ "$n" -gt "$last" ] && n="$last"
    echo "${EFFORT_TIERS[$n]}"
}

# --- Main loop --------------------------------------------------------------
log_info "Starting Ralph loop (max $MAX_ITERATIONS iterations, model $MODEL)."

while [ "$ITERATION" -lt "$MAX_ITERATIONS" ]; do
    ITERATION=$((ITERATION + 1))

    # 0. A broken PRD is never completion.
    if ! prd_ok; then
        log_error "$PRD_FILE is missing, malformed, or has no 'userStories'"
        log_error "array. Stopping for human review."
        exit 3
    fi

    PENDING_BEFORE="$(count_pending)"
    if [ "$PENDING_BEFORE" -eq 0 ]; then
        log_success "All tasks in $PRD_FILE pass. Nothing left to do."
        exit 0
    fi
    HEAD_BEFORE="$(git rev-parse HEAD 2>/dev/null || echo none)"
    EFFORT="$(effort_for_stall "$STALLED_COUNT")"

    echo
    log_info "ITERATION $ITERATION/$MAX_ITERATIONS  |  PENDING: $PENDING_BEFORE  |  STALL: $STALLED_COUNT/$STALL_LIMIT  |  EFFORT: $EFFORT"
    if [ "$STALLED_COUNT" -gt 0 ]; then
        log_step "Stalled $STALLED_COUNT round(s); running at $EFFORT effort."
    fi

    # 1. One Codex session. Its progress narration goes to stderr and stays
    #    on the terminal; stdout carries only the agent's final message, so
    #    tee both shows it and keeps a copy for the completion check.
    TMP_OUT="$(mktemp)"
    codex -m "$MODEL" exec --yolo \
        --config "model_reasoning_effort=\"$EFFORT\"" \
        - < "$PROMPT_FILE" | tee "$TMP_OUT"
    CODEX_RC="${PIPESTATUS[0]}"   # capture before anything clobbers it
    if [ "$CODEX_RC" -ne 0 ]; then
        log_warn "codex exited non-zero (rc=$CODEX_RC) -- auth, rate limit, or"
        log_warn "crash? Treating this iteration as no progress."
    fi

    # 2. State after the run. A -1 means the session left the PRD unparseable
    #    partway through; do not read that as tasks disappearing.
    PENDING_AFTER="$(count_pending)"
    if [ "$PENDING_AFTER" -lt 0 ]; then
        log_warn "$PRD_FILE became unparseable during this run."
        PENDING_AFTER="$PENDING_BEFORE"
    fi
    HEAD_AFTER="$(git rev-parse HEAD 2>/dev/null || echo none)"

    # 3. Completion, trusted only when the PRD agrees. On its own the token
    #    may just be the agent restating the stop condition while planning.
    if [ "$CODEX_RC" -eq 0 ] &&
       grep -q '<promise>COMPLETE</promise>' "$TMP_OUT"; then
        if [ "$PENDING_AFTER" -eq 0 ]; then
            echo
            log_success "SUCCESS: complete reported and 0 tasks pending."
            exit 0
        fi
        log_warn "Saw the COMPLETE signal but $PENDING_AFTER task(s) are still"
        log_warn "pending -- ignoring it."
    fi

    # 4. Progress is a new commit or a smaller pending count. A merely dirty
    #    tree is not progress: PROMPT.md requires the session to commit, so
    #    uncommitted flailing must not reset the escalation ladder.
    if [ -n "$(git status --porcelain)" ]; then
        log_warn "Working tree left dirty. Not counted as progress -- the"
        log_warn "session is supposed to commit completed work."
    fi

    if [ "$HEAD_AFTER" != "$HEAD_BEFORE" ] ||
       [ "$PENDING_AFTER" -lt "$PENDING_BEFORE" ]; then
        log_success "Progress (commit: $HEAD_BEFORE -> $HEAD_AFTER, pending: $PENDING_BEFORE -> $PENDING_AFTER)."
        log_success "Effort resets to ${EFFORT_TIERS[0]}."
        STALLED_COUNT=0
    else
        STALLED_COUNT=$((STALLED_COUNT + 1))
        log_warn "No progress this round (stall $STALLED_COUNT/$STALL_LIMIT). Next effort: $(effort_for_stall "$STALLED_COUNT")."
    fi

    rm -f "$TMP_OUT"; TMP_OUT=""

    # 5. Stop rather than burn every iteration on a no-op.
    if [ "$STALLED_COUNT" -ge "$STALL_LIMIT" ]; then
        log_error "Stalled $STALL_LIMIT rounds in a row with escalation"
        log_error "exhausted. Stopping for human review."
        exit 2
    fi

    sleep 2
done

echo
log_warn "Reached MAX_ITERATIONS=$MAX_ITERATIONS with $(count_pending) task(s) pending."
exit 0
