// Dock Board — Plan B (local data.js polling)
// Clean late logic + skip empties; MAX Late = 2; MAX Up Next = 3

const STATE = { data: null, lastFetched: null };

const DATA_JS_PATH = 'data.js';   // local file Power Automate overwrites
const REFRESH_MS   = 30000;       // poll every 30s

// Business rules
const MAX_DOCK_DURATION_MIN = 30; // auto-clear after 30 min on dock
const LATE_GRACE_MIN        = 10; // minutes past sched_depart to count as late
const MAX_GLOBAL_NEXT       = 3;  // cap Up Next
const MAX_GLOBAL_LATE       = 4;  // cap Late  (<< changed to 2)

// Blacklist only affects GLOBAL panels (Up Next / Late)
const BLACKLIST_CARRIERS = [
 "TRESCAL ( Monday & Thursday )",
 "TRADINCO ( Wednesday )",
 "VWR ( Wednesday )",
 "SIMAC ( Unplanned )",
 "Free Dock",
 "Supplier" // rows that look like headers
];

// ---------- helpers ----------
const hasCarrier = (r) => !!(r && r.carrier && r.carrier.trim().length);
function isBlacklistedGlobal(r){
 // If a dock is assigned, allow it (so dock panels can still show it)
 if (r.dock && String(r.dock).trim() !== "") return false;
 const c = (r.carrier || "").trim().toLowerCase();
 return BLACKLIST_CARRIERS.some(b => c === b.toLowerCase());
}

