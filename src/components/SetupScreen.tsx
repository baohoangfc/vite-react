import { useState } from 'react';
import { Database } from 'lucide-react';

export default function SetupScreen() {
    const [jsonInput, setJsonInput] = useState('');
    const [error, setError] = useState('');

    const handleSaveConfig = () => {
        try {
            let str = jsonInput.trim();
            if (str.includes('{') && str.includes('}')) str = str.substring(str.indexOf('{'), str.lastIndexOf('}') + 1);
            const parsedConfig = new Function('return ' + str)();
            if (!parsedConfig || !parsedConfig.apiKey || !parsedConfig.projectId) throw new Error("Cấu hình thiếu apiKey/projectId.");
            localStorage.setItem('btc_firebase_cfg', JSON.stringify(parsedConfig));
            window.location.reload();
        } catch (e: any) { setError("Lỗi: Không thể đọc cấu hình. Vui lòng kiểm tra lại."); }
    };

    return (
        <div className="min-h-screen bg-[#05070a] text-white flex flex-col items-center justify-center p-6 font-sans">
            <Database size={60} className="text-blue-500 mb-6 animate-pulse drop-shadow-[0_0_15px_rgba(59,130,246,0.5)]" />
            <h1 className="text-3xl font-black mb-3 text-center uppercase tracking-tighter">Kết nối Database</h1>
            <div className="w-full max-w-xl space-y-4">
                <textarea
                    value={jsonInput}
                    onChange={(e) => setJsonInput(e.target.value)}
                    className="w-full h-48 bg-[#0d1117] border border-gray-800 rounded-3xl p-5 font-mono text-sm text-green-400 focus:border-blue-500 outline-none shadow-inner"
                    placeholder={`{\n  apiKey: "AIzaSy...",\n  authDomain: "...",\n  projectId: "...",\n  appId: "..."\n}`}
                />
                {error && <p className="text-red-400 text-xs font-bold text-center bg-red-500/10 p-2 rounded-lg">{error}</p>}
                <button onClick={handleSaveConfig} className="w-full bg-blue-600 hover:bg-blue-700 font-black py-4 rounded-xl transition-all shadow-lg shadow-blue-500/20 active:scale-95 uppercase tracking-widest">Khởi tạo Đám mây</button>
            </div>
        </div>
    );
}
