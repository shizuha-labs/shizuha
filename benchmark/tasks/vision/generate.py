#!/usr/bin/env python3
"""Generate deterministic test images for the vision benchmark task.

Produces 5 PNG images with known ground-truth answers:
  bar_chart.png   — tallest bar is "B" with value 42
  text_overlay.png — text reads "BENCHMARK 2026 VISION"
  shapes.png      — 3 red circles, 2 blue squares, 1 green triangle
  pie_chart.png   — largest slice is "Technology" at 40%
  table_image.png — table with total row summing to 150
"""

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as patches
import numpy as np
from pathlib import Path

OUT = Path(__file__).resolve().parent


def bar_chart():
    """Bar chart where bar B is tallest at 42."""
    fig, ax = plt.subplots(figsize=(6, 4))
    categories = ["A", "B", "C", "D", "E"]
    values = [28, 42, 15, 33, 21]
    colors = ["#4285F4", "#EA4335", "#FBBC05", "#34A853", "#FF6D01"]
    bars = ax.bar(categories, values, color=colors, edgecolor="black", linewidth=0.8)
    for bar, val in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 1,
                str(val), ha="center", va="bottom", fontsize=12, fontweight="bold")
    ax.set_title("Quarterly Sales by Category", fontsize=14, fontweight="bold")
    ax.set_ylabel("Sales (units)", fontsize=11)
    ax.set_xlabel("Category", fontsize=11)
    ax.set_ylim(0, 50)
    ax.grid(axis="y", alpha=0.3)
    fig.tight_layout()
    fig.savefig(OUT / "bar_chart.png", dpi=150)
    plt.close(fig)


def text_overlay():
    """Image with large text: BENCHMARK 2026 VISION."""
    fig, ax = plt.subplots(figsize=(8, 3))
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_facecolor("#1a1a2e")
    fig.patch.set_facecolor("#1a1a2e")
    ax.text(0.5, 0.5, "BENCHMARK 2026 VISION", transform=ax.transAxes,
            fontsize=32, fontweight="bold", color="#e94560",
            ha="center", va="center",
            bbox=dict(boxstyle="round,pad=0.3", facecolor="#16213e", edgecolor="#e94560", linewidth=2))
    ax.axis("off")
    fig.tight_layout()
    fig.savefig(OUT / "text_overlay.png", dpi=150)
    plt.close(fig)


def shapes():
    """3 red circles, 2 blue squares, 1 green triangle."""
    fig, ax = plt.subplots(figsize=(8, 5))
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 6)
    ax.set_aspect("equal")
    ax.set_facecolor("#f5f5f5")
    ax.set_title("Shape Collection", fontsize=14, fontweight="bold")

    # 3 red circles
    for cx, cy in [(1.5, 4.5), (4.0, 4.5), (6.5, 4.5)]:
        circle = plt.Circle((cx, cy), 0.7, facecolor="#EA4335", edgecolor="black", linewidth=1.5)
        ax.add_patch(circle)

    # 2 blue squares
    for sx, sy in [(1.0, 1.5), (3.5, 1.5)]:
        rect = patches.Rectangle((sx, sy), 1.4, 1.4, facecolor="#4285F4", edgecolor="black", linewidth=1.5)
        ax.add_patch(rect)

    # 1 green triangle
    triangle = plt.Polygon([(7.0, 1.5), (8.4, 1.5), (7.7, 3.0)],
                           facecolor="#34A853", edgecolor="black", linewidth=1.5)
    ax.add_patch(triangle)

    ax.text(4.0, 5.5, "Red Circles", ha="center", va="bottom", fontsize=9, color="#333")
    ax.text(2.85, 0.8, "Blue Squares", ha="center", fontsize=9, color="#333")
    ax.text(7.7, 0.8, "Green Triangle", ha="center", fontsize=9, color="#333")
    ax.axis("off")
    fig.tight_layout()
    fig.savefig(OUT / "shapes.png", dpi=150)
    plt.close(fig)


def pie_chart():
    """Pie chart with largest slice = Technology at 40%."""
    fig, ax = plt.subplots(figsize=(6, 5))
    labels = ["Technology", "Healthcare", "Finance", "Education"]
    sizes = [40, 25, 20, 15]
    colors = ["#4285F4", "#EA4335", "#FBBC05", "#34A853"]
    explode = (0.05, 0, 0, 0)
    wedges, texts, autotexts = ax.pie(sizes, explode=explode, labels=labels,
                                       colors=colors, autopct="%1.0f%%",
                                       shadow=False, startangle=90,
                                       textprops={"fontsize": 11})
    for at in autotexts:
        at.set_fontweight("bold")
    ax.set_title("Market Share by Sector", fontsize=14, fontweight="bold")
    fig.tight_layout()
    fig.savefig(OUT / "pie_chart.png", dpi=150)
    plt.close(fig)


def table_image():
    """Rendered table image with a total row summing to 150."""
    fig, ax = plt.subplots(figsize=(6, 3.5))
    ax.axis("off")

    col_labels = ["Item", "Q1", "Q2", "Q3", "Q4", "Total"]
    data = [
        ["Product A", "10", "15", "20", "25", "70"],
        ["Product B", "8",  "12", "18", "12", "50"],
        ["Product C", "5",  "8",  "10", "7",  "30"],
        ["Grand Total", "23", "35", "48", "44", "150"],
    ]

    table = ax.table(cellText=data, colLabels=col_labels, loc="center",
                     cellLoc="center", colColours=["#4285F4"] * 6)
    table.auto_set_font_size(False)
    table.set_fontsize(11)
    table.scale(1.2, 1.6)

    # Style header row
    for j in range(len(col_labels)):
        table[0, j].set_text_props(color="white", fontweight="bold")
        table[0, j].set_facecolor("#4285F4")

    # Style total row (last data row = row index 4)
    for j in range(len(col_labels)):
        table[4, j].set_facecolor("#e8f0fe")
        table[4, j].set_text_props(fontweight="bold")

    ax.set_title("Quarterly Sales Report", fontsize=14, fontweight="bold", pad=20)
    fig.tight_layout()
    fig.savefig(OUT / "table_image.png", dpi=150)
    plt.close(fig)


if __name__ == "__main__":
    bar_chart()
    text_overlay()
    shapes()
    pie_chart()
    table_image()
    print("Generated 5 test images in", OUT)
    for f in sorted(OUT.glob("*.png")):
        print(f"  {f.name} ({f.stat().st_size / 1024:.1f} KB)")
