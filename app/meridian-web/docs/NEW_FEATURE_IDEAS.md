# New Feature Ideas (noted during implementation)

Ideas that came up during the full build but weren't part of the plan. For review.

1. **Price alerts** — User sets a threshold (e.g., "notify me when AAPL YES hits 70c") and gets a browser notification or toast when the order book crosses it. Could use the existing WebSocket subscription infrastructure from OraclePrice.

2. **Order book heatmap view** — Alternative visualization to the depth table showing price levels as colored cells, more intuitive for pattern recognition. Recharts heatmap or custom canvas.

3. **Portfolio P&L chart** — Time-series chart of portfolio value over time. Would require storing historical position snapshots, possibly in localStorage or a lightweight IndexedDB.

4. **Limit order notifications** — Toast when a resting limit order gets filled. Could poll order book for the user's orders and detect quantity changes.

5. **Quick close all positions** — Single button to place market sell orders for all open positions across all markets. Useful for risk-off moments.

6. **Market depth chart** — Visual bid/ask depth chart (like crypto exchanges) alongside the tabular order book.

7. **Dark/light mode toggle** — Currently hardcoded dark. Some users prefer light mode for readability during market hours.

8. **Watchlist** — Save favorite tickers/strikes for quick access on the trade page.
