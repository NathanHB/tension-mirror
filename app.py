"""Tension Mirror - a small, hackable climb browser for one board setup.

Everything reads straight from the board's sqlite database (produced by
`boardlib database tension ...`). Browsing needs no login. Logging in
(via your real board account) additionally marks which climbs you've
already sent or attempted, pulled straight from the Aurora API.

Logging a try or an ascent from this app does NOT write back to Aurora -
their write endpoints (/ascents/save/..., /bids/save/...) 404 as of this
writing (Aurora migrated their backend; see boardlib issue #78). Instead,
those actions are recorded in a small local sqlite db (PROGRESS_DB_PATH)
and merged with whatever Aurora reports at login. If Aurora ever restores
those endpoints, this is the only place that needs to change.

To point this at a different layout/size, change the three constants
below. To support another board entirely, change BOARD_DIR too - the
rest of the queries only care about layout_id / size_id, which are the
same concepts on every Aurora-based board (Kilter, Decoy, ...).
"""

import secrets
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import boardlib.api.aurora as aurora
from flask import Flask, jsonify, render_template, request, send_from_directory, session

BASE_DIR = Path(__file__).parent
BOARD_DIR = BASE_DIR / "data" / "tension"
DB_PATH = BOARD_DIR / "db.sqlite"
IMAGES_DIR = BOARD_DIR / "images"
PROGRESS_DB_PATH = BASE_DIR / "data" / "my_progress.sqlite"
SECRET_KEY_PATH = BASE_DIR / "data" / "secret_key.txt"
APP_URL = "https://tensionboardapp2.com"  # where "open in app" links point
BOARD = "tension"

LAYOUT_ID = 10  # Tension Board 2 Mirror
SIZE_ID = 6  # 12 high x 12 wide

SORT_COLUMNS = {
    "ascents": "climb_stats.ascensionist_count",
    "quality": "climb_stats.quality_average",
    "difficulty": "climb_stats.display_difficulty",
    "name": "climbs.name",
}

# What Aurora itself reported at login, per user_id: fetched once (either at
# login, or lazily the first time it's needed after a restart) and kept in
# memory. Merged at read time with the locally-logged progress in
# PROGRESS_DB_PATH.
PROGRESS_CACHE = {}


def load_or_create_secret_key():
    if SECRET_KEY_PATH.exists():
        return SECRET_KEY_PATH.read_text().strip()
    SECRET_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    key = secrets.token_hex(32)
    SECRET_KEY_PATH.write_text(key)
    return key


app = Flask(__name__)
# A stable key (instead of a fresh random one per process) so your login
# cookie survives restarts - otherwise every restart invalidates it and
# you'd have to log in again every time.
app.secret_key = load_or_create_secret_key()
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=365)
# Without this, Jinja caches the compiled template in memory under
# gunicorn (no debug mode), so editing templates/*.html does nothing until
# the server restarts - static JS/CSS aren't affected, only templates.
app.config["TEMPLATES_AUTO_RELOAD"] = True


