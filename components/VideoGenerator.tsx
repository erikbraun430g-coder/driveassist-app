
import React, { useState } from 'react';
import { generateVideo } from '../services/geminiService';

const VideoGenerator: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');

  const handleGenerate = async () => {
    if (!prompt.trim() || isGenerating) return;
    setIsGenerating(true);
    setVideoUrl(null);
    setStatus('Aanvraag indienen...');

    try {
      // Periodic updates simulation since polling is internal to service
      const statusInterval = setInterval(() => {
        const messages = [
          'De scènes worden opgebouwd...',
          'Licht en schaduw worden berekend...',
          'Frames worden gerenderd...',
          'Nog heel even geduld...',
          'Video wordt geoptimaliseerd...'
        ];
        setStatus(messages[Math.floor(Math.random() * messages.length)]);
      }, 8000);

      const url = await generateVideo(prompt);
      clearInterval(statusInterval);
      setVideoUrl(url);
    } catch (error: any) {
      if (error.message?.includes('entity was not found')) {
        alert("API sleutel is mogelijk verlopen of onjuist. Selecteer deze opnieuw.");
      } else {
        alert("Er is een fout opgetreden bij het maken van de video.");
      }
    } finally {
      setIsGenerating(false);
      setStatus('');
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-10">
      <div className="bg-gradient-to-br from-indigo-900 to-slate-900 p-8 rounded-3xl text-white shadow-xl">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center backdrop-blur-sm border border-white/20">
            <i className="fa-solid fa-clapperboard text-xl text-indigo-300"></i>
          </div>
          <div>
            <h3 className="text-xl font-bold">Veo Video Generator</h3>
            <p className="text-indigo-200/70 text-sm">Creëer cinematische video's van tekst.</p>
          </div>
        </div>

        <div className="space-y-6">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="w-full p-5 bg-white/5 border border-white/10 rounded-2xl focus:ring-2 focus:ring-indigo-400 outline-none h-32 resize-none transition-all text-white placeholder:text-white/30"
            placeholder="Een majestueuze leeuw die door een futuristische neon-stad wandelt, trage camerabeweging..."
          />
          
          <div className="flex justify-between items-center">
             <div className="flex gap-4">
                <span className="flex items-center gap-2 text-xs text-indigo-300/80 bg-white/5 px-3 py-1 rounded-full border border-white/10">
                  <i className="fa-solid fa-hd text-[10px]"></i> 720p
                </span>
                <span className="flex items-center gap-2 text-xs text-indigo-300/80 bg-white/5 px-3 py-1 rounded-full border border-white/10">
                  <i className="fa-solid fa-clock text-[10px]"></i> ~60s
                </span>
             </div>

            <button
              onClick={handleGenerate}
              disabled={isGenerating || !prompt.trim()}
              className="px-8 py-3 bg-white text-indigo-900 font-bold rounded-xl hover:bg-indigo-50 disabled:opacity-50 transition-all flex items-center gap-3 shadow-lg"
            >
              {isGenerating ? (
                <>
                  <i className="fa-solid fa-gear fa-spin"></i>
                  Genereren...
                </>
              ) : (
                <>
                  <i className="fa-solid fa-play"></i>
                  Start Productie
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {isGenerating && (
        <div className="p-12 text-center space-y-6 bg-white rounded-3xl border border-slate-200 shadow-sm animate-pulse">
          <div className="relative w-24 h-24 mx-auto">
             <div className="absolute inset-0 border-4 border-indigo-100 rounded-full"></div>
             <div className="absolute inset-0 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
             <div className="absolute inset-0 flex items-center justify-center">
                <i className="fa-solid fa-film text-2xl text-indigo-600"></i>
             </div>
          </div>
          <div>
            <h4 className="text-xl font-semibold text-slate-800">{status}</h4>
            <p className="text-slate-500 mt-2">Dit kan een minuutje duren. We maken er iets moois van!</p>
          </div>
        </div>
      )}

      {videoUrl && (
        <div className="bg-white p-2 rounded-3xl shadow-2xl border border-slate-200 overflow-hidden animate-in zoom-in-95 duration-700">
          <video 
            src={videoUrl} 
            controls 
            className="w-full rounded-2xl aspect-video bg-black"
            autoPlay
            loop
          />
          <div className="p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
             <div>
               <h4 className="font-bold text-slate-800">Je Meesterwerk is Klaar</h4>
               <p className="text-slate-500 text-sm">Gegenereerd met Veo 3.1 Fast</p>
             </div>
             <a 
               href={videoUrl} 
               download="gemini-video.mp4" 
               className="px-6 py-2.5 bg-slate-900 text-white rounded-xl font-medium hover:bg-black transition-all flex items-center justify-center gap-2"
             >
               <i className="fa-solid fa-cloud-arrow-down"></i>
               Video Opslaan
             </a>
          </div>
        </div>
      )}
    </div>
  );
};

export default VideoGenerator;
