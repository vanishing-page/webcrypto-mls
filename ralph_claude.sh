#!/usr/bin/env bash
#
# ralph_claude.sh -- one-task-per-session agentic loop for Claude Code.
#
# Each loop iteration = exactly ONE Claude session = ideally ONE task + commit.
# The bash loop owns the cadence; Claude owns the work inside a single session.
#
# Usage:  ./ralph_claude.sh [MAX_ITERATIONS] [MAX_TURNS_PER_SESSION]
#         ./ralph_claude.sh 200 80
#
set -uo pipefail   # NOT -e: we handle per-iteration failures ourselves.

# --- Config -----------------------------------------------------------------
PROMPT_FILE="PROMPT.md"
PRD_FILE="specs/prd.json"
LOG_FILE="progress.log"
MODEL="sonnet"
MAX_ITERATIONS=${1:-10}
MAX_TURNS_PER_SESSION=${2:-80}   # hard ceiling so a single session can't run away
STALL_LIMIT=4                    # bail after this many no-progress iterations
ITERATION=0
STALLED_COUNT=0
TMP_CONTEXT=""                   # globals so the EXIT trap can clean them up
TMP_CAPTURE=""

# Adaptive reasoning ladder, indexed by stall count (clamps at the last entry).
# Valid levels: low | medium | high | xhigh | max -- AVAILABILITY DEPENDS ON THE
# MODEL. If your $MODEL rejects a level (e.g. "max"), trim the high end here.
# With STALL_LIMIT=4 the loop runs at stall 0,1,2,3 before bailing, so all four
# tiers fire. Progress resets STALLED_COUNT=0, which drops effort back to the
# baseline automatically -- no separate "reset to medium" logic needed.
EFFORT_TIERS=("medium" "high" "max")

