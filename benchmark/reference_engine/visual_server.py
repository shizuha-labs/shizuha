#!/usr/bin/env python3
"""Visual Chess Server — Flask server for visual chess battles.

Agents interact with the board by:
  - GET /screenshot → PNG image of current board state
  - POST /api/move → submit a move (JSON: {"move": "e2e4"})
  - GET /api/state → game state JSON (for host monitoring)
  - POST /api/reset → reset to new game

Chess clocks are tracked server-side using time.monotonic().
Game-over conditions: checkmate, stalemate, 50-move rule, flag fall.

Configuration via environment variables:
  BASE_TIME: seconds per side (default: 600)
  INCREMENT: seconds added per move (default: 0)
  WHITE_NAME: display name for white (default: "White")
  BLACK_NAME: display name for black (default: "Black")
"""

import os
import time
import json
import threading

from flask import Flask, request, jsonify, Response
from chess_engine import Board
import board_renderer

app = Flask(__name__)

# ── Configuration ──
BASE_TIME = int(os.environ.get("BASE_TIME", "600"))
INCREMENT = int(os.environ.get("INCREMENT", "0"))
WHITE_NAME = os.environ.get("WHITE_NAME", "White")
BLACK_NAME = os.environ.get("BLACK_NAME", "Black")

# ── Game State (protected by lock) ──
_lock = threading.Lock()
_board: Board = Board()
_move_history: list[str] = []
_game_over: bool = False
_game_result: str = ""     # "white", "black", "draw"
_game_reason: str = ""     # "checkmate", "stalemate", "50-move", "flag_fall"
_clocks: dict[str, float] = {"white": float(BASE_TIME), "black": float(BASE_TIME)}
_last_move_time: float = time.monotonic()  # when the current turn started
_move_count: int = 0
_use_clock: bool = BASE_TIME > 0
_move_details: list[dict] = []  # per-move timing telemetry


def _current_clocks() -> dict[str, float]:
    """Get current clock values, accounting for elapsed time on the active player's clock."""
    if not _use_clock or _game_over:
        return dict(_clocks)
    elapsed = time.monotonic() - _last_move_time
    turn = _board.turn
    clocks = dict(_clocks)
    clocks[turn] = max(0, clocks[turn] - elapsed)
    return clocks


def _check_flag_fall() -> bool:
    """Check if the current player's clock has expired. Must hold _lock."""
    global _game_over, _game_result, _game_reason
    if not _use_clock or _game_over:
        return False
    clocks = _current_clocks()
    turn = _board.turn
    if clocks[turn] <= 0:
        _game_over = True
        _game_result = "black" if turn == "white" else "white"
        _game_reason = "flag_fall"
        return True
    return False


def _check_game_end() -> None:
    """Check for checkmate, stalemate, 50-move rule. Must hold _lock."""
    global _game_over, _game_result, _game_reason
    if _game_over:
        return

    legal = _board.legal_moves_algebraic()
    if not legal:
        _game_over = True
        if _board.is_checkmate():
            _game_result = "black" if _board.turn == "white" else "white"
            _game_reason = "checkmate"
        else:
            _game_result = "draw"
            _game_reason = "stalemate"
        return

    if hasattr(_board, "halfmove_clock") and _board.halfmove_clock >= 100:
        _game_over = True
        _game_result = "draw"
        _game_reason = "50-move"


def _get_status_text() -> str:
    """Get human-readable status for the board renderer."""
    if _game_over:
        if _game_reason == "checkmate":
            winner = _game_result.capitalize()
            return f"Checkmate! {winner} wins"
        elif _game_reason == "stalemate":
            return "Stalemate — Draw"
        elif _game_reason == "50-move":
            return "50-move rule — Draw"
        elif _game_reason == "flag_fall":
            winner = _game_result.capitalize()
            return f"Flag fall! {winner} wins on time"
        return f"Game over: {_game_result}"

    if _board.is_in_check(_board.turn):
        return f"{_board.turn.capitalize()} is in CHECK!"
    return f"{_board.turn.capitalize()} to move"


