# Operations

How the bot stayed live for a whole night on shared hardware, and what broke.

## Layout on the training machine

| tmux | What runs there |
|---|---|
| `evo:v5` | the current CMA-ES run |
| `evo:field` | refreshes the live field data every 15 minutes; training picks it up and re-measures its peak |
| `evo:release` | `ops/release.sh`, the release gate |
| `evo:monitor` | `src/monitor.ts --no-llm`: connection, stalls, losing streaks |
| `nijello` | `live/run.sh`, which restarts the client after any disconnect |

## The release gate (`ops/release.sh`)

The live bot reads `runs/live/params.json` at every match start, and only the gate writes it.
Every time training confirms a new best, the gate replays our real matches (same opponents, profiled, same seats) with the live params and the candidate on identical tables.
The candidate goes live only if it wins by more than 2 paired standard errors of placing score.
The first candidates it saw were held back: +0.005, -0.003 and +0.016, each with a standard error of about 0.014.

## Never stop the bot mid-match

A disconnected bot keeps its seat and scores 0, which the rating treats as a last place.
Restarts wait for the bot's own log line for the final auction (`bag 0`), when its last words and bid are already sent, then restart it half a second later, before it can join the next lobby.

## Incidents

**Two hard freezes.**
The machine froze twice, at 01:50 and 02:23, both within minutes of a 27B-parameter LLM (Qwen 3.5 on Ollama) generating on the GPU while training filled every CPU core.
Training alone had run for hours without trouble.
We dropped the LLM.
The first left Nijello disconnected in a running match, which scores 0; during the second it was already stopped for a training run.

**A file emptied by the crash.**
After the first freeze, `src/monitor.ts` on the machine was 0 bytes: it had been copied just before the crash and never reached the disk.
Recovery now checks checksums after every copy and syncs to disk.

**One bad process match.**
A broad `pkill -f` once matched the tmux server's own command line and took down every session.
Processes are now stopped only by exact PID or tmux window.

## Recovery (`ops/recover.sh`)

```bash
ops/recover.sh diag             # what happened: reboot, OOM, emptied files, what is running
ops/recover.sh evolve           # resume training from its checkpoint
ops/recover.sh golive           # live bot on runs/live/params.json, release gate, monitor
```

## Decision latency

Over 3,131 live decisions: median 0.2 ms, 99th percentile 1.6 ms, worst 4.4 ms.
3 bids arrived after their auction closed.
Bids are sealed and only the amount matters, so a bid that lands in time wins nothing extra by being faster.
