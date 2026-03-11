import { Activity, TrendingUp, TrendingDown } from 'lucide-react';
import { Analysis } from '../../types';

interface MarketRadarProps {
    analysis: Analysis;
}

export default function MarketRadar({ analysis }: MarketRadarProps) {
    return (
        <div className="ios-card p-5 relative overflow-hidden">
            <h3 className="text-xs font-bold text-slate-200 uppercase tracking-[0.2em] mb-4 flex items-center gap-2">
                <Activity size={14} className="text-cyan-200" /> Radar SMC
            </h3>
            <div className="space-y-4">
                <div>
                    <div className="flex justify-between text-[10px] text-slate-300 font-semibold mb-1 uppercase">
                        <span>Sell</span><span>Neutral</span><span>Buy</span>
                    </div>
                    <div className="h-2.5 w-full bg-white/20 rounded-full relative overflow-hidden">
                        <div className="absolute top-0 bottom-0 w-[1px] bg-white/70 left-1/2 z-10"></div>
                        <div className={`h-full absolute transition-all duration-500 ${analysis.score > 0 ? 'bg-emerald-300 right-1/2 translate-x-full' : 'bg-rose-300 left-1/2 -translate-x-full'}`}
                            style={{ width: `${Math.abs(analysis.score) * 20}%` }}></div>
                    </div>
                    <div className="text-center mt-1 text-xs font-semibold text-slate-100">Điểm đồng thuận: {analysis.score > 0 ? '+' + analysis.score : analysis.score}/5</div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-3 border-t border-white/20">
                    <div className="bg-white/15 p-3 rounded-2xl border border-white/20">
                        <span className="text-[10px] text-slate-300 uppercase font-semibold block mb-1">Xu hướng</span>
                        <span className={`text-sm font-bold flex items-center gap-1 ${analysis.trend === 'UP' ? 'text-emerald-100' : 'text-rose-100'}`}>
                            {analysis.trend === 'UP' ? <TrendingUp size={16} /> : <TrendingDown size={16} />} {analysis.trend}
                        </span>
                    </div>
                    <div className="bg-white/15 p-3 rounded-2xl border border-white/20">
                        <span className="text-[10px] text-slate-300 uppercase font-semibold block mb-1">RSI</span>
                        <span className={`text-sm font-bold ${analysis.rsi > 65 ? 'text-rose-100' : analysis.rsi < 35 ? 'text-emerald-100' : 'text-slate-100'}`}>
                            {analysis.rsi.toFixed(1)}
                        </span>
                    </div>
                    <div className="bg-white/15 p-3 rounded-2xl border border-white/20 col-span-2">
                        <span className="text-[10px] text-slate-300 uppercase font-semibold block mb-1">Tín hiệu SMC trọng tâm</span>
                        <span className="text-sm font-bold text-cyan-100 block">
                            {analysis.ob ? `${analysis.ob} Order Block` : analysis.fvg ? `${analysis.fvg} FVG` : 'Đang chờ xác nhận'}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
