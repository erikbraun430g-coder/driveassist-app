
import React from 'react';

const Dashboard: React.FC<{location: any}> = ({ location }) => {
  return (
    <div className="h-full grid grid-cols-1 md:grid-cols-3 gap-6 animate-in fade-in duration-700">
      {/* Main Speedometer / Visualizer */}
      <div className="md:col-span-2 bg-slate-900/50 rounded-[2.5rem] border border-white/5 p-8 flex flex-col items-center justify-center relative overflow-hidden group">
        <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/10 to-transparent opacity-30"></div>
        
        <div className="relative z-10 flex flex-col items-center">
          <span className="text-sm font-black text-cyan-500 uppercase tracking-[0.3em] mb-2">Snelheid</span>
          <div className="text-[120px] font-black leading-none text-white tracking-tighter">
            85<span className="text-3xl text-slate-500 ml-2">km/h</span>
          </div>
          <div className="mt-8 flex gap-8">
            <div className="text-center">
              <div className="text-xs font-bold text-slate-500 uppercase mb-1">Verbruik</div>
              <div className="text-xl font-bold">14.2 <span className="text-[10px] opacity-50">kWh</span></div>
            </div>
            <div className="w-px h-10 bg-white/10"></div>
            <div className="text-center">
              <div className="text-xs font-bold text-slate-500 uppercase mb-1">Bereik</div>
              <div className="text-xl font-bold text-emerald-400">342 <span className="text-[10px] opacity-50">km</span></div>
            </div>
          </div>
        </div>

        {/* Decorative Grid */}
        <div className="absolute bottom-0 w-full h-32 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-cyan-500/10 via-transparent to-transparent opacity-50"></div>
      </div>

      {/* Side Widgets */}
      <div className="flex flex-col gap-6">
        <div className="flex-1 bg-slate-900/50 rounded-[2.5rem] border border-white/5 p-6">
          <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
            <i className="fa-solid fa-cloud-sun text-amber-400"></i> Weer op Bestemming
          </h3>
          <div className="flex items-center justify-between">
            <div className="text-3xl font-bold">18°C</div>
            <div className="text-right text-xs text-slate-400 font-medium">Licht bewolkt<br/>Antwerpen, BE</div>
          </div>
        </div>

        <div className="flex-1 bg-indigo-600 rounded-[2.5rem] p-6 shadow-xl shadow-indigo-900/20 relative overflow-hidden">
          <i className="fa-solid fa-route absolute -right-4 -bottom-4 text-8xl text-black/10"></i>
          <h3 className="text-[10px] font-black text-white/60 uppercase tracking-widest mb-4">Volgende Actie</h3>
          <div className="text-xl font-bold text-white mb-2">Linksaf over 400m</div>
          <div className="text-sm text-white/80">E19 richting Amsterdam</div>
        </div>

        <div className="flex-1 bg-slate-900/50 rounded-[2.5rem] border border-white/5 p-6">
           <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Systeemstatus</span>
              <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>
           </div>
           <p className="text-xs text-slate-300">Alle sensoren functioneren optimaal. Bandenspanning stabiel.</p>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
