'use strict';
(function (root) {
    const validValue = value => value != null && Number.isFinite(Number(value));
    function pointsFor(config) {
        return config.samples.map((sample,index) => ({t:Number(sample?.t),index}))
            .filter(point => Number.isFinite(point.t) && point.t >= config.start && point.t <= config.end && config.tracks.some(track => validValue(track.values[point.index])))
            .sort((a,b) => a.t-b.t);
    }
    function nearestPoint(points, timestamp, tolerance = Infinity) {
        if (!points.length) return null;
        let left = 0, right = points.length;
        while (left < right) {
            const middle = (left+right) >> 1;
            if (points[middle].t < timestamp) left = middle+1; else right = middle;
        }
        const before = points[Math.max(0,left-1)], after = points[Math.min(left,points.length-1)];
        const selected = Math.abs(before.t-timestamp) <= Math.abs(after.t-timestamp) ? before : after;
        return Math.abs(selected.t-timestamp) <= tolerance ? selected : null;
    }
    function attach(svg, config) {
        const wrap = svg.closest('.chart-wrap');
        if (!wrap) return;
        let state = svg._nexoTooltip;
        if (!state) {
            let tip = wrap.querySelector('.chart-tip');
            if (!tip) { tip = document.createElement('div'); tip.className='chart-tip'; wrap.appendChild(tip); }
            tip.id = `chart-tooltip-${svg.dataset.chart}`;
            tip.setAttribute('role','tooltip');
            tip.setAttribute('aria-hidden','true');
            svg.setAttribute('tabindex','0');
            svg.setAttribute('aria-describedby',tip.id);
            state = svg._nexoTooltip = {tip,config:null,points:[],pointer:null,selectedTime:null};
            const clearMarks = () => svg.querySelectorAll('[data-chart-hover]').forEach(node=>node.remove());
            state.hide = () => {
                state.pointer=null; state.selectedTime=null;
                tip.style.display='none'; tip.setAttribute('aria-hidden','true'); clearMarks();
            };
            state.show = point => {
                clearMarks();
                if (!point) { tip.style.display='none'; tip.setAttribute('aria-hidden','true'); state.selectedTime=null; return; }
                const c=state.config, index=point.index, span=c.end-c.start;
                const x=c.pad.left+(span ? (point.t-c.start)/span : 0.5)*(c.w-c.pad.left-c.pad.right);
                const bottom=c.h-c.pad.bottom, plotH=bottom-c.pad.top;
                const make = (name,attrs) => {
                    const node=document.createElementNS('http://www.w3.org/2000/svg',name);
                    Object.entries({...attrs,'data-chart-hover':'true','pointer-events':'none'}).forEach(([key,value])=>node.setAttribute(key,String(value)));
                    svg.appendChild(node);
                };
                tip.replaceChildren();
                const time=document.createElement('div'); time.className='tt';
                time.textContent=new Intl.DateTimeFormat('es-CO',{...(span>86400000?{day:'numeric',month:'short'}:{}),hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(point.t));
                tip.appendChild(time);
                make('line',{x1:x,x2:x,y1:c.pad.top,y2:bottom,class:'chart-cross'});
                let highest=bottom;
                c.tracks.forEach((track,i)=>{
                    const value=track.values[index];
                    const row=document.createElement('div');
                    row.textContent=`${track.label || `Serie ${i+1}`}: ${validValue(value) ? new Intl.NumberFormat('es-CO',{maximumFractionDigits:2}).format(Number(value))+' '+c.unit : 'Sin datos'}`;
                    tip.appendChild(row);
                    if (!validValue(value)) return;
                    const y=bottom-Math.max(0,Math.min(c.max,Number(value)))/c.max*plotH;
                    highest=Math.min(highest,y);
                    make('circle',{cx:x,cy:y,r:4,fill:track.color,stroke:'var(--surface-solid)','stroke-width':2});
                });
                tip.style.display='block'; tip.setAttribute('aria-hidden','false'); state.selectedTime=point.t;
                const rect=svg.getBoundingClientRect(), parent=wrap.getBoundingClientRect();
                const offsetX=rect.left-parent.left+x/c.w*rect.width;
                const offsetY=rect.top-parent.top+highest/c.h*rect.height;
                tip.style.left=Math.max(0,Math.min(parent.width-tip.offsetWidth,offsetX+12))+'px';
                tip.style.top=Math.max(0,offsetY-tip.offsetHeight-10)+'px';
            };
            state.move = pointer => {
                const c=state.config, rect=svg.getBoundingClientRect();
                if (!rect.width || !rect.height) return state.hide();
                const x=(pointer.x-rect.left)/rect.width*c.w, y=(pointer.y-rect.top)/rect.height*c.h;
                if (x<c.pad.left || x>c.w-c.pad.right || y<c.pad.top || y>c.h-c.pad.bottom) return state.hide();
                state.pointer=pointer;
                const timestamp=c.start+(x-c.pad.left)/(c.w-c.pad.left-c.pad.right)*(c.end-c.start);
                state.show(nearestPoint(state.points,timestamp,Math.max(120000,(c.end-c.start)/399*3)));
            };
            svg.addEventListener('pointermove',event=>state.move({x:event.clientX,y:event.clientY}));
            svg.addEventListener('pointerdown',event=>state.move({x:event.clientX,y:event.clientY}));
            svg.addEventListener('pointerleave',()=>state.hide());
            svg.addEventListener('pointercancel',()=>state.hide());
            svg.addEventListener('blur',()=>state.hide());
            svg.addEventListener('keydown',event=>{
                if (event.key==='Escape') return state.hide();
                if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key) || !state.points.length) return;
                event.preventDefault(); state.pointer=null;
                let index=state.points.findIndex(point=>point.t===state.selectedTime);
                if (index<0) index=event.key==='ArrowRight'? -1 : state.points.length;
                index=event.key==='Home'?0:event.key==='End'?state.points.length-1:index+(event.key==='ArrowLeft'?-1:1);
                state.show(state.points[Math.max(0,Math.min(state.points.length-1,index))]);
            });
        }
        state.config=config;
        state.points=pointsFor(config);
        if (state.pointer) state.move(state.pointer);
        else if (state.selectedTime!==null) state.show(nearestPoint(state.points,state.selectedTime));
    }
    const api={attach,pointsFor,nearestPoint};
    if (typeof module!=='undefined' && module.exports) module.exports=api;
    else root.NexoChartTooltip=api;
})(typeof window!=='undefined'?window:globalThis);
