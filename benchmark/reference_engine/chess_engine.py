"""Chess engine with full rules enforcement."""

PIECE_SYMBOLS = {
    'K': '♔', 'Q': '♕', 'R': '♖', 'B': '♗', 'N': '♘', 'P': '♙',
    'k': '♚', 'q': '♛', 'r': '♜', 'b': '♝', 'n': '♞', 'p': '♟',
}

FILES = 'abcdefgh'
RANKS = '12345678'


def sq(file_idx, rank_idx):
    """Convert file/rank indices (0-7) to square name like 'e4'."""
    return FILES[file_idx] + RANKS[rank_idx]


def parse_sq(s):
    """Convert square name like 'e4' to (file_idx, rank_idx)."""
    return FILES.index(s[0]), RANKS.index(s[1])


class Board:
    def __init__(self):
        # board[rank][file] - rank 0 = rank 1 (white's back rank)
        self.board = [[None] * 8 for _ in range(8)]
        self.turn = 'white'
        self.castling_rights = {'K': True, 'Q': True, 'k': True, 'q': True}
        self.en_passant_target = None  # square name like 'e3' or None
        self.halfmove_clock = 0
        self.fullmove_number = 1
        self.move_history = []
        self._setup_initial_position()

    def _setup_initial_position(self):
        # White pieces (rank 0 = rank 1)
        back_rank = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']
        for f in range(8):
            self.board[0][f] = ('white', back_rank[f])
            self.board[1][f] = ('white', 'P')
            self.board[6][f] = ('black', 'P')
            self.board[7][f] = ('black', back_rank[f])

    def piece_at(self, file_idx, rank_idx):
        """Return (color, piece_type) or None."""
        if 0 <= file_idx < 8 and 0 <= rank_idx < 8:
            return self.board[rank_idx][file_idx]
        return None

    def set_piece(self, file_idx, rank_idx, piece):
        """Set piece at position. piece is (color, type) or None."""
        self.board[rank_idx][file_idx] = piece

    def find_king(self, color):
        """Find the king's position for a given color."""
        for r in range(8):
            for f in range(8):
                p = self.board[r][f]
                if p and p[0] == color and p[1] == 'K':
                    return (f, r)
        return None

    def is_square_attacked(self, file_idx, rank_idx, by_color):
        """Check if a square is attacked by any piece of the given color."""
        # Knight attacks
        knight_offsets = [(-2, -1), (-2, 1), (-1, -2), (-1, 2),
                          (1, -2), (1, 2), (2, -1), (2, 1)]
        for df, dr in knight_offsets:
            nf, nr = file_idx + df, rank_idx + dr
            p = self.piece_at(nf, nr)
            if p and p[0] == by_color and p[1] == 'N':
                return True

        # King attacks
        for df in [-1, 0, 1]:
            for dr in [-1, 0, 1]:
                if df == 0 and dr == 0:
                    continue
                nf, nr = file_idx + df, rank_idx + dr
                p = self.piece_at(nf, nr)
                if p and p[0] == by_color and p[1] == 'K':
                    return True

        # Pawn attacks
        pawn_dir = -1 if by_color == 'white' else 1  # direction pawns attack FROM
        for df in [-1, 1]:
            nf, nr = file_idx + df, rank_idx + pawn_dir
            p = self.piece_at(nf, nr)
            if p and p[0] == by_color and p[1] == 'P':
                return True

        # Sliding pieces: rook/queen (straight) and bishop/queen (diagonal)
        # Rook/Queen directions
        for df, dr in [(0, 1), (0, -1), (1, 0), (-1, 0)]:
            for dist in range(1, 8):
                nf, nr = file_idx + df * dist, rank_idx + dr * dist
                if not (0 <= nf < 8 and 0 <= nr < 8):
                    break
                p = self.piece_at(nf, nr)
                if p:
                    if p[0] == by_color and p[1] in ('R', 'Q'):
                        return True
                    break

        # Bishop/Queen directions
        for df, dr in [(1, 1), (1, -1), (-1, 1), (-1, -1)]:
            for dist in range(1, 8):
                nf, nr = file_idx + df * dist, rank_idx + dr * dist
                if not (0 <= nf < 8 and 0 <= nr < 8):
                    break
                p = self.piece_at(nf, nr)
                if p:
                    if p[0] == by_color and p[1] in ('B', 'Q'):
                        return True
                    break

        return False

    def is_in_check(self, color):
        """Check if the given color's king is in check."""
        if isinstance(color, str) and color in ('white', 'black'):
            pass
        else:
            raise ValueError(f"Invalid color: {color}")
        king_pos = self.find_king(color)
        if not king_pos:
            return False
        opponent = 'black' if color == 'white' else 'white'
        return self.is_square_attacked(king_pos[0], king_pos[1], opponent)

    def _generate_pseudo_legal_moves(self, color):
        """Generate all pseudo-legal moves (ignoring check) for a color.
        Returns list of (from_file, from_rank, to_file, to_rank, promotion_piece).
        """
        moves = []
        direction = 1 if color == 'white' else -1
        start_rank = 1 if color == 'white' else 6
        promo_rank = 7 if color == 'white' else 0
        opponent = 'black' if color == 'white' else 'white'

        for r in range(8):
            for f in range(8):
                p = self.piece_at(f, r)
                if not p or p[0] != color:
                    continue
                piece_type = p[1]

                if piece_type == 'P':
                    # Single advance
                    nr = r + direction
                    if 0 <= nr < 8 and self.piece_at(f, nr) is None:
                        if nr == promo_rank:
                            for promo in ['Q', 'R', 'B', 'N']:
                                moves.append((f, r, f, nr, promo))
                        else:
                            moves.append((f, r, f, nr, None))
                        # Double advance
                        if r == start_rank:
                            nr2 = r + 2 * direction
                            if self.piece_at(f, nr2) is None:
                                moves.append((f, r, f, nr2, None))

                    # Diagonal captures
                    for df in [-1, 1]:
                        nf = f + df
                        nr = r + direction
                        if not (0 <= nf < 8 and 0 <= nr < 8):
                            continue
                        target = self.piece_at(nf, nr)
                        if target and target[0] == opponent:
                            if nr == promo_rank:
                                for promo in ['Q', 'R', 'B', 'N']:
                                    moves.append((f, r, nf, nr, promo))
                            else:
                                moves.append((f, r, nf, nr, None))

                    # En passant
                    if self.en_passant_target:
                        ep_f, ep_r = parse_sq(self.en_passant_target)
                        if ep_r == r + direction and abs(ep_f - f) == 1:
                            moves.append((f, r, ep_f, ep_r, None))

                elif piece_type == 'N':
                    for df, dr in [(-2, -1), (-2, 1), (-1, -2), (-1, 2),
                                   (1, -2), (1, 2), (2, -1), (2, 1)]:
                        nf, nr = f + df, r + dr
                        if 0 <= nf < 8 and 0 <= nr < 8:
                            target = self.piece_at(nf, nr)
                            if not target or target[0] != color:
                                moves.append((f, r, nf, nr, None))

                elif piece_type == 'B':
                    for df, dr in [(1, 1), (1, -1), (-1, 1), (-1, -1)]:
                        for dist in range(1, 8):
                            nf, nr = f + df * dist, r + dr * dist
                            if not (0 <= nf < 8 and 0 <= nr < 8):
                                break
                            target = self.piece_at(nf, nr)
                            if target:
                                if target[0] != color:
                                    moves.append((f, r, nf, nr, None))
                                break
                            moves.append((f, r, nf, nr, None))

                elif piece_type == 'R':
                    for df, dr in [(0, 1), (0, -1), (1, 0), (-1, 0)]:
                        for dist in range(1, 8):
                            nf, nr = f + df * dist, r + dr * dist
                            if not (0 <= nf < 8 and 0 <= nr < 8):
                                break
                            target = self.piece_at(nf, nr)
                            if target:
                                if target[0] != color:
                                    moves.append((f, r, nf, nr, None))
                                break
                            moves.append((f, r, nf, nr, None))

                elif piece_type == 'Q':
                    for df, dr in [(0, 1), (0, -1), (1, 0), (-1, 0),
                                   (1, 1), (1, -1), (-1, 1), (-1, -1)]:
                        for dist in range(1, 8):
                            nf, nr = f + df * dist, r + dr * dist
                            if not (0 <= nf < 8 and 0 <= nr < 8):
                                break
                            target = self.piece_at(nf, nr)
                            if target:
                                if target[0] != color:
                                    moves.append((f, r, nf, nr, None))
                                break
                            moves.append((f, r, nf, nr, None))

                elif piece_type == 'K':
                    for df in [-1, 0, 1]:
                        for dr in [-1, 0, 1]:
                            if df == 0 and dr == 0:
                                continue
                            nf, nr = f + df, r + dr
                            if 0 <= nf < 8 and 0 <= nr < 8:
                                target = self.piece_at(nf, nr)
                                if not target or target[0] != color:
                                    moves.append((f, r, nf, nr, None))

                    # Castling
                    if color == 'white' and f == 4 and r == 0:
                        # Kingside
                        if self.castling_rights['K']:
                            if (self.piece_at(5, 0) is None and
                                    self.piece_at(6, 0) is None and
                                    not self.is_square_attacked(4, 0, opponent) and
                                    not self.is_square_attacked(5, 0, opponent) and
                                    not self.is_square_attacked(6, 0, opponent)):
                                moves.append((4, 0, 6, 0, None))
                        # Queenside
                        if self.castling_rights['Q']:
                            if (self.piece_at(3, 0) is None and
                                    self.piece_at(2, 0) is None and
                                    self.piece_at(1, 0) is None and
                                    not self.is_square_attacked(4, 0, opponent) and
                                    not self.is_square_attacked(3, 0, opponent) and
                                    not self.is_square_attacked(2, 0, opponent)):
                                moves.append((4, 0, 2, 0, None))
                    elif color == 'black' and f == 4 and r == 7:
                        # Kingside
                        if self.castling_rights['k']:
                            if (self.piece_at(5, 7) is None and
                                    self.piece_at(6, 7) is None and
                                    not self.is_square_attacked(4, 7, opponent) and
                                    not self.is_square_attacked(5, 7, opponent) and
                                    not self.is_square_attacked(6, 7, opponent)):
                                moves.append((4, 7, 6, 7, None))
                        # Queenside
                        if self.castling_rights['q']:
                            if (self.piece_at(3, 7) is None and
                                    self.piece_at(2, 7) is None and
                                    self.piece_at(1, 7) is None and
                                    not self.is_square_attacked(4, 7, opponent) and
                                    not self.is_square_attacked(3, 7, opponent) and
                                    not self.is_square_attacked(2, 7, opponent)):
                                moves.append((4, 7, 2, 7, None))

        return moves

    def _is_legal_move(self, ff, fr, tf, tr, promo):
        """Check if a pseudo-legal move is legal (doesn't leave king in check)."""
        color = self.turn
        # Make the move on a copy
        saved_board = [row[:] for row in self.board]
        saved_ep = self.en_passant_target

        piece = self.piece_at(ff, fr)

        # Handle en passant capture (remove captured pawn)
        is_en_passant = (piece[1] == 'P' and self.en_passant_target and
                         tf == parse_sq(self.en_passant_target)[0] and
                         tr == parse_sq(self.en_passant_target)[1])

        self.set_piece(tf, tr, piece)
        self.set_piece(ff, fr, None)

        if is_en_passant:
            # Remove the captured pawn
            captured_rank = fr  # pawn is on same rank as moving pawn's start
            self.set_piece(tf, captured_rank, None)

        # Handle promotion
        if promo:
            self.set_piece(tf, tr, (color, promo))

        in_check = self.is_in_check(color)

        # Restore
        self.board = saved_board
        self.en_passant_target = saved_ep

        return not in_check

    def legal_moves(self):
        """Generate all legal moves for the current player.
        Returns list of (from_file, from_rank, to_file, to_rank, promotion_piece).
        """
        pseudo = self._generate_pseudo_legal_moves(self.turn)
        return [(ff, fr, tf, tr, promo) for ff, fr, tf, tr, promo in pseudo
                if self._is_legal_move(ff, fr, tf, tr, promo)]

    def legal_moves_algebraic(self):
        """Return legal moves as coordinate strings like 'e2e4', 'a7a8q'."""
        result = []
        for ff, fr, tf, tr, promo in self.legal_moves():
            move_str = sq(ff, fr) + sq(tf, tr)
            if promo:
                move_str += promo.lower()
            result.append(move_str)
        return result

    def make_move(self, notation):
        """Execute a move given in coordinate notation like 'e2e4'.
        Returns True if successful, raises ValueError if illegal.
        """
        if len(notation) < 4 or len(notation) > 5:
            raise ValueError(f"Invalid move notation: {notation}")

        from_sq = notation[0:2]
        to_sq = notation[2:4]
        promo_char = notation[4].upper() if len(notation) == 5 else None

        try:
            ff, fr = parse_sq(from_sq)
            tf, tr = parse_sq(to_sq)
        except (ValueError, IndexError):
            raise ValueError(f"Invalid square in move: {notation}")

        piece = self.piece_at(ff, fr)
        if not piece:
            raise ValueError(f"No piece at {from_sq}")
        if piece[0] != self.turn:
            raise ValueError(f"Not {piece[0]}'s turn, it's {self.turn}'s turn")

        # Check if this move is in legal moves
        legal = self.legal_moves()
        matching = []
        for m in legal:
            if m[0] == ff and m[1] == fr and m[2] == tf and m[3] == tr:
                matching.append(m)

        if not matching:
            raise ValueError(f"Illegal move: {notation}")

        # Handle promotion
        if promo_char:
            found = [m for m in matching if m[4] == promo_char]
            if not found:
                raise ValueError(f"Invalid promotion in move: {notation}")
            move = found[0]
        else:
            # If promotion moves are available but no promo specified, auto-queen
            promo_moves = [m for m in matching if m[4] is not None]
            if promo_moves:
                move = [m for m in promo_moves if m[4] == 'Q'][0]
            else:
                non_promo = [m for m in matching if m[4] is None]
                if not non_promo:
                    raise ValueError(f"Promotion piece required for move: {notation}")
                move = non_promo[0]

        self._execute_move(move)
        return True

    def _execute_move(self, move):
        """Actually execute a legal move and update all state."""
        ff, fr, tf, tr, promo = move
        piece = self.piece_at(ff, fr)
        color = piece[0]
        piece_type = piece[1]
        opponent = 'black' if color == 'white' else 'white'
        captured = self.piece_at(tf, tr)

        # Detect en passant capture
        is_en_passant = (piece_type == 'P' and self.en_passant_target and
                         tf == parse_sq(self.en_passant_target)[0] and
                         tr == parse_sq(self.en_passant_target)[1])

        # Detect castling
        is_castling = (piece_type == 'K' and abs(tf - ff) == 2)

        # Update halfmove clock
        if piece_type == 'P' or captured or is_en_passant:
            self.halfmove_clock = 0
        else:
            self.halfmove_clock += 1

        # Record move
        move_str = sq(ff, fr) + sq(tf, tr)
        if promo:
            move_str += promo.lower()
        self.move_history.append(move_str)

        # Move piece
        if promo:
            self.set_piece(tf, tr, (color, promo))
        else:
            self.set_piece(tf, tr, piece)
        self.set_piece(ff, fr, None)

        # En passant capture: remove captured pawn
        if is_en_passant:
            self.set_piece(tf, fr, None)

        # Castling: move rook
        if is_castling:
            if tf == 6:  # kingside
                rook = self.piece_at(7, fr)
                self.set_piece(5, fr, rook)
                self.set_piece(7, fr, None)
            elif tf == 2:  # queenside
                rook = self.piece_at(0, fr)
                self.set_piece(3, fr, rook)
                self.set_piece(0, fr, None)

        # Update en passant target
        if piece_type == 'P' and abs(tr - fr) == 2:
            ep_rank = (fr + tr) // 2
            self.en_passant_target = sq(ff, ep_rank)
        else:
            self.en_passant_target = None

        # Update castling rights
        if piece_type == 'K':
            if color == 'white':
                self.castling_rights['K'] = False
                self.castling_rights['Q'] = False
            else:
                self.castling_rights['k'] = False
                self.castling_rights['q'] = False

        if piece_type == 'R':
            if color == 'white':
                if ff == 7 and fr == 0:
                    self.castling_rights['K'] = False
                elif ff == 0 and fr == 0:
                    self.castling_rights['Q'] = False
            else:
                if ff == 7 and fr == 7:
                    self.castling_rights['k'] = False
                elif ff == 0 and fr == 7:
                    self.castling_rights['q'] = False

        # If a rook is captured, remove its castling rights
        if captured and captured[1] == 'R':
            if tf == 7 and tr == 0:
                self.castling_rights['K'] = False
            elif tf == 0 and tr == 0:
                self.castling_rights['Q'] = False
            elif tf == 7 and tr == 7:
                self.castling_rights['k'] = False
            elif tf == 0 and tr == 7:
                self.castling_rights['q'] = False

        # Update fullmove number
        if color == 'black':
            self.fullmove_number += 1

        # Switch turn
        self.turn = opponent

    def is_checkmate(self):
        """Check if the current player is in checkmate."""
        return self.is_in_check(self.turn) and len(self.legal_moves()) == 0

    def is_stalemate(self):
        """Check if the current player is in stalemate."""
        return not self.is_in_check(self.turn) and len(self.legal_moves()) == 0

    def to_fen(self):
        """Export current position as FEN string."""
        # Piece placement
        rows = []
        for r in range(7, -1, -1):
            row = ''
            empty = 0
            for f in range(8):
                p = self.piece_at(f, r)
                if p is None:
                    empty += 1
                else:
                    if empty > 0:
                        row += str(empty)
                        empty = 0
                    c = p[1]
                    if p[0] == 'black':
                        c = c.lower()
                    row += c
            if empty > 0:
                row += str(empty)
            rows.append(row)
        placement = '/'.join(rows)

        # Active color
        active = 'w' if self.turn == 'white' else 'b'

        # Castling
        castling = ''
        for key in ['K', 'Q', 'k', 'q']:
            if self.castling_rights[key]:
                castling += key
        if not castling:
            castling = '-'

        # En passant
        ep = self.en_passant_target if self.en_passant_target else '-'

        return f"{placement} {active} {castling} {ep} {self.halfmove_clock} {self.fullmove_number}"

    @classmethod
    def from_fen(cls, fen_str):
        """Create a Board from a FEN string."""
        parts = fen_str.strip().split()
        if len(parts) < 4:
            raise ValueError(f"Invalid FEN: {fen_str}")

        board = cls.__new__(cls)
        board.board = [[None] * 8 for _ in range(8)]
        board.move_history = []

        # Parse piece placement
        placement = parts[0]
        rank_idx = 7
        for rank_str in placement.split('/'):
            file_idx = 0
            for ch in rank_str:
                if ch.isdigit():
                    file_idx += int(ch)
                else:
                    color = 'white' if ch.isupper() else 'black'
                    piece_type = ch.upper()
                    board.board[rank_idx][file_idx] = (color, piece_type)
                    file_idx += 1
            rank_idx -= 1

        # Active color
        board.turn = 'white' if parts[1] == 'w' else 'black'

        # Castling rights
        board.castling_rights = {'K': False, 'Q': False, 'k': False, 'q': False}
        if parts[2] != '-':
            for ch in parts[2]:
                board.castling_rights[ch] = True

        # En passant
        board.en_passant_target = None if parts[3] == '-' else parts[3]

        # Halfmove clock and fullmove number
        board.halfmove_clock = int(parts[4]) if len(parts) > 4 else 0
        board.fullmove_number = int(parts[5]) if len(parts) > 5 else 1

        return board

    def display(self, use_unicode=True):
        """Return a string representation of the board."""
        lines = []
        lines.append('  a b c d e f g h')
        for r in range(7, -1, -1):
            row = f"{r + 1} "
            for f in range(8):
                p = self.piece_at(f, r)
                if p is None:
                    row += '. '
                elif use_unicode:
                    c = p[1] if p[0] == 'white' else p[1].lower()
                    row += PIECE_SYMBOLS[c] + ' '
                else:
                    c = p[1] if p[0] == 'white' else p[1].lower()
                    row += c + ' '
            row += f"{r + 1}"
            lines.append(row)
        lines.append('  a b c d e f g h')
        return '\n'.join(lines)