# ── HTML page for browser debugging ──
HTML_PAGE = """<!DOCTYPE html>
<html>
<head>
<title>Visual Chess Battle</title>
<style>
  body { background: #1a1a2e; color: #e0e0e0; font-family: monospace;
         display: flex; flex-direction: column; align-items: center; padding: 20px; }
  h1 { color: #4fc3f7; }
  #board { margin: 20px 0; }
  #board img { border: 2px solid #444; border-radius: 4px; }
  #status { font-size: 1.2em; margin: 10px 0; }
  #clocks { display: flex; gap: 40px; font-size: 1.3em; margin: 10px 0; }
  .clock { padding: 8px 16px; border-radius: 6px; background: #2a2a4a; }
  .clock.active { background: #1b5e20; color: #76ff03; }
  #moves { max-width: 640px; word-wrap: break-word; color: #aaa; margin-top: 10px; }
  #state { font-size: 0.85em; color: #666; margin-top: 20px; white-space: pre; }
</style>
</head>
<body>
<h1>Visual Chess Battle</h1>
<div id="clocks">
  <div class="clock" id="clock-black"><span id="black-name">Black</span>: <span id="black-time">--:--</span></div>
  <div class="clock" id="clock-white"><span id="white-name">White</span>: <span id="white-time">--:--</span></div>
</div>
<div id="status">Loading...</div>
<div id="board"><img id="screenshot" src="/screenshot" /></div>
<div id="moves"></div>
<div id="state"></div>
<script>
function fmtClock(s) {
  if (s <= 0) return "0:00";
  return Math.floor(s/60) + ":" + String(Math.floor(s)%60).padStart(2,"0");
}
function refresh() {
  fetch("/api/state").then(r=>r.json()).then(d => {
    document.getElementById("status").textContent = d.status_text;
    document.getElementById("black-name").textContent = d.black_name;
    document.getElementById("white-name").textContent = d.white_name;
    document.getElementById("black-time").textContent = fmtClock(d.clocks.black);
    document.getElementById("white-time").textContent = fmtClock(d.clocks.white);
    document.getElementById("clock-black").className = "clock" + (d.turn==="black" && !d.game_over ? " active" : "");
    document.getElementById("clock-white").className = "clock" + (d.turn==="white" && !d.game_over ? " active" : "");
    // Format moves as pairs
    let moves = d.moves || [];
    let parts = [];
    for (let i = 0; i < moves.length; i += 2) {
      let n = Math.floor(i/2) + 1;
      parts.push(n + ". " + moves[i] + (moves[i+1] ? " " + moves[i+1] : ""));
    }
    document.getElementById("moves").textContent = parts.join(" ");
    document.getElementById("state").textContent = "FEN: " + d.fen + "\\nMoves: " + d.move_count;
    // Refresh screenshot with cache-bust
    document.getElementById("screenshot").src = "/screenshot?t=" + Date.now();
  });
}
setInterval(refresh, 2000);
refresh();
</script>
</body>
</html>"""


@app.route("/")
def index():
    """Browser debugging page."""
    return HTML_PAGE


@app.route("/screenshot")
def screenshot():
    """Return PNG screenshot of the current board state."""
    with _lock:
        _check_flag_fall()
        clocks = _current_clocks()
        status_text = _get_status_text()
        png_bytes = board_renderer.render(
            board=_board,
            white_clock=clocks["white"],
            black_clock=clocks["black"],
            white_name=WHITE_NAME,
            black_name=BLACK_NAME,
            turn=_board.turn,
            status=status_text,
        )
    return Response(png_bytes, mimetype="image/png")


@app.route("/api/state")
def api_state():
    """Return full game state as JSON (for host-side monitoring)."""
    with _lock:
        _check_flag_fall()
        clocks = _current_clocks()
        legal = _board.legal_moves_algebraic() if not _game_over else []
        state = {
            "fen": _board.to_fen(),
            "turn": _board.turn,
            "legal_moves": legal,
            "legal_move_count": len(legal),
            "moves": list(_move_history),
            "move_count": _move_count,
            "clocks": clocks,
            "game_over": _game_over,
            "game_result": _game_result,
            "game_reason": _game_reason,
            "status_text": _get_status_text(),
            "white_name": WHITE_NAME,
            "black_name": BLACK_NAME,
            "in_check": _board.is_in_check(_board.turn) if not _game_over else False,
            "move_details": list(_move_details),
        }
    return jsonify(state)


