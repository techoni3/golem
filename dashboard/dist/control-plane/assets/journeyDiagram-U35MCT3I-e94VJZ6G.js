import{$ as gt,C as mt,F as I,M as xt,N as kt,R as _t,b as bt,et as vt,g as n,p as W,rt as wt}from"./src-SharrJEw.js";import{t as et}from"./arc-D5TFu92q.js";import{a as Tt,i as St,o as lt,t as $t}from"./chunk-D6G4REZN-Dds0NEOg.js";var U=(function(){var t=n(function(r,i,y,l){for(y=y||{},l=r.length;l--;y[r[l]]=i);return y},"o"),e=[6,8,10,11,12,14,16,17,18],a=[1,9],c=[1,10],s=[1,11],o=[1,12],u=[1,13],p=[1,14],d={trace:n(function(){},"trace"),yy:{},symbols_:{error:2,start:3,journey:4,document:5,EOF:6,line:7,SPACE:8,statement:9,NEWLINE:10,title:11,acc_title:12,acc_title_value:13,acc_descr:14,acc_descr_value:15,acc_descr_multiline_value:16,section:17,taskName:18,taskData:19,$accept:0,$end:1},terminals_:{2:"error",4:"journey",6:"EOF",8:"SPACE",10:"NEWLINE",11:"title",12:"acc_title",13:"acc_title_value",14:"acc_descr",15:"acc_descr_value",16:"acc_descr_multiline_value",17:"section",18:"taskName",19:"taskData"},productions_:[0,[3,3],[5,0],[5,2],[7,2],[7,1],[7,1],[7,1],[9,1],[9,2],[9,2],[9,1],[9,1],[9,2]],performAction:n(function(i,y,l,f,g,h,T){var x=h.length-1;switch(g){case 1:return h[x-1];case 2:this.$=[];break;case 3:h[x-1].push(h[x]),this.$=h[x-1];break;case 4:case 5:this.$=h[x];break;case 6:case 7:this.$=[];break;case 8:f.setDiagramTitle(h[x].substr(6)),this.$=h[x].substr(6);break;case 9:this.$=h[x].trim(),f.setAccTitle(this.$);break;case 10:case 11:this.$=h[x].trim(),f.setAccDescription(this.$);break;case 12:f.addSection(h[x].substr(8)),this.$=h[x].substr(8);break;case 13:f.addTask(h[x-1],h[x]),this.$="task";break}},"anonymous"),table:[{3:1,4:[1,2]},{1:[3]},t(e,[2,2],{5:3}),{6:[1,4],7:5,8:[1,6],9:7,10:[1,8],11:a,12:c,14:s,16:o,17:u,18:p},t(e,[2,7],{1:[2,1]}),t(e,[2,3]),{9:15,11:a,12:c,14:s,16:o,17:u,18:p},t(e,[2,5]),t(e,[2,6]),t(e,[2,8]),{13:[1,16]},{15:[1,17]},t(e,[2,11]),t(e,[2,12]),{19:[1,18]},t(e,[2,4]),t(e,[2,9]),t(e,[2,10]),t(e,[2,13])],defaultActions:{},parseError:n(function(i,y){if(y.recoverable)this.trace(i);else{var l=new Error(i);throw l.hash=y,l}},"parseError"),parse:n(function(i){var y=this,l=[0],f=[],g=[null],h=[],T=this.table,x="",L=0,J=0,K=0,yt=2,Q=1,dt=h.slice.call(arguments,1),k=Object.create(this.lexer),M={yy:{}};for(var z in this.yy)Object.prototype.hasOwnProperty.call(this.yy,z)&&(M.yy[z]=this.yy[z]);k.setInput(i,M.yy),M.yy.lexer=k,M.yy.parser=this,typeof k.yylloc>"u"&&(k.yylloc={});var O=k.yylloc;h.push(O);var pt=k.options&&k.options.ranges;typeof M.yy.parseError=="function"?this.parseError=M.yy.parseError:this.parseError=Object.getPrototypeOf(this).parseError;function ft(v){l.length=l.length-2*v,g.length=g.length-v,h.length=h.length-v}n(ft,"popStack");function D(){var v=f.pop()||k.lex()||Q;return typeof v!="number"&&(v instanceof Array&&(f=v,v=f.pop()),v=y.symbols_[v]||v),v}n(D,"lex");for(var _,Y,E,b,q,A={},B,S,tt,N;;){if(E=l[l.length-1],this.defaultActions[E]?b=this.defaultActions[E]:((_===null||typeof _>"u")&&(_=D()),b=T[E]&&T[E][_]),typeof b>"u"||!b.length||!b[0]){var G="";N=[];for(B in T[E])this.terminals_[B]&&B>yt&&N.push("'"+this.terminals_[B]+"'");k.showPosition?G="Parse error on line "+(L+1)+`:
`+k.showPosition()+`
Expecting `+N.join(", ")+", got '"+(this.terminals_[_]||_)+"'":G="Parse error on line "+(L+1)+": Unexpected "+(_==Q?"end of input":"'"+(this.terminals_[_]||_)+"'"),this.parseError(G,{text:k.match,token:this.terminals_[_]||_,line:k.yylineno,loc:O,expected:N})}if(b[0]instanceof Array&&b.length>1)throw new Error("Parse Error: multiple actions possible at state: "+E+", token: "+_);switch(b[0]){case 1:l.push(_),g.push(k.yytext),h.push(k.yylloc),l.push(b[1]),_=null,Y?(_=Y,Y=null):(J=k.yyleng,x=k.yytext,L=k.yylineno,O=k.yylloc,K>0&&K--);break;case 2:if(S=this.productions_[b[1]][1],A.$=g[g.length-S],A._$={first_line:h[h.length-(S||1)].first_line,last_line:h[h.length-1].last_line,first_column:h[h.length-(S||1)].first_column,last_column:h[h.length-1].last_column},pt&&(A._$.range=[h[h.length-(S||1)].range[0],h[h.length-1].range[1]]),q=this.performAction.apply(A,[x,J,L,M.yy,b[1],g,h].concat(dt)),typeof q<"u")return q;S&&(l=l.slice(0,-1*S*2),g=g.slice(0,-1*S),h=h.slice(0,-1*S)),l.push(this.productions_[b[1]][0]),g.push(A.$),h.push(A._$),tt=T[l[l.length-2]][l[l.length-1]],l.push(tt);break;case 3:return!0}}return!0},"parse")};d.lexer=(function(){return{EOF:1,parseError:n(function(i,y){if(this.yy.parser)this.yy.parser.parseError(i,y);else throw new Error(i)},"parseError"),setInput:n(function(r,i){return this.yy=i||this.yy||{},this._input=r,this._more=this._backtrack=this.done=!1,this.yylineno=this.yyleng=0,this.yytext=this.matched=this.match="",this.conditionStack=["INITIAL"],this.yylloc={first_line:1,first_column:0,last_line:1,last_column:0},this.options.ranges&&(this.yylloc.range=[0,0]),this.offset=0,this},"setInput"),input:n(function(){var r=this._input[0];return this.yytext+=r,this.yyleng++,this.offset++,this.match+=r,this.matched+=r,r.match(/(?:\r\n?|\n).*/g)?(this.yylineno++,this.yylloc.last_line++):this.yylloc.last_column++,this.options.ranges&&this.yylloc.range[1]++,this._input=this._input.slice(1),r},"input"),unput:n(function(r){var i=r.length,y=r.split(/(?:\r\n?|\n)/g);this._input=r+this._input,this.yytext=this.yytext.substr(0,this.yytext.length-i),this.offset-=i;var l=this.match.split(/(?:\r\n?|\n)/g);this.match=this.match.substr(0,this.match.length-1),this.matched=this.matched.substr(0,this.matched.length-1),y.length-1&&(this.yylineno-=y.length-1);var f=this.yylloc.range;return this.yylloc={first_line:this.yylloc.first_line,last_line:this.yylineno+1,first_column:this.yylloc.first_column,last_column:y?(y.length===l.length?this.yylloc.first_column:0)+l[l.length-y.length].length-y[0].length:this.yylloc.first_column-i},this.options.ranges&&(this.yylloc.range=[f[0],f[0]+this.yyleng-i]),this.yyleng=this.yytext.length,this},"unput"),more:n(function(){return this._more=!0,this},"more"),reject:n(function(){if(this.options.backtrack_lexer)this._backtrack=!0;else return this.parseError("Lexical error on line "+(this.yylineno+1)+`. You can only invoke reject() in the lexer when the lexer is of the backtracking persuasion (options.backtrack_lexer = true).
`+this.showPosition(),{text:"",token:null,line:this.yylineno});return this},"reject"),less:n(function(r){this.unput(this.match.slice(r))},"less"),pastInput:n(function(){var r=this.matched.substr(0,this.matched.length-this.match.length);return(r.length>20?"...":"")+r.substr(-20).replace(/\n/g,"")},"pastInput"),upcomingInput:n(function(){var r=this.match;return r.length<20&&(r+=this._input.substr(0,20-r.length)),(r.substr(0,20)+(r.length>20?"...":"")).replace(/\n/g,"")},"upcomingInput"),showPosition:n(function(){var r=this.pastInput(),i=new Array(r.length+1).join("-");return r+this.upcomingInput()+`
`+i+"^"},"showPosition"),test_match:n(function(r,i){var y,l,f;if(this.options.backtrack_lexer&&(f={yylineno:this.yylineno,yylloc:{first_line:this.yylloc.first_line,last_line:this.last_line,first_column:this.yylloc.first_column,last_column:this.yylloc.last_column},yytext:this.yytext,match:this.match,matches:this.matches,matched:this.matched,yyleng:this.yyleng,offset:this.offset,_more:this._more,_input:this._input,yy:this.yy,conditionStack:this.conditionStack.slice(0),done:this.done},this.options.ranges&&(f.yylloc.range=this.yylloc.range.slice(0))),l=r[0].match(/(?:\r\n?|\n).*/g),l&&(this.yylineno+=l.length),this.yylloc={first_line:this.yylloc.last_line,last_line:this.yylineno+1,first_column:this.yylloc.last_column,last_column:l?l[l.length-1].length-l[l.length-1].match(/\r?\n?/)[0].length:this.yylloc.last_column+r[0].length},this.yytext+=r[0],this.match+=r[0],this.matches=r,this.yyleng=this.yytext.length,this.options.ranges&&(this.yylloc.range=[this.offset,this.offset+=this.yyleng]),this._more=!1,this._backtrack=!1,this._input=this._input.slice(r[0].length),this.matched+=r[0],y=this.performAction.call(this,this.yy,this,i,this.conditionStack[this.conditionStack.length-1]),this.done&&this._input&&(this.done=!1),y)return y;if(this._backtrack){for(var g in f)this[g]=f[g];return!1}return!1},"test_match"),next:n(function(){if(this.done)return this.EOF;this._input||(this.done=!0);var r,i,y,l;this._more||(this.yytext="",this.match="");for(var f=this._currentRules(),g=0;g<f.length;g++)if(y=this._input.match(this.rules[f[g]]),y&&(!i||y[0].length>i[0].length)){if(i=y,l=g,this.options.backtrack_lexer){if(r=this.test_match(y,f[g]),r!==!1)return r;if(this._backtrack){i=!1;continue}else return!1}else if(!this.options.flex)break}return i?(r=this.test_match(i,f[l]),r!==!1?r:!1):this._input===""?this.EOF:this.parseError("Lexical error on line "+(this.yylineno+1)+`. Unrecognized text.
`+this.showPosition(),{text:"",token:null,line:this.yylineno})},"next"),lex:n(function(){var i=this.next();return i||this.lex()},"lex"),begin:n(function(i){this.conditionStack.push(i)},"begin"),popState:n(function(){return this.conditionStack.length-1>0?this.conditionStack.pop():this.conditionStack[0]},"popState"),_currentRules:n(function(){return this.conditionStack.length&&this.conditionStack[this.conditionStack.length-1]?this.conditions[this.conditionStack[this.conditionStack.length-1]].rules:this.conditions.INITIAL.rules},"_currentRules"),topState:n(function(i){return i=this.conditionStack.length-1-Math.abs(i||0),i>=0?this.conditionStack[i]:"INITIAL"},"topState"),pushState:n(function(i){this.begin(i)},"pushState"),stateStackSize:n(function(){return this.conditionStack.length},"stateStackSize"),options:{"case-insensitive":!0},performAction:n(function(i,y,l,f){switch(l){case 0:break;case 1:break;case 2:return 10;case 3:break;case 4:break;case 5:return 4;case 6:return 11;case 7:return this.begin("acc_title"),12;case 8:return this.popState(),"acc_title_value";case 9:return this.begin("acc_descr"),14;case 10:return this.popState(),"acc_descr_value";case 11:this.begin("acc_descr_multiline");break;case 12:this.popState();break;case 13:return"acc_descr_multiline_value";case 14:return 17;case 15:return 18;case 16:return 19;case 17:return":";case 18:return 6;case 19:return"INVALID"}},"anonymous"),rules:[/^(?:%(?!\{)[^\n]*)/i,/^(?:[^\}]%%[^\n]*)/i,/^(?:[\n]+)/i,/^(?:\s+)/i,/^(?:#[^\n]*)/i,/^(?:journey\b)/i,/^(?:title\s[^#\n;]+)/i,/^(?:accTitle\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*\{\s*)/i,/^(?:[\}])/i,/^(?:[^\}]*)/i,/^(?:section\s[^#:\n;]+)/i,/^(?:[^#:\n;]+)/i,/^(?::[^#\n;]+)/i,/^(?::)/i,/^(?:$)/i,/^(?:.)/i],conditions:{acc_descr_multiline:{rules:[12,13],inclusive:!1},acc_descr:{rules:[10],inclusive:!1},acc_title:{rules:[8],inclusive:!1},INITIAL:{rules:[0,1,2,3,4,5,6,7,9,11,14,15,16,17,18,19],inclusive:!0}}}})();function m(){this.yy={}}return n(m,"Parser"),m.prototype=d,d.Parser=m,new m})();U.parser=U;var Mt=U,C="",H=[],V=[],F=[],Et=n(function(){H.length=0,V.length=0,C="",F.length=0,bt()},"clear"),Pt=n(function(t){C=t,H.push(t)},"addSection"),It=n(function(){return H},"getSections"),At=n(function(){let t=rt();const e=100;let a=0;for(;!t&&a<e;)t=rt(),a++;return V.push(...F),V},"getTasks"),Ct=n(function(){const t=[];return V.forEach(e=>{e.people&&t.push(...e.people)}),[...new Set(t)].sort()},"updateActors"),Vt=n(function(t,e){const a=e.substr(1).split(":");let c=0,s=[];a.length===1?(c=Number(a[0]),s=[]):(c=Number(a[0]),s=a[1].split(","));const o=s.map(p=>p.trim()),u={section:C,type:C,people:o,task:t,score:c};F.push(u)},"addTask"),Ft=n(function(t){const e={section:C,type:C,description:t,task:t,classes:[]};V.push(e)},"addTaskOrg"),rt=n(function(){const t=n(function(a){return F[a].processed},"compileTask");let e=!0;for(const[a,c]of F.entries())t(a),e=e&&c.processed;return e},"compileTasks"),it={getConfig:n(()=>I().journey,"getConfig"),clear:Et,setDiagramTitle:wt,getDiagramTitle:_t,setAccTitle:vt,getAccTitle:kt,setAccDescription:gt,getAccDescription:xt,addSection:Pt,getSections:It,getTasks:At,addTask:Vt,addTaskOrg:Ft,getActors:n(function(){return Ct()},"getActors")},Rt=n(t=>`.label {
    font-family: ${t.fontFamily};
    color: ${t.textColor};
  }
  .mouth {
    stroke: #666;
  }

  line {
    stroke: ${t.textColor}
  }

  .legend {
    fill: ${t.textColor};
    font-family: ${t.fontFamily};
  }

  .label text {
    fill: #333;
  }
  .label {
    color: ${t.textColor}
  }

  .face {
    ${t.faceColor?`fill: ${t.faceColor}`:"fill: #FFF8DC"};
    stroke: #999;
  }

  .node rect,
  .node circle,
  .node ellipse,
  .node polygon,
  .node path {
    fill: ${t.mainBkg};
    stroke: ${t.nodeBorder};
    stroke-width: 1px;
  }

  .node .label {
    text-align: center;
  }
  .node.clickable {
    cursor: pointer;
  }

  .arrowheadPath {
    fill: ${t.arrowheadColor};
  }

  .edgePath .path {
    stroke: ${t.lineColor};
    stroke-width: 1.5px;
  }

  .flowchart-link {
    stroke: ${t.lineColor};
    fill: none;
  }

  .edgeLabel {
    background-color: ${t.edgeLabelBackground};
    rect {
      opacity: 0.5;
    }
    text-align: center;
  }

  .cluster rect {
  }

  .cluster text {
    fill: ${t.titleColor};
  }

  div.mermaidTooltip {
    position: absolute;
    text-align: center;
    max-width: 200px;
    padding: 2px;
    font-family: ${t.fontFamily};
    font-size: 12px;
    background: ${t.tertiaryColor};
    border: 1px solid ${t.border2};
    border-radius: 2px;
    pointer-events: none;
    z-index: 100;
  }

  .task-type-0, .section-type-0  {
    ${t.fillType0?`fill: ${t.fillType0}`:""};
  }
  .task-type-1, .section-type-1  {
    ${t.fillType0?`fill: ${t.fillType1}`:""};
  }
  .task-type-2, .section-type-2  {
    ${t.fillType0?`fill: ${t.fillType2}`:""};
  }
  .task-type-3, .section-type-3  {
    ${t.fillType0?`fill: ${t.fillType3}`:""};
  }
  .task-type-4, .section-type-4  {
    ${t.fillType0?`fill: ${t.fillType4}`:""};
  }
  .task-type-5, .section-type-5  {
    ${t.fillType0?`fill: ${t.fillType5}`:""};
  }
  .task-type-6, .section-type-6  {
    ${t.fillType0?`fill: ${t.fillType6}`:""};
  }
  .task-type-7, .section-type-7  {
    ${t.fillType0?`fill: ${t.fillType7}`:""};
  }

  .actor-0 {
    ${t.actor0?`fill: ${t.actor0}`:""};
  }
  .actor-1 {
    ${t.actor1?`fill: ${t.actor1}`:""};
  }
  .actor-2 {
    ${t.actor2?`fill: ${t.actor2}`:""};
  }
  .actor-3 {
    ${t.actor3?`fill: ${t.actor3}`:""};
  }
  .actor-4 {
    ${t.actor4?`fill: ${t.actor4}`:""};
  }
  .actor-5 {
    ${t.actor5?`fill: ${t.actor5}`:""};
  }
`,"getStyles"),Z=n(function(t,e){return St(t,e)},"drawRect"),Lt=n(function(t,e){const c=t.append("circle").attr("cx",e.cx).attr("cy",e.cy).attr("class","face").attr("r",15).attr("stroke-width",2).attr("overflow","visible"),s=t.append("g");s.append("circle").attr("cx",e.cx-15/3).attr("cy",e.cy-15/3).attr("r",1.5).attr("stroke-width",2).attr("fill","#666").attr("stroke","#666"),s.append("circle").attr("cx",e.cx+15/3).attr("cy",e.cy-15/3).attr("r",1.5).attr("stroke-width",2).attr("fill","#666").attr("stroke","#666");function o(d){const m=et().startAngle(Math.PI/2).endAngle(3*(Math.PI/2)).innerRadius(7.5).outerRadius(6.8181818181818175);d.append("path").attr("class","mouth").attr("d",m).attr("transform","translate("+e.cx+","+(e.cy+2)+")")}n(o,"smile");function u(d){const m=et().startAngle(3*Math.PI/2).endAngle(5*(Math.PI/2)).innerRadius(7.5).outerRadius(6.8181818181818175);d.append("path").attr("class","mouth").attr("d",m).attr("transform","translate("+e.cx+","+(e.cy+7)+")")}n(u,"sad");function p(d){d.append("line").attr("class","mouth").attr("stroke",2).attr("x1",e.cx-5).attr("y1",e.cy+7).attr("x2",e.cx+5).attr("y2",e.cy+7).attr("class","mouth").attr("stroke-width","1px").attr("stroke","#666")}return n(p,"ambivalent"),e.score>3?o(s):e.score<3?u(s):p(s),c},"drawFace"),ot=n(function(t,e){const a=t.append("circle");return a.attr("cx",e.cx),a.attr("cy",e.cy),a.attr("class","actor-"+e.pos),a.attr("fill",e.fill),a.attr("stroke",e.stroke),a.attr("r",e.r),a.class!==void 0&&a.attr("class",a.class),e.title!==void 0&&a.append("title").text(e.title),a},"drawCircle"),ct=n(function(t,e){return Tt(t,e)},"drawText"),Bt=n(function(t,e){function a(s,o,u,p,d){return s+","+o+" "+(s+u)+","+o+" "+(s+u)+","+(o+p-d)+" "+(s+u-d*1.2)+","+(o+p)+" "+s+","+(o+p)}n(a,"genPoints");const c=t.append("polygon");c.attr("points",a(e.x,e.y,50,20,7)),c.attr("class","labelBox"),e.y=e.y+e.labelMargin,e.x=e.x+.5*e.labelMargin,ct(t,e)},"drawLabel"),Nt=n(function(t,e,a){const c=t.append("g"),s=lt();s.x=e.x,s.y=e.y,s.fill=e.fill,s.width=a.width*e.taskCount+a.diagramMarginX*(e.taskCount-1),s.height=a.height,s.class="journey-section section-type-"+e.num,s.rx=3,s.ry=3,Z(c,s),ht(a)(e.text,c,s.x,s.y,s.width,s.height,{class:"journey-section section-type-"+e.num},a,e.colour)},"drawSection"),st=-1,jt=n(function(t,e,a){const c=e.x+a.width/2,s=t.append("g");st++,s.append("line").attr("id","task"+st).attr("x1",c).attr("y1",e.y).attr("x2",c).attr("y2",450).attr("class","task-line").attr("stroke-width","1px").attr("stroke-dasharray","4 2").attr("stroke","#666"),Lt(s,{cx:c,cy:300+(5-e.score)*30,score:e.score});const o=lt();o.x=e.x,o.y=e.y,o.fill=e.fill,o.width=a.width,o.height=a.height,o.class="task task-type-"+e.num,o.rx=3,o.ry=3,Z(s,o);let u=e.x+14;e.people.forEach(p=>{const d=e.actors[p].color,m={cx:u,cy:e.y,r:7,fill:d,stroke:"#000",title:p,pos:e.actors[p].position};ot(s,m),u+=10}),ht(a)(e.task,s,o.x,o.y,o.width,o.height,{class:"task"},a,e.colour)},"drawTask"),zt=n(function(t,e){$t(t,e)},"drawBackgroundRect"),ht=(function(){function t(s,o,u,p,d,m,r,i){c(o.append("text").attr("x",u+d/2).attr("y",p+m/2+5).style("font-color",i).style("text-anchor","middle").text(s),r)}n(t,"byText");function e(s,o,u,p,d,m,r,i,y){const{taskFontSize:l,taskFontFamily:f}=i,g=s.split(/<br\s*\/?>/gi);for(let h=0;h<g.length;h++){const T=h*l-l*(g.length-1)/2,x=o.append("text").attr("x",u+d/2).attr("y",p).attr("fill",y).style("text-anchor","middle").style("font-size",l).style("font-family",f);x.append("tspan").attr("x",u+d/2).attr("dy",T).text(g[h]),x.attr("y",p+m/2).attr("dominant-baseline","central").attr("alignment-baseline","central"),c(x,r)}}n(e,"byTspan");function a(s,o,u,p,d,m,r,i){const y=o.append("switch"),l=y.append("foreignObject").attr("x",u).attr("y",p).attr("width",d).attr("height",m).attr("position","fixed").append("xhtml:div").style("display","table").style("height","100%").style("width","100%");l.append("div").attr("class","label").style("display","table-cell").style("text-align","center").style("vertical-align","middle").text(s),e(s,y,u,p,d,m,r,i),c(l,r)}n(a,"byFo");function c(s,o){for(const u in o)u in o&&s.attr(u,o[u])}return n(c,"_setTextAttrs"),function(s){return s.textPlacement==="fo"?a:s.textPlacement==="old"?t:e}})(),R={drawRect:Z,drawCircle:ot,drawSection:Nt,drawText:ct,drawLabel:Bt,drawTask:jt,drawBackgroundRect:zt,initGraphics:n(function(t){t.append("defs").append("marker").attr("id","arrowhead").attr("refX",5).attr("refY",2).attr("markerWidth",6).attr("markerHeight",4).attr("orient","auto").append("path").attr("d","M 0,0 V 4 L6,2 Z")},"initGraphics")},Ot=n(function(t){Object.keys(t).forEach(function(e){j[e]=t[e]})},"setConf"),$={};function ut(t){const e=I().journey;let a=60;Object.keys($).forEach(c=>{const s=$[c].color,o={cx:20,cy:a,r:7,fill:s,stroke:"#000",pos:$[c].position};R.drawCircle(t,o);const u={x:40,y:a+7,fill:"#666",text:c,textMargin:e.boxTextMargin|5};R.drawText(t,u),a+=20})}n(ut,"drawActorLegend");var j=I().journey,P=j.leftMargin,Yt=n(function(t,e,a,c){const s=I().journey,o=I().securityLevel;let u;o==="sandbox"&&(u=W("#i"+e));const p=o==="sandbox"?W(u.nodes()[0].contentDocument.body):W("body");w.init();const d=p.select("#"+e);R.initGraphics(d);const m=c.db.getTasks(),r=c.db.getDiagramTitle(),i=c.db.getActors();for(const T in $)delete $[T];let y=0;i.forEach(T=>{$[T]={color:s.actorColours[y%s.actorColours.length],position:y},y++}),ut(d),w.insert(0,0,P,Object.keys($).length*50),qt(d,m,0);const l=w.getBounds();r&&d.append("text").text(r).attr("x",P).attr("font-size","4ex").attr("font-weight","bold").attr("y",25);const f=l.stopy-l.starty+2*s.diagramMarginY,g=P+l.stopx+2*s.diagramMarginX;mt(d,f,g,s.useMaxWidth),d.append("line").attr("x1",P).attr("y1",s.height*4).attr("x2",g-P-4).attr("y2",s.height*4).attr("stroke-width",4).attr("stroke","black").attr("marker-end","url(#arrowhead)");const h=r?70:0;d.attr("viewBox",`${l.startx} -25 ${g} ${f+h}`),d.attr("preserveAspectRatio","xMinYMin meet"),d.attr("height",f+h+25)},"draw"),w={data:{startx:void 0,stopx:void 0,starty:void 0,stopy:void 0},verticalPos:0,sequenceItems:[],init:n(function(){this.sequenceItems=[],this.data={startx:void 0,stopx:void 0,starty:void 0,stopy:void 0},this.verticalPos=0},"init"),updateVal:n(function(t,e,a,c){t[e]===void 0?t[e]=a:t[e]=c(a,t[e])},"updateVal"),updateBounds:n(function(t,e,a,c){const s=I().journey,o=this;let u=0;function p(d){return n(function(r){u++;const i=o.sequenceItems.length-u+1;o.updateVal(r,"starty",e-i*s.boxMargin,Math.min),o.updateVal(r,"stopy",c+i*s.boxMargin,Math.max),o.updateVal(w.data,"startx",t-i*s.boxMargin,Math.min),o.updateVal(w.data,"stopx",a+i*s.boxMargin,Math.max),d!=="activation"&&(o.updateVal(r,"startx",t-i*s.boxMargin,Math.min),o.updateVal(r,"stopx",a+i*s.boxMargin,Math.max),o.updateVal(w.data,"starty",e-i*s.boxMargin,Math.min),o.updateVal(w.data,"stopy",c+i*s.boxMargin,Math.max))},"updateItemBounds")}n(p,"updateFn"),this.sequenceItems.forEach(p())},"updateBounds"),insert:n(function(t,e,a,c){const s=Math.min(t,a),o=Math.max(t,a),u=Math.min(e,c),p=Math.max(e,c);this.updateVal(w.data,"startx",s,Math.min),this.updateVal(w.data,"starty",u,Math.min),this.updateVal(w.data,"stopx",o,Math.max),this.updateVal(w.data,"stopy",p,Math.max),this.updateBounds(s,u,o,p)},"insert"),bumpVerticalPos:n(function(t){this.verticalPos=this.verticalPos+t,this.data.stopy=this.verticalPos},"bumpVerticalPos"),getVerticalPos:n(function(){return this.verticalPos},"getVerticalPos"),getBounds:n(function(){return this.data},"getBounds")},X=j.sectionFills,nt=j.sectionColours,qt=n(function(t,e,a){const c=I().journey;let s="";const o=a+(c.height*2+c.diagramMarginY);let u=0,p="#CCC",d="black",m=0;for(const[r,i]of e.entries()){if(s!==i.section){p=X[u%X.length],m=u%X.length,d=nt[u%nt.length];let l=0;const f=i.section;for(let h=r;h<e.length&&e[h].section==f;h++)l=l+1;const g={x:r*c.taskMargin+r*c.width+P,y:50,text:i.section,fill:p,num:m,colour:d,taskCount:l};R.drawSection(t,g,c),s=i.section,u++}const y=i.people.reduce((l,f)=>($[f]&&(l[f]=$[f]),l),{});i.x=r*c.taskMargin+r*c.width+P,i.y=o,i.width=c.diagramMarginX,i.height=c.diagramMarginY,i.colour=d,i.fill=p,i.num=m,i.actors=y,R.drawTask(t,i,c),w.insert(i.x,i.y,i.x+i.width+c.taskMargin,450)}},"drawTasks"),at={setConf:Ot,draw:Yt},Ut={parser:Mt,db:it,renderer:at,styles:Rt,init:n(t=>{at.setConf(t.journey),it.clear()},"init")};export{Ut as diagram};
