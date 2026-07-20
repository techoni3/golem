import{$ as O,B as S,E as R,M as k,N as E,P as w,R as I,U as F,b as _,et as D,g as l,rt as P}from"./src-SharrJEw.js";import{r as y}from"./chunk-O4NI6UNU-CBbM2qD-.js";import{t as G}from"./chunk-4BMEZGHF-CtAPLBVZ.js";import{t as z}from"./chunk-7B677QYD-BdaaWx5Y.js";import{t as B}from"./mermaid-parser.core-DGoWkEhh.js";var h={showLegend:!0,ticks:5,max:null,min:0,graticule:"circle"},C={axes:[],curves:[],options:h},g=structuredClone(C),W=R.radar,H=l(()=>y({...W,...w().radar}),"getConfig"),b=l(()=>g.axes,"getAxes"),j=l(()=>g.curves,"getCurves"),N=l(()=>g.options,"getOptions"),U=l(a=>{g.axes=a.map(t=>({name:t.name,label:t.label??t.name}))},"setAxes"),V=l(a=>{g.curves=a.map(t=>({name:t.name,label:t.label??t.name,entries:X(t.entries)}))},"setCurves"),X=l(a=>{if(a[0].axis==null)return a.map(e=>e.value);const t=b();if(t.length===0)throw new Error("Axes must be populated before curves for reference entries");return t.map(e=>{const r=a.find(s=>s.axis?.$refText===e.name);if(r===void 0)throw new Error("Missing entry for axis "+e.label);return r.value})},"computeCurveEntries"),x={getAxes:b,getCurves:j,getOptions:N,setAxes:U,setCurves:V,setOptions:l(a=>{const t=a.reduce((e,r)=>(e[r.name]=r,e),{});g.options={showLegend:t.showLegend?.value??h.showLegend,ticks:t.ticks?.value??h.ticks,max:t.max?.value??h.max,min:t.min?.value??h.min,graticule:t.graticule?.value??h.graticule}},"setOptions"),getConfig:H,clear:l(()=>{_(),g=structuredClone(C)},"clear"),setAccTitle:D,getAccTitle:E,setDiagramTitle:P,getDiagramTitle:I,getAccDescription:k,setAccDescription:O},Y=l(a=>{G(a,x);const{axes:t,curves:e,options:r}=a;x.setAxes(t),x.setCurves(e),x.setOptions(r)},"populate"),Z={parse:l(async a=>{const t=await B("radar",a);F.debug(t),Y(t)},"parse")},q=l((a,t,e,r)=>{const s=r.db,o=s.getAxes(),i=s.getCurves(),n=s.getOptions(),c=s.getConfig(),u=s.getDiagramTitle(),d=J(z(t),c),p=n.max??Math.max(...i.map($=>Math.max(...$.entries))),m=n.min,v=Math.min(c.width,c.height)/2;K(d,o,v,n.ticks,n.graticule),Q(d,o,v,c),M(d,o,i,m,p,n.graticule,c),T(d,i,n.showLegend,c),d.append("text").attr("class","radarTitle").text(u).attr("x",0).attr("y",-c.height/2-c.marginTop)},"draw"),J=l((a,t)=>{const e=t.width+t.marginLeft+t.marginRight,r=t.height+t.marginTop+t.marginBottom,s={x:t.marginLeft+t.width/2,y:t.marginTop+t.height/2};return a.attr("viewbox",`0 0 ${e} ${r}`).attr("width",e).attr("height",r),a.append("g").attr("transform",`translate(${s.x}, ${s.y})`)},"drawFrame"),K=l((a,t,e,r,s)=>{if(s==="circle")for(let o=0;o<r;o++){const i=e*(o+1)/r;a.append("circle").attr("r",i).attr("class","radarGraticule")}else if(s==="polygon"){const o=t.length;for(let i=0;i<r;i++){const n=e*(i+1)/r,c=t.map((u,d)=>{const p=2*d*Math.PI/o-Math.PI/2;return`${n*Math.cos(p)},${n*Math.sin(p)}`}).join(" ");a.append("polygon").attr("points",c).attr("class","radarGraticule")}}},"drawGraticule"),Q=l((a,t,e,r)=>{const s=t.length;for(let o=0;o<s;o++){const i=t[o].label,n=2*o*Math.PI/s-Math.PI/2;a.append("line").attr("x1",0).attr("y1",0).attr("x2",e*r.axisScaleFactor*Math.cos(n)).attr("y2",e*r.axisScaleFactor*Math.sin(n)).attr("class","radarAxisLine"),a.append("text").text(i).attr("x",e*r.axisLabelFactor*Math.cos(n)).attr("y",e*r.axisLabelFactor*Math.sin(n)).attr("class","radarAxisLabel")}},"drawAxes");function M(a,t,e,r,s,o,i){const n=t.length,c=Math.min(i.width,i.height)/2;e.forEach((u,d)=>{if(u.entries.length!==n)return;const p=u.entries.map((m,v)=>{const $=2*Math.PI*v/n-Math.PI/2,f=A(m,r,s,c);return{x:f*Math.cos($),y:f*Math.sin($)}});o==="circle"?a.append("path").attr("d",L(p,i.curveTension)).attr("class",`radarCurve-${d}`):o==="polygon"&&a.append("polygon").attr("points",p.map(m=>`${m.x},${m.y}`).join(" ")).attr("class",`radarCurve-${d}`)})}l(M,"drawCurves");function A(a,t,e,r){return r*(Math.min(Math.max(a,t),e)-t)/(e-t)}l(A,"relativeRadius");function L(a,t){const e=a.length;let r=`M${a[0].x},${a[0].y}`;for(let s=0;s<e;s++){const o=a[(s-1+e)%e],i=a[s],n=a[(s+1)%e],c=a[(s+2)%e],u={x:i.x+(n.x-o.x)*t,y:i.y+(n.y-o.y)*t},d={x:n.x-(c.x-i.x)*t,y:n.y-(c.y-i.y)*t};r+=` C${u.x},${u.y} ${d.x},${d.y} ${n.x},${n.y}`}return`${r} Z`}l(L,"closedRoundCurve");function T(a,t,e,r){if(!e)return;const s=(r.width/2+r.marginRight)*3/4,o=-(r.height/2+r.marginTop)*3/4,i=20;t.forEach((n,c)=>{const u=a.append("g").attr("transform",`translate(${s}, ${o+c*i})`);u.append("rect").attr("width",12).attr("height",12).attr("class",`radarLegendBox-${c}`),u.append("text").attr("x",16).attr("y",0).attr("class","radarLegendText").text(n.label)})}l(T,"drawLegend");var tt={draw:q},et=l((a,t)=>{let e="";for(let r=0;r<a.THEME_COLOR_LIMIT;r++){const s=a[`cScale${r}`];e+=`
		.radarCurve-${r} {
			color: ${s};
			fill: ${s};
			fill-opacity: ${t.curveOpacity};
			stroke: ${s};
			stroke-width: ${t.curveStrokeWidth};
		}
		.radarLegendBox-${r} {
			fill: ${s};
			fill-opacity: ${t.curveOpacity};
			stroke: ${s};
		}
		`}return e},"genIndexStyles"),at=l(a=>{const t=y(S(),w().themeVariables);return{themeVariables:t,radarOptions:y(t.radar,a)}},"buildRadarStyleOptions"),lt={parser:Z,db:x,renderer:tt,styles:l(({radar:a}={})=>{const{themeVariables:t,radarOptions:e}=at(a);return`
	.radarTitle {
		font-size: ${t.fontSize};
		color: ${t.titleColor};
		dominant-baseline: hanging;
		text-anchor: middle;
	}
	.radarAxisLine {
		stroke: ${e.axisColor};
		stroke-width: ${e.axisStrokeWidth};
	}
	.radarAxisLabel {
		dominant-baseline: middle;
		text-anchor: middle;
		font-size: ${e.axisLabelFontSize}px;
		color: ${e.axisColor};
	}
	.radarGraticule {
		fill: ${e.graticuleColor};
		fill-opacity: ${e.graticuleOpacity};
		stroke: ${e.graticuleColor};
		stroke-width: ${e.graticuleStrokeWidth};
	}
	.radarLegendText {
		text-anchor: start;
		font-size: ${e.legendFontSize}px;
		dominant-baseline: hanging;
	}
	${et(t,e)}
	`},"styles")};export{lt as diagram};
