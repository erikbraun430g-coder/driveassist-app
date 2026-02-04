
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
    setAppState(prev => ({ ...prev, status: 'connecting', aiText: 'Contacten verifiëren...' }));
    
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
            setAppState(prev => ({ ...prev, status: 'active', isActive: true, aiText: 'Gereed voor instructies.' }));
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
                  }, 2500);
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
        <div className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center p-6 backdrop-blur-xl">
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

      {callingTask && (
        <div className="fixed inset-0 z-[60] bg-indigo-900 flex flex-col items-center justify-center p-10 text-center animate-in fade-in duration-300">
           <div className="w-24 h-24 bg-white/10 rounded-full flex items-center justify-center mb-8 animate-pulse">
             <i className="fa-solid fa-phone text-4xl"></i>
           </div>
           <h2 className="text-3xl font-black mb-2">{callingTask.name}</h2>
           <p className="text-xl opacity-50 mb-10">{callingTask.phoneNumber}</p>
           <p className="text-xs font-bold uppercase tracking-[0.3em] text-indigo-400">Microfoon wordt vrijgegeven...</p>
        </div>
      )}

      <header className="px-8 pt-[env(safe-area-inset-top,3.5rem)] pb-6 flex justify-between items-center bg-slate-950/80 backdrop-blur-lg border-b border-white/5">
        <div className="flex items-center gap-4">
          <div className="w-11 h-11 bg-indigo-600 rounded-2xl flex items-center justify-center">
            <i className="fa-solid fa-headset text-white"></i>
          </div>
          <div>
            <h1 className="text-[11px] font-black uppercase tracking-[0.3em]">CallAssist <span className="text-indigo-400">4.2</span></h1>
            <span className="text-[9px] text-white/30 font-bold uppercase tracking-widest">{appState.tasks.length} items</span>
          </div>
        </div>
        <button onClick={() => setShowSyncModal(true)} className="w-11 h-11 rounded-2xl bg-white/5 flex items-center justify-center active:scale-90 transition-transform">
          <i className={`fa-solid fa-sync text-base ${isSyncing ? 'animate-spin text-indigo-400' : 'text-white/40'}`}></i>
        </button>
      </header>

      <main className="flex-1 flex flex-col p-6 overflow-hidden">
        <div className="flex-1 flex flex-col items-center justify-center text-center space-y-12">
          <div className="h-24 flex flex-col justify-center">
            {appState.userText && <p className="text-indigo-400 font-bold text-[10px] uppercase tracking-widest animate-pulse mb-3">"{appState.userText}"</p>}
            <h2 className="text-xl font-black px-6">{appState.aiText || "Klaar voor start?"}</h2>
          </div>
          
          <div className="relative group">
            <button 
              onClick={appState.isActive ? () => stopCoPilot('manual') : startCoPilot}
              className={`w-44 h-44 rounded-full flex flex-col items-center justify-center transition-all duration-500 relative ${appState.isActive ? 'bg-slate-900 border-[8px] border-indigo-500 shadow-[0_0_80px_rgba(99,102,241,0.4)]' : 'bg-indigo-600 border-[8px] border-white/5 shadow-2xl active:scale-95'}`}
            >
              {appState.isActive ? (
                <div className="flex gap-2 items-end h-12">
                  {[1,3,5,2,4,2,1].map((v, i) => (<div key={i} className="w-2 bg-indigo-400 rounded-full animate-wave" style={{ height: `${v * 8}px`, animationDelay: `${i*0.1}s` }}></div>))}
                </div>
              ) : (
                <>
                  <i className="fa-solid fa-microphone text-5xl mb-3"></i>
                  <span className="text-[10px] font-black uppercase tracking-widest opacity-40">Start Assist</span>
                </>
              )}
            </button>
            
            {appState.isActive && (
              <button 
                onClick={() => stopCoPilot('siri')}
                className="absolute -bottom-16 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 animate-in slide-in-from-top-4 duration-500"
              >
                <div className="w-12 h-12 rounded-full bg-red-500/20 border border-red-500/30 flex items-center justify-center shadow-lg active:scale-90 transition-transform">
                  <i className="fa-solid fa-microphone-slash text-red-500 text-sm"></i>
                </div>
                <span className="text-[9px] font-black text-red-500 uppercase tracking-widest whitespace-nowrap">Siri Vrijgeven</span>
              </button>
            )}
          </div>
        </div>
        
        <div className="mt-14 space-y-5">
          <div className="flex justify-between items-end px-3">
             <h3 className="text-[10px] font-black text-white/20 uppercase tracking-[0.4em]">Contactlijst</h3>
             {!appState.isActive && (
               <span className="text-[10px] font-black text-emerald-500 tracking-widest flex items-center gap-2 animate-in fade-in slide-in-from-right-2">
                 <i className="fa-solid fa-circle-check text-[7px]"></i> Microfoon vrij voor Siri
               </span>
             )}
          </div>
          <div className="overflow-y-auto max-h-[25vh] space-y-3 pb-8 custom-scrollbar">
            {appState.tasks.map(t => (
              <div key={t.id} className="p-5 bg-white/5 border border-white/5 rounded-[1.5rem] flex justify-between items-center group active:bg-indigo-600/30 transition-all">
                <div className="flex-1 pr-4">
                  <p className="font-bold text-base tracking-tight">{t.name}</p>
                  <p className="text-[11px] text-white/40 mt-0.5">{t.organization}</p>
                  <p className="text-[10px] text-indigo-400 font-bold mt-1 uppercase tracking-wider italic">{t.subject}</p>
                </div>
                <div className="text-right">
                  <p className="text-[11px] text-white/30 font-bold mb-2 font-mono">{t.phoneNumber}</p>
                  <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center ml-auto">
                    <i className="fa-solid fa-phone text-[10px] text-indigo-400"></i>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>

      <style>{`
        @keyframes wave { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1.3); } }
        .animate-wave { animation: wave 1.2s infinite ease-in-out; }
        .custom-scrollbar::-webkit-scrollbar { width: 0; }
      `}</style>
    </div>
  );
};

export default App;
