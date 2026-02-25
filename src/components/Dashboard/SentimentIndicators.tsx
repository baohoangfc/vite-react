import { Wifi, WifiOff, Layers } from 'lucide-react';
import { MTFSentiment } from '../../types';

interface SentimentIndicatorsProps {
    sentiment: MTFSentiment;
}

export default function SentimentIndicators({ sentiment }: SentimentIndicatorsProps) {
    const getBadgeColor = (type: string) => {
        if (type === 'BULLISH') return 'bg-green-500/10 border-green-500/20 text-green-400';
        if (type === 'BEARISH') return 'bg-red-500/10 border-red-500/20 text-red-400';
        return 'bg-gray-500/10 border-gray-500/20 text-gray-400';
    };

    const getIcon = (type: string) => {
        if (type === 'BULLISH') return <Wifi size={10} />;
        return <WifiOff size={10} />;
    };

    return (
        <div className="flex items-center gap-2">
            {(['1m', '5m', '15m'] as const).map((tf) => (
                <span key={tf} className={`${getBadgeColor(sentiment[tf])} border text-[9px] px-2 py-0.5 rounded-full flex items-center gap-1 font-bold uppercase tracking-widest`}>
                    {getIcon(sentiment[tf])} {tf}: {sentiment[tf]}
                </span>
            ))}
        </div>
    );
}
