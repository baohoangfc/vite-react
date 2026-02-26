import { TradeHistoryItem } from '../../types';

interface DailyAggregationProps {
    history: TradeHistoryItem[];
}

export default function DailyAggregation({ history }: DailyAggregationProps) {
    const aggregateByDay = () => {
        const daily: Record<string, { pnl: number, trades: number, wins: number }> = {};

        history.forEach(trade => {
            const date = new Date(trade.time).toLocaleDateString();
            if (!daily[date]) daily[date] = { pnl: 0, trades: 0, wins: 0 };
            daily[date].pnl += trade.pnl;
            daily[date].trades += 1;
            if (trade.pnl > 0) daily[date].wins += 1;
        });

        return Object.entries(daily).map(([date, stats]) => ({
            date,
            ...stats,
            winRate: ((stats.wins / stats.trades) * 100).toFixed(1)
        })).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    };

    const dailyStats = aggregateByDay();

    return (
        <div className="space-y-3">
            {dailyStats.length === 0 && <div className="text-center text-gray-700 text-[10px] py-10 uppercase tracking-widest font-bold">Chưa có dữ liệu theo ngày.</div>}
            {dailyStats.map((stat) => (
                <div key={stat.date} className="bg-slate-900 p-3 sm:p-4 rounded-xl border border-slate-700 flex justify-between items-center transition-hover hover:bg-slate-800">
                    <div>
                        <div className="text-[10px] sm:text-xs font-black uppercase text-blue-400">{stat.date}</div>
                        <div className="text-[8px] sm:text-[9px] text-gray-500 font-bold mt-1 uppercase tracking-widest">
                            {stat.trades} Lệnh • Winrate: {stat.winRate}%
                        </div>
                    </div>
                    <div className="text-right">
                        <div className={`text-xs sm:text-sm font-black ${stat.pnl > 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {stat.pnl > 0 ? '+' : ''}{stat.pnl.toFixed(2)} USDT
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}
