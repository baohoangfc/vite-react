import { BarChart2 } from 'lucide-react';
import { Candle, Position } from '../../types';

interface BarChartProps {
    candles: Candle[];
    position: Position | null;
}

export default function BarChart({ candles, position }: BarChartProps) {
    const renderCandles = () => {
        if (candles.length === 0) return null;
        const maxPrice = Math.max(...candles.map(c => c.high));
        const minPrice = Math.min(...candles.map(c => c.low));
        const range = Math.max(maxPrice - minPrice, 0.0001);

        return (
            <div className="flex items-end h-full w-full relative gap-px overflow-hidden">
                {position && (
                    <div className="absolute w-full border-t border-amber-300/80 border-dashed z-10" style={{ top: `${((maxPrice - position.entryPrice) / range) * 100}%` }}>
                        <span className="bg-amber-200/30 text-amber-100 px-2 py-0.5 text-[9px] rounded-full absolute right-0 -translate-y-1/2 font-semibold backdrop-blur-sm">ENTRY</span>
                    </div>
                )}
                {candles.map((c, i) => {
                    const heightPercent = ((c.high - c.low) / range) * 100;
                    const topPercent = ((maxPrice - c.high) / range) * 100;
                    const bodyTopPercent = ((maxPrice - Math.max(c.open, c.close)) / range) * 100;
                    const bodyHeightPercent = ((Math.abs(c.open - c.close)) / range) * 100;
                    return (
                        <div key={i} className="flex-1 min-w-0 relative" style={{ height: '100%' }}>
                            <div className={`absolute w-[1px] left-1/2 -translate-x-1/2 ${c.isGreen ? 'bg-emerald-300/70' : 'bg-rose-300/70'}`} style={{ height: `${heightPercent}%`, top: `${topPercent}%` }}></div>
                            <div className={`absolute w-full rounded-sm ${c.isGreen ? 'bg-emerald-300 shadow-[0_0_5px_#6ee7b7aa]' : 'bg-rose-300 shadow-[0_0_5px_#fda4afaa]'}`} style={{ height: `${Math.max(bodyHeightPercent, 1)}%`, top: `${bodyTopPercent}%` }}></div>
                        </div>
                    );
                })}
            </div>
        );
    };

    return (
        <div className="ios-card p-4 h-[260px] sm:h-[320px] relative flex flex-col overflow-hidden">
            <div className="flex justify-between mb-2 z-10">
                <h3 className="text-xs font-bold text-slate-200 uppercase tracking-[0.2em] flex items-center gap-2"><BarChart2 size={14} className="text-cyan-200" /> Giá vàng / điểm vào lệnh</h3>
            </div>
            <div className="absolute inset-0 top-12 bottom-4 left-4 right-4 bg-[linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] bg-[size:22px_22px] pointer-events-none rounded-xl"></div>
            <div className="flex-1 w-full relative pt-2 z-10">{renderCandles()}</div>
        </div>
    );
}
