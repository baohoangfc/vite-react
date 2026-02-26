import React, { useState } from 'react';
import { ShieldCheck, RefreshCw } from 'lucide-react';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { CONFIG, APP_ID } from '../config';

export default function AuthScreen() {
    const [isLogin, setIsLogin] = useState(true);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleAuth = async (e: React.FormEvent) => {
        e.preventDefault(); setError(''); setLoading(true);
        try {
            if (isLogin) await signInWithEmailAndPassword(auth, email, password);
            else {
                const res = await createUserWithEmailAndPassword(auth, email, password);
                await setDoc(doc(db, 'artifacts', APP_ID, 'users', res.user.uid, 'account', 'data'), {
                    balance: CONFIG.INITIAL_BALANCE,
                    pnlHistory: 0,
                    createdAt: Date.now()
                });
            }
        } catch (err: any) { setError('Lỗi đăng nhập. Kiểm tra lại thông tin.'); }
        finally { setLoading(false); }
    };

    return (
        <div className="fixed inset-0 z-40 bg-slate-900 flex items-center justify-center p-4 font-sans text-slate-100">
            <div className="bg-slate-800 p-6 sm:p-8 rounded-[1.5rem] sm:rounded-[2rem] border border-slate-700 w-full max-w-md shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500"></div>
                <div className="flex justify-center mb-6">
                    <div className="p-3 sm:p-4 bg-gradient-to-br from-blue-600 to-purple-600 rounded-2xl shadow-lg shadow-purple-500/20 text-white">
                        <ShieldCheck size={32} />
                    </div>
                </div>
                <h2 className="text-xl sm:text-2xl font-black text-center mb-2 uppercase tracking-tighter text-slate-100">Cyber-Pro Login</h2>
                <form onSubmit={handleAuth} className="space-y-4 mt-6">
                    <input
                        type="email"
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        required
                        className="w-full bg-slate-900 border border-slate-700 rounded-xl p-4 text-sm outline-none focus:border-blue-500 transition-colors"
                        placeholder="Địa chỉ Email"
                    />
                    <input
                        type="password"
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        required
                        className="w-full bg-slate-900 border border-slate-700 rounded-xl p-4 text-sm outline-none focus:border-blue-500 transition-colors"
                        placeholder="Mật khẩu bảo mật"
                    />
                    {error && <p className="text-red-600 text-xs text-center font-bold bg-red-900/30 p-2 rounded-lg">{error}</p>}
                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-blue-600 hover:bg-blue-500 font-black py-4 rounded-xl uppercase tracking-widest transition-all active:scale-95 mt-2 flex justify-center shadow-lg shadow-blue-500/20 disabled:opacity-50 text-white"
                    >
                        {loading ? <RefreshCw className="animate-spin" size={20} /> : (isLogin ? 'VÀO HỆ THỐNG' : 'ĐĂNG KÝ MỚI')}
                    </button>
                </form>
                <button
                    onClick={() => setIsLogin(!isLogin)}
                    className="w-full mt-6 text-slate-400 text-xs hover:text-blue-500 uppercase font-bold tracking-widest"
                >
                    {isLogin ? "Chưa có tài khoản?" : "Quay lại đăng nhập"}
                </button>
            </div>
        </div>
    );
}
