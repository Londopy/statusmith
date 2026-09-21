# Timers

The **Timer** row decides what Discord draws under the two lines of text.

| Mode | Card shows | Starts from |
|---|---|---|
| None | nothing | — |
| Elapsed since apply | `12:34 elapsed`, counting up | the moment you applied the preset |
| Elapsed since launch | same, counting up | when Statusmith started |
| Countdown | `04:59 left`, counting down | apply time, for the duration you set (minutes, decimals allowed) |

## The progress bar

Set the type to **Listening** and the timer to **Countdown** and Discord draws a music-player
style progress bar instead of a countdown number, with the elapsed and total times under it. A
3.5-minute countdown with *restart when it ends* ticked looks like a song on loop; a 25-minute one
is a pomodoro that everyone can see.

## Restart when it ends

With this ticked, a countdown re-applies itself at zero with a fresh start time. Without it, the
card sits at zero until you apply something else. The shortest countdown is 15 seconds — the
same floor as everything else, so nothing re-applies faster than Discord accepts.

## What survives

"Elapsed since apply" remembers its start time across Statusmith restarts and reboots: with
*Restore last presence on launch* on, the card comes back with the timer still counting from
the original moment. "Elapsed since launch" resets when Statusmith starts, which is the point.

Rotation applies each preset fresh, so an elapsed timer in a rotating preset restarts at every
turn.