# --- UI Colors --------------------------------------------------------------
BLUE='\033[1;34m'; YELLOW='\033[1;33m'; GREEN='\033[1;32m'; MAGENTA='\033[1;35m'; RED='\033[1;31m'; NC='\033[0m'
log_info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_step()    { echo -e "${YELLOW}➔ $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warn()    { echo -e "${MAGENTA}⚠️  $1${NC}"; }
log_error()   { echo -e "${RED}✖ $1${NC}"; }

cleanup() { rm -f "${TMP_CONTEXT:-}" "${TMP_CAPTURE:-}" 2>/dev/null || true; }
trap cleanup EXIT
trap 'echo; log_warn "Stopping Ralph Loop..."; exit 130' INT

# --- Preflight --------------------------------------------------------------
for bin in claude jq git; do
    command -v "$bin" >/dev/null 2>&1 || { log_error "'$bin' not found in PATH."; exit 1; }
done
for f in "$PROMPT_FILE" "$PRD_FILE"; do
    [ -f "$f" ] || { log_error "Missing required file: $f"; exit 1; }
done
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { log_error "Not inside a git repo."; exit 1; }
touch "$LOG_FILE"

# --- Helpers ----------------------------------------------------------------
# Is the PRD parseable and shaped as expected? Distinguishes a real "done"
# state from a corrupted file (which must NOT look like success).
prd_ok() {
    jq -e 'has("userStories") and (.userStories | type == "array")' "$PRD_FILE" >/dev/null 2>&1
}
# Count tasks not yet passing, excluding manual:true (those require a
# human-in-the-loop device session -- see ralph_device.sh -- and must never
# be selected or counted by this autonomous loop). Returns -1 on parse failure.
count_pending() {
    jq -r '[.userStories[] | select((.passes == false or .passes == null) and (.manual != true))] | length' "$PRD_FILE" 2>/dev/null || echo "-1"
}
# Count manual:true stories still not passing, for the "only manual work
# left" report. These are surfaced but never selected or touched here.
count_pending_manual() {
    jq -r '[.userStories[] | select((.passes == false or .passes == null) and (.manual == true))] | length' "$PRD_FILE" 2>/dev/null || echo "-1"
}
# Pretty list of pending tasks (for visibility / context). Manual stories are
# still listed, tagged, so a session knows they exist and to leave them alone.
pending_list() {
    jq -r '.userStories[] | select(.passes == false or .passes == null) | "[\(.id)] \(.title)" + (if .manual == true then "  (manual -- excluded from this loop)" else "" end)' "$PRD_FILE" 2>/dev/null
}
# Pretty list of manual:true stories still not passing.
pending_manual_list() {
    jq -r '.userStories[] | select((.passes == false or .passes == null) and (.manual == true)) | "[\(.id)] \(.title)"' "$PRD_FILE" 2>/dev/null
}
# The single highest-priority pending, non-manual task. Empty string when the
# PRD is valid and has no such task left (caller checks count_pending_manual()
# to distinguish "fully done" from "only manual work remains").
current_task() {
    jq -r '
        [.userStories[] | select((.passes == false or .passes == null) and (.manual != true))]
        | sort_by(.priority // 9999)
        | (.[0] // empty) | "[\(.id)] \(.title)"
    ' "$PRD_FILE" 2>/dev/null
}

# Map the stall count onto a reasoning effort level from EFFORT_TIERS, clamping
# at the last tier. This is the model-side half of escalation: it raises the
# actual thinking budget via `claude --effort`. The prompt-side half lives in
# reasoning_hint() below; both ramp on the same counter and stay in sync.
effort_for_stall() {
    local n="$1" last=$(( ${#EFFORT_TIERS[@]} - 1 ))
    [ "$n" -gt "$last" ] && n="$last"
    echo "${EFFORT_TIERS[$n]}"
}

# Reasoning hint injected into the prompt, escalating with the stall count.
# With STALL_LIMIT=4 the hint is evaluated at stall 0,1,2,3 -> all tiers fire
# before the loop bails. (Prompt-based escalation is version-proof; it doesn't
# rely on any particular `claude` reasoning flag existing.) This reinforces the
# `--effort` ladder driven by effort_for_stall().
reasoning_hint() {
    case "$1" in
        0) echo "" ;;
        1) echo "REASONING: Think step by step before acting." ;;
        2) echo "REASONING: This task stalled once already. Re-read progress.log and the spec, question your earlier assumptions, and try a different approach." ;;
        *) echo "REASONING: This task has stalled repeatedly. Think very hard. Re-read the Codebase Patterns and recent learnings in progress.log, abandon the approaches that have already failed, and attempt a genuinely different strategy." ;;
    esac
}

# --- Main loop --------------------------------------------------------------
while [ "$ITERATION" -lt "$MAX_ITERATIONS" ]; do
    ITERATION=$((ITERATION + 1))

    # 0. Never treat a broken PRD as completion.
    if ! prd_ok; then
        log_error "$PRD_FILE is missing/malformed or has no 'userStories' array. Stopping for human review."
        exit 3
    fi

    # 1. Pick the one task for this session.
    TASK="$(current_task)"
    if [ -z "$TASK" ]; then
        PENDING_MANUAL="$(count_pending_manual)"
        if [ "$PENDING_MANUAL" -gt 0 ]; then
            log_success "No headless work left — only manual:true stories remain:"
            pending_manual_list
            log_info "Run each via ./ralph_device.sh <story-id> in an attended session."
            exit 0
        fi
        log_success "All tasks in $PRD_FILE pass. Nothing left to do."
        exit 0
    fi
    PENDING_BEFORE="$(count_pending)"
    HEAD_BEFORE="$(git rev-parse HEAD 2>/dev/null || echo none)"

    # 1b. Pick this session's reasoning effort from the current stall count.
    EFFORT="$(effort_for_stall "$STALLED_COUNT")"

    # 2. Stall-driven friction relief: wipe stale local wrangler state.
    if [ "$STALLED_COUNT" -eq 2 ] && [ -d ".wrangler/state/v3" ]; then
        log_warn "Friction detected — clearing .wrangler/state/v3 ..."
        rm -rf .wrangler/state/v3
    fi

    echo -e "${BLUE}------------------------------------------------------------${NC}"
    log_info "ITERATION $ITERATION/$MAX_ITERATIONS  |  PENDING: $PENDING_BEFORE  |  STALL: $STALLED_COUNT/$STALL_LIMIT  |  EFFORT: $EFFORT"
    log_step "TARGET: $TASK"
    echo -e "${BLUE}------------------------------------------------------------${NC}"

    # 3. Build the per-session context. Pin THIS task and forbid touching others.
    TMP_CONTEXT="$(mktemp)"
    {
        cat "$PROMPT_FILE"
        echo
        echo "# THIS SESSION"
        echo "Work on EXACTLY ONE task: $TASK"
        echo "Complete it (write failing tests first, implement, lint, run only the"
        echo "relevant tests, update progress.log, set passes:true for this story,"
        echo "then commit). When that single task is done and committed, STOP. Do NOT"
        echo "start any other task this session, and do NOT mark any other story passing."
        echo
        echo "Remaining tasks (context only — do not work on these now):"
        pending_list
        echo
        echo "LAST_LOG_ENTRIES:"
        tail -n 8 "$LOG_FILE" 2>/dev/null
        HINT="$(reasoning_hint "$STALLED_COUNT")"
        if [ -n "$HINT" ]; then echo; echo "$HINT"; fi
    } > "$TMP_CONTEXT"

    # 4. Execute one session. Stream events live for the human; tee the RAW jsonl
    #    to a capture file. tee sits BETWEEN claude and jq, so the capture holds
    #    claude's stdout regardless of any downstream jq hiccup.
    #    --effort raises the model-side reasoning budget as stalls accumulate.
    TMP_CAPTURE="$(mktemp)"
    set +o pipefail
    cat "$TMP_CONTEXT" | claude -p --verbose \
          --output-format stream-json \
          --model "$MODEL" \
          --effort "$EFFORT" \
          --max-turns "$MAX_TURNS_PER_SESSION" \
          --dangerously-skip-permissions \
      | tee "$TMP_CAPTURE" \
      | jq --unbuffered -r '
          if .type == "system" then
            ( .subtype as $s
              | if   $s == "init"             then "🟦 session start (" + (.model // "?") + ")"
                elif $s == "api_retry"        then "⏳ retry " + ((.attempt // 0)|tostring) + "/" + ((.max_retries // 0)|tostring)
                                                    + " — " + (.error // "?") + " " + ((.error_status // "")|tostring)
                elif $s == "compact_boundary" then "🗜️  context compacted"
                elif $s == "thinking_tokens"  then "🧠 thinking: " + ([to_entries[] | select(.value|type=="number") | "\(.key)=\(.value)"] | join(" "))
                else "🟦 system: " + ($s // "?") end )
          elif .type == "assistant" then
            (.message.content[]? |
              if .type == "text"     then "💬 " + .text
              elif .type == "tool_use" then "🔧 " + .name + ": " + ((.input // {}) | tostring | .[0:140])
              else empty end)
          elif .type == "user" then
            (.message.content[]? | if .type == "tool_result" then "↩️  tool result" else empty end)
          elif .type == "result" then
            "✅ " + (.subtype // "done") + "  ($" + ((.total_cost_usd // 0) | tostring) + ")"
          else empty end
        ' 2>/dev/null
    # Capture pipe statuses IMMEDIATELY (before any other command clobbers them).
    PSTATUS=("${PIPESTATUS[@]}")
    set -o pipefail
    CLAUDE_RC="${PSTATUS[1]:-0}"   # 0=cat 1=claude 2=tee 3=jq
    if [ "$CLAUDE_RC" -ne 0 ]; then
        log_warn "claude exited non-zero (rc=$CLAUDE_RC) — auth/rate-limit/crash/unsupported --effort? Treating as no progress."
    fi

    # 5. Detect completion — but ONLY trust it if the PRD agrees all tasks pass.
    #    This kills false positives from claude merely *restating* the stop
    #    string while planning, and from any stream that echoes the prompt.
    PENDING_AFTER="$(count_pending)"
    if grep -q '<promise>COMPLETE</promise>' "$TMP_CAPTURE"; then
        if [ "$PENDING_AFTER" -eq 0 ]; then
            log_success "MISSION ACCOMPLISHED — COMPLETE reported and 0 tasks pending."
            exit 0
        else
            log_warn "Saw COMPLETE signal but $PENDING_AFTER task(s) still pending — ignoring (likely planning text)."
        fi
    fi

    # 6. Progress = a NEW COMMIT or FEWER PENDING TASKS. A merely-dirty tree is
    #    NOT progress: uncommitted flailing must not reset the stall counter,
    #    otherwise reasoning never escalates.
    HEAD_AFTER="$(git rev-parse HEAD 2>/dev/null || echo none)"
    if [ -n "$(git status --porcelain)" ]; then
        log_warn "Working tree left dirty (uncommitted changes). Not counted as progress — Claude should commit completed work."
    fi

    if [ "$HEAD_AFTER" != "$HEAD_BEFORE" ] || [ "$PENDING_AFTER" -lt "$PENDING_BEFORE" ]; then
        DELTA=$((PENDING_BEFORE - PENDING_AFTER))
        if [ "$DELTA" -gt 1 ]; then
            log_warn "Pending dropped by $DELTA (>1) — session completed more than one task. Tighten the prompt if this recurs."
        fi
        log_success "Progress (commits: $HEAD_BEFORE → $HEAD_AFTER, pending: $PENDING_BEFORE → $PENDING_AFTER). Effort resets to ${EFFORT_TIERS[0]}."
        STALLED_COUNT=0
    else
        STALLED_COUNT=$((STALLED_COUNT + 1))
        log_warn "No progress this session (stall $STALLED_COUNT/$STALL_LIMIT). Next effort: $(effort_for_stall "$STALLED_COUNT")."
    fi

    # Clean this iteration's tempfiles now (the EXIT trap is the safety net).
    rm -f "$TMP_CONTEXT" "$TMP_CAPTURE"; TMP_CONTEXT=""; TMP_CAPTURE=""

    # 7. Bail if we're truly stuck — avoid burning all iterations on a no-op.
    if [ "$STALLED_COUNT" -ge "$STALL_LIMIT" ]; then
        log_error "Stalled $STALL_LIMIT sessions in a row with escalation exhausted. Stopping for human review."
        exit 2
    fi
done

log_warn "Reached MAX_ITERATIONS=$MAX_ITERATIONS with tasks still pending ($(count_pending) left)."
exit 0