function fmtClock(d=new Date()){
 const p = n => String(n).padStart(2,'0');
 return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function parseHHMM(hhmm){
 if(!hhmm) return null;
 const parts = hhmm.split(':');
 if (parts.length < 2) return null;
 const H = Number(parts[0]), M = Number(parts[1]);
 if(Number.isNaN(H) || Number.isNaN(M)) return null;
 const now = new Date();
 return new Date(now.getFullYear(), now.getMonth(), now.getDate(), H||0, M||0, 0, 0);
}
function minutesBetween(a, b){ return Math.round((a.getTime() - b.getTime())/60000); }

// ---------- classifiers ----------
function classifyDockNow(items, dock){
 const now = new Date();
 const rel = (items || []).filter(r => String(r.dock) === String(dock));
 const t  = s => s ? parseHHMM(s) : null;

 // choose the latest actual_start still considered "on dock"
 const nowCandidates = rel.filter(r => {
   const aStart  = t(r.actual_start);
   if (!aStart) return false;                      // must have actual start
   const aDepart = t(r.actual_depart);
   if (aDepart && now >= aDepart) return false;    // departed -> not on dock
   if (minutesBetween(now, aStart) >= MAX_DOCK_DURATION_MIN) return false; // aged out
   return true;
 }).sort((a,b) => (t(b.actual_start)||0) - (t(a.actual_start)||0));

 return nowCandidates.length ? [nowCandidates[0]] : [];
}

function computeGlobalNext(items){
 const now = new Date();
 const t = s => s ? parseHHMM(s) : null;

 const next = (items||[])
   .filter(r => hasCarrier(r) && !isBlacklistedGlobal(r))
   .filter(r => {
     // Up Next must NOT be on dock yet
     if (t(r.actual_start)) return false;

     const ss = t(r.sched_start);
     if (!ss) return false;              // need a start time to schedule

     const sd = t(r.sched_depart);
     const dueNow = (ss <= now) && (!sd || now < sd); // in its scheduled window
     return dueNow || (now < ss);         // current or upcoming
   })
   .map(r => {
     const ss = t(r.sched_start);
     const sd = t(r.sched_depart);
     r._due_now = (ss && ss <= now && (!sd || now < sd));
     return r;
   })
   .sort((a,b) => {
     if (a._due_now && !b._due_now) return -1;
     if (!a._due_now && b._due_now) return 1;
     return (t(a.sched_start) || 0) - (t(b.sched_start) || 0);
   });

 return next.slice(0, MAX_GLOBAL_NEXT);
}

function computeGlobalLate(items){
 const now = new Date();
 const t = s => s ? parseHHMM(s) : null;

 const late = (items||[])
   .filter(r => hasCarrier(r) && !isBlacklistedGlobal(r))
   .filter(r => {
     // If it's actually docked, it is NOT late (your request)
     if (t(r.actual_start)) return false;

     const sd = t(r.sched_depart);
     if (!sd) return false;                  // no scheduled depart -> can't be "late"
     const minsLate = minutesBetween(now, sd);
     r._late_mins = minsLate;
     return minsLate > LATE_GRACE_MIN;       // late beyond grace
   })
   // show most recently missed first
   .sort((a,b) => (t(b.sched_depart)||0) - (t(a.sched_depart)||0))
   .slice(0, MAX_GLOBAL_LATE);

 return late;
}

// ---------- rendering ----------
function el(tag, cls, html){
 const e = document.createElement(tag);
 if(cls) e.className = cls;
 if(html !== undefined) e.innerHTML = html;
 return e;
}

function renderGlobalNext(items){
 const ul = document.getElementById('global-next');
 ul.innerHTML = '';
 if(items.length === 0){
   ul.appendChild(el('li','item', `<div class="time">—</div><div class="title">No upcoming entries</div><div class="docktag"></div>`));
   return;
 }
 items.forEach(r => {
   const li = el('li','item' + (r._due_now ? ' due' : ''), '');
   li.innerHTML = `
     <div class="time">${r.sched_start || '--:--'}</div>
     <div class="title">${(r.carrier||'').toUpperCase()}</div>
     <div class="docktag">${r.dock ? ('Dock ' + r.dock) : 'No dock yet'}</div>
   `;
   ul.appendChild(li);
 });
}

function renderGlobalLate(items){
 const ul = document.getElementById('global-late');
 ul.innerHTML = '';
 if(items.length === 0){
   ul.appendChild(el('li','item', `<div class="time">—</div><div class="title">No late entries</div>`));
   return;
 }
 items.forEach(r => {
   const li = el('li','item');
   li.innerHTML = `
     <div class="time">${r.sched_depart || '--:--'}</div>
     <div class="title">⚠️ ${(r.carrier||'').toUpperCase()} — LATE BY ${r._late_mins} MIN</div>
   `;
   ul.appendChild(li);
 });
}

function renderDockNow(targetId, items){
 const ul = document.getElementById(targetId);
 ul.innerHTML = '';
 if(items.length === 0){
   ul.appendChild(el('li','item', `<div class="time">—</div><div class="title">No current truck</div>`));
   return;
 }
 const r = items[0];
 const li = el('li','item');
 li.innerHTML = `
   <div class="time">${r.actual_start || r.sched_start || '--:--'}</div>
   <div class="title">${(r.carrier||'').toUpperCase()}</div>
 `;
 ul.appendChild(li);
}

function render(){
 if(!STATE.data) return;
 const items = STATE.data.items || [];
 renderGlobalNext(computeGlobalNext(items));
 renderGlobalLate(computeGlobalLate(items));
 renderDockNow('now-10', classifyDockNow(items, '10'));
 renderDockNow('now-11', classifyDockNow(items, '11'));
 const status = document.getElementById('status');
 if(status) status.textContent = STATE.lastFetched ? `Last update: ${new Date(STATE.lastFetched).toLocaleTimeString()}` : 'Loaded';
}

// ---------- local data.js polling (works for file:// and http:// when not cached) ----------
function loadDataFromScript(){
 return new Promise((resolve, reject) => {
   const prev = document.getElementById('datajs-loader');
   if (prev) prev.remove();

   const script = document.createElement('script');
   script.id = 'datajs-loader';
   script.async = true;
   script.src = `${DATA_JS_PATH}?ts=` + Date.now(); // cache-bust when served over http
   script.onload = () => {
     try {
       if (!window.DOCK_DATA) throw new Error('DOCK_DATA not defined by data.js');
       resolve(window.DOCK_DATA);
     } catch (e) {
       reject(e);
     }
   };
   script.onerror = () => reject(new Error('Failed to load data.js'));
   document.body.appendChild(script);
 });
}

async function refresh(){
 try {
   const data = await loadDataFromScript();
   STATE.data = data;
   STATE.lastFetched = Date.now();
   render();
 } catch (e) {
   console.warn('data.js load failed:', e);
 }
}

// Hard reload fallback for file:// (some browsers ignore ?ts= on local files)
const IS_FILE_PROTOCOL = location.protocol === 'file:';
const HARD_RELOAD_MS   = 60000; // full page refresh every 60s on file://

function tickClock(){
 const el = document.getElementById('clock');
 if(el) el.textContent = fmtClock();
}

window.addEventListener('DOMContentLoaded', () => {
 tickClock();
 setInterval(tickClock, 1000);

 if (window.DOCK_DATA) {
   STATE.data = window.DOCK_DATA;
   STATE.lastFetched = Date.now();
   render();
 }

 refresh();
 setInterval(refresh, REFRESH_MS);

 if (IS_FILE_PROTOCOL) {
   setInterval(() => location.reload(), HARD_RELOAD_MS);
 }
});