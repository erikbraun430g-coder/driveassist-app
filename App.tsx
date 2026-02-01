
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Type } from '@google/genai';
import { decode, decodeAudioData, createBlob } from './services/audioUtils';
import { AppState, Task } from './types';

const STORAGE_KEY_TASKS = 'driveassist_tasks_v3';
const STORAGE_KEY_SHEET_URL = 'driveassist_sheet_url';

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
      location: { lat: 52.3676, lng: 4.9041 },
      tasks: saved ? JSON.parse(saved) : [],
      activeTaskId: null
    };
  });

  const tasksRef = useRef<Task[]>(appState.tasks);
  const sessionRef = useRef<any>(null);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const audioContextRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);

  useEffect(() => {
    tasksRef.current = appState.tasks;
    localStorage.setItem(STORAGE_KEY_TASKS, JSON.stringify(appState.tasks));
  }, [appState.tasks]);

  useEffect(() => {
    if (sheetUrl) syncWithGoogleSheet();
  }, []);

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
      if (!response.ok) throw new Error("Sync mislukt");
      const csvData = await response.text();
      processCsvData(csvData);
      localStorage.setItem(STORAGE_KEY_SHEET_URL, sheetUrl);
      setShowSyncModal(false);
    } catch (err) {
      alert("Zorg dat de Google Sheet 'Gepubliceerd naar het web' is als CSV.");
    } finally {
      setIsSyncing(false);
    }
  };

  const processCsvData = (content: string) => {
    const lines = content.split(/\r?\n/);
    const newTasks: Task[] = [];
    const startIndex = (lines[0]?.toLowerCase().includes('taak') || lines[0]?.toLowerCase().includes('naam')) ? 1 : 0;
    
    for (let i = startIndex; i < lines.length; i++) {
      const cols = lines[i].split(/[,;]/);
      if (cols[0] && cols[0].trim().length > 0) {
        newTasks.push({
          id: `t-${i}-${Date.now()}`,
          omschrijving: cols[0].trim(),
          telefoonnummer: cols[1]?.trim() || '',
          notitie: '',
          status: 'open'
        });
      }
    }
    setAppState(prev => ({ ...prev, tasks: newTasks }));
  };

  const startCoPilot = async () => {
    setAppState(prev => ({ ...prev, status: 'connecting', aiText: 'Verbinding maken...' }));
    
    try {
      // Microfoon toestemming vragen
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      // AudioContexten MOETEN hier binnen de klik-handler aangemaakt worden
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextRef.current = { input: inputCtx, output: outputCtx };

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setAppState(prev => ({ ...prev, status: 'active', isActive: true, aiText: 'Ik luister.' }));
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
                let result: any = "ok";
                if (fc.name === 'dial_number') {
                  const taskId = fc.args.taskId as string;
                  const num = fc.args.number as string;
                  setCallingTask(tasksRef.current.find(t => t.id === taskId) || null);
                  setTimeout(() => { window.location.assign(`tel:${num}`); setCallingTask(null); }, 3500);
                }
                sessionPromise.then(s => s.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result } } }));
              }
            }
            if (message.serverContent?.inputTranscription) setAppState(prev => ({ ...prev, userText: message.serverContent!.inputTranscription!.text }));
            if (message.serverContent?.outputTranscription) setAppState(prev => ({ ...prev, aiText: message.serverContent!.outputTranscription!.text }));

            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
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
            }
          },
          onclose: () => stopCoPilot(),
          onerror: () => stopCoPilot(),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: "Je bent DriveAssist. Je helpt een chauffeur met de rittenlijst. Praat kort, zakelijk en vlot. Gebruik de dial_number tool als de chauffeur iemand wil bellen."
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      setAppState(prev => ({ ...prev, status: 'error', aiText: 'Microfoon toegang geweigerd.' }));
    }
  };

  const stopCoPilot = () => {
    sessionRef.current?.close();
    audioContextRef.current?.input.close();
    audioContextRef.current?.output.close();
    audioContextRef.current = null;
    setAppState(prev => ({ ...prev, isActive: false, status: 'idle', userText: '', aiText: '' }));
    audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  };

  return (
    <div className="fixed inset-0 bg-slate-950 flex flex-col text-white font-sans overflow-hidden">
      
      {/* Cloud Sync Modal */}
      {showSyncModal && (
        <div className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center p-6 backdrop-blur-xl">
          <div className="w-full max-w-md bg-slate-900 border border-white/10 p-10 rounded-[3rem] shadow-2xl">
            <h2 className="text-2xl font-black mb-6">Agenda Koppelen</h2>
            <div className="space-y-4 text-slate-400 text-sm mb-8 leading-relaxed">
              <p>1. Open je Google Sheet rittenlijst.</p>
              <p>2. Ga naar <b>Bestand</b> &gt; <b>Delen</b> &gt; <b>Publiceren op internet</b>.</p>
              <p>3. Selecteer <b>CSV (.csv)</b> en klik op <b>Publiceren</b>.</p>
              <p>4. Plak de link hieronder.</p>
            </div>
            <input 
              type="text" 
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.target.value)}
              placeholder="Plak CSV link hier..."
              className="w-full bg-black/50 border border-white/10 p-5 rounded-2xl mb-8 outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <div className="flex gap-4">
              <button onClick={() => setShowSyncModal(false)} className="flex-1 py-4 text-xs font-black uppercase tracking-widest opacity-50">Annuleren</button>
              <button onClick={syncWithGoogleSheet} className="flex-1 py-4 bg-indigo-600 rounded-2xl text-xs font-black uppercase tracking-widest">Koppelen</button>
            </div>
          </div>
        </div>
      )}

      {/* Calling Animation */}
      {callingTask && (
        <div className="fixed inset-0 z-[60] bg-indigo-700 flex flex-col items-center justify-center p-12">
           <i className="fa-solid fa-phone-volume text-7xl mb-10 animate-pulse text-white"></i>
           <h2 className="text-4xl font-black mb-2 text-center">{callingTask.omschrijving}</h2>
           <p className="text-xl opacity-50 tracking-widest">{callingTask.telefoonnummer}</p>
        </div>
      )}

      {/* Header */}
      <header className="px-6 py-6 flex justify-between items-center border-b border-white/5 bg-slate-950/50 backdrop-blur-md">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-600/20">
            <i className="fa-solid fa-car-side text-white"></i>
          </div>
          <div>
            <h1 className="text-[10px] font-black uppercase tracking-[0.3em]">DriveAssist <span className="text-indigo-400">3.1</span></h1>
            <span className="text-[8px] text-white/30 font-bold uppercase tracking-widest">{sheetUrl ? 'Cloud Connected' : 'No Data'}</span>
          </div>
        </div>
        <button onClick={() => setShowSyncModal(true)} className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center hover:bg-white/10 transition-colors">
          <i className={`fa-solid fa-cloud-arrow-down text-sm ${isSyncing ? 'animate-bounce text-indigo-400' : 'text-white/40'}`}></i>
        </button>
      </header>

      {/* Main Experience */}
      <main className="flex-1 flex flex-col p-6 overflow-hidden">
        <div className="flex-1 flex flex-col items-center justify-center text-center space-y-10">
          <div className="h-20 flex flex-col justify-center">
            {appState.userText && <p className="text-indigo-400 font-bold text-xs uppercase tracking-widest animate-pulse mb-2">"{appState.userText}"</p>}
            <h2 className="text-xl font-black px-4 leading-tight">{appState.aiText || "Klaar voor de start?"}</h2>
          </div>
          
          <button 
            onClick={appState.isActive ? stopCoPilot : startCoPilot}
            className={`w-44 h-44 rounded-full flex flex-col items-center justify-center transition-all duration-500 relative ${appState.isActive ? 'bg-slate-900 border-[6px] border-indigo-500 shadow-[0_0_80px_rgba(99,102,241,0.4)]' : 'bg-indigo-600 border-[6px] border-white/5 hover:scale-105 active:scale-95 shadow-2xl'}`}
          >
            {appState.isActive ? (
              <div className="flex gap-1.5 items-end h-12">
                {[1,3,5,2,4,2,1].map((v, i) => (<div key={i} className="w-1.5 bg-indigo-400 rounded-full animate-wave" style={{ height: `${v * 8}px`, animationDelay: `${i*0.1}s` }}></div>))}
              </div>
            ) : (
              <>
                <i className="fa-solid fa-microphone text-4xl mb-2"></i>
                <span className="text-[9px] font-black uppercase tracking-widest opacity-40">Start Co-Pilot</span>
              </>
            )}
          </button>
        </div>
        
        {/* Simplified Task List */}
        <div className="mt-8 space-y-4">
          <div className="flex justify-between items-end px-2">
             <h3 className="text-[10px] font-black text-white/20 uppercase tracking-[0.4em]">Agenda Punten</h3>
             <span className="text-[9px] font-black text-indigo-400">{appState.tasks.length} ritten</span>
          </div>
          <div className="overflow-y-auto max-h-[35vh] space-y-3 pb-6 custom-scrollbar pr-1">
            {appState.tasks.length === 0 ? (
              <div className="py-12 text-center border-2 border-dashed border-white/5 rounded-3xl opacity-20">
                 <p className="text-[10px] font-black uppercase">Geen data geladen</p>
              </div>
            ) : (
              appState.tasks.map(t => (
                <div key={t.id} className="p-5 bg-white/5 border border-white/5 rounded-3xl flex justify-between items-center group active:bg-white/10 transition-colors">
                  <div>
                    <p className="font-bold text-sm tracking-tight">{t.omschrijving}</p>
                    <p className="text-[10px] text-white/30 font-bold mt-0.5 tracking-wider">{t.telefoonnummer || 'GEEN NUMMER'}</p>
                  </div>
                  <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center group-active:bg-indigo-600 transition-colors">
                     <i className="fa-solid fa-phone text-[10px] opacity-30"></i>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      <footer className="py-6 text-center opacity-10">
        <p className="text-[8px] font-black uppercase tracking-[0.4em]">Powered by DriveAssist Core v3.1</p>
      </footer>

      <style>{`
        @keyframes wave { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1.2); } }
        .animate-wave { animation: wave 1.2s infinite ease-in-out; }
        .custom-scrollbar::-webkit-scrollbar { width: 3px; }
      `}</style>
    </div>
  );
};

export default App;
