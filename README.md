# Tension Mirror

A small, hackable climb browser for one specific board setup: the **Tension
Board 2, Mirror layout, 12x12**. Built from scratch as a minimal alternative
to running the full [Climbdex](https://github.com/lemeryfertitta/Climbdex)
app just for this one use case.

Everything reads straight from the board's own sqlite database (produced by
[`boardlib`](https://github.com/lemeryfertitta/BoardLib)) - no ORM, no
bundled frontend framework, no bloat. Filter by grade, angle, and classics;
click a climb to see the holds lit up on the board image; log in with your
real board account to see (and add to) your sends and projects; light up
the actual board over Bluetooth.

## Features

- Filter by grade range, angle, "classics only", minimum ascents/quality, name
- Click a climb to see it drawn on the real board image, holds in their real colors
- Log in with your Aurora account to see which climbs you've sent or attempted
- "+1 Try" / "Mark as sent" - logged to a small local database (see **Aurora write API is down** below)
- "Light up board" - sends the climb to your physical board over Bluetooth
- A native Mac app wrapper with real Bluetooth support (see `mac/`)

## Setup

```
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Sync the board database (this is the same database Climbdex/boardlib use;
point `-u` at your board account username to sync recent climbs, or omit it
to just download without syncing):

```
mkdir -p data/tension
boardlib database tension data/tension/db.sqlite -u <your-board-username>
boardlib images tension data/tension/db.sqlite data/tension/images
```

Run it:

```
gunicorn app:app --bind 127.0.0.1:8001
```

Open `http://127.0.0.1:8001`.

### Changing board/layout/size

Edit the constants at the top of `app.py` (`LAYOUT_ID`, `SIZE_ID`,
`BOARD_DIR`). The SQL queries only care about `layout_id`/`size_id`, which
are the same concepts on any Aurora-based board (Kilter, Decoy, ...).

## The Mac app

`mac/` is a native macOS wrapper (SwiftUI + WKWebView) that runs this same
Flask app as an embedded subprocess and swaps in real `CoreBluetooth` for
the illuminate feature, since WKWebView (like Safari) doesn't support Web
Bluetooth.

```
cd mac
./build.sh
open TensionMirror.app
```

Requires Xcode's command line tools (`xcode-select -p` should print a
path). The app is ad-hoc signed by the build script, which is enough to
run locally but won't survive being copied to another Mac without
rebuilding there.

Since the board doesn't necessarily advertise a name containing "Tension"
(a real unit showed up as a serial-style name), the Mac app scans for a few
seconds and shows you a picker of every nearby Bluetooth device to choose
from, rather than guessing.

## Aurora's write API is currently down

As of this writing, Aurora's own endpoints for logging an ascent or attempt
(`/ascents/save/...`, `/bids/save/...`) both 404 - a backend migration on
their end, not something fixable client-side (see
[boardlib#78](https://github.com/lemeryfertitta/BoardLib/issues/78)). Reads
(login, syncing the climb catalog) still work fine.

Because of that, "+1 Try" and "Mark as sent" write to a small local sqlite
table (`data/my_progress.sqlite`) instead, keyed by your Aurora `user_id`.
What you see in the app is that local log **merged** with whatever Aurora
itself reported the last time you logged in. If Aurora restores the write
endpoints, `save_attempt`/`log_ascent` in `app.py` are the only places that
would need to change back.

## Staying logged in

The Flask session secret is persisted to `data/secret_key.txt` (generated
once, reused after that) so your login survives app restarts instead of
requiring you to log back in every time.
