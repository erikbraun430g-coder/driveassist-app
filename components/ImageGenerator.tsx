
import React, { useState } from 'react';
import { generateImage } from '../services/geminiService';

const ImageGenerator: React.FC = () => {
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState<"1:1" | "16:9" | "9:16">("1:1");
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!prompt.trim() || isGenerating) return;
    setIsGenerating(true);
    setResult(null);
    try {
      const url = await generateImage(prompt, aspectRatio);
      setResult(url);
    } catch (error) {
      alert("Fout bij het genereren van de afbeelding.");
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 pb-10">
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-6">
        <div className="space-y-2">
          <label className="text-sm font-semibold text-slate-700">Wat wil je maken?</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="w-full p-4 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none h-24 resize-none transition-all"
            placeholder="Een futuristische stad in de wolken, cyberpunk stijl, 8k..."
          />
        </div>

        <div className="flex flex-wrap items-center gap-6">
          <div className="space-y-2">
            <span className="text-sm font-semibold text-slate-700 block">Verhouding</span>
            <div className="flex gap-2">
              {(["1:1", "16:9", "9:16"] as const).map(ratio => (
                <button
                  key={ratio}
                  onClick={() => setAspectRatio(ratio)}
                  className={`px-4 py-2 rounded-lg border transition-all text-sm font-medium ${
                    aspectRatio === ratio 
                      ? 'bg-indigo-600 border-indigo-600 text-white shadow-md' 
                      : 'bg-white border-slate-200 text-slate-600 hover:border-indigo-400'
                  }`}
                >
                  {ratio}
                </button>
              ))}
            </div>
          </div>
          
          <button
            onClick={handleGenerate}
            disabled={isGenerating || !prompt.trim()}
            className="ml-auto px-8 py-3 bg-indigo-600 text-white font-bold rounded-xl shadow-lg shadow-indigo-200 hover:bg-indigo-700 disabled:opacity-50 transition-all flex items-center gap-3"
          >
            {isGenerating ? (
              <>
                <i className="fa-solid fa-spinner fa-spin"></i>
                Bezig met creëren...
              </>
            ) : (
              <>
                <i className="fa-solid fa-sparkles"></i>
                Genereer Afbeelding
              </>
            )}
          </button>
        </div>
      </div>

      {result && (
        <div className="bg-white p-4 rounded-2xl shadow-md border border-slate-200 overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
          <img src={result} alt="Gegenereerd resultaat" className="w-full h-auto rounded-xl shadow-inner" />
          <div className="mt-4 flex justify-between items-center px-2">
             <span className="text-sm text-slate-400 italic">"{prompt.length > 50 ? prompt.substring(0, 50) + '...' : prompt}"</span>
             <a 
               href={result} 
               download="gemini-creation.png" 
               className="text-indigo-600 hover:text-indigo-800 font-medium text-sm flex items-center gap-2"
             >
               <i className="fa-solid fa-download"></i>
               Downloaden
             </a>
          </div>
        </div>
      )}

      {isGenerating && !result && (
        <div className="aspect-square w-full max-w-md mx-auto bg-slate-100 rounded-2xl flex flex-col items-center justify-center gap-4 border-2 border-dashed border-slate-200">
           <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
           <p className="text-slate-500 font-medium">De AI is aan het schilderen...</p>
        </div>
      )}
    </div>
  );
};

export default ImageGenerator;
