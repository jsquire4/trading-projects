export default function TradePage({ params }: { params: { ticker: string } }) {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">{params.ticker} Markets</h1>
      <p className="text-white/60">Loading strike markets...</p>
    </div>
  );
}
