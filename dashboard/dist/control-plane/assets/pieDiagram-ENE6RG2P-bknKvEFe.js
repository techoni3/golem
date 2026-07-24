import{n as d}from"./chunk-Y2CYZVJY-CrVYBJys.js";import{m as B}from"./src-X8OiGRmM.js";import{H as rt,K as nt,U as it,a as ot,c as st,f as lt,v as ct,w as ut,x as dt,y as gt}from"./chunk-WYO6CB5R-BZdKSvcn.js";import{t as ft}from"./ordinal-BWIqZ7B5.js";import{n as C}from"./path-B-366Oci.js";import{m as G}from"./dist-DdEfsKdK.js";import{t as Z}from"./arc-CiL4VC-h.js";import{t as pt}from"./array-DbBWA3E_.js";import{i as ht,p as mt}from"./chunk-ICXQ74PX-rS9FKHRn.js";import{t as vt}from"./chunk-VAUOI2AC-DwFqIbWw.js";import{t as xt}from"./chunk-JWPE2WC7-CE3kxLOT.js";import{n as yt}from"./mermaid-parser.core-Bk6Q2qIu.js";function St(t,r){return r<t?-1:r>t?1:r>=t?0:NaN}function wt(t){return t}function At(){var t=wt,r=St,v=null,l=C(0),c=C(G),$=C(0);function n(e){var o,g=(e=pt(e)).length,x,D,w=0,f=new Array(g),i=new Array(g),A=+l.apply(this,arguments),k=Math.min(G,Math.max(-G,c.apply(this,arguments)-A)),T,M=Math.min(Math.abs(k)/g,$.apply(this,arguments)),p=M*(k<0?-1:1),y;for(o=0;o<g;++o)(y=i[f[o]=o]=+t(e[o],o,e))>0&&(w+=y);for(r!=null?f.sort(function(_,h){return r(i[_],i[h])}):v!=null&&f.sort(function(_,h){return v(e[_],e[h])}),o=0,D=w?(k-g*p)/w:0;o<g;++o,A=T)x=f[o],y=i[x],T=A+(y>0?y*D:0)+p,i[x]={data:e[x],index:o,value:y,startAngle:A,endAngle:T,padAngle:M};return i}return n.value=function(e){return arguments.length?(t=typeof e=="function"?e:C(+e),n):t},n.sortValues=function(e){return arguments.length?(r=e,v=null,n):r},n.sort=function(e){return arguments.length?(v=e,r=null,n):v},n.startAngle=function(e){return arguments.length?(l=typeof e=="function"?e:C(+e),n):l},n.endAngle=function(e){return arguments.length?(c=typeof e=="function"?e:C(+e),n):c},n.padAngle=function(e){return arguments.length?($=typeof e=="function"?e:C(+e),n):$},n}var q=lt.pie,U={sections:new Map,showData:!1,config:q},L=U.sections,I=U.showData,Ct=structuredClone(q),J={getConfig:d(()=>structuredClone(Ct),"getConfig"),clear:d(()=>{L=new Map,I=U.showData,ot()},"clear"),setDiagramTitle:nt,getDiagramTitle:ut,setAccTitle:it,getAccTitle:gt,setAccDescription:rt,getAccDescription:ct,addSection:d(({label:t,value:r})=>{if(r<0)throw new Error(`"${t}" has invalid value: ${r}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);L.has(t)||(L.set(t,r),B.debug(`added new section: ${t}, with value: ${r}`))},"addSection"),getSections:d(()=>L,"getSections"),setShowData:d(t=>{I=t},"setShowData"),getShowData:d(()=>I,"getShowData")},$t=d((t,r)=>{xt(t,r),r.setShowData(t.showData),t.sections.map(r.addSection)},"populateDb"),Dt={parse:d(async t=>{const r=await yt("pie",t);B.debug(r),$t(r,J)},"parse")},Tt=d(t=>`
  .pieCircle{
    stroke: ${t.pieStrokeColor};
    stroke-width : ${t.pieStrokeWidth};
    opacity : ${t.pieOpacity};
  }
  .pieCircle.highlighted{
    scale: 1.05;
    opacity: 1;
  }
  .pieCircle.highlightedOnHover:hover{
    transition-duration: 250ms;
    scale: 1.05;
    opacity: 1;
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
`,"getStyles"),bt=d(t=>{const r=[...t.values()].reduce((l,c)=>l+c,0),v=[...t.entries()].map(([l,c])=>({label:l,value:c})).filter(l=>l.value/r*100>=1);return At().value(l=>l.value).sort(null)(v)},"createPieArcs"),Rt={parser:Dt,db:J,renderer:{draw:d((t,r,v,l)=>{B.debug(`rendering pie chart
`+t);const c=l.db,$=dt(),n=ht(c.getConfig(),$.pie),e=40,o=18,g=4,x=450,D=x,w=vt(r),f=w.append("g");f.attr("transform","translate(225,225)");const{themeVariables:i}=$;let[A]=mt(i.pieOuterStrokeWidth);A??=2;const k=n.legendPosition,T=n.textPosition,M=n.donutHole>0&&n.donutHole<=.9?n.donutHole:0,p=Math.min(D,x)/2-e,y=Z().innerRadius(M*p).outerRadius(p),_=Z().innerRadius(p*T).outerRadius(p*T),h=f.append("g");h.append("circle").attr("cx",0).attr("cy",0).attr("r",p+A/2).attr("class","pieOuterCircle");const z=c.getSections(),Q=bt(z),Y=[i.pie1,i.pie2,i.pie3,i.pie4,i.pie5,i.pie6,i.pie7,i.pie8,i.pie9,i.pie10,i.pie11,i.pie12];let W=0;z.forEach(a=>{W+=a});const V=Q.filter(a=>(a.data.value/W*100).toFixed(0)!=="0"),F=ft(Y).domain([...z.keys()]);h.selectAll("mySlices").data(V).enter().append("path").attr("d",y).attr("fill",a=>F(a.data.label)).attr("class",a=>{let s="pieCircle";return n.highlightSlice==="hover"?s+=" highlightedOnHover":n.highlightSlice===a.data.label&&(s+=" highlighted"),s}),h.selectAll("mySlices").data(V).enter().append("text").text(a=>(a.data.value/W*100).toFixed(0)+"%").attr("transform",a=>"translate("+_.centroid(a)+")").style("text-anchor","middle").attr("class","slice");const tt=f.append("text").text(c.getDiagramTitle()).attr("x",0).attr("y",-400/2).attr("class","pieTitleText"),E=[...z.entries()].map(([a,s])=>({label:a,value:s})),S=f.selectAll(".legend").data(E).enter().append("g").attr("class","legend");S.append("rect").attr("width",o).attr("height",o).style("fill",a=>F(a.label)).style("stroke",a=>F(a.label)),S.append("text").attr("x",22).attr("y",o-g).text(a=>c.getShowData()?`${a.label} [${a.value}]`:a.label);const b=Math.max(...S.selectAll("text").nodes().map(a=>a?.getBoundingClientRect().width??0));let H=x,N=490;const u=22,O=E.length*u;switch(k){case"center":S.attr("transform",(a,s)=>{const m=u*E.length/2,P=-b/2-22,R=s*u-m;return"translate("+P+","+R+")"});break;case"top":H+=O,S.attr("transform",(a,s)=>{const m=p;return`translate(${-b/2-22}, ${s*u-m})`}),h.attr("transform",()=>`translate(0, ${O+u})`);break;case"bottom":H+=O,S.attr("transform",(a,s)=>{const m=-185-u,P=-b/2-22,R=s*u-m;return"translate("+P+","+R+")"});break;case"left":N+=22+b,S.attr("transform",(a,s)=>{const m=u*E.length/2;return"translate(-207,"+(s*u-m)+")"}),h.attr("transform",()=>`translate(${b+o+g}, 0)`);break;default:N+=22+b,S.attr("transform",(a,s)=>{const m=u*E.length/2;return"translate(216,"+(s*u-m)+")"});break}const j=tt.node()?.getBoundingClientRect().width??0,et=D/2-j/2,at=D/2+j/2,K=Math.min(0,et),X=Math.max(N,at)-K;w.attr("viewBox",`${K} 0 ${X} ${H}`),st(w,H,X,n.useMaxWidth)},"draw")},styles:Tt};export{Rt as diagram};
