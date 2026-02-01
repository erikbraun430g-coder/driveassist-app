
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Type, FunctionDeclaration } from '@google/genai';
import { decode, decodeAudioData, createBlob } from './services/audioUtils';
import { AppState, Task } from './types';

const STORAGE_KEY_TASKS = 'callassist_tasks_v4';
const STORAGE_KEY_SHEET_URL = 'callassist_sheet_url_v4';

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
      if (!response.ok) throw new Error("Sync failed");
      const csvData = await response.text();
      
      const lines = csvData.split(/\r?\n/);
      const newTasks: Task[] = [];
      
      // Determine if there's a header line
      const firstLine = lines[0]?.toLowerCase() || "";
      const startIndex = (firstLine.includes('naam') || firstLine.includes('contact')) ? 1 : 0;
      
      for (let i = startIndex; i < lines.length; i++) {
        const cols = lines[i].split(/[,;]/);
        if (cols[0]?.trim()) {
          newTasks.push({
            id: `call-${i}-${Date.now()}`,
            name: cols[0].trim(),
            organization: cols[1]?.trim() || 'Onbekend',
            subject: cols[2]?.trim() || 'Geen specifiek onderwerp',
            phoneNumber: cols[3]?.trim() || '',
            status: 'open'
          });
        }
      }
      setAppState(prev => ({ ...prev, tasks: newTasks }));
      localStorage.setItem(STORAGE_KEY_SHEET_URL, sheetUrl);
      setShowSyncModal(false);
    } catch (err) {
      alert("Kon de lijst niet laden. Controleer de link.");
    } finally {
      setIsSyncing(false);
    }
  };

  const startCoPilot = async () => {
    setAppState(prev => ({ ...prev, status: 'connecting', aiText: 'Telefoonlijst inladen...' }));
    
    // Construct rich context for the AI
    const callListContext = tasksRef.current.length > 0 
      ? tasksRef.current.map((t, idx) => `${idx + 1}. Contact: ${t.name} | Org: ${t.organization} | Onderwerp: ${t.subject} | Tel: ${t.phoneNumber}`).join('\n')
      : "Er zijn momenteel geen contacten geladen.";

    // Tool declaration for the dial_number tool referenced in system instructions
    const dialNumberTool: FunctionDeclaration = {
      name: 'dial_number',
      parameters: {
        type: Type.OBJECT,
        description: 'Belt een telefoonnummer uit de lijst.',
        properties: {
          number: {
            type: Type.STRING,
            description: 'Het telefoonnummer om te bellen.',
          },
        },
        required: ['number'],
      },
    };

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
            setAppState(prev => ({ ...prev, status: 'active', isActive: true, aiText: 'Ik ben er klaar voor.' }));
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const pcmBlob = createBlob(e.inputBuffer.getChannelData(0));
              // Always initiate sendRealtimeInput after live.connect call resolves.
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
                  setCallingTask(task || { id: 'ext', name: 'Onbekend', organization: '', subject: 'Nummer bellen', phoneNumber: num, status: 'bezig' });
                  setTimeout(() => { window.location.assign(`tel:${num}`); setCallingTask(null); }, 3000);
                }
                sessionPromise.then(s => s.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } } }));
              }
            }
            if (message.serverContent?.inputTranscription) setAppState(prev => ({ ...prev, userText: message.serverContent!.inputTranscription!.text }));
            if (message.serverContent?.outputTranscription) setAppState(prev => ({ ...prev, aiText: message.serverContent!.outputTranscription!.text }));

            // Iterate through parts to find the audio part.
            const audioPart = message.serverContent?.modelTurn?.parts.find(p => p.inlineData);
            const audioData = audioPart?.inlineData?.data;
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

            if (message.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
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
          systemInstruction: `Je bent CallAssist, een virtuele assistent die de gebruiker helpt met een lijst van telefoongesprekken. 
          
          JE OPDRACHT:
          1. Gebruik UITSLUITEND de onderstaande lijst van contactpersonen. Verzin NOOIT eigen namen, onderwerpen of nummers.
          2. Noem bij elk contact de naam, de organisatie EN het onderwerp van het gesprek. 
          3. Wees kort, zakelijk en professioneel.
          4. Als de gebruiker vraagt wie hij als volgende moet bellen, lees dan het eerste openstaande contact uit de lijst voor.
          5. Gebruik de dial_number tool als de gebruiker zegt "bel hem" of "bel [naam]".
          
          HUIDIGE BELLIJST:
          ${callListContext}
          
          Antwoord in het Nederlands.`
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      setAppState(prev => ({ ...prev, status: 'error', aiText: 'Microfoon niet beschikbaar.' }));
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
            <h2 className="text-xl font-black mb-4">Bellijst Koppelen</h2>
            <p className="text-slate-400 text-sm mb-6 leading-relaxed">
              {'Plak de CSV-link van je Google Sheet (Bestand > Delen > Publiceren op internet).'}
            </p>
            <div className="bg-indigo-500/10 border border-indigo-500/20 p-4 rounded-xl mb-6 text-[10px] text-indigo-300 font-medium">
              Verwachte kolommen: Naam, Organisatie, Onderwerp, Nummer.
            </div>
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
           <h2 className="text-3xl font-black mb-2">{callingTask.name}</h2>
           <p className="text-lg text-white/60 mb-1">{callingTask.organization}</p>
           <p className="text-xl opacity-50 tracking-widest font-mono">{callingTask.phoneNumber}</p>
        </div>
      )}

      {/* Optimized Safe Area Header */}
      <header className="px-8 pt-[env(safe-area-inset-top,3.5rem)] pb-6 flex justify-between items-center bg-slate-950/80 backdrop-blur-lg border-b border-white/5">
        <div className="flex items-center gap-4">
          <div className="w-11 h-11 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-600/20">
            <i className="fa-solid fa-headset text-white text-lg"></i>
          </div>
          <div>
            <h1 className="text-[11px] font-black uppercase tracking-[0.3em]">CallAssist <span className="text-indigo-400">4.0</span></h1>
            <span className="text-[9px] text-white/30 font-bold uppercase tracking-widest">{sheetUrl ? 'Live List Connected' : 'Geen Sync'}</span>
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
            <h2 className="text-xl font-black px-6 leading-tight">{appState.aiText || "Klaar voor de gesprekken?"}</h2>
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
                <span className="text-[10px] font-black uppercase tracking-widest opacity-40">Start Gesprek</span>
              </>
            )}
          </button>
        </div>
        
        <div className="mt-8 space-y-5">
          <div className="flex justify-between items-end px-3">
             <h3 className="text-[10px] font-black text-white/20 uppercase tracking-[0.4em]">Bellijst</h3>
             <span className="text-[10px] font-black text-indigo-400 tracking-widest">{appState.tasks.length} personen</span>
          </div>
          <div className="overflow-y-auto max-h-[30vh] space-y-3 pb-8 custom-scrollbar pr-1">
            {appState.tasks.length === 0 ? (
              <div className="py-14 text-center border-2 border-dashed border-white/5 rounded-[2.5rem] opacity-20">
                 <p className="text-[10px] font-black uppercase tracking-widest">Koppel je Google Sheet</p>
              </div>
            ) : (
              appState.tasks.map(t => (
                <div key={t.id} className="p-5 bg-white/5 border border-white/5 rounded-[1.5rem] flex justify-between items-center group active:bg-indigo-600/30 transition-all">
                  <div className="flex-1 pr-4">
                    <p className="font-bold text-base tracking-tight leading-tight">{t.name}</p>
                    <p className="text-[11px] text-white/60 font-medium mt-0.5">{t.organization}</p>
                    <p className="text-[10px] text-indigo-400/80 font-bold mt-1 uppercase tracking-wider line-clamp-1 italic">{t.subject}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] text-white/30 font-bold mb-2 font-mono">{t.phoneNumber || 'GEEN NR'}</p>
                    <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center ml-auto">
                      <i className="fa-solid fa-phone text-[10px] opacity-30"></i>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      <footer className="py-6 text-center opacity-10 pb-[env(safe-area-inset-bottom,1.5rem)]">
        <p className="text-[9px] font-black uppercase tracking-[0.5em]">CallAssist Intelligent Core</p>
      </footer>

      <style>{`
        @keyframes wave { 0%, 100% { transform: scaleY(0.5); } 50% { transform: scaleY(1.3); } }
        .animate-wave { animation: wave 1.2s infinite ease-in-out; }
      `}</style>
    </div>
  );
};

export default App;
