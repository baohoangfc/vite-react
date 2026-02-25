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
        const range = maxPrice - minPrice;

        return (
            <div className="flex items-end justify-between h-full w-full px-1 relative">
                {position && (
                    <div className="absolute w-full border-t border-yellow-400/80 border-dashed z-10" style={{ top: `${((maxPrice - position.entryPrice) / range) * 100}%` }}>
                        <span className="bg-yellow-400/20 text-yellow-400 px-1.5 py-0.5 text-[9px] rounded absolute right-0 -translate-y-1/2 font-bold backdrop-blur-sm">ENTRY</span>
                    </div>
                )}
                {candles.map((c, i) => {
                    const heightPercent = ((c.high - c.low) / range) * 100;
                    const topPercent = ((maxPrice - c.high) / range) * 100;
                    const bodyTopPercent = ((maxPrice - Math.max(c.open, c.close)) / range) * 100;
                    const bodyHeightPercent = ((Math.abs(c.open - c.close)) / range) * 100;
                    return (
                        <div key={i} className="flex-1 relative mx-[1px] group" style={{ height: '100%' }}>
                            <div className={`absolute w-[1px] left-1/2 -translate-x-1/2 ${c.isGreen ? 'bg-[#0ecb81]/50' : 'bg-[#f6465d]/50'}`} style={{ height: `${heightPercent}%`, top: `${topPercent}%` }}></div>
                            <div className={`absolute w-full rounded-[1px] ${c.isGreen ? 'bg-[#0ecb81] shadow-[0_0_5px_#0ecb8160]' : 'bg-[#f6465d] shadow-[0_0_5px_#f6465d60]'}`} style={{ height: `${Math.max(bodyHeightPercent, 1)}%`, top: `${bodyTopPercent}%` }}></div>
                        </div>
                    );
                })}
            </div>
        );
    };

    return (
        <div className="bg-[#0d1117]/80 backdrop-blur-xl p-5 rounded-2xl border border-white/5 h-[250px] sm:h-[300px] relative flex flex-col shadow-xl">
            <div className="flex justify-between mb-2 z-10">
                <h3 className="text-xs font-black text-gray-400 uppercase tracking-widest flex items-center gap-2"><BarChart2 size={14} className="text-blue-400" /> Phân tích Kỹ thuật M1</h3>
            </div>
            <div className="absolute inset-0 top-12 bottom-4 left-4 right-4 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:20px_20px] pointer-events-none rounded-lg"></div>
            <div className="flex-1 w-full relative pt-2 z-10">{renderCandles()}</div>
        </div>
    );
}
