"""Pillow-based PNG renderer for chess board visualization.

Renders the current board state as a PNG image suitable for LLM vision input.
Includes piece positions, chess clocks, player names, and status indicators.
"""

import io
from PIL import Image, ImageDraw, ImageFont

# Board dimensions
SQUARE_SIZE = 80
BOARD_SIZE = SQUARE_SIZE * 8  # 640px

# Colors
LIGHT_SQUARE = (240, 217, 181)   # #F0D9B5
DARK_SQUARE = (181, 136, 99)     # #B58863
BG_COLOR = (26, 26, 46)          # #1A1A2E
TEXT_COLOR = (220, 220, 220)
ACTIVE_CLOCK_COLOR = (76, 175, 80)   # green highlight
INACTIVE_CLOCK_COLOR = (160, 160, 160)
CHECK_COLOR = (220, 50, 50, 100)     # red overlay for king in check
LABEL_COLOR = (180, 180, 180)

# Unicode chess pieces (white on top = black pieces at top ranks)
UNICODE_PIECES = {
    ('white', 'K'): '\u2654', ('white', 'Q'): '\u2655',
    ('white', 'R'): '\u2656', ('white', 'B'): '\u2657',
    ('white', 'N'): '\u2658', ('white', 'P'): '\u2659',
    ('black', 'K'): '\u265A', ('black', 'Q'): '\u265B',
    ('black', 'R'): '\u265C', ('black', 'B'): '\u265D',
    ('black', 'N'): '\u265E', ('black', 'P'): '\u265F',
}


def _find_font(size: int) -> ImageFont.FreeTypeFont:
    """Try to find a suitable font that renders chess unicode glyphs."""
    candidates = [
        # DejaVu has chess piece unicode glyphs — prefer it
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
        "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def _fmt_clock(seconds: float) -> str:
    """Format seconds as MM:SS."""
    if seconds <= 0:
        return "0:00"
    m = int(seconds) // 60
    s = int(seconds) % 60
    return f"{m}:{s:02d}"


def render(
    board,
    white_clock: float = 0,
    black_clock: float = 0,
    white_name: str = "White",
    black_name: str = "Black",
    turn: str = "white",
    status: str = "",
) -> bytes:
    """Render the chess board as a PNG image.

    Args:
        board: chess_engine.Board instance with piece_at(file, rank) method
        white_clock: White's remaining time in seconds (0 = unlimited)
        black_clock: Black's remaining time in seconds (0 = unlimited)
        white_name: Display name for white player
        black_name: Display name for black player
        turn: Current turn ("white" or "black")
        status: Status text (e.g. "Check!", "Checkmate", "Stalemate")

    Returns:
        PNG image bytes
    """
    # Layout: top margin (clocks) + board + bottom margin (labels + status)
    margin_top = 70
    margin_bottom = 60
    margin_left = 35
    margin_right = 15
    total_width = margin_left + BOARD_SIZE + margin_right
    total_height = margin_top + BOARD_SIZE + margin_bottom

    img = Image.new("RGB", (total_width, total_height), BG_COLOR)
    draw = ImageDraw.Draw(img)

    # Fonts
    piece_font = _find_font(int(SQUARE_SIZE * 0.75))
    label_font = _find_font(16)
    clock_font = _find_font(22)
    status_font = _find_font(18)
    name_font = _find_font(16)

    # ── Draw clocks and player names at top ──
    # Black player (top) - clock on left, name on right
    black_clock_str = _fmt_clock(black_clock) if black_clock > 0 else "--:--"
    black_clock_color = ACTIVE_CLOCK_COLOR if turn == "black" else INACTIVE_CLOCK_COLOR
    draw.text((margin_left + 5, 8), f"{black_name}", fill=LABEL_COLOR, font=name_font)
    draw.text((margin_left + 5, 30), black_clock_str, fill=black_clock_color, font=clock_font)

    # Turn indicator
    indicator = "\u25cf" if turn == "black" else "\u25cb"  # filled/empty circle
    draw.text((margin_left + BOARD_SIZE - 30, 30), indicator, fill=black_clock_color, font=clock_font)

    # ── Draw board squares ──
    for rank in range(8):
        for file in range(8):
            x = margin_left + file * SQUARE_SIZE
            # Rank 7 (8th rank) at top, rank 0 (1st rank) at bottom
            y = margin_top + (7 - rank) * SQUARE_SIZE

            # Square color
            is_light = (file + rank) % 2 == 0
            color = DARK_SQUARE if is_light else LIGHT_SQUARE
            draw.rectangle([x, y, x + SQUARE_SIZE, y + SQUARE_SIZE], fill=color)

            # Draw piece
            piece = board.piece_at(file, rank)
            if piece:
                piece_color, piece_type = piece
                char = UNICODE_PIECES.get((piece_color, piece_type), "?")
                # Center the piece in the square
                bbox = draw.textbbox((0, 0), char, font=piece_font)
                tw = bbox[2] - bbox[0]
                th = bbox[3] - bbox[1]
                px = x + (SQUARE_SIZE - tw) // 2
                py = y + (SQUARE_SIZE - th) // 2 - 4  # slight upward offset
                # Draw piece shadow for visibility
                draw.text((px + 1, py + 1), char, fill=(0, 0, 0, 128), font=piece_font)
                draw.text((px, py), char, fill=(255, 255, 255) if piece_color == "white" else (30, 30, 30), font=piece_font)

    # ── File labels (a-h) at bottom ──
    for file in range(8):
        label = "abcdefgh"[file]
        x = margin_left + file * SQUARE_SIZE + SQUARE_SIZE // 2 - 5
        y = margin_top + BOARD_SIZE + 4
        draw.text((x, y), label, fill=LABEL_COLOR, font=label_font)

    # ── Rank labels (1-8) on left ──
    for rank in range(8):
        label = str(rank + 1)
        x = 8
        y = margin_top + (7 - rank) * SQUARE_SIZE + SQUARE_SIZE // 2 - 10
        draw.text((x, y), label, fill=LABEL_COLOR, font=label_font)

    # ── White player (bottom) - clock and name ──
    white_clock_str = _fmt_clock(white_clock) if white_clock > 0 else "--:--"
    white_clock_color = ACTIVE_CLOCK_COLOR if turn == "white" else INACTIVE_CLOCK_COLOR
    bottom_y = margin_top + BOARD_SIZE + 22
    draw.text((margin_left + 5, bottom_y), f"{white_name}", fill=LABEL_COLOR, font=name_font)
    draw.text((margin_left + 5, bottom_y + 18), white_clock_str, fill=white_clock_color, font=clock_font)

    # Turn indicator for white
    indicator = "\u25cf" if turn == "white" else "\u25cb"
    draw.text((margin_left + BOARD_SIZE - 30, bottom_y + 18), indicator, fill=white_clock_color, font=clock_font)

    # ── Status text ──
    if status:
        status_x = margin_left + BOARD_SIZE // 2
        status_y = margin_top + BOARD_SIZE + 45
        bbox = draw.textbbox((0, 0), status, font=status_font)
        sw = bbox[2] - bbox[0]
        draw.text((status_x - sw // 2, status_y), status, fill=(255, 200, 50), font=status_font)

    # Encode as PNG
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()