def progress_db():
    conn = sqlite3.connect(PROGRESS_DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS logged_progress (
            user_id TEXT NOT NULL,
            climb_uuid TEXT NOT NULL,
            angle INTEGER NOT NULL,
            sent INTEGER NOT NULL DEFAULT 0,
            tries INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user_id, climb_uuid, angle)
        )"""
    )
    # Every time you log a send, not just the first - "sent" used to be a
    # single flag on logged_progress, which meant re-clicking after the
    # first send did nothing. This is a proper dated log instead.
    conn.execute(
        """CREATE TABLE IF NOT EXISTS ascent_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            climb_uuid TEXT NOT NULL,
            angle INTEGER NOT NULL,
            logged_at TEXT NOT NULL
        )"""
    )
    # One-time backfill: carry over old sent=1 flags (from before ascent_log
    # existed) as a single dated entry, so nothing already marked sent
    # silently reverts to unsent.
    conn.execute(
        """INSERT INTO ascent_log (user_id, climb_uuid, angle, logged_at)
           SELECT user_id, climb_uuid, angle, strftime('%Y-%m-%dT%H:%M:%S', 'now')
           FROM logged_progress AS lp
           WHERE lp.sent = 1
           AND NOT EXISTS (
               SELECT 1 FROM ascent_log AS a
               WHERE a.user_id = lp.user_id AND a.climb_uuid = lp.climb_uuid AND a.angle = lp.angle
           )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS favorites (
            user_id TEXT NOT NULL,
            climb_uuid TEXT NOT NULL,
            angle INTEGER NOT NULL,
            PRIMARY KEY (user_id, climb_uuid, angle)
        )"""
    )
    conn.commit()
    return conn


def get_local_favorites(user_id):
    """Returns the set of "uuid:angle" keys this user has favorited."""
    conn = progress_db()
    try:
        rows = conn.execute(
            "SELECT climb_uuid, angle FROM favorites WHERE user_id = ?",
            (user_id,),
        ).fetchall()
    finally:
        conn.close()
    return {f"{uuid}:{angle}" for uuid, angle in rows}


def toggle_local_favorite(user_id, climb_uuid, angle):
    conn = progress_db()
    try:
        existing = conn.execute(
            "SELECT 1 FROM favorites WHERE user_id = ? AND climb_uuid = ? AND angle = ?",
            (user_id, climb_uuid, angle),
        ).fetchone()
        if existing:
            conn.execute(
                "DELETE FROM favorites WHERE user_id = ? AND climb_uuid = ? AND angle = ?",
                (user_id, climb_uuid, angle),
            )
            favorited = False
        else:
            conn.execute(
                "INSERT INTO favorites (user_id, climb_uuid, angle) VALUES (?, ?, ?)",
                (user_id, climb_uuid, angle),
            )
            favorited = True
        conn.commit()
    finally:
        conn.close()
    return favorited


def get_local_progress(user_id):
    conn = progress_db()
    try:
        tries_rows = conn.execute(
            "SELECT climb_uuid, angle, tries FROM logged_progress WHERE user_id = ?",
            (user_id,),
        ).fetchall()
        send_rows = conn.execute(
            """SELECT climb_uuid, angle, COUNT(*) AS n, MAX(logged_at) AS last
               FROM ascent_log WHERE user_id = ? GROUP BY climb_uuid, angle""",
            (user_id,),
        ).fetchall()
    finally:
        conn.close()
    tries = {f"{uuid}:{angle}": t for uuid, angle, t in tries_rows}
    sends = {f"{uuid}:{angle}": (n, last) for uuid, angle, n, last in send_rows}
    return {"tries": tries, "sends": sends}


def add_local_try(user_id, climb_uuid, angle):
    conn = progress_db()
    try:
        conn.execute(
            """INSERT INTO logged_progress (user_id, climb_uuid, angle, tries)
               VALUES (?, ?, ?, 1)
               ON CONFLICT (user_id, climb_uuid, angle)
               DO UPDATE SET tries = tries + 1""",
            (user_id, climb_uuid, angle),
        )
        conn.commit()
        tries = conn.execute(
            "SELECT tries FROM logged_progress WHERE user_id = ? AND climb_uuid = ? AND angle = ?",
            (user_id, climb_uuid, angle),
        ).fetchone()[0]
    finally:
        conn.close()
    return tries


def log_local_ascent(user_id, climb_uuid, angle):
    """Records one more dated send - can be called any number of times for
    the same climb, unlike the old single sent=1 flag."""
    conn = progress_db()
    try:
        conn.execute(
            "INSERT INTO ascent_log (user_id, climb_uuid, angle, logged_at) VALUES (?, ?, ?, ?)",
            (user_id, climb_uuid, angle, datetime.now().isoformat(timespec="seconds")),
        )
        conn.commit()
        count = conn.execute(
            "SELECT COUNT(*) FROM ascent_log WHERE user_id = ? AND climb_uuid = ? AND angle = ?",
            (user_id, climb_uuid, angle),
        ).fetchone()[0]
    finally:
        conn.close()
    return count


def query(sql, params=()):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


@app.route("/")
def index():
    grades = [
        (row["difficulty"], row["boulder_name"])
        for row in query(
            "SELECT difficulty, boulder_name FROM difficulty_grades"
            " WHERE is_listed = 1 ORDER BY difficulty"
        )
    ]
    angles = [
        row["angle"]
        for row in query(
            "SELECT angle FROM products_angles"
            " JOIN layouts ON layouts.product_id = products_angles.product_id"
            " WHERE layouts.id = ? ORDER BY angle",
            (LAYOUT_ID,),
        )
    ]
    colors = {
        row["id"]: f"#{row['screen_color']}"
        for row in query(
            "SELECT placement_roles.id, placement_roles.screen_color"
            " FROM placement_roles"
            " JOIN layouts ON layouts.product_id = placement_roles.product_id"
            " WHERE layouts.id = ?",
            (LAYOUT_ID,),
        )
    }

    sets = query(
        "SELECT sets.id AS id, product_sizes_layouts_sets.image_filename AS image_filename"
        " FROM sets"
        " JOIN product_sizes_layouts_sets"
        "   ON product_sizes_layouts_sets.set_id = sets.id"
        " WHERE product_sizes_layouts_sets.layout_id = ?"
        "   AND product_sizes_layouts_sets.product_size_id = ?",
        (LAYOUT_ID, SIZE_ID),
    )
    images_to_holds = {}
    for set_row in sets:
        holds = query(
            "SELECT placements.id AS placement_id,"
            "       mirrored_placements.id AS mirrored_placement_id,"
            "       holes.x AS x, holes.y AS y"
            " FROM holes"
            " JOIN placements"
            "   ON placements.hole_id = holes.id"
            "   AND placements.set_id = ? AND placements.layout_id = ?"
            " LEFT JOIN placements mirrored_placements"
            "   ON mirrored_placements.hole_id = holes.mirrored_hole_id"
            "   AND mirrored_placements.set_id = ? AND mirrored_placements.layout_id = ?",
            (set_row["id"], LAYOUT_ID, set_row["id"], LAYOUT_ID),
        )
        image_url = f"/images/{set_row['image_filename']}"
        images_to_holds[image_url] = [
            [h["placement_id"], h["mirrored_placement_id"], h["x"], h["y"]] for h in holds
        ]

    edges = query(
        "SELECT edge_left, edge_right, edge_bottom, edge_top"
        " FROM product_sizes WHERE id = ?",
        (SIZE_ID,),
    )[0]

    # For lighting up the physical board over Bluetooth: which LED index
    # each placement maps to at this size, and which color each hold role
    # lights up as (distinct from the on-screen "colors" above).
    placement_positions = {
        row["placement_id"]: row["position"]
        for row in query(
            "SELECT placements.id AS placement_id, leds.position AS position"
            " FROM placements"
            " JOIN leds ON placements.hole_id = leds.hole_id"
            " WHERE placements.layout_id = ? AND leds.product_size_id = ?",
            (LAYOUT_ID, SIZE_ID),
        )
    }
    led_colors = {
        row["id"]: row["led_color"]
        for row in query(
            "SELECT placement_roles.id AS id, placement_roles.led_color AS led_color"
            " FROM placement_roles"
            " JOIN layouts ON layouts.product_id = placement_roles.product_id"
            " WHERE layouts.id = ?",
            (LAYOUT_ID,),
        )
    }

    return render_template(
        "index.html",
        grades=grades,
        angles=angles,
        colors=colors,
        images_to_holds=images_to_holds,
        edge_left=edges["edge_left"],
        edge_right=edges["edge_right"],
        edge_bottom=edges["edge_bottom"],
        edge_top=edges["edge_top"],
        app_url=APP_URL,
        board=BOARD,
        placement_positions=placement_positions,
        led_colors=led_colors,
    )


@app.route("/images/<path:filename>")
def images(filename):
    return send_from_directory(IMAGES_DIR, filename)


def fetch_progress(token):
    """Pull this user's full ascent/attempt history from the Aurora API.

    Deliberately calls the raw (pandas-free) boardlib helpers rather than
    boardlib's own logbook_entries(), which pulls in pandas for summarizing -
    unnecessary here and one less thing that can break.
    """
    sent = set()
    ascents = []  # (climb_uuid, angle, climbed_at) - for the History tab
    for ascent in aurora.get_ascents(BOARD, token):
        sent.add(f"{ascent['climb_uuid']}:{ascent['angle']}")
        if ascent.get("is_listed") and ascent.get("climbed_at"):
            ascents.append((ascent["climb_uuid"], ascent["angle"], ascent["climbed_at"]))

    tried = {}
    for bid in aurora.get_attempts(BOARD, token):
        key = f"{bid['climb_uuid']}:{bid['angle']}"
        tried[key] = tried.get(key, 0) + bid["bid_count"]

    return {"sent": sent, "tried": tried, "ascents": ascents}


def get_aurora_progress(user_id):
    """PROGRESS_CACHE is memory-only, so after a restart it's empty even
    though the login cookie (which is now stable across restarts) still
    says you're logged in. Refetch once from Aurora using the session's
    own token rather than making you log in again just to see it."""
    if not user_id:
        return None
    if user_id in PROGRESS_CACHE:
        return PROGRESS_CACHE[user_id]
    token = session.get("token")
    if not token:
        return None
    try:
        PROGRESS_CACHE[user_id] = fetch_progress(token)
    except Exception:
        return None
    return PROGRESS_CACHE[user_id]


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(force=True) or {}
    username = data.get("username", "")
    password = data.get("password", "")

    try:
        session_info = aurora.login(BOARD, username, password)
    except ValueError as error:
        return jsonify({"error": str(error)}), 401
    except Exception:
        return jsonify({"error": "Login failed. Try again."}), 502

    token = session_info["token"]
    user_id = session_info["user_id"]
    session.permanent = True
    session["token"] = token
    session["user_id"] = user_id
    PROGRESS_CACHE[user_id] = fetch_progress(token)
    return jsonify({"ok": True})


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/me")
def me():
    return jsonify({"logged_in": "user_id" in session})


@app.route("/api/refresh-progress", methods=["POST"])
def refresh_progress():
    token = session.get("token")
    user_id = session.get("user_id")
    if not token or not user_id:
        return jsonify({"error": "Not logged in"}), 401
    PROGRESS_CACHE[user_id] = fetch_progress(token)
    return jsonify({"ok": True})


@app.route("/api/history")
def history():
    user_id = session.get("user_id")
    if not user_id:
        return jsonify({"error": "Not logged in"}), 401

    # Two sources: sends logged locally in this app (ascent_log, needed
    # since Aurora's write API is down - see log_local_ascent), and your
    # real historical logbook as last synced from Aurora at login. Without
    # the second one this tab would only ever show "today".
    conn = progress_db()
    try:
        log_rows = conn.execute(
            "SELECT climb_uuid, angle, logged_at FROM ascent_log WHERE user_id = ?",
            (user_id,),
        ).fetchall()
    finally:
        conn.close()

    timestamped = [(uuid, angle, logged_at) for uuid, angle, logged_at in log_rows]

    aurora_progress = get_aurora_progress(user_id)
    if aurora_progress:
        for climb_uuid, angle, climbed_at in aurora_progress.get("ascents", []):
            try:
                iso_at = datetime.strptime(climbed_at, "%Y-%m-%d %H:%M:%S").isoformat(timespec="seconds")
            except ValueError:
                iso_at = climbed_at
            timestamped.append((climb_uuid, angle, iso_at))

    timestamped.sort(key=lambda row: row[2], reverse=True)

    entries = []
    for climb_uuid, angle, logged_at in timestamped:
        climb_rows = query(
            """SELECT climbs.name, climbs.setter_username, climb_stats.benchmark_difficulty,
                      (SELECT boulder_name FROM difficulty_grades
                       WHERE difficulty = ROUND(climb_stats.display_difficulty)) AS grade
               FROM climbs
               JOIN climb_stats ON climb_stats.climb_uuid = climbs.uuid AND climb_stats.angle = ?
               WHERE climbs.uuid = ?""",
            (angle, climb_uuid),
        )
        if not climb_rows:
            continue
        climb = climb_rows[0]
        entries.append({
            "uuid": climb_uuid,
            "angle": angle,
            "logged_at": logged_at,
            "name": climb["name"],
            "grade": climb["grade"],
            "setter_username": climb["setter_username"],
            "benchmark_difficulty": climb["benchmark_difficulty"],
        })

    return jsonify({"entries": entries})


def require_login():
    token = session.get("token")
    user_id = session.get("user_id")
    if not token or not user_id:
        return None
    return token, user_id


@app.route("/api/log-try", methods=["POST"])
def log_try():
    login_info = require_login()
    if not login_info:
        return jsonify({"error": "Not logged in"}), 401
    _token, user_id = login_info

    data = request.get_json(force=True) or {}
    climb_uuid = data.get("climb_uuid")
    angle = int(data.get("angle"))

    tries = add_local_try(user_id, climb_uuid, angle)
    return jsonify({"ok": True, "tries": tries})


@app.route("/api/log-ascent", methods=["POST"])
def log_ascent():
    login_info = require_login()
    if not login_info:
        return jsonify({"error": "Not logged in"}), 401
    _token, user_id = login_info

    data = request.get_json(force=True) or {}
    climb_uuid = data.get("climb_uuid")
    angle = int(data.get("angle"))

    send_count = log_local_ascent(user_id, climb_uuid, angle)
    return jsonify({"ok": True, "send_count": send_count})


@app.route("/api/toggle-favorite", methods=["POST"])
def toggle_favorite():
    login_info = require_login()
    if not login_info:
        return jsonify({"error": "Not logged in"}), 401
    _token, user_id = login_info

    data = request.get_json(force=True) or {}
    climb_uuid = data.get("climb_uuid")
    angle = int(data.get("angle"))

    favorited = toggle_local_favorite(user_id, climb_uuid, angle)
    return jsonify({"ok": True, "favorited": favorited})


@app.route("/api/climbs")
def climbs():
    args = request.args
    min_grade = int(args.get("minGrade", 1))
    max_grade = int(args.get("maxGrade", 99))
    min_ascents = int(args.get("minAscents", 1))
    min_quality = float(args.get("minQuality", 0))
    only_classics = args.get("onlyClassics", "1") != "0"
    only_favorites = args.get("onlyFavorites", "0") != "0"
    angle = args.get("angle", "any")
    name = args.get("name", "").strip()
    user_id = session.get("user_id")
    sort_column = SORT_COLUMNS.get(args.get("sortBy"), SORT_COLUMNS["ascents"])
    sort_order = "ASC" if args.get("sortOrder") == "asc" else "DESC"
    page = max(int(args.get("page", 0)), 0)
    page_size = min(int(args.get("pageSize", 24)), 100)

    where_sql = """
        FROM climbs
        JOIN climb_stats ON climb_stats.climb_uuid = climbs.uuid
        JOIN product_sizes ON product_sizes.id = ?
        WHERE climbs.layout_id = ?
          AND climbs.frames_count = 1
          AND climbs.is_draft = 0
          AND climbs.is_listed = 1
          AND climbs.edge_left > product_sizes.edge_left
          AND climbs.edge_right < product_sizes.edge_right
          AND climbs.edge_bottom > product_sizes.edge_bottom
          AND climbs.edge_top < product_sizes.edge_top
          AND climb_stats.ascensionist_count >= ?
          AND ROUND(climb_stats.display_difficulty) BETWEEN ? AND ?
          AND climb_stats.quality_average >= ?
    """
    params = [SIZE_ID, LAYOUT_ID, min_ascents, min_grade, max_grade, min_quality]

    if only_classics:
        where_sql += " AND climb_stats.benchmark_difficulty IS NOT NULL"
    if angle != "any":
        where_sql += " AND climb_stats.angle = ?"
        params.append(int(angle))
    if name:
        where_sql += " AND climbs.name LIKE ?"
        params.append(f"%{name}%")

    if only_favorites:
        favorite_pairs = []
        if user_id:
            favorite_pairs = [
                key.split(":") for key in get_local_favorites(user_id)
            ]
        if not favorite_pairs:
            return jsonify({"total": 0, "climbs": []})
        where_sql += " AND (climbs.uuid, climb_stats.angle) IN (VALUES " + ", ".join(
            ["(?, ?)"] * len(favorite_pairs)
        ) + ")"
        for climb_uuid, climb_angle in favorite_pairs:
            params.append(climb_uuid)
            params.append(int(climb_angle))

    total = query(f"SELECT COUNT(*) AS n {where_sql}", params)[0]["n"]

    select_sql = f"""
        SELECT
            climbs.uuid,
            climbs.setter_username,
            climbs.name,
            climbs.description,
            climbs.frames,
            climb_stats.angle,
            climb_stats.ascensionist_count,
            (SELECT boulder_name FROM difficulty_grades
             WHERE difficulty = ROUND(climb_stats.display_difficulty)) AS grade,
            climb_stats.quality_average,
            ROUND(climb_stats.difficulty_average - ROUND(climb_stats.display_difficulty), 2) AS grade_error,
            climb_stats.benchmark_difficulty
        {where_sql}
        ORDER BY {sort_column} {sort_order}{
            ", climb_stats.ascensionist_count DESC" if sort_column != SORT_COLUMNS["ascents"] else ""
        }
        LIMIT ? OFFSET ?
    """
    rows = query(select_sql, params + [page_size, page * page_size])

    aurora_progress = get_aurora_progress(user_id)
    local_progress = get_local_progress(user_id) if user_id else {"tries": {}, "sends": {}}
    favorites = get_local_favorites(user_id) if user_id else set()

    results = []
    for row in rows:
        climb = dict(row)
        key = f"{climb['uuid']}:{climb['angle']}"
        local_send_count, local_last_sent = local_progress["sends"].get(key, (0, None))
        local_tries = local_progress["tries"].get(key, 0)
        aurora_sent = bool(aurora_progress and key in aurora_progress["sent"])
        aurora_tries = aurora_progress["tried"].get(key, 0) if aurora_progress else 0
        climb["sent"] = aurora_sent or local_send_count > 0
        climb["send_count"] = local_send_count
        climb["last_sent_at"] = local_last_sent
        climb["tries"] = aurora_tries + local_tries
        climb["favorited"] = key in favorites
        results.append(climb)

    return jsonify({"total": total, "climbs": results})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
