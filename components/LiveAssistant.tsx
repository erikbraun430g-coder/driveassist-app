
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { decode, decodeAudioData, createBlob } from '../services/audioUtils';

const LiveAssistant: React.FC = () => {
  const [isActive, setIsActive] = useState(false);
  const [status, setStatus] = useState<'standby' | 'connecting' | 'active'>('standby');
  const [transcription, setTranscription] = useState('');
  const [modelTranscription, setModelTranscription] = useState('');
  
  const audioContextsRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const stopAllAudio = () => {
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  };

  const startSession = async () => {
    setStatus('connecting');
    setTranscription('Verbinding maken...');
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextsRef.current = { input: inputCtx, output: outputCtx };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setStatus('active');
            setTranscription('Ik luister. Zeg iets...');
            
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle transcriptions
            if (message.serverContent?.inputTranscription) {
              setTranscription(message.serverContent.inputTranscription.text);
            }
            if (message.serverContent?.outputTranscription) {
              setModelTranscription(prev => prev + message.serverContent!.outputTranscription!.text);
            }
            if (message.serverContent?.turnComplete) {
              setModelTranscription('');
            }

            // Handle audio output
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputCtx) {
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputCtx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), outputCtx, 24000, 1);
              const source = outputCtx.createBufferSource();
              source.buffer = buffer;
              source.connect(outputCtx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
            }

            if (message.serverContent?.interrupted) {
              stopAllAudio();
            }
          },
          onclose: () => {
            stopSession();
          },
          onerror: (e) => {
            console.error("Live API Error", e);
            stopSession();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          },
          systemInstruction: 'Je bent DriveAssist, een behulpzame co-piloot. Antwoord kort, bondig en gefocust op verkeersveiligheid en navigatie.'
        }
      });

      sessionRef.current = await sessionPromise;
      setIsActive(true);
    } catch (err) {
      console.error(err);
      setTranscription("Fout bij starten microfoon.");
      setStatus('standby');
    }
  };

  const stopSession = () => {
    setIsActive(false);
    setStatus('standby');
    setTranscription('');
    setModelTranscription('');
    stopAllAudio();
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (audioContextsRef.current) {
      audioContextsRef.current.input.close();
      audioContextsRef.current.output.close();
      audioContextsRef.current.input = null as any;
      audioContextsRef.current.output = null as any;
    }
  };

  return (
    <div className="h-full flex flex-col items-center justify-center animate-in zoom-in-95 duration-500">
      <div className={`relative mb-12 transition-all duration-700 ${isActive ? 'scale-110' : 'scale-100'}`}>
        {/* Animated Orbs */}
        <div className={`absolute inset-0 bg-cyan-500 rounded-full blur-3xl transition-opacity duration-1000 ${isActive ? 'opacity-30 animate-pulse' : 'opacity-0'}`}></div>
        
        <div className={`w-56 h-56 rounded-full bg-slate-900 border-2 flex flex-col items-center justify-center relative z-10 transition-colors duration-500 ${isActive ? 'border-cyan-500 shadow-[0_0_60px_rgba(6,182,212,0.4)]' : 'border-white/10'}`}>
          <div className="flex gap-2 items-end h-16 mb-4">
            {[1,2,3,4,5,6,7,8].map(i => (
              <div 
                key={i} 
                className={`w-2 bg-cyan-400 rounded-full transition-all duration-200 ${isActive ? 'animate-pulse' : 'h-2 opacity-20'}`}
                style={{ height: isActive ? `${15 + Math.random() * 45}px` : '6px', animationDelay: `${i * 0.08}s` }}
              ></div>
            ))}
          </div>
          {isActive && <span className="text-[10px] font-black text-cyan-500 uppercase tracking-widest animate-pulse">Live Link</span>}
        </div>
      </div>

      <div className="text-center max-w-xl space-y-6">
        <h2 className={`text-4xl font-black tracking-tighter transition-all duration-500 ${isActive ? 'text-white' : 'text-slate-800'}`}>
          {status === 'connecting' ? 'Verbinding maken...' : isActive ? 'DriveAssist Actief' : 'Systeem Stand-by'}
        </h2>
        
        <div className="space-y-4">
          <p className={`text-xl font-medium min-h-[1.5rem] transition-colors ${isActive ? 'text-cyan-400' : 'text-slate-500'}`}>
            {transcription || (isActive ? "Zeg iets..." : "Tik op de knop om spraakbediening te starten.")}
          </p>
          {modelTranscription && (
            <p className="text-slate-300 text-lg italic bg-white/5 p-4 rounded-2xl border border-white/5 animate-in fade-in slide-in-from-bottom-2">
              "{modelTranscription}"
            </p>
          )}
        </div>
        
        <button 
          onClick={isActive ? stopSession : startSession}
          disabled={status === 'connecting'}
          className={`px-12 py-5 rounded-full font-black uppercase tracking-widest text-sm transition-all shadow-2xl ${
            isActive 
              ? 'bg-red-500/20 text-red-500 border border-red-500/40 hover:bg-red-500/30' 
              : 'bg-indigo-600 text-white hover:bg-indigo-500 hover:scale-105 active:scale-95'
          }`}
        >
          {status === 'connecting' ? 'Initialiseren...' : isActive ? 'Sessie Beëindigen' : 'Start Spraakbediening'}
        </button>
      </div>

      <div className="mt-16 flex gap-6 opacity-40">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest">
           <i className="fa-solid fa-microphone text-cyan-500"></i> 16kHz PCM
        </div>
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest">
           <i className="fa-solid fa-volume-high text-indigo-500"></i> 24kHz Native
        </div>
      </div>
    </div>
  );
};

export default LiveAssistant;
