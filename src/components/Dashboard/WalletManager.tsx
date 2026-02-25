import { Wallet } from 'lucide-react';
import { Account, Position } from '../../types';
import { CONFIG } from '../../config';

interface WalletManagerProps {
    account: Account;
    position: Position | null;
    unrealizedPnl: number;
}

export default function WalletManager({ account, position, unrealizedPnl }: WalletManagerProps) {
    const equity = account.balance + (position ? position.margin + unrealizedPnl : 0);

    return (
        <div className="bg-[#0d1117]/80 backdrop-blur-xl p-5 rounded-2xl border border-white/5 relative shadow-xl">
            <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none"><Wallet size={100} /></div>
            <h3 className="text-xs font-black text-gray-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Wallet size={14} className="text-yellow-400" /> Quản lý Tài Sản
            </h3>
            <div className="space-y-4">
                <div>
                    <span className="text-[10px] text-gray-500 font-bold uppercase block mb-1">Số dư Ví (USDT)</span>
                    <span className="text-3xl font-mono font-black text-white">{account.balance.toFixed(2)}</span>
                </div>
                <div className="pt-3 border-t border-gray-800/50">
                    <span className="text-[10px] text-gray-500 font-bold uppercase block mb-1">Tài sản Ròng (Bao gồm PnL)</span>
                    <span className={`text-xl font-mono font-black ${equity >= CONFIG.INITIAL_BALANCE ? 'text-green-400' : 'text-red-400'}`}>
                        {equity.toFixed(2)}
                    </span>
                </div>
            </div>
        </div>
    );
}