@app.route("/api/move", methods=["POST"])
def api_move():
    """Submit a move. Expects JSON: {"move": "e2e4"}."""
    global _move_count, _last_move_time, _game_over, _game_result, _game_reason

    data = request.get_json(silent=True) or {}
    move_str = data.get("move", "").strip()

    if not move_str:
        return jsonify({"error": "Missing 'move' field", "ok": False}), 400

    with _lock:
        if _game_over:
            return jsonify({
                "error": "Game is already over",
                "game_result": _game_result,
                "game_reason": _game_reason,
                "ok": False,
            }), 400

        # Check flag fall before accepting move
        if _check_flag_fall():
            return jsonify({
                "error": f"Game over: {_game_reason}",
                "game_result": _game_result,
                "game_reason": _game_reason,
                "ok": False,
            }), 400

        # Validate and execute move
        legal = _board.legal_moves_algebraic()
        if move_str not in legal:
            return jsonify({
                "error": f"Illegal move: {move_str}",
                "legal_moves": legal,
                "turn": _board.turn,
                "ok": False,
            }), 400

        # Deduct time from current player's clock
        now = time.monotonic()
        if _use_clock:
            elapsed = now - _last_move_time
            turn = _board.turn
            _clocks[turn] -= elapsed
            if _clocks[turn] <= 0:
                _game_over = True
                _game_result = "black" if turn == "white" else "white"
                _game_reason = "flag_fall"
                return jsonify({
                    "error": f"Flag fall: {turn} ran out of time",
                    "game_result": _game_result,
                    "game_reason": _game_reason,
                    "ok": False,
                }), 400
            # Add increment after successful move
            _clocks[turn] += INCREMENT

        # Execute the move
        turn = _board.turn
        try:
            _board.make_move(move_str)
        except ValueError as e:
            return jsonify({"error": str(e), "ok": False}), 400

        _move_history.append(move_str)
        _move_count += 1

        # Record per-move telemetry
        think_time_ms = int(elapsed * 1000) if _use_clock else int((now - _last_move_time) * 1000)
        _move_details.append({
            "move_number": _move_count,
            "move": move_str,
            "color": turn,
            "think_time_ms": think_time_ms,
            "clock_after": _clocks.get(turn, 0),
            "wall_timestamp": time.time(),
        })

        _last_move_time = time.monotonic()

        # Check for game end after the move
        _check_game_end()

        clocks = _current_clocks()
        return jsonify({
            "ok": True,
            "move": move_str,
            "fen": _board.to_fen(),
            "turn": _board.turn,
            "move_count": _move_count,
            "clocks": clocks,
            "game_over": _game_over,
            "game_result": _game_result,
            "game_reason": _game_reason,
        })


@app.route("/api/reset", methods=["POST"])
def api_reset():
    """Reset the game to starting position."""
    global _board, _move_history, _game_over, _game_result, _game_reason
    global _clocks, _last_move_time, _move_count, _move_details

    with _lock:
        _board = Board()
        _move_history = []
        _game_over = False
        _game_result = ""
        _game_reason = ""
        _clocks = {"white": float(BASE_TIME), "black": float(BASE_TIME)}
        _last_move_time = time.monotonic()
        _move_count = 0
        _move_details = []

    return jsonify({"ok": True, "message": "Game reset"})


if __name__ == "__main__":
    print(f"Visual Chess Server starting...")
    print(f"  Time control: {BASE_TIME}s + {INCREMENT}s/move")
    print(f"  White: {WHITE_NAME}, Black: {BLACK_NAME}")
    print(f"  Endpoints: GET /, GET /screenshot, GET /api/state, POST /api/move, POST /api/reset")
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
