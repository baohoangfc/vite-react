import { Zap, XCircle, Target } from 'lucide-react';
import { Position } from '../../types';
import { CONFIG } from '../../config';

interface ActivePositionProps {
    position: Position | null;
    currentPrice: number;
    unrealizedPnl: number;
    unrealizedRoe: number;
    onCloseOrder: (reason: string, pnl: number) => void;
}

export default function ActivePosition({
    position,
    currentPrice,
    unrealizedPnl,
    unrealizedRoe,
    onCloseOrder
}: ActivePositionProps) {
    return (
        <div className={`backdrop-blur-xl p-5 rounded-2xl border transition-all duration-500 flex flex-col h-full ${position ? 'bg-gradient-to-b from-[#1e2329] to-[#0d1117] border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.15)]' : 'bg-[#0d1117]/80 border-white/5 opacity-80 shadow-xl'}`}>
            <h3 className="text-xs font-black text-gray-400 uppercase tracking-widest mb-4 flex justify-between items-center">
                <span className="flex items-center gap-2"><Zap size={14} className={position ? "text-yellow-400 animate-pulse" : "text-gray-600"} /> Vị thế Active</span>
                {position && <span className={`text-[10px] px-2 py-0.5 rounded font-black ${position.type === 'LONG' ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>{position.type} x{CONFIG.LEVERAGE}</span>}
            </h3>

            {position ? (
                <div className="space-y-4 flex-1 flex flex-col justify-between">
                    <div className="text-center bg-[#05070a] p-3 sm:p-4 rounded-xl border border-gray-800 shadow-inner">
                        <span className="text-[10px] text-gray-500 font-bold uppercase block mb-1">Lợi nhuận Tạm tính (ROE)</span>
                        <span className={`font-mono font-black text-2xl sm:text-3xl ${unrealizedPnl >= 0 ? 'text-green-400 drop-shadow-[0_0_5px_rgba(74,222,128,0.4)]' : 'text-red-400 drop-shadow-[0_0_5px_rgba(248,113,113,0.4)]'}`}>
                            {unrealizedPnl > 0 ? '+' : ''}{unrealizedPnl.toFixed(2)} <span className="text-lg">({unrealizedRoe.toFixed(1)}%)</span>
                        </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 sm:gap-3 text-xs">
                        <div className="bg-white/5 p-2 rounded-lg border border-white/5 text-center">
                            <span className="block text-[9px] text-gray-500 uppercase font-bold mb-0.5">Vào Lệnh</span>
                            <span className="text-gray-200 font-mono font-bold text-[10px] sm:text-xs">{position.entryPrice.toLocaleString()}</span>
                        </div>
                        <div className="bg-white/5 p-2 rounded-lg border border-white/5 text-center">
                            <span className="block text-[9px] text-gray-500 uppercase font-bold mb-0.5">Ký quỹ</span>
                            <span className="text-gray-200 font-mono font-bold text-[10px] sm:text-xs">${position.margin.toFixed(1)}</span>
                        </div>
                    </div>

                    <div className="relative h-1.5 w-full bg-gray-800 rounded-full overflow-hidden my-1">
                        {(() => {
                            const range = Math.abs(position.tpPrice - position.slPrice);
                            const currentPos = Math.abs(currentPrice - position.slPrice);
                            const pct = Math.max(0, Math.min(100, (currentPos / range) * 100));
                            const isLong = position.type === 'LONG';
                            return (
                                <div className={`absolute top-0 bottom-0 w-2 rounded-full transition-all duration-300 ${isLong ? (pct > 50 ? 'bg-green-400' : 'bg-red-400') : (pct < 50 ? 'bg-green-400' : 'bg-red-400')}`} style={{ left: `${pct}%`, transform: 'translateX(-50%)', boxShadow: '0 0 10px currentColor' }}></div>
                            )
                        })()}
                    </div>
                    <div className="flex justify-between text-[9px] font-bold uppercase text-gray-500 px-1">
                        <span className="text-red-400">SL: {position.slPrice.toLocaleString()}</span>
                        <span className="text-green-400">TP: {position.tpPrice.toLocaleString()}</span>
                    </div>

                    <button onClick={() => onCloseOrder('Đóng Lệnh Bằng Tay', unrealizedPnl + (position.size * CONFIG.FEE))}
                        className="w-full bg-red-500/10 hover:bg-red-500/20 text-red-400 font-black uppercase tracking-widest text-[11px] py-3 rounded-xl transition-all border border-red-500/30 flex justify-center items-center gap-2 active:scale-95">
                        <XCircle size={14} /> Đóng Lệnh Khẩn Cấp
                    </button>
                </div>
            ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center opacity-50">
                    <Target size={40} className="text-gray-600 mb-3" />
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Hệ thống đang rình mồi...</p>
                    <p className="text-[10px] text-gray-600 mt-1 max-w-[200px]">AI đang phân tích cấu trúc SMC đa chỉ báo để tìm điểm vào an toàn nhất.</p>
                </div>
            )}
        </div>
    );
}
