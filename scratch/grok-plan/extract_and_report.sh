#!/bin/bash
# Extract Grok plan result and drop a report marker for the next turn.
set -u
WS=/home/openclaw/.openclaw/workspace/projects/deathbot-2000/scratch/grok-plan
cd "$WS"
if ! grep -q '"result"' run.jsonl 2>/dev/null; then
  echo "NOT_DONE jsonl_lines=$(wc -l < run.jsonl) alive=$(pgrep -fc 'cursor-agent' 2>/dev/null || echo 0)" > status.txt
  echo "Grok-Plan-Lauf noch nicht fertig."
  exit 0
fi
python3 /home/openclaw/.openclaw/agents/main/agent/workshop-skills/cursor-cli-code-review/scripts/extract-stream-text.py run.jsonl > result.txt 2>result.err
if [ -s result.txt ]; then
  echo "DONE plan_bytes=$(wc -c < result.txt)" > status.txt
  echo "Plan fertig."
else
  echo "DONE_EMPTY" > status.txt
  echo "result leer."
fi
