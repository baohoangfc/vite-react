import { Activity, TrendingUp, TrendingDown } from 'lucide-react';
import { Analysis } from '../../types';

interface MarketRadarProps {
    analysis: Analysis;
}

export default function MarketRadar({ analysis }: MarketRadarProps) {
    return (
        <div className="bg-slate-200 p-5 rounded-2xl border border-slate-300 relative overflow-hidden shadow-lg">
            <h3 className="text-xs font-black text-slate-600 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Activity size={14} className="text-blue-400" /> AI Market Radar
            </h3>
            <div className="space-y-4">
                <div>
                    <div className="flex justify-between text-[10px] text-slate-500 font-bold mb-1 uppercase">
                        <span>Strong Sell</span><span>Neutral</span><span>Strong Buy</span>
                    </div>
                    <div className="h-2 w-full bg-slate-300 rounded-full relative overflow-hidden">
                        <div className="absolute top-0 bottom-0 w-[1px] bg-slate-400 left-1/2 z-10"></div>
                        <div className={`h-full absolute transition-all duration-500 ${analysis.score > 0 ? 'bg-green-500 right-1/2 translate-x-full' : 'bg-red-500 left-1/2 -translate-x-full'}`}
                            style={{ width: `${Math.abs(analysis.score) * 20}%` }}></div>
                    </div>
                    <div className="text-center mt-1 text-xs font-bold text-slate-800">Điểm Đồng thuận: {analysis.score > 0 ? '+' + analysis.score : analysis.score}/5</div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-slate-300">
                    <div className="bg-slate-100 p-3 rounded-xl border border-slate-300">
                        <span className="text-[10px] text-slate-500 uppercase font-bold block mb-1">Xu Hướng (EMA)</span>
                        <span className={`text-sm font-black flex items-center gap-1 ${analysis.trend === 'UP' ? 'text-green-400' : 'text-red-400'}`}>
                            {analysis.trend === 'UP' ? <TrendingUp size={16} /> : <TrendingDown size={16} />} {analysis.trend}
                        </span>
                    </div>
                    <div className="bg-slate-100 p-3 rounded-xl border border-slate-300">
                        <span className="text-[10px] text-slate-500 uppercase font-bold block mb-1">RSI (14) Động</span>
                        <span className={`text-sm font-black ${analysis.rsi > 65 ? 'text-red-400' : analysis.rsi < 35 ? 'text-green-400' : 'text-slate-800'}`}>
                            {analysis.rsi.toFixed(1)}
                        </span>
                    </div>
                    <div className="bg-slate-100 p-3 rounded-xl border border-slate-300 text-center sm:text-left">
                        <span className="text-[10px] text-slate-500 uppercase font-bold block mb-1">Dòng tiền SMC</span>
                        <span className="text-sm font-black text-blue-400 truncate block">
                            {analysis.ob ? `${analysis.ob} OB` : analysis.fvg ? `${analysis.fvg} FVG` : 'Chờ Tín Hiệu'}
                        </span>
                    </div>
                    <div className="bg-slate-100 p-3 rounded-xl border border-slate-300 text-center sm:text-left">
                        <span className="text-[10px] text-slate-500 uppercase font-bold block mb-1">Động lượng MACD</span>
                        <span className={`text-sm font-black ${analysis.macd.hist > 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {analysis.macd.hist > 0 ? 'Phân kỳ Dương' : 'Phân kỳ Âm'}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}
