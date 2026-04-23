import logging
import re
from typing import Optional

import cv2
import fitz
import numpy as np
from pdf2image import convert_from_path

logger = logging.getLogger(__name__)

THR = 5
MIN_GRID_SZ = 25


def _consolidate(lst: list[int]) -> list[int]:
    """Deduplicate closely-spaced line positions."""
    result, prev = [lst[0]], lst[0]
    for val in lst:
        if val - prev > MIN_GRID_SZ:
            prev = val
            result.append(val)
    return result


def _find_puzzle_grid(img: np.ndarray) -> tuple[tuple[int, int], list[list[int]]]:
    """Detect the crossword grid in a page image.

    Returns (grid_sz, grid) where grid_sz=(rows, cols) and grid is a 2-D list:
      -1  black cell
       0  white cell (no clue starts here)
      >0  white cell where that clue number begins
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY_INV)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, 1)

    max_area, max_cnt = -1, None
    for cnt in contours:
        approx = cv2.approxPolyDP(cnt, 0.02 * cv2.arcLength(cnt, True), True)
        if len(approx) == 4 and cv2.contourArea(cnt) > max_area:
            max_area, max_cnt = cv2.contourArea(cnt), cnt

    x, y, w, h = cv2.boundingRect(max_cnt)
    img2 = img[y - THR : y + h + THR, x - THR : x + w + THR]
    thresh2 = thresh[y - THR : y + h + THR, x - THR : x + w + THR]

    edges = cv2.Canny(img2, 30, 200, apertureSize=3)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=100, minLineLength=50, maxLineGap=10)

    vlst, hlst = [], []
    if lines is not None:
        for line in lines:
            x1, y1, x2, y2 = line[0]
            if abs(x1 - x2) < THR:
                vlst.append(x1)
            if abs(y1 - y2) < THR:
                hlst.append(y1)

    vlst = _consolidate(sorted(vlst))
    hlst = _consolidate(sorted(hlst))
    rows, cols = len(hlst) - 1, len(vlst) - 1

    # Classify each cell as black or white
    grid: list[list[int]] = []
    for i, ix in zip(hlst, hlst[1:]):
        row = []
        for j, jy in zip(vlst, vlst[1:]):
            x_sz = (ix - i - THR) // 2
            y_sz = (jy - j - THR) // 2
            sub = thresh2[i + THR : i + THR + x_sz, j + THR : j + THR + y_sz]
            pct = np.sum(sub > 200) / np.prod(sub.shape)
            row.append(-1 if pct > 0.9 else 0)
        grid.append(row)

    # Assign clue numbers
    cntr = 1
    for r in range(rows):
        for c in range(cols):
            if grid[r][c] == 0:
                left = grid[r][c - 1] if c > 0 else -1
                right = grid[r][c + 1] if c < cols - 1 else -1
                top = grid[r - 1][c] if r > 0 else -1
                bot = grid[r + 1][c] if r < rows - 1 else -1
                if (left < 0 and right == 0) or (top < 0 and bot == 0):
                    grid[r][c] = cntr
                    cntr += 1

    return (rows, cols), grid


def _extract_clueinfo(
    grid: list[list[int]], transpose: int = 0
) -> dict[int, tuple[int, tuple[int, int]]]:
    """Return {clue_num: (answer_length, (row, col))} from the grid.

    Pass transpose=1 for the Down pass (grid is transposed; coords are swapped back).
    """
    clueinfo: dict[int, tuple[int, tuple[int, int]]] = {}
    for row_num, row in enumerate(grid):
        clue, length, loc = 0, 0, (0, 0)
        for col_num, cell in enumerate(row):
            if cell == -1:
                if length > 1:
                    clueinfo[clue] = (length, loc)
                clue, length, loc = 0, 0, (0, 0)
                continue
            elif cell == 0:
                length += 1
            else:
                if clue == 0:
                    loc = (row_num, col_num) if transpose == 0 else (col_num, row_num)
                    clue = cell
                    length = 0
                length += 1
        if length > 1:
            clueinfo[clue] = (length, loc)
    return clueinfo


def _extract_section_clues(
    section_text: str, grid_sz: tuple[int, int]
) -> list[dict]:
    """Parse raw text for one direction into a list of {clue_number, clue_text} dicts."""
    clues = []
    current_number = "0"
    current_clue = ""

    for line in section_text.strip().split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        match = re.match(r"^(\d+)\s+(.+)", stripped)
        if match and 1 <= int(match.group(1)) - int(current_number) <= grid_sz[1]:
            if current_number != "0":
                clues.append({"clue_text": current_clue.strip(), "clue_number": int(current_number)})
            current_number, current_clue = match.group(1), match.group(2)
        else:
            current_clue += " " + stripped

    if current_number != "0" and current_clue:
        clues.append({"clue_text": current_clue[:80].strip(), "clue_number": int(current_number)})

    return clues


def _extract_clue_text(file_path: str, grid_sz: tuple[int, int]) -> Optional[dict]:
    """Pull across/down clue texts from the PDF using PyMuPDF."""
    doc = fitz.open(file_path)
    if not doc:
        return None
    text = doc[0].get_text()
    sections = re.split(r"\n\s*ACROSS|DOWN", text)
    if len(sections) != 3:
        return None
    _, across_text, down_text = sections
    return {
        "across": _extract_section_clues(across_text, grid_sz),
        "down": _extract_section_clues(down_text, grid_sz),
    }


def _merge(
    clue_texts: list[dict],
    clueinfo: dict[int, tuple[int, tuple[int, int]]],
) -> dict[int, tuple[tuple[int, int], str, int]]:
    """Merge grid positions with clue texts.

    Output: {clue_num: ((row, col), clue_text, answer_length)}
    """
    merged = {}
    for clue in clue_texts:
        num = clue["clue_number"]
        if num not in clueinfo:
            continue
        answer_length, location = clueinfo[num]
        merged[num] = (location, clue["clue_text"], answer_length)
    return merged


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

ParseResult = tuple[
    tuple[int, int],          # grid_sz: (rows, cols)
    list[list[int]],          # grid
    dict[int, tuple],         # across: {num: ((row,col), text, length)}
    dict[int, tuple],         # down:   {num: ((row,col), text, length)}
]


def parse_puzzle(file_path: str) -> Optional[ParseResult]:
    """Parse a crossword PDF and return structured puzzle data, or None on failure."""
    try:
        pages = convert_from_path(file_path, dpi=250)
        cv2_img = np.array(pages[0])

        grid_sz, grid = _find_puzzle_grid(cv2_img)

        across_info = _extract_clueinfo(grid)
        transposed = list(map(list, zip(*grid)))
        down_info = _extract_clueinfo(transposed, transpose=1)

        clues = _extract_clue_text(file_path, grid_sz)
        if clues is None:
            logger.warning("parse_puzzle: failed to extract clue text from %s", file_path)
            return None

        across = _merge(clues["across"], across_info)
        down = _merge(clues["down"], down_info)

        return grid_sz, grid, across, down

    except Exception:
        logger.exception("parse_puzzle: unexpected error parsing %s", file_path)
        return None
