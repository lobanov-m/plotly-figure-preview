"""Manual test bed for the Plotly Figure Preview extension.

Run this under the VS Code Python debugger, stop at the marked line near the bottom, then
right-click any of the `fig_*` variables in the Variables pane.

    Open Plotly Figure          -> reuses the shared "Plotly Preview" tab
    Open Plotly Figure in New Tab -> opens an independent tab

The `not_a_figure` / `some_string` variables are here to check that non-figures are rejected
with a readable message rather than an empty tab.
"""

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from plotly.subplots import make_subplots

rng = np.random.default_rng(0)


def scatter_with_encodings() -> go.Figure:
    """Multi-trace scatter — exercises hover, legend toggling and box zoom."""
    df = pd.DataFrame(
        {
            "x": rng.normal(size=200),
            "y": rng.normal(size=200),
            "size": rng.uniform(5, 25, size=200),
            "group": rng.choice(["alpha", "beta", "gamma"], size=200),
        }
    )
    return px.scatter(
        df,
        x="x",
        y="y",
        color="group",
        size="size",
        title="px.scatter — colour + size encodings",
    )


def surface_3d() -> go.Figure:
    """3-D surface — proves the chart is genuinely interactive (drag to rotate)."""
    grid = np.linspace(-3, 3, 60)
    x, y = np.meshgrid(grid, grid)
    z = np.sin(np.sqrt(x**2 + y**2)) * np.exp(-0.1 * (x**2 + y**2))

    fig = go.Figure(data=[go.Surface(x=grid, y=grid, z=z, colorscale="Viridis")])
    fig.update_layout(title="go.Surface — drag to rotate")
    return fig


def large_scatter(n: int = 50_000) -> go.Figure:
    """~50k points.

    This is the reason the extension serializes figures through a temp file instead of returning
    them as an expression result: debugpy truncates long reprs, which would silently corrupt a
    figure this size.
    """
    fig = go.Figure(
        data=[
            go.Scattergl(
                x=rng.normal(size=n),
                y=rng.normal(size=n),
                mode="markers",
                marker={"size": 3, "opacity": 0.4},
                name=f"{n:,} points",
            )
        ]
    )
    fig.update_layout(title=f"go.Scattergl — {n:,} points")
    return fig


def subplot_grid() -> go.Figure:
    """2x2 subplot grid with mixed trace types."""
    fig = make_subplots(
        rows=2,
        cols=2,
        subplot_titles=("line", "bar", "histogram", "box"),
    )
    t = np.linspace(0, 4 * np.pi, 150)

    fig.add_trace(go.Scatter(x=t, y=np.sin(t), name="sin"), row=1, col=1)
    fig.add_trace(go.Bar(x=list("abcde"), y=rng.integers(1, 10, 5), name="bar"), row=1, col=2)
    fig.add_trace(go.Histogram(x=rng.normal(size=1000), name="hist"), row=2, col=1)
    fig.add_trace(go.Box(y=rng.normal(size=200), name="box"), row=2, col=2)

    fig.update_layout(title="make_subplots — 2x2 grid", showlegend=False)
    return fig


def main() -> None:
    fig_px = scatter_with_encodings()
    fig_go = surface_3d()
    fig_big = large_scatter()
    fig_sub = subplot_grid()

    # Rejection-path fixtures: neither of these is a Plotly figure.
    not_a_figure = {"a": 1, "b": [2, 3]}
    some_string = "hello"

    print("Figures ready:", [type(f).__name__ for f in (fig_px, fig_go, fig_big, fig_sub)])
    print("Set a breakpoint on the `breakpoint()` line below, then right-click a fig_* variable")
    print("in the Variables pane and choose 'Open Plotly Figure'.")

    breakpoint()  # <-- STOP HERE (or clear this and click the gutter instead)

    # Referenced so linters keep the fixtures alive until the breakpoint above.
    del fig_px, fig_go, fig_big, fig_sub, not_a_figure, some_string


if __name__ == "__main__":
    main()
