
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Type, FunctionDeclaration } from '@google/genai';
import { decode, decodeAudioData, createBlob } from './services/audioUtils';
import { AppState, Task } from './types';

const STORAGE_KEY_TASKS = 'callassist_tasks_v5';
const STORAGE_KEY_SHEET_URL = 'callassist_sheet_url_v5';

const App: React.FC = () => {
  const [isSyncing, setIsSyncing] = useState(false);
  const [showSyncModal, setShowSyncModal] = useState(false);
  const [sheetUrl, setSheetUrl] = useState(localStorage.getItem(STORAGE_KEY_SHEET_URL) || '');
  const [callingTask, setCallingTask] = useState<Task | null>(null);

  const [appState, setAppState] = useState<AppState>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_TASKS);
    return {
      isActive: false,
      status: 'idle',
      userText: '',
      aiText: '',
      location: null,
      tasks: saved ? JSON.parse(saved) : [],
      activeTaskId: null
    };
  });

  const tasksRef = useRef<Task[]>(appState.tasks);
  const sessionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);

  useEffect(() => {
    tasksRef.current = appState.tasks;
    localStorage.setItem(STORAGE_KEY_TASKS, JSON.stringify(appState.tasks));
  }, [appState.tasks]);

  useEffect(() => {
    if (sheetUrl) syncWithGoogleSheet();
  }, []);

  const parseCSVLine = (line: string) => {
    const result = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') inQuote = !inQuote;
      else if (char === ',' && !inQuote) {
        result.push(cur.trim());
        cur = "";
      } else cur += char;
    }
    result.push(cur.trim());
    return result;
  };

  const syncWithGoogleSheet = async () => {
    if (!sheetUrl) return;
    setIsSyncing(true);
    try {
      let exportUrl = sheetUrl;
      if (sheetUrl.includes('/edit')) {
        exportUrl = sheetUrl.replace(/\/edit.*$/, '/export?format=csv');
      } else if (!sheetUrl.includes('format=csv')) {
        exportUrl = sheetUrl.includes('?') ? `${sheetUrl}&format=csv` : `${sheetUrl}?format=csv`;
      }

      const response = await fetch(exportUrl);
      if (!response.ok) throw new Error("Sync failed");
      const csvData = await response.text();
      
      const lines = csvData.split(/\r?\n/);
      const newTasks: Task[] = [];
      const firstLine = lines[0]?.toLowerCase() || "";
      const startIndex = (firstLine.includes('naam') || firstLine.includes('contact')) ? 1 : 0;
      
      for (let i = startIndex; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cols = parseCSVLine(lines[i]);
        if (cols[0]) {
          newTasks.push({
            id: `call-${i}-${Date.now()}`,
            name: cols[0].replace(/^"|"$/g, ''),
            organization: (cols[1] || 'Onbekend').replace(/^"|"$/g, ''),
            subject: (cols[2] || 'Geen onderwerp').replace(/^"|"$/g, ''),
            phoneNumber: (cols[3] || '').replace(/[^0-9+]/g, ''),
            status: 'open'
          });
        }
      }
      setAppState(prev => ({ ...prev, tasks: newTasks }));
      localStorage.setItem(STORAGE_KEY_SHEET_URL, sheetUrl);
      setShowSyncModal(false);
    } catch (err) {
      alert("Fout bij laden.");
    } finally {
      setIsSyncing(false);
    }
  };

  const stopCoPilot = (reason: string = 'idle') => {
    sessionRef.current?.close();
    sessionRef.current = null;

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.input.close();
      audioContextRef.current.output.close();
      audioContextRef.current = null;
    }
    
    audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;

    const feedbackText = reason === 'siri' ? 'Microfoon vrij voor Siri.' : '';

    setAppState(prev => ({ 
      ...prev, 
      isActive: false, 
      status: 'idle', 
      userText: '', 
      aiText: feedbackText 
    }));
  };

  const startCoPilot = async () => {
    setAppState(prev => ({ ...prev, status: 'connecting', aiText: 'Systeem laden...' }));
    
    const callListContext = tasksRef.current.length > 0 
      ? tasksRef.current.map((t, idx) => `CONTACT ${idx + 1}:
        - NAAM: ${t.name}
        - ORGANISATIE: ${t.organization}
        - ONDERWERP: ${t.subject}
        - TELEFOONNUMMER: ${t.phoneNumber}`).join('\n\n')
      : "Geen contacten.";

    const dialNumberTool: FunctionDeclaration = {
      name: 'dial_number',
      parameters: {
        type: Type.OBJECT,
        description: 'Belt een telefoonnummer.',
        properties: { number: { type: Type.STRING } },
        required: ['number'],
      },
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextRef.current = { input: inputCtx, output: outputCtx };

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setAppState(prev => ({ ...prev, status: 'active', isActive: true, aiText: 'Ik luister...' }));
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const pcmBlob = createBlob(e.inputBuffer.getChannelData(0));
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'dial_number') {
                  const num = fc.args.number as string;
                  const task = tasksRef.current.find(t => t.phoneNumber === num);
                  setCallingTask(task || { id: 'ext', name: 'Onbekend', organization: '', subject: 'Bellen...', phoneNumber: num, status: 'bezig' });
                  
                  stopCoPilot('calling');
                  
                  setTimeout(() => { 
                    window.location.assign(`tel:${num}`); 
                    setCallingTask(null); 
                  }, 4000);
                }
                sessionPromise.then(s => s.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } } }));
              }
            }
            if (message.serverContent?.inputTranscription) setAppState(prev => ({ ...prev, userText: message.serverContent!.inputTranscription!.text }));
            if (message.serverContent?.outputTranscription) setAppState(prev => ({ ...prev, aiText: message.serverContent!.outputTranscription!.text }));

            const audioData = message.serverContent?.modelTurn?.parts?.find(p => p.inlineData)?.inlineData?.data;
            if (audioData && audioContextRef.current) {
              const outCtx = audioContextRef.current.output;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), outCtx, 24000, 1);
              const source = outCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outCtx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              audioSourcesRef.current.add(source);
              source.onended = () => audioSourcesRef.current.delete(source);
            }
          },
          onclose: () => stopCoPilot(),
          onerror: () => stopCoPilot(),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [{ functionDeclarations: [dialNumberTool] }],
          systemInstruction: `Je bent CallAssist. Je helpt met de lijst van ${tasksRef.current.length} contacten. Gebruik dial_number om te bellen. Antwoord kort in het Nederlands.\n\nLIJST:\n${callListContext}`
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      setAppState(prev => ({ ...prev, status: 'error', aiText: 'Microfoonfout.' }));
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950 flex flex-col text-white font-sans overflow-hidden">
      
      {showSyncModal && (
        <div className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center p-6 backdrop-blur-xl">
          <div className="w-full max-w-md bg-slate-900 p-8 rounded-[2.5rem] border border-white/10 shadow-2xl">
            <h2 className="text-xl font-black mb-4">Lijst synchroniseren</h2>
            <input 
              type="text" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)}
              className="w-full bg-black/50 border border-white/10 p-5 rounded-2xl mb-6 outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
              placeholder="Google Sheets CSV URL..."
            />
            <div className="flex gap-4">
              <button onClick={() => setShowSyncModal(false)} className="flex-1 py-4 text-xs font-bold uppercase tracking-widest opacity-50">Sluiten</button>
              <button onClick={syncWithGoogleSheet} className="flex-1 py-4 bg-indigo-600 rounded-2xl text-xs font-bold uppercase tracking-widest">Update</button>
            </div>
          </div>
        </div>
      )}

      {/* GIGANTISCH BEL-SCHERM (Emergency-style) */}
      {callingTask && (
        <div className="fixed inset-0 z-[90] bg-indigo-950 flex flex-col items-center justify-center p-12 text-center animate-in fade-in duration-500">
           <div className="absolute top-0 left-0 w-full h-2 bg-white/20 overflow-hidden">
              <div className="h-full bg-white animate-[progress_4s_linear]"></div>
           </div>
           
           <div className="w-40 h-40 bg-white/5 rounded-full flex items-center justify-center mb-16 ring-8 ring-white/10 animate-pulse">
             <i className="fa-solid fa-phone-flip text-7xl text-white"></i>
           </div>
           
           <div className="space-y-6">
              <h2 className="text-6xl font-black tracking-tighter leading-tight text-white mb-2">{callingTask.name}</h2>
              <p className="text-7xl font-mono font-black text-indigo-400 tracking-tighter">{callingTask.phoneNumber}</p>
           </div>
           
           <div className="mt-24">
              <p className="text-sm font-black uppercase tracking-[0.5em] text-white/40 animate-pulse">Microfoon wordt vrijgegeven...</p>
           </div>
        </div>
      )}

      <header className="px-8 pt-[env(safe-area-inset-top,3.5rem)] pb-6 flex justify-between items-center bg-slate-950/80 backdrop-blur-lg border-b border-white/5">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-900/40">
            <i className="fa-solid fa-headset text-white text-lg"></i>
          </div>
          <div>
            <h1 className="text-[12px] font-black uppercase tracking-[0.3em]">CallAssist <span className="text-indigo-400">5.0</span></h1>
            <span className="text-[10px] text-white/30 font-bold uppercase tracking-widest">Drive Mode</span>
          </div>
        </div>
        <button onClick={() => setShowSyncModal(true)} className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center active:scale-90 transition-transform">
          <i className={`fa-solid fa-sync text-lg ${isSyncing ? 'animate-spin text-indigo-400' : 'text-white/40'}`}></i>
        </button>
      </header>

      <main className="flex-1 flex flex-col p-6 overflow-hidden relative">
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <div className="h-32 flex flex-col justify-center mb-8">
            {appState.userText && <p className="text-indigo-400 font-black text-sm uppercase tracking-[0.2em] animate-pulse mb-4">"{appState.userText}"</p>}
            <h2 className="text-3xl font-black px-4 leading-tight">{appState.aiText || "Klaar voor start?"}</h2>
          </div>
          
          <div className="relative w-full flex flex-col items-center">
            {/* GIGANTISCHE CENTRALE KNOP */}
            <button 
              onClick={appState.isActive ? () => stopCoPilot('manual') : startCoPilot}
              className={`w-64 h-64 rounded-full flex flex-col items-center justify-center transition-all duration-500 relative ${appState.isActive ? 'bg-slate-900 border-[12px] border-indigo-500 shadow-[0_0_120px_rgba(99,102,241,0.6)] scale-110' : 'bg-indigo-600 border-[12px] border-white/5 shadow-2xl active:scale-90'}`}
            >
              {appState.isActive ? (
                <div className="flex gap-4 items-end h-20">
                  {[1,3,5,2,4,2,1].map((v, i) => (<div key={i} className="w-3 bg-indigo-400 rounded-full animate-wave" style={{ height: `${v * 12}px`, animationDelay: `${i*0.1}s` }}></div>))}
                </div>
              ) : (
                <>
                  <i className="fa-solid fa-microphone text-7xl mb-6"></i>
                  <span className="text-[12px] font-black uppercase tracking-[0.3em] text-white/60">Tik om te praten</span>
                </>
              )}
            </button>
          </div>
        </div>
        
        {/* LIJST SECTIE (Wordt bijna onzichtbaar bij actieve assistent om focus te houden) */}
        <div className={`mt-10 space-y-4 transition-all duration-500 ${appState.isActive ? 'opacity-5 blur-sm scale-95 pointer-events-none' : 'opacity-100 scale-100'}`}>
          <div className="flex justify-between items-end px-4">
             <h3 className="text-[11px] font-black text-white/30 uppercase tracking-[0.4em]">Contacten</h3>
             {!appState.isActive && (
               <span className="text-[11px] font-black text-emerald-500 tracking-widest flex items-center gap-2">
                 <i className="fa-solid fa-check-circle text-[10px]"></i> Siri Klaar
               </span>
             )}
          </div>
          <div className="overflow-y-auto max-h-[25vh] space-y-3 pb-24 custom-scrollbar">
            {appState.tasks.map(t => (
              <div key={t.id} className="p-7 bg-white/5 border border-white/5 rounded-[2rem] flex justify-between items-center active:bg-indigo-600 transition-colors">
                <div className="flex-1 pr-8">
                  <p className="font-black text-xl tracking-tighter leading-none">{t.name}</p>
                  <p className="text-sm text-white/40 mt-1.5 font-bold uppercase tracking-wide">{t.organization}</p>
                </div>
                <div className="text-right">
                  <p className="text-base text-white/30 font-mono font-black mb-3">{t.phoneNumber}</p>
                  <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center ml-auto">
                    <i className="fa-solid fa-phone text-sm text-indigo-400"></i>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* GIGANTISCHE SIRI VRIJGAVE BALK - ONDERAAN SCHERM */}
        {appState.isActive && (
          <button 
            onClick={() => stopCoPilot('siri')}
            className="fixed bottom-0 left-0 w-full h-32 bg-red-600 flex items-center justify-center gap-6 shadow-[0_-10px_60px_rgba(220,38,38,0.5)] active:bg-red-700 transition-all animate-in slide-in-from-bottom-full duration-500 z-50"
          >
            <i className="fa-solid fa-microphone-slash text-4xl"></i>
            <span className="text-2xl font-black uppercase tracking-[0.2em] text-white">Siri Nu Vrijgeven</span>
          </button>
        )}
      </main>

      <style>{`
        @keyframes wave { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1.5); } }
        @keyframes progress { from { width: 0%; } to { width: 100%; } }
        .animate-wave { animation: wave 0.8s infinite ease-in-out; }
        .custom-scrollbar::-webkit-scrollbar { width: 0; }
        body { -webkit-tap-highlight-color: transparent; touch-action: manipulation; }
      `}</style>
    </div>
  );
};

export default App;
