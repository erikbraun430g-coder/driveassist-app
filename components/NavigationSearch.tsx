import React, { useState } from 'react';
import { searchDriveAssist } from '../services/geminiService';

const NavigationSearch: React.FC<{location: any}> = ({ location }) => {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    try {
      const data = await searchDriveAssist(query, location);
      setResult(data);
    } catch (error) {
      alert("Zoekopdracht mislukt.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full max-w-4xl mx-auto flex flex-col gap-6 animate-in slide-in-from-right-10 duration-500">
      <form onSubmit={handleSearch} className="relative group">
        <input 
          type="text" 
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Waar wilt u naartoe?"
          className="w-full bg-slate-900 border border-white/10 rounded-3xl py-6 pl-14 pr-24 text-xl font-bold focus:ring-4 focus:ring-cyan-500/20 outline-none transition-all placeholder:text-slate-700"
        />
        <i className="fa-solid fa-magnifying-glass absolute left-6 top-1/2 -translate-y-1/2 text-slate-500 text-xl"></i>
        <button 
          disabled={loading}
          className="absolute right-4 top-1/2 -translate-y-1/2 bg-cyan-500 hover:bg-cyan-400 text-black px-6 py-2 rounded-2xl font-black text-xs uppercase tracking-widest disabled:opacity-50 transition-all"
        >
          {loading ? 'Zoeken...' : 'Ga'}
        </button>
      </form>

      <div className="flex-1 overflow-y-auto space-y-6 pr-2">
        {!result && !loading && (
          <div className="flex flex-col items-center justify-center py-20 opacity-20">
            <i className="fa-solid fa-map-marked-alt text-8xl mb-4"></i>
            <p className="font-black uppercase tracking-widest text-sm">Navigatie Intelligence</p>
          </div>
        )}

        {loading && (
          <div className="animate-pulse space-y-4">
            <div className="h-32 bg-slate-900 rounded-3xl"></div>
            <div className="h-20 bg-slate-900 rounded-3xl w-2/3"></div>
          </div>
        )}

        {result && (
          <div className="bg-slate-900 border border-white/10 rounded-3xl p-8 space-y-6">
            <div className="prose prose-invert max-w-none text-slate-300 leading-relaxed font-medium">
              {result.text}
            </div>
            
            {result.sources && (
              <div className="pt-6 border-t border-white/5 space-y-3">
                <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Bronnen & Locaties</h4>
                <div className="flex flex-wrap gap-3">
                  {result.sources.map((chunk: any, i: number) => (
                    <React.Fragment key={i}>
                      {/* Mandatorily extract and display URLs from groundingChunks (Maps and Web) */}
                      {chunk.maps && (
                        <a 
                          href={chunk.maps.uri} 
                          target="_blank" 
                          rel="noreferrer"
                          className="bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl px-4 py-2 text-xs font-bold flex items-center gap-2 transition-colors"
                        >
                          <i className="fa-solid fa-location-arrow text-cyan-500"></i>
                          {chunk.maps.title || "Kaart bekijken"}
                        </a>
                      )}
                      {chunk.web && (
                        <a 
                          href={chunk.web.uri} 
                          target="_blank" 
                          rel="noreferrer"
                          className="bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl px-4 py-2 text-xs font-bold flex items-center gap-2 transition-colors"
                        >
                          <i className="fa-solid fa-globe text-indigo-400"></i>
                          {chunk.web.title || "Website bekijken"}
                        </a>
                      )}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default NavigationSearch;
