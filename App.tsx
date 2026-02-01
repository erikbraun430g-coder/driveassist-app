
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
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
      if (!response.ok) throw new Error("Netwerkfout");
      const csvData = await response.text();
      
      const lines = csvData.split(/\r?\n/);
      const newTasks: Task[] = [];
      const startIndex = (lines[0]?.toLowerCase().includes('taak') || lines[0]?.toLowerCase().includes('naam')) ? 1 : 0;
      
      for (let i = startIndex; i < lines.length; i++) {
        const cols = lines[i].split(/[,;]/);
        if (cols[0]?.trim()) {
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
      localStorage.setItem(STORAGE_KEY_SHEET_URL, sheetUrl);
      setShowSyncModal(false);
    } catch (err) {
      alert("Synchronisatie mislukt. Controleer de link.");
    } finally {
      setIsSyncing(false);
    }
  };

  const startCoPilot = async () => {
    setAppState(prev => ({ ...prev, status: 'connecting', aiText: 'Systeem laden...' }));
    
    // Injecteer de werkelijke rittenlijst in de instructies
    const currentRitten = tasksRef.current.length > 0 
      ? tasksRef.current.map(t => `- Bestemming: ${t.omschrijving} | Tel: ${t.telefoonnummer || 'Niet beschikbaar'}`).join('\n')
      : "Er zijn momenteel GEEN ritten geladen in het systeem.";

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
                if (fc.name === 'dial_number') {
                  const num = fc.args.number as string;
                  const task = tasksRef.current.find(t => t.telefoonnummer === num);
                  setCallingTask(task || { id: 'ext', omschrijving: 'Extern nummer', telefoonnummer: num, notitie: '', status: 'bezig' });
                  setTimeout(() => { window.location.assign(`tel:${num}`); setCallingTask(null); }, 3000);
                }
                sessionPromise.then(s => s.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } } }));
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
          systemInstruction: `Je bent DriveAssist, de co-piloot voor deze chauffeur. 
          
          STRIKTE REGELS:
          1. Gebruik UITSLUITEND de onderstaande rittenlijst. 
          2. Verzin NOOIT eigen ritten of adressen. 
          3. Als de chauffeur vraagt naar de volgende rit, lees dan de eerste rit uit de lijst voor.
          4. Antwoord kort en krachtig.
          
          WERKELIJKE RITTENLIJST:
          ${currentRitten}
          
          Als de chauffeur zegt "Bel [naam]", zoek dan het nummer in de lijst en gebruik dial_number.`
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      setAppState(prev => ({ ...prev, status: 'error', aiText: 'Microfoon toegang geweigerd.' }));
    }
  };

  const stopCoPilot = () => {
    sessionRef.current?.close();
    if (audioContextRef.current) {
      audioContextRef.current.input.close();
      audioContextRef.current.output.close();
      audioContextRef.current = null;
    }
    setAppState(prev => ({ ...prev, isActive: false, status: 'idle', userText: '', aiText: '' }));
    audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  };

  return (
    <div className="fixed inset-0 bg-slate-950 flex flex-col text-white font-sans overflow-hidden">
      
      {showSyncModal && (
        <div className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center p-6 backdrop-blur-xl">
          <div className="w-full max-w-md bg-slate-900 p-8 rounded-[2.5rem] border border-white/10 shadow-2xl">
            <h2 className="text-xl font-black mb-4">Agenda Koppelen</h2>
            <p className="text-slate-400 text-sm mb-6 leading-relaxed">
              {'Plak de CSV-link van je Google Sheet (Bestand > Delen > Publiceren op internet).'}
            </p>
            <input 
              type="text" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)}
              className="w-full bg-black/50 border border-white/10 p-5 rounded-2xl mb-6 outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
              placeholder="https://docs.google.com/spreadsheets/..."
            />
            <div className="flex gap-4">
              <button onClick={() => setShowSyncModal(false)} className="flex-1 py-4 text-xs font-bold uppercase tracking-widest opacity-50">Sluiten</button>
              <button onClick={syncWithGoogleSheet} className="flex-1 py-4 bg-indigo-600 rounded-2xl text-xs font-bold uppercase tracking-widest">Koppelen</button>
            </div>
          </div>
        </div>
      )}

      {callingTask && (
        <div className="fixed inset-0 z-[60] bg-indigo-700 flex flex-col items-center justify-center p-10 text-center">
           <i className="fa-solid fa-phone-volume text-7xl mb-10 animate-pulse"></i>
           <h2 className="text-3xl font-black mb-2">{callingTask.omschrijving}</h2>
           <p className="text-xl opacity-50 tracking-widest">{callingTask.telefoonnummer}</p>
        </div>
      )}

      {/* Verbeterde header voor iPhone Safe Area */}
      <header className="px-8 pt-[env(safe-area-inset-top,3.5rem)] pb-6 flex justify-between items-center bg-slate-950/80 backdrop-blur-lg border-b border-white/5">
        <div className="flex items-center gap-4">
          <div className="w-11 h-11 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-600/20">
            <i className="fa-solid fa-car-side text-white text-lg"></i>
          </div>
          <div>
            <h1 className="text-[11px] font-black uppercase tracking-[0.3em]">DriveAssist <span className="text-indigo-400">3.1</span></h1>
            <span className="text-[9px] text-white/30 font-bold uppercase tracking-widest">{sheetUrl ? 'Cloud Connected' : 'Geen Sync'}</span>
          </div>
        </div>
        <button 
          onClick={() => setShowSyncModal(true)} 
          className="w-11 h-11 rounded-2xl bg-white/5 flex items-center justify-center active:scale-90 transition-transform"
        >
          <i className={`fa-solid fa-cloud-arrow-down text-base ${isSyncing ? 'animate-bounce text-indigo-400' : 'text-white/40'}`}></i>
        </button>
      </header>

      <main className="flex-1 flex flex-col p-6 overflow-hidden">
        <div className="flex-1 flex flex-col items-center justify-center text-center space-y-12">
          <div className="h-24 flex flex-col justify-center">
            {appState.userText && <p className="text-indigo-400 font-bold text-[10px] uppercase tracking-widest animate-pulse mb-3 px-6 leading-tight">"{appState.userText}"</p>}
            <h2 className="text-xl font-black px-6 leading-tight">{appState.aiText || "Klaar voor de start?"}</h2>
          </div>
          
          <button 
            onClick={appState.isActive ? stopCoPilot : startCoPilot}
            className={`w-44 h-44 rounded-full flex flex-col items-center justify-center transition-all duration-500 relative ${appState.isActive ? 'bg-slate-900 border-[8px] border-indigo-500 shadow-[0_0_80px_rgba(99,102,241,0.4)]' : 'bg-indigo-600 border-[8px] border-white/5 shadow-2xl active:scale-95'}`}
          >
            {appState.isActive ? (
              <div className="flex gap-2 items-end h-12">
                {[1,3,5,2,4,2,1].map((v, i) => (<div key={i} className="w-2 bg-indigo-400 rounded-full animate-wave" style={{ height: `${v * 8}px`, animationDelay: `${i*0.1}s` }}></div>))}
              </div>
            ) : (
              <>
                <i className="fa-solid fa-microphone text-5xl mb-3"></i>
                <span className="text-[10px] font-black uppercase tracking-widest opacity-40">Spraak Start</span>
              </>
            )}
          </button>
        </div>
        
        <div className="mt-8 space-y-5">
          <div className="flex justify-between items-end px-3">
             <h3 className="text-[10px] font-black text-white/20 uppercase tracking-[0.4em]">Rittenlijst</h3>
             <span className="text-[10px] font-black text-indigo-400 tracking-widest">{appState.tasks.length} stops</span>
          </div>
          <div className="overflow-y-auto max-h-[30vh] space-y-3 pb-8 custom-scrollbar pr-1">
            {appState.tasks.length === 0 ? (
              <div className="py-14 text-center border-2 border-dashed border-white/5 rounded-[2.5rem] opacity-20">
                 <p className="text-[10px] font-black uppercase tracking-widest">Wacht op cloud sync</p>
              </div>
            ) : (
              appState.tasks.map(t => (
                <div key={t.id} className="p-5 bg-white/5 border border-white/5 rounded-[1.5rem] flex justify-between items-center group active:bg-indigo-600/50 transition-all">
                  <div className="flex-1 pr-4">
                    <p className="font-bold text-base tracking-tight leading-tight">{t.omschrijving}</p>
                    <p className="text-[11px] text-white/30 font-bold mt-1 tracking-wider">{t.telefoonnummer || 'GEEN NUMMER'}</p>
                  </div>
                  <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center group-active:bg-white/20">
                    <i className="fa-solid fa-phone text-xs opacity-30 group-active:opacity-100"></i>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      <footer className="py-6 text-center opacity-10 pb-[env(safe-area-inset-bottom,1.5rem)]">
        <p className="text-[9px] font-black uppercase tracking-[0.5em]">DriveAssist AI Core v3.1</p>
      </footer>

      <style>{`
        @keyframes wave { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1.3); } }
        .animate-wave { animation: wave 1.2s infinite ease-in-out; }
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
      `}</style>
    </div>
  );
};

export default App;
