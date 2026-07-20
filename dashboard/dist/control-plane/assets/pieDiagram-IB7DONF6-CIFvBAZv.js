import{$ as I,C as L,E as B,F as U,M as V,N as j,R as Z,U as _,b as q,et as H,g as c,rt as J}from"./src-SharrJEw.js";import{t as K}from"./ordinal-BWIqZ7B5.js";import{n as v}from"./path-B-366Oci.js";import{p as M}from"./math-Pt91xTZE.js";import{t as G}from"./arc-D5TFu92q.js";import{t as Q}from"./array-DbBWA3E_.js";import{f as X,r as Y}from"./chunk-O4NI6UNU-CBbM2qD-.js";import{t as tt}from"./chunk-4BMEZGHF-CtAPLBVZ.js";import{t as et}from"./chunk-7B677QYD-BdaaWx5Y.js";import{t as at}from"./mermaid-parser.core-DGoWkEhh.js";function rt(t,a){return a<t?-1:a>t?1:a>=t?0:NaN}function nt(t){return t}function it(){var t=nt,a=rt,s=null,h=v(0),f=v(M),A=v(0);function n(e){var i,g=(e=Q(e)).length,u,D,S=0,l=new Array(g),r=new Array(g),x=+h.apply(this,arguments),w=Math.min(M,Math.max(-M,f.apply(this,arguments)-x)),m,C=Math.min(Math.abs(w)/g,A.apply(this,arguments)),$=C*(w<0?-1:1),p;for(i=0;i<g;++i)(p=r[l[i]=i]=+t(e[i],i,e))>0&&(S+=p);for(a!=null?l.sort(function(y,d){return a(r[y],r[d])}):s!=null&&l.sort(function(y,d){return s(e[y],e[d])}),i=0,D=S?(w-g*$)/S:0;i<g;++i,x=m)u=l[i],p=r[u],m=x+(p>0?p*D:0)+$,r[u]={data:e[u],index:i,value:p,startAngle:x,endAngle:m,padAngle:C};return r}return n.value=function(e){return arguments.length?(t=typeof e=="function"?e:v(+e),n):t},n.sortValues=function(e){return arguments.length?(a=e,s=null,n):a},n.sort=function(e){return arguments.length?(s=e,a=null,n):s},n.startAngle=function(e){return arguments.length?(h=typeof e=="function"?e:v(+e),n):h},n.endAngle=function(e){return arguments.length?(f=typeof e=="function"?e:v(+e),n):f},n.padAngle=function(e){return arguments.length?(A=typeof e=="function"?e:v(+e),n):A},n}var O=B.pie,F={sections:new Map,showData:!1,config:O},E=F.sections,b=F.showData,st=structuredClone(O),P={getConfig:c(()=>structuredClone(st),"getConfig"),clear:c(()=>{E=new Map,b=F.showData,q()},"clear"),setDiagramTitle:J,getDiagramTitle:Z,setAccTitle:H,getAccTitle:j,setAccDescription:I,getAccDescription:V,addSection:c(({label:t,value:a})=>{E.has(t)||(E.set(t,a),_.debug(`added new section: ${t}, with value: ${a}`))},"addSection"),getSections:c(()=>E,"getSections"),setShowData:c(t=>{b=t},"setShowData"),getShowData:c(()=>b,"getShowData")},ot=c((t,a)=>{tt(t,a),a.setShowData(t.showData),t.sections.map(a.addSection)},"populateDb"),lt={parse:c(async t=>{const a=await at("pie",t);_.debug(a),ot(a,P)},"parse")},ct=c(t=>`
  .pieCircle{
    stroke: ${t.pieStrokeColor};
    stroke-width : ${t.pieStrokeWidth};
    opacity : ${t.pieOpacity};
  }
  .pieOuterCircle{
    stroke: ${t.pieOuterStrokeColor};
    stroke-width: ${t.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${t.pieTitleTextSize};
    fill: ${t.pieTitleTextColor};
    font-family: ${t.fontFamily};
  }
  .slice {
    font-family: ${t.fontFamily};
    fill: ${t.pieSectionTextColor};
    font-size:${t.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${t.pieLegendTextColor};
    font-family: ${t.fontFamily};
    font-size: ${t.pieLegendTextSize};
  }
`,"getStyles"),ut=c(t=>{const a=[...t.entries()].map(s=>({label:s[0],value:s[1]})).sort((s,h)=>h.value-s.value);return it().value(s=>s.value)(a)},"createPieArcs"),At={parser:lt,db:P,renderer:{draw:c((t,a,s,h)=>{_.debug(`rendering pie chart
`+t);const f=h.db,A=U(),n=Y(f.getConfig(),A.pie),e=40,i=18,g=4,u=450,D=u,S=et(a),l=S.append("g");l.attr("transform","translate(225,225)");const{themeVariables:r}=A;let[x]=X(r.pieOuterStrokeWidth);x??=2;const w=n.textPosition,m=Math.min(D,u)/2-e,C=G().innerRadius(0).outerRadius(m),$=G().innerRadius(m*w).outerRadius(m*w);l.append("circle").attr("cx",0).attr("cy",0).attr("r",m+x/2).attr("class","pieOuterCircle");const p=f.getSections(),y=ut(p),d=K([r.pie1,r.pie2,r.pie3,r.pie4,r.pie5,r.pie6,r.pie7,r.pie8,r.pie9,r.pie10,r.pie11,r.pie12]);l.selectAll("mySlices").data(y).enter().append("path").attr("d",C).attr("fill",o=>d(o.data.label)).attr("class","pieCircle");let z=0;p.forEach(o=>{z+=o}),l.selectAll("mySlices").data(y).enter().append("text").text(o=>(o.data.value/z*100).toFixed(0)+"%").attr("transform",o=>"translate("+$.centroid(o)+")").style("text-anchor","middle").attr("class","slice"),l.append("text").text(f.getDiagramTitle()).attr("x",0).attr("y",-400/2).attr("class","pieTitleText");const k=l.selectAll(".legend").data(d.domain()).enter().append("g").attr("class","legend").attr("transform",(o,T)=>{const W=22*d.domain().length/2;return"translate(216,"+(T*22-W)+")"});k.append("rect").attr("width",i).attr("height",i).style("fill",d).style("stroke",d),k.data(y).append("text").attr("x",22).attr("y",i-g).text(o=>{const{label:T,value:R}=o.data;return f.getShowData()?`${T} [${R}]`:T});const N=512+Math.max(...k.selectAll("text").nodes().map(o=>o?.getBoundingClientRect().width??0));S.attr("viewBox",`0 0 ${N} ${u}`),L(S,u,N,n.useMaxWidth)},"draw")},styles:ct};export{At as diagram};
