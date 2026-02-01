
import React, { useState, useRef, useEffect } from 'react';
import { chatWithGemini } from '../services/geminiService';
import { ChatMessage } from '../types';

const STORAGE_KEY_CHAT = 'driveassist_chat_history';

const ChatInterface: React.FC = () => {
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_CHAT);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Herstel Date objecten
        return parsed.map((m: any) => ({ ...m, timestamp: new Date(m.timestamp) }));
      } catch (e) { return []; }
    }
    return [];
  });
  
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Sla berichten op zodra ze veranderen
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_CHAT, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const clearChat = () => {
    if (window.confirm("Chatgeschiedenis wissen?")) {
      setMessages([]);
      localStorage.removeItem(STORAGE_KEY_CHAT);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMsg: ChatMessage = {
      role: 'user',
      text: input,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);

    try {
      const stream = await chatWithGemini(input);
      let fullText = '';
      
      const modelMsg: ChatMessage = {
        role: 'model',
        text: '',
        timestamp: new Date()
      };
      
      setMessages(prev => [...prev, modelMsg]);

      for await (const chunk of stream) {
        // @ts-ignore
        const text = chunk.text;
        if (text) {
          fullText += text;
          setMessages(prev => {
            const last = prev[prev.length - 1];
            return [...prev.slice(0, -1), { ...last, text: fullText }];
          });
        }
      }
    } catch (error) {
      console.error(error);
      setMessages(prev => [...prev, {
        role: 'model',
        text: 'Systeemfout: Kan geen verbinding maken met DriveAssist kern. Controleer uw netwerk.',
        timestamp: new Date()
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto h-full flex flex-col bg-white rounded-3xl shadow-xl border border-slate-200 overflow-hidden">
      <div className="px-6 py-4 bg-white border-b border-slate-100 flex justify-between items-center">
        <h3 className="font-black text-xs uppercase tracking-widest text-slate-400">Logboek</h3>
        {messages.length > 0 && (
          <button onClick={clearChat} className="text-[10px] font-bold text-red-400 hover:text-red-600 transition-colors uppercase">
            Wissen
          </button>
        )}
      </div>
      
      <div ref={scrollRef} className="flex-1 p-8 overflow-y-auto space-y-8 bg-slate-50/30">
        {messages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center space-y-6 py-20">
            <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center text-indigo-600 shadow-inner">
              <i className="fa-solid fa-route text-3xl"></i>
            </div>
            <div>
              <h3 className="text-2xl font-black text-slate-800">Klaar voor de start?</h3>
              <p className="text-slate-500 max-w-sm mx-auto font-medium">
                Vraag me over uw route, technische mankementen of de beste stopplaatsen voor uw reis.
              </p>
            </div>
          </div>
        )}
        
        {messages.map((msg, idx) => (
          <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-3xl p-5 ${
              msg.role === 'user' 
                ? 'bg-slate-900 text-white rounded-tr-none shadow-lg' 
                : 'bg-white text-slate-800 rounded-tl-none border border-slate-200 shadow-sm leading-relaxed'
            }`}>
              <div className="flex items-center gap-2 mb-2 opacity-50 text-[10px] font-black uppercase tracking-widest">
                <i className={msg.role === 'user' ? 'fa-solid fa-user' : 'fa-solid fa-robot'}></i>
                {msg.role === 'user' ? 'Bestuurder' : 'DriveAssist'}
              </div>
              <div className="whitespace-pre-wrap">{msg.text}</div>
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-white border border-slate-200 rounded-3xl rounded-tl-none p-5 shadow-sm">
              <div className="flex gap-2">
                <div className="w-2 h-2 bg-indigo-600 rounded-full animate-bounce"></div>
                <div className="w-2 h-2 bg-indigo-600 rounded-full animate-bounce delay-150"></div>
                <div className="w-2 h-2 bg-indigo-600 rounded-full animate-bounce delay-300"></div>
              </div>
            </div>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="p-6 border-t border-slate-200 bg-white">
        <div className="relative group">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Stel een vraag aan uw co-piloot..."
            className="w-full pl-6 pr-14 py-4 bg-slate-100 border-none rounded-2xl focus:outline-none focus:ring-2 focus:ring-slate-900 transition-all font-medium text-slate-800"
          />
          <button
            type="submit"
            disabled={isLoading || !input.trim()}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center bg-slate-900 text-white rounded-xl disabled:opacity-30 hover:bg-black transition-all shadow-md"
          >
            <i className="fa-solid fa-arrow-up text-sm"></i>
          </button>
        </div>
      </form>
    </div>
  );
};

export default ChatInterface;
