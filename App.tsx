
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Type } from '@google/genai';
import { decode, decodeAudioData, createBlob } from './services/audioUtils';
import { AppState, Task } from './types';

import Dashboard from './components/Dashboard';
import NavigationSearch from './components/NavigationSearch';
import ChatInterface from './components/ChatInterface';
import ImageGenerator from './components/ImageGenerator';
import VideoGenerator from './components/VideoGenerator';

const STORAGE_KEY_TASKS = 'driveassist_tasks_v3';
const STORAGE_KEY_SHEET_URL = 'driveassist_sheet_url';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'drive' | 'dashboard' | 'search' | 'creative' | 'chat'>('drive');
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
      }

      const response = await fetch(exportUrl);
      if (!response.ok) throw new Error("Netwerk error");
      const csvData = await response.text();
      processCsvData(csvData);
      localStorage.setItem(STORAGE_KEY_SHEET_URL, sheetUrl);
      setShowSyncModal(false);
    } catch (err) {
      alert("Synchronisatie mislukt. Zorg dat de sheet 'Gepubliceerd naar het web' is als CSV.");
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
      if (cols[0]) {
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
    setAppState(prev => ({ ...prev, status: 'connecting', aiText: 'Co-piloot start op...' }));
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setAppState(prev => ({ ...prev, status: 'active', isActive: true, aiText: 'Ik luister.' }));
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              const pcmBlob = createBlob(e.inputBuffer.getChannelData(0));
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(processor);
            processor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                let result: any = "ok";
                if (fc.name === 'get_tasks') {
                  result = tasksRef.current.filter(t => t.status !== 'voltooid');
                } else if (fc.name === 'dial_number') {
                  const task = tasksRef.current.find(t => t.id === fc.args.taskId);
                  if (task) {
                    setCallingTask(task);
                    setAppState(prev => ({
                      ...prev,
                      activeTaskId: fc.args.taskId,
                      tasks: prev.tasks.map(t => t.id === fc.args.taskId ? { ...t, status: 'bezig' } : t)
                    }));
                    setTimeout(() => {
                      window.location.assign(`tel:${fc.args.number}`);
                      setCallingTask(null);
                    }, 4000);
                  }
                }
                sessionPromise.then(s => s.sendToolResponse({ 
                  functionResponses: { id: fc.id, name: fc.name, response: { result } } 
                }));
              }
            }
            if (message.serverContent?.inputTranscription) setAppState(prev => ({ ...prev, userText: message.serverContent!.inputTranscription!.text }));
            if (message.serverContent?.outputTranscription) setAppState(prev => ({ ...prev, aiText: message.serverContent!.outputTranscription!.text }));
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outputCtx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              audioSourcesRef.current.add(source);
            }
          },
          onclose: () => stopCoPilot(),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          tools: [{ functionDeclarations: [
            { name: 'get_tasks', description: 'Haal lijst op.', parameters: { type: Type.OBJECT, properties: {} } },
            { name: 'dial_number', description: 'Bel nummer.', parameters: { type: Type.OBJECT, properties: { number: { type: Type.STRING }, taskId: { type: Type.STRING } }, required: ['number', 'taskId'] } }
          ]}],
          systemInstruction: "Je bent DriveAssist co-piloot. Je helpt chauffeur met taken. Wees extreem beknopt en zakelijk. Vraag altijd om bevestiging voor een actie."
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) { 
      setAppState(prev => ({ ...prev, status: 'error', aiText: 'Microfoon of verbinding mislukt.' })); 
    }
  };

  const stopCoPilot = () => {
    sessionRef.current?.close();
    setAppState(prev => ({ ...prev, isActive: false, status: 'idle', userText: '', aiText: '' }));
    audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    audioSourcesRef.current.clear();
  };

  return (
    <div className="fixed inset-0 bg-slate-950 flex flex-col safe-top safe-bottom select-none">
      
      {showSyncModal && (
        <div className="fixed inset-0 z-50 bg-black/95 backdrop-blur-2xl flex items-center justify-center p-6 animate-in fade-in duration-300">
          <div className="w-full max-w-md bg-slate-900 border border-white/10 p-10 rounded-[3rem] shadow-2xl">
            <h2 className="text-3xl font-black mb-4 tracking-tighter">Agenda Koppelen</h2>
            <div className="space-y-4 text-slate-400 text-sm mb-8 leading-relaxed font-medium">
              <p>1. Open je Google Sheet takenlijst.</p>
              <p>2. <b>Bestand &gt; Delen &gt; Publiceren op internet</b>.</p>
              <p>3. Selecteer <b>CSV (.csv)</b> en klik <b>Publiceren</b>.</p>
              <p>4. Plak de link hieronder.</p>
            </div>
            <input 
              type="text" 
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              className="w-full bg-black/50 border border-white/5 p-6 rounded-2xl text-sm mb-8 focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-white placeholder:text-white/10"
            />
            <div className="flex gap-4">
              <button onClick={() => setShowSyncModal(false)} className="flex-1 py-5 text-xs font-black uppercase tracking-widest text-slate-500 hover:text-white transition-colors">Annuleren</button>
              <button onClick={syncWithGoogleSheet} className="flex-1 py-5 bg-indigo-600 rounded-2xl text-xs font-black uppercase tracking-widest shadow-xl shadow-indigo-600/20 hover:bg-indigo-500 transition-all">Koppelen</button>
            </div>
          </div>
        </div>
      )}

      {callingTask && (
        <div className="fixed inset-0 z-[60] bg-indigo-700 flex flex-col items-center justify-center text-center p-12 animate-in slide-in-from-bottom duration-500">
           <div className="w-40 h-40 bg-white/10 rounded-full flex items-center justify-center mb-10 animate-pulse border-4 border-white/20">
              <i className="fa-solid fa-phone-volume text-6xl text-white"></i>
           </div>
           <h2 className="text-[10px] font-black uppercase tracking-[0.5em] text-indigo-300 mb-6">Verbinden met...</h2>
           <h2 className="text-5xl font-black mb-4 tracking-tighter">{callingTask.omschrijving}</h2>
           <p className="text-2xl font-bold opacity-40 tracking-widest">{callingTask.telefoonnummer}</p>
        </div>
      )}

      <header className="px-6 py-6 flex justify-between items-center bg-black/40 border-b border-white/5 backdrop-blur-3xl relative z-40">
        <div className="flex items-center gap-4">
          <div className="w-11 h-11 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-xl shadow-indigo-600/30">
            <i className="fa-solid fa-car-side text-white text-lg"></i>
          </div>
          <div>
            <h1 className="text-[11px] font-black uppercase tracking-[0.4em] mb-1">DriveAssist <span className="text-indigo-400">3.1</span></h1>
            <div className="flex items-center gap-2">
               <div className={`w-1.5 h-1.5 rounded-full ${sheetUrl ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`}></div>
               <span className="text-[9px] text-white/30 font-black uppercase tracking-widest">{sheetUrl ? 'Cloud Connected' : 'Offline Mode'}</span>
            </div>
          </div>
        </div>
        <button onClick={() => setShowSyncModal(true)} className="w-11 h-11 rounded-2xl bg-white/5 border border-white/5 flex items-center justify-center hover:bg-white/10 transition-all group">
          <i className={`fa-solid fa-cloud-arrow-down text-sm transition-all ${isSyncing ? 'animate-bounce text-indigo-400' : 'text-white/20 group-hover:text-white/60'}`}></i>
        </button>
      </header>

      <main className="flex-1 flex flex-col p-6 overflow-hidden relative">
        <div className={`absolute inset-0 bg-indigo-600/5 transition-opacity duration-1000 ${appState.isActive ? 'opacity-100' : 'opacity-0'}`}></div>
        
        {activeTab === 'drive' && (
          <div className="h-full flex flex-col relative z-10">
            <div className="flex-1 flex flex-col items-center justify-center text-center space-y-12">
              <div className="h-10">
                {appState.userText && <p className="text-indigo-400 font-black text-[11px] uppercase tracking-[0.3em] animate-pulse">"{appState.userText}"</p>}
              </div>
              <div className="h-32 flex items-center justify-center px-6">
                <h2 className="text-2xl font-black max-w-xs leading-tight tracking-tight">
                  {appState.aiText || (appState.tasks.length > 0 ? "Klaar voor de volgende rit." : "Koppel je agenda via de cloud knop.")}
                </h2>
              </div>
              
              <button 
                onClick={appState.isActive ? stopCoPilot : startCoPilot}
                className={`w-48 h-48 rounded-full flex flex-col items-center justify-center transition-all duration-700 relative group ${appState.isActive ? 'bg-slate-900 border-[8px] border-indigo-500 shadow-[0_0_100px_rgba(99,102,241,0.5)]' : 'bg-indigo-600 border-[8px] border-white/5 shadow-2xl hover:scale-105 active:scale-95'}`}
              >
                {appState.isActive ? (
                  <div className="flex gap-2 items-end h-14">
                    {[1,4,6,3,5,3,1].map((v, i) => (<div key={i} className="w-2 bg-indigo-400 rounded-full animate-wave" style={{ height: `${v * 8}px`, animationDelay: `${i*0.1}s` }}></div>))}
                  </div>
                ) : (
                  <>
                    <i className="fa-solid fa-microphone text-5xl mb-3"></i>
                    <span className="text-[10px] font-black uppercase tracking-[0.3em] opacity-40">Tik om te praten</span>
                  </>
                )}
              </button>
            </div>
            
            <div className="mt-12 space-y-5">
              <div className="flex justify-between items-end px-3">
                 <h3 className="text-[11px] font-black text-white/20 uppercase tracking-[0.5em]">Route Agenda</h3>
                 <span className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">{appState.tasks.length} Punten</span>
              </div>
              <div className="flex-1 overflow-y-auto max-h-72 space-y-3 pr-1 custom-scrollbar">
                {appState.tasks.length === 0 ? (
                  <div className="py-16 text-center border-2 border-dashed border-white/5 rounded-[3rem] opacity-20">
                     <i className="fa-solid fa-sheet-plastic text-4xl mb-4"></i>
                     <p className="text-[11px] font-black uppercase tracking-widest">Geen data geladen</p>
                  </div>
                ) : (
                  appState.tasks.map(t => (
                    <div key={t.id} className="p-6 bg-white/5 border border-white/5 rounded-[2.5rem] flex justify-between items-center group hover:bg-white/10 transition-all">
                      <div className="min-w-0">
                        <p className="font-black text-[15px] truncate tracking-tight">{t.omschrijving}</p>
                        <p className="text-[11px] text-white/30 font-bold mt-1 tracking-widest">{t.telefoonnummer || 'GEEN NUMMER'}</p>
                      </div>
                      <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center group-hover:bg-indigo-600 transition-all shadow-xl">
                         <i className="fa-solid fa-phone text-xs opacity-20 group-hover:opacity-100 group-hover:text-white"></i>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
        
        {activeTab === 'dashboard' && <Dashboard location={appState.location} />}
        {activeTab === 'search' && <NavigationSearch location={appState.location} />}
        {activeTab === 'creative' && <div className="space-y-12 pb-20 custom-scrollbar overflow-y-auto"><VideoGenerator /><ImageGenerator /></div>}
        {activeTab === 'chat' && <ChatInterface />}
      </main>

      <nav className="px-6 py-10 bg-black/60 border-t border-white/5 backdrop-blur-3xl flex justify-between items-center relative z-40">
        <NavBtn act={activeTab === 'dashboard'} icon="fa-gauge-simple-high" label="Status" onClick={() => setActiveTab('dashboard')} />
        <NavBtn act={activeTab === 'drive'} icon="fa-microphone" label="Co-Pilot" onClick={() => setActiveTab('drive')} main />
        <NavBtn act={activeTab === 'search'} icon="fa-compass" label="Zoek" onClick={() => setActiveTab('search')} />
        <NavBtn act={activeTab === 'creative'} icon="fa-wand-magic-sparkles" label="Studio" onClick={() => setActiveTab('creative')} />
        <NavBtn act={activeTab === 'chat'} icon="fa-clock-rotate-left" label="Logboek" onClick={() => setActiveTab('chat')} />
      </nav>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
        @keyframes wave { 0%, 100% { transform: scaleY(0.4); } 50% { transform: scaleY(1); } }
        .animate-wave { animation: wave 1s infinite ease-in-out; }
      `}</style>
    </div>
  );
};

const NavBtn: React.FC<{act: boolean; icon: string; label: string; onClick: () => void; main?: boolean}> = ({act, icon, label, onClick, main}) => (
  <button onClick={onClick} className={`flex flex-col items-center gap-2.5 transition-all duration-300 ${act ? 'text-indigo-400 scale-110' : 'text-white/20 hover:text-white/40'}`}>
    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-all ${act ? 'bg-indigo-600/20 border border-indigo-500/30' : main ? 'bg-white/5 border border-white/5' : ''}`}>
      <i className={`fa-solid ${icon} ${act ? 'text-xl' : 'text-lg'}`}></i>
    </div>
    <span className="text-[9px] font-black uppercase tracking-[0.2em]">{label}</span>
  </button>
);

export default App;
