# Weekend wristband colors

**Saturday and Sunday, 4 PM – 9 PM only.** The rest of the week the monitor
looks exactly as it did before.

During the weekend rush there are too many cards to read one timer at a time.
So each session's wristbands get stamped with the color of the **half hour it
has to be out by**, and staff sweep the play area for one color instead of
chasing names off the screen.

## The colors

| Out by | Band | | Out by | Band |
|---|---|---|---|---|
| 4:30 | Coral | | 7:30 | Coral |
| 5:00 | Yellow | | 8:00 | Yellow |
| 5:30 | Green | | 8:30 | Green |
| 6:00 | Teal | | 9:00 | Teal |
| 6:30 | Purple | | | |
| 7:00 | Pink | | | |

Two things make this stick:

- **It's fixed to the clock, not to arrival order.** The 6:30 band is purple
  this Saturday and every Saturday after. Nothing rotates or resets.
- **Six colors, so the cycle is three hours long.** Coral comes back at 7:30,
  by which time the 4:30 coral kids are long gone — two bands are never the
  same color on the floor at once.

The colors are all from the brand palette, and brown is deliberately left out
(it reads as coral under the play-area lights).

## How to read a card

A session ending at 6:12 PM sits in the 6:00–6:30 half hour, so it gets the
**purple** band and the card says "Out by 6:30 PM". The color is the sweep
instruction; the countdown on the card is still the exact time.

A session that ends exactly on a half-hour mark belongs to that mark, not the
next one — a 6:30 PM finish is purple, "Out by 6:30 PM". The band answers "what
is the first sweep this session must be gone by", so the end time rounds *up*
to a mark.

Cards keep their normal status colors underneath (purple border = waiting,
green = running, yellow = last 10 minutes, coral = overdue, teal = member), so
one card tells you both which band and how long is left.

No band is shown for:

- sessions whose finish time falls outside Sat/Sun 4–9 PM
- app bookings still **waiting** to check in (the clock hasn't started, so
  there's no finish time yet — the band appears the moment you check them in,
  which is when you stamp)
- **untimed membership visits** — nothing to time them out of
- sessions already **checked out**

The key row at the top of the monitor appears only during the window.

## Changing it

Everything lives in [`src/lib/ops/bands.ts`](../src/lib/ops/bands.ts): the
days, the 4 PM–9 PM window, the half-hour size, and the color cycle. Adding a
seventh color stretches the cycle to 3½ hours; the table and the on-screen key
both follow from the same array.

Times come from the device clock, like every other time on the monitor — keep
the counter tablet on IST.
