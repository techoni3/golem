import{$ as ie,F as C,M as re,N as ae,R as ne,S as Y,U as b,b as le,et as oe,g as h,rt as ce}from"./src-SharrJEw.js";import{h as he,o as ue}from"./chunk-O4NI6UNU-CBbM2qD-.js";import{n as de,t as fe}from"./chunk-RZ5BOZE2-DuE84pjE.js";import{r as pe}from"./chunk-TYCBKAJE-BsJpQHCt.js";var bt=(function(){var t=h(function(n,d,o,p){for(o=o||{},p=n.length;p--;o[n[p]]=d);return o},"o"),e=[1,2],l=[1,3],r=[1,4],s=[2,4],u=[1,9],S=[1,11],g=[1,16],a=[1,17],T=[1,18],V=[1,19],R=[1,32],A=[1,20],f=[1,21],x=[1,22],L=[1,23],$=[1,24],P=[1,26],O=[1,27],N=[1,28],q=[1,29],Q=[1,30],Z=[1,31],tt=[1,34],et=[1,35],st=[1,36],it=[1,37],j=[1,33],y=[1,4,5,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,42,45,48,49,50,51,54],rt=[1,4,5,14,15,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,42,45,48,49,50,51,54],xt=[4,5,16,17,19,21,22,24,25,26,27,28,29,33,35,37,38,42,45,48,49,50,51,54],pt={trace:h(function(){},"trace"),yy:{},symbols_:{error:2,start:3,SPACE:4,NL:5,SD:6,document:7,line:8,statement:9,classDefStatement:10,styleStatement:11,cssClassStatement:12,idStatement:13,DESCR:14,"-->":15,HIDE_EMPTY:16,scale:17,WIDTH:18,COMPOSIT_STATE:19,STRUCT_START:20,STRUCT_STOP:21,STATE_DESCR:22,AS:23,ID:24,FORK:25,JOIN:26,CHOICE:27,CONCURRENT:28,note:29,notePosition:30,NOTE_TEXT:31,direction:32,acc_title:33,acc_title_value:34,acc_descr:35,acc_descr_value:36,acc_descr_multiline_value:37,classDef:38,CLASSDEF_ID:39,CLASSDEF_STYLEOPTS:40,DEFAULT:41,style:42,STYLE_IDS:43,STYLEDEF_STYLEOPTS:44,class:45,CLASSENTITY_IDS:46,STYLECLASS:47,direction_tb:48,direction_bt:49,direction_rl:50,direction_lr:51,eol:52,";":53,EDGE_STATE:54,STYLE_SEPARATOR:55,left_of:56,right_of:57,$accept:0,$end:1},terminals_:{2:"error",4:"SPACE",5:"NL",6:"SD",14:"DESCR",15:"-->",16:"HIDE_EMPTY",17:"scale",18:"WIDTH",19:"COMPOSIT_STATE",20:"STRUCT_START",21:"STRUCT_STOP",22:"STATE_DESCR",23:"AS",24:"ID",25:"FORK",26:"JOIN",27:"CHOICE",28:"CONCURRENT",29:"note",31:"NOTE_TEXT",33:"acc_title",34:"acc_title_value",35:"acc_descr",36:"acc_descr_value",37:"acc_descr_multiline_value",38:"classDef",39:"CLASSDEF_ID",40:"CLASSDEF_STYLEOPTS",41:"DEFAULT",42:"style",43:"STYLE_IDS",44:"STYLEDEF_STYLEOPTS",45:"class",46:"CLASSENTITY_IDS",47:"STYLECLASS",48:"direction_tb",49:"direction_bt",50:"direction_rl",51:"direction_lr",53:";",54:"EDGE_STATE",55:"STYLE_SEPARATOR",56:"left_of",57:"right_of"},productions_:[0,[3,2],[3,2],[3,2],[7,0],[7,2],[8,2],[8,1],[8,1],[9,1],[9,1],[9,1],[9,1],[9,2],[9,3],[9,4],[9,1],[9,2],[9,1],[9,4],[9,3],[9,6],[9,1],[9,1],[9,1],[9,1],[9,4],[9,4],[9,1],[9,2],[9,2],[9,1],[10,3],[10,3],[11,3],[12,3],[32,1],[32,1],[32,1],[32,1],[52,1],[52,1],[13,1],[13,1],[13,3],[13,3],[30,1],[30,1]],performAction:h(function(d,o,p,_,E,i,H){var c=i.length-1;switch(E){case 3:return _.setRootDoc(i[c]),i[c];case 4:this.$=[];break;case 5:i[c]!="nl"&&(i[c-1].push(i[c]),this.$=i[c-1]);break;case 6:case 7:this.$=i[c];break;case 8:this.$="nl";break;case 12:this.$=i[c];break;case 13:const nt=i[c-1];nt.description=_.trimColon(i[c]),this.$=nt;break;case 14:this.$={stmt:"relation",state1:i[c-2],state2:i[c]};break;case 15:const lt=_.trimColon(i[c]);this.$={stmt:"relation",state1:i[c-3],state2:i[c-1],description:lt};break;case 19:this.$={stmt:"state",id:i[c-3],type:"default",description:"",doc:i[c-1]};break;case 20:var B=i[c],M=i[c-2].trim();if(i[c].match(":")){var z=i[c].split(":");B=z[0],M=[M,z[1]]}this.$={stmt:"state",id:B,type:"default",description:M};break;case 21:this.$={stmt:"state",id:i[c-3],type:"default",description:i[c-5],doc:i[c-1]};break;case 22:this.$={stmt:"state",id:i[c],type:"fork"};break;case 23:this.$={stmt:"state",id:i[c],type:"join"};break;case 24:this.$={stmt:"state",id:i[c],type:"choice"};break;case 25:this.$={stmt:"state",id:_.getDividerId(),type:"divider"};break;case 26:this.$={stmt:"state",id:i[c-1].trim(),note:{position:i[c-2].trim(),text:i[c].trim()}};break;case 29:this.$=i[c].trim(),_.setAccTitle(this.$);break;case 30:case 31:this.$=i[c].trim(),_.setAccDescription(this.$);break;case 32:case 33:this.$={stmt:"classDef",id:i[c-1].trim(),classes:i[c].trim()};break;case 34:this.$={stmt:"style",id:i[c-1].trim(),styleClass:i[c].trim()};break;case 35:this.$={stmt:"applyClass",id:i[c-1].trim(),styleClass:i[c].trim()};break;case 36:_.setDirection("TB"),this.$={stmt:"dir",value:"TB"};break;case 37:_.setDirection("BT"),this.$={stmt:"dir",value:"BT"};break;case 38:_.setDirection("RL"),this.$={stmt:"dir",value:"RL"};break;case 39:_.setDirection("LR"),this.$={stmt:"dir",value:"LR"};break;case 42:case 43:this.$={stmt:"state",id:i[c].trim(),type:"default",description:""};break;case 44:this.$={stmt:"state",id:i[c-2].trim(),classes:[i[c].trim()],type:"default",description:""};break;case 45:this.$={stmt:"state",id:i[c-2].trim(),classes:[i[c].trim()],type:"default",description:""};break}},"anonymous"),table:[{3:1,4:e,5:l,6:r},{1:[3]},{3:5,4:e,5:l,6:r},{3:6,4:e,5:l,6:r},t([1,4,5,16,17,19,22,24,25,26,27,28,29,33,35,37,38,42,45,48,49,50,51,54],s,{7:7}),{1:[2,1]},{1:[2,2]},{1:[2,3],4:u,5:S,8:8,9:10,10:12,11:13,12:14,13:15,16:g,17:a,19:T,22:V,24:R,25:A,26:f,27:x,28:L,29:$,32:25,33:P,35:O,37:N,38:q,42:Q,45:Z,48:tt,49:et,50:st,51:it,54:j},t(y,[2,5]),{9:38,10:12,11:13,12:14,13:15,16:g,17:a,19:T,22:V,24:R,25:A,26:f,27:x,28:L,29:$,32:25,33:P,35:O,37:N,38:q,42:Q,45:Z,48:tt,49:et,50:st,51:it,54:j},t(y,[2,7]),t(y,[2,8]),t(y,[2,9]),t(y,[2,10]),t(y,[2,11]),t(y,[2,12],{14:[1,39],15:[1,40]}),t(y,[2,16]),{18:[1,41]},t(y,[2,18],{20:[1,42]}),{23:[1,43]},t(y,[2,22]),t(y,[2,23]),t(y,[2,24]),t(y,[2,25]),{30:44,31:[1,45],56:[1,46],57:[1,47]},t(y,[2,28]),{34:[1,48]},{36:[1,49]},t(y,[2,31]),{39:[1,50],41:[1,51]},{43:[1,52]},{46:[1,53]},t(rt,[2,42],{55:[1,54]}),t(rt,[2,43],{55:[1,55]}),t(y,[2,36]),t(y,[2,37]),t(y,[2,38]),t(y,[2,39]),t(y,[2,6]),t(y,[2,13]),{13:56,24:R,54:j},t(y,[2,17]),t(xt,s,{7:57}),{24:[1,58]},{24:[1,59]},{23:[1,60]},{24:[2,46]},{24:[2,47]},t(y,[2,29]),t(y,[2,30]),{40:[1,61]},{40:[1,62]},{44:[1,63]},{47:[1,64]},{24:[1,65]},{24:[1,66]},t(y,[2,14],{14:[1,67]}),{4:u,5:S,8:8,9:10,10:12,11:13,12:14,13:15,16:g,17:a,19:T,21:[1,68],22:V,24:R,25:A,26:f,27:x,28:L,29:$,32:25,33:P,35:O,37:N,38:q,42:Q,45:Z,48:tt,49:et,50:st,51:it,54:j},t(y,[2,20],{20:[1,69]}),{31:[1,70]},{24:[1,71]},t(y,[2,32]),t(y,[2,33]),t(y,[2,34]),t(y,[2,35]),t(rt,[2,44]),t(rt,[2,45]),t(y,[2,15]),t(y,[2,19]),t(xt,s,{7:72}),t(y,[2,26]),t(y,[2,27]),{4:u,5:S,8:8,9:10,10:12,11:13,12:14,13:15,16:g,17:a,19:T,21:[1,73],22:V,24:R,25:A,26:f,27:x,28:L,29:$,32:25,33:P,35:O,37:N,38:q,42:Q,45:Z,48:tt,49:et,50:st,51:it,54:j},t(y,[2,21])],defaultActions:{5:[2,1],6:[2,2],46:[2,46],47:[2,47]},parseError:h(function(d,o){if(o.recoverable)this.trace(d);else{var p=new Error(d);throw p.hash=o,p}},"parseError"),parse:h(function(d){var o=this,p=[0],_=[],E=[null],i=[],H=this.table,c="",B=0,M=0,z=0,nt=2,lt=1,te=i.slice.call(arguments,1),m=Object.create(this.lexer),G={yy:{}};for(var St in this.yy)Object.prototype.hasOwnProperty.call(this.yy,St)&&(G.yy[St]=this.yy[St]);m.setInput(d,G.yy),G.yy.lexer=m,G.yy.parser=this,typeof m.yylloc>"u"&&(m.yylloc={});var yt=m.yylloc;i.push(yt);var ee=m.options&&m.options.ranges;typeof G.yy.parseError=="function"?this.parseError=G.yy.parseError:this.parseError=Object.getPrototypeOf(this).parseError;function se(v){p.length=p.length-2*v,E.length=E.length-v,i.length=i.length-v}h(se,"popStack");function At(){var v=_.pop()||m.lex()||lt;return typeof v!="number"&&(v instanceof Array&&(_=v,v=_.pop()),v=o.symbols_[v]||v),v}h(At,"lex");for(var D,gt,F,k,Tt,U={},ot,I,Lt,ct;;){if(F=p[p.length-1],this.defaultActions[F]?k=this.defaultActions[F]:((D===null||typeof D>"u")&&(D=At()),k=H[F]&&H[F][D]),typeof k>"u"||!k.length||!k[0]){var _t="";ct=[];for(ot in H[F])this.terminals_[ot]&&ot>nt&&ct.push("'"+this.terminals_[ot]+"'");m.showPosition?_t="Parse error on line "+(B+1)+`:
`+m.showPosition()+`
Expecting `+ct.join(", ")+", got '"+(this.terminals_[D]||D)+"'":_t="Parse error on line "+(B+1)+": Unexpected "+(D==lt?"end of input":"'"+(this.terminals_[D]||D)+"'"),this.parseError(_t,{text:m.match,token:this.terminals_[D]||D,line:m.yylineno,loc:yt,expected:ct})}if(k[0]instanceof Array&&k.length>1)throw new Error("Parse Error: multiple actions possible at state: "+F+", token: "+D);switch(k[0]){case 1:p.push(D),E.push(m.yytext),i.push(m.yylloc),p.push(k[1]),D=null,gt?(D=gt,gt=null):(M=m.yyleng,c=m.yytext,B=m.yylineno,yt=m.yylloc,z>0&&z--);break;case 2:if(I=this.productions_[k[1]][1],U.$=E[E.length-I],U._$={first_line:i[i.length-(I||1)].first_line,last_line:i[i.length-1].last_line,first_column:i[i.length-(I||1)].first_column,last_column:i[i.length-1].last_column},ee&&(U._$.range=[i[i.length-(I||1)].range[0],i[i.length-1].range[1]]),Tt=this.performAction.apply(U,[c,M,B,G.yy,k[1],E,i].concat(te)),typeof Tt<"u")return Tt;I&&(p=p.slice(0,-1*I*2),E=E.slice(0,-1*I),i=i.slice(0,-1*I)),p.push(this.productions_[k[1]][0]),E.push(U.$),i.push(U._$),Lt=H[p[p.length-2]][p[p.length-1]],p.push(Lt);break;case 3:return!0}}return!0},"parse")};pt.lexer=(function(){return{EOF:1,parseError:h(function(d,o){if(this.yy.parser)this.yy.parser.parseError(d,o);else throw new Error(d)},"parseError"),setInput:h(function(n,d){return this.yy=d||this.yy||{},this._input=n,this._more=this._backtrack=this.done=!1,this.yylineno=this.yyleng=0,this.yytext=this.matched=this.match="",this.conditionStack=["INITIAL"],this.yylloc={first_line:1,first_column:0,last_line:1,last_column:0},this.options.ranges&&(this.yylloc.range=[0,0]),this.offset=0,this},"setInput"),input:h(function(){var n=this._input[0];return this.yytext+=n,this.yyleng++,this.offset++,this.match+=n,this.matched+=n,n.match(/(?:\r\n?|\n).*/g)?(this.yylineno++,this.yylloc.last_line++):this.yylloc.last_column++,this.options.ranges&&this.yylloc.range[1]++,this._input=this._input.slice(1),n},"input"),unput:h(function(n){var d=n.length,o=n.split(/(?:\r\n?|\n)/g);this._input=n+this._input,this.yytext=this.yytext.substr(0,this.yytext.length-d),this.offset-=d;var p=this.match.split(/(?:\r\n?|\n)/g);this.match=this.match.substr(0,this.match.length-1),this.matched=this.matched.substr(0,this.matched.length-1),o.length-1&&(this.yylineno-=o.length-1);var _=this.yylloc.range;return this.yylloc={first_line:this.yylloc.first_line,last_line:this.yylineno+1,first_column:this.yylloc.first_column,last_column:o?(o.length===p.length?this.yylloc.first_column:0)+p[p.length-o.length].length-o[0].length:this.yylloc.first_column-d},this.options.ranges&&(this.yylloc.range=[_[0],_[0]+this.yyleng-d]),this.yyleng=this.yytext.length,this},"unput"),more:h(function(){return this._more=!0,this},"more"),reject:h(function(){if(this.options.backtrack_lexer)this._backtrack=!0;else return this.parseError("Lexical error on line "+(this.yylineno+1)+`. You can only invoke reject() in the lexer when the lexer is of the backtracking persuasion (options.backtrack_lexer = true).
`+this.showPosition(),{text:"",token:null,line:this.yylineno});return this},"reject"),less:h(function(n){this.unput(this.match.slice(n))},"less"),pastInput:h(function(){var n=this.matched.substr(0,this.matched.length-this.match.length);return(n.length>20?"...":"")+n.substr(-20).replace(/\n/g,"")},"pastInput"),upcomingInput:h(function(){var n=this.match;return n.length<20&&(n+=this._input.substr(0,20-n.length)),(n.substr(0,20)+(n.length>20?"...":"")).replace(/\n/g,"")},"upcomingInput"),showPosition:h(function(){var n=this.pastInput(),d=new Array(n.length+1).join("-");return n+this.upcomingInput()+`
`+d+"^"},"showPosition"),test_match:h(function(n,d){var o,p,_;if(this.options.backtrack_lexer&&(_={yylineno:this.yylineno,yylloc:{first_line:this.yylloc.first_line,last_line:this.last_line,first_column:this.yylloc.first_column,last_column:this.yylloc.last_column},yytext:this.yytext,match:this.match,matches:this.matches,matched:this.matched,yyleng:this.yyleng,offset:this.offset,_more:this._more,_input:this._input,yy:this.yy,conditionStack:this.conditionStack.slice(0),done:this.done},this.options.ranges&&(_.yylloc.range=this.yylloc.range.slice(0))),p=n[0].match(/(?:\r\n?|\n).*/g),p&&(this.yylineno+=p.length),this.yylloc={first_line:this.yylloc.last_line,last_line:this.yylineno+1,first_column:this.yylloc.last_column,last_column:p?p[p.length-1].length-p[p.length-1].match(/\r?\n?/)[0].length:this.yylloc.last_column+n[0].length},this.yytext+=n[0],this.match+=n[0],this.matches=n,this.yyleng=this.yytext.length,this.options.ranges&&(this.yylloc.range=[this.offset,this.offset+=this.yyleng]),this._more=!1,this._backtrack=!1,this._input=this._input.slice(n[0].length),this.matched+=n[0],o=this.performAction.call(this,this.yy,this,d,this.conditionStack[this.conditionStack.length-1]),this.done&&this._input&&(this.done=!1),o)return o;if(this._backtrack){for(var E in _)this[E]=_[E];return!1}return!1},"test_match"),next:h(function(){if(this.done)return this.EOF;this._input||(this.done=!0);var n,d,o,p;this._more||(this.yytext="",this.match="");for(var _=this._currentRules(),E=0;E<_.length;E++)if(o=this._input.match(this.rules[_[E]]),o&&(!d||o[0].length>d[0].length)){if(d=o,p=E,this.options.backtrack_lexer){if(n=this.test_match(o,_[E]),n!==!1)return n;if(this._backtrack){d=!1;continue}else return!1}else if(!this.options.flex)break}return d?(n=this.test_match(d,_[p]),n!==!1?n:!1):this._input===""?this.EOF:this.parseError("Lexical error on line "+(this.yylineno+1)+`. Unrecognized text.
`+this.showPosition(),{text:"",token:null,line:this.yylineno})},"next"),lex:h(function(){var d=this.next();return d||this.lex()},"lex"),begin:h(function(d){this.conditionStack.push(d)},"begin"),popState:h(function(){return this.conditionStack.length-1>0?this.conditionStack.pop():this.conditionStack[0]},"popState"),_currentRules:h(function(){return this.conditionStack.length&&this.conditionStack[this.conditionStack.length-1]?this.conditions[this.conditionStack[this.conditionStack.length-1]].rules:this.conditions.INITIAL.rules},"_currentRules"),topState:h(function(d){return d=this.conditionStack.length-1-Math.abs(d||0),d>=0?this.conditionStack[d]:"INITIAL"},"topState"),pushState:h(function(d){this.begin(d)},"pushState"),stateStackSize:h(function(){return this.conditionStack.length},"stateStackSize"),options:{"case-insensitive":!0},performAction:h(function(d,o,p,_){switch(p){case 0:return 41;case 1:return 48;case 2:return 49;case 3:return 50;case 4:return 51;case 5:break;case 6:break;case 7:return 5;case 8:break;case 9:break;case 10:break;case 11:break;case 12:return this.pushState("SCALE"),17;case 13:return 18;case 14:this.popState();break;case 15:return this.begin("acc_title"),33;case 16:return this.popState(),"acc_title_value";case 17:return this.begin("acc_descr"),35;case 18:return this.popState(),"acc_descr_value";case 19:this.begin("acc_descr_multiline");break;case 20:this.popState();break;case 21:return"acc_descr_multiline_value";case 22:return this.pushState("CLASSDEF"),38;case 23:return this.popState(),this.pushState("CLASSDEFID"),"DEFAULT_CLASSDEF_ID";case 24:return this.popState(),this.pushState("CLASSDEFID"),39;case 25:return this.popState(),40;case 26:return this.pushState("CLASS"),45;case 27:return this.popState(),this.pushState("CLASS_STYLE"),46;case 28:return this.popState(),47;case 29:return this.pushState("STYLE"),42;case 30:return this.popState(),this.pushState("STYLEDEF_STYLES"),43;case 31:return this.popState(),44;case 32:return this.pushState("SCALE"),17;case 33:return 18;case 34:this.popState();break;case 35:this.pushState("STATE");break;case 36:return this.popState(),o.yytext=o.yytext.slice(0,-8).trim(),25;case 37:return this.popState(),o.yytext=o.yytext.slice(0,-8).trim(),26;case 38:return this.popState(),o.yytext=o.yytext.slice(0,-10).trim(),27;case 39:return this.popState(),o.yytext=o.yytext.slice(0,-8).trim(),25;case 40:return this.popState(),o.yytext=o.yytext.slice(0,-8).trim(),26;case 41:return this.popState(),o.yytext=o.yytext.slice(0,-10).trim(),27;case 42:return 48;case 43:return 49;case 44:return 50;case 45:return 51;case 46:this.pushState("STATE_STRING");break;case 47:return this.pushState("STATE_ID"),"AS";case 48:return this.popState(),"ID";case 49:this.popState();break;case 50:return"STATE_DESCR";case 51:return 19;case 52:this.popState();break;case 53:return this.popState(),this.pushState("struct"),20;case 54:break;case 55:return this.popState(),21;case 56:break;case 57:return this.begin("NOTE"),29;case 58:return this.popState(),this.pushState("NOTE_ID"),56;case 59:return this.popState(),this.pushState("NOTE_ID"),57;case 60:this.popState(),this.pushState("FLOATING_NOTE");break;case 61:return this.popState(),this.pushState("FLOATING_NOTE_ID"),"AS";case 62:break;case 63:return"NOTE_TEXT";case 64:return this.popState(),"ID";case 65:return this.popState(),this.pushState("NOTE_TEXT"),24;case 66:return this.popState(),o.yytext=o.yytext.substr(2).trim(),31;case 67:return this.popState(),o.yytext=o.yytext.slice(0,-8).trim(),31;case 68:return 6;case 69:return 6;case 70:return 16;case 71:return 54;case 72:return 24;case 73:return o.yytext=o.yytext.trim(),14;case 74:return 15;case 75:return 28;case 76:return 55;case 77:return 5;case 78:return"INVALID"}},"anonymous"),rules:[/^(?:default\b)/i,/^(?:.*direction\s+TB[^\n]*)/i,/^(?:.*direction\s+BT[^\n]*)/i,/^(?:.*direction\s+RL[^\n]*)/i,/^(?:.*direction\s+LR[^\n]*)/i,/^(?:%%(?!\{)[^\n]*)/i,/^(?:[^\}]%%[^\n]*)/i,/^(?:[\n]+)/i,/^(?:[\s]+)/i,/^(?:((?!\n)\s)+)/i,/^(?:#[^\n]*)/i,/^(?:%[^\n]*)/i,/^(?:scale\s+)/i,/^(?:\d+)/i,/^(?:\s+width\b)/i,/^(?:accTitle\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*:\s*)/i,/^(?:(?!\n||)*[^\n]*)/i,/^(?:accDescr\s*\{\s*)/i,/^(?:[\}])/i,/^(?:[^\}]*)/i,/^(?:classDef\s+)/i,/^(?:DEFAULT\s+)/i,/^(?:\w+\s+)/i,/^(?:[^\n]*)/i,/^(?:class\s+)/i,/^(?:(\w+)+((,\s*\w+)*))/i,/^(?:[^\n]*)/i,/^(?:style\s+)/i,/^(?:[\w,]+\s+)/i,/^(?:[^\n]*)/i,/^(?:scale\s+)/i,/^(?:\d+)/i,/^(?:\s+width\b)/i,/^(?:state\s+)/i,/^(?:.*<<fork>>)/i,/^(?:.*<<join>>)/i,/^(?:.*<<choice>>)/i,/^(?:.*\[\[fork\]\])/i,/^(?:.*\[\[join\]\])/i,/^(?:.*\[\[choice\]\])/i,/^(?:.*direction\s+TB[^\n]*)/i,/^(?:.*direction\s+BT[^\n]*)/i,/^(?:.*direction\s+RL[^\n]*)/i,/^(?:.*direction\s+LR[^\n]*)/i,/^(?:["])/i,/^(?:\s*as\s+)/i,/^(?:[^\n\{]*)/i,/^(?:["])/i,/^(?:[^"]*)/i,/^(?:[^\n\s\{]+)/i,/^(?:\n)/i,/^(?:\{)/i,/^(?:%%(?!\{)[^\n]*)/i,/^(?:\})/i,/^(?:[\n])/i,/^(?:note\s+)/i,/^(?:left of\b)/i,/^(?:right of\b)/i,/^(?:")/i,/^(?:\s*as\s*)/i,/^(?:["])/i,/^(?:[^"]*)/i,/^(?:[^\n]*)/i,/^(?:\s*[^:\n\s\-]+)/i,/^(?:\s*:[^:\n;]+)/i,/^(?:[\s\S]*?end note\b)/i,/^(?:stateDiagram\s+)/i,/^(?:stateDiagram-v2\s+)/i,/^(?:hide empty description\b)/i,/^(?:\[\*\])/i,/^(?:[^:\n\s\-\{]+)/i,/^(?:\s*:[^:\n;]+)/i,/^(?:-->)/i,/^(?:--)/i,/^(?::::)/i,/^(?:$)/i,/^(?:.)/i],conditions:{LINE:{rules:[9,10],inclusive:!1},struct:{rules:[9,10,22,26,29,35,42,43,44,45,54,55,56,57,71,72,73,74,75],inclusive:!1},FLOATING_NOTE_ID:{rules:[64],inclusive:!1},FLOATING_NOTE:{rules:[61,62,63],inclusive:!1},NOTE_TEXT:{rules:[66,67],inclusive:!1},NOTE_ID:{rules:[65],inclusive:!1},NOTE:{rules:[58,59,60],inclusive:!1},STYLEDEF_STYLEOPTS:{rules:[],inclusive:!1},STYLEDEF_STYLES:{rules:[31],inclusive:!1},STYLE_IDS:{rules:[],inclusive:!1},STYLE:{rules:[30],inclusive:!1},CLASS_STYLE:{rules:[28],inclusive:!1},CLASS:{rules:[27],inclusive:!1},CLASSDEFID:{rules:[25],inclusive:!1},CLASSDEF:{rules:[23,24],inclusive:!1},acc_descr_multiline:{rules:[20,21],inclusive:!1},acc_descr:{rules:[18],inclusive:!1},acc_title:{rules:[16],inclusive:!1},SCALE:{rules:[13,14,33,34],inclusive:!1},ALIAS:{rules:[],inclusive:!1},STATE_ID:{rules:[48],inclusive:!1},STATE_STRING:{rules:[49,50],inclusive:!1},FORK_STATE:{rules:[],inclusive:!1},STATE:{rules:[9,10,36,37,38,39,40,41,46,47,51,52,53],inclusive:!1},ID:{rules:[9,10],inclusive:!1},INITIAL:{rules:[0,1,2,3,4,5,6,7,8,10,11,12,15,17,19,22,26,29,32,35,53,57,68,69,70,71,72,73,74,76,77,78],inclusive:!0}}}})();function at(){this.yy={}}return h(at,"Parser"),at.prototype=pt,pt.Parser=at,new at})();bt.parser=bt;var Fe=bt,Se="TB",Vt="TB",It="dir",ut="state",Dt="relation",ye="classDef",ge="style",Te="applyClass",K="default",Mt="divider",Ut="fill:none",jt="fill: #333",Ht="c",zt="text",Wt="normal",Et="rect",mt="rectWithTitle",_e="stateStart",Ee="stateEnd",Rt="divider",Ot="roundedWithTitle",me="note",be="noteGroup",J="statediagram",De=`${J}-state`,Xt="transition",ke="note",ve=`${Xt} note-edge`,Ce=`${J}-${ke}`,xe=`${J}-cluster`,Ae=`${J}-cluster-alt`,Kt="parent",Jt="note",Le="state",Ct="----",Ie=`${Ct}${Jt}`,Nt=`${Ct}${Kt}`,qt=h((t,e=Vt)=>{if(!t.doc)return e;let l=e;for(const r of t.doc)r.stmt==="dir"&&(l=r.value);return l},"getDir"),Ye={getClasses:h(function(t,e){return e.db.getClasses()},"getClasses"),draw:h(async function(t,e,l,r){b.info("REF0:"),b.info("Drawing state diagram (v2)",e);const{securityLevel:s,state:u,layout:S}=C();r.db.extract(r.db.getRootDocV2());const g=r.db.getData(),a=fe(e,s);g.type=r.type,g.layoutAlgorithm=S,g.nodeSpacing=u?.nodeSpacing||50,g.rankSpacing=u?.rankSpacing||50,g.markers=["barb"],g.diagramId=e,await pe(g,a);const T=8;he.insertTitle(a,"statediagramTitleText",u?.titleTopMargin??25,r.db.getDiagramTitle()),de(a,T,J,u?.useMaxWidth??!0)},"draw"),getDir:qt},dt=new Map,w=0;function ft(t="",e=0,l="",r=Ct){return`${Le}-${t}${l!==null&&l.length>0?`${r}${l}`:""}-${e}`}h(ft,"stateDomId");var Re=h((t,e,l,r,s,u,S,g)=>{b.trace("items",e),e.forEach(a=>{switch(a.stmt){case ut:X(t,a,l,r,s,u,S,g);break;case K:X(t,a,l,r,s,u,S,g);break;case Dt:{X(t,a.state1,l,r,s,u,S,g),X(t,a.state2,l,r,s,u,S,g);const T={id:"edge"+w,start:a.state1.id,end:a.state2.id,arrowhead:"normal",arrowTypeEnd:"arrow_barb",style:Ut,labelStyle:"",label:Y.sanitizeText(a.description,C()),arrowheadStyle:jt,labelpos:Ht,labelType:zt,thickness:Wt,classes:Xt,look:S};s.push(T),w++}break}})},"setupDoc"),wt=h((t,e=Vt)=>{let l=e;if(t.doc)for(const r of t.doc)r.stmt==="dir"&&(l=r.value);return l},"getDir");function W(t,e,l){if(!e.id||e.id==="</join></fork>"||e.id==="</choice>")return;e.cssClasses&&(Array.isArray(e.cssCompiledStyles)||(e.cssCompiledStyles=[]),e.cssClasses.split(" ").forEach(s=>{if(l.get(s)){const u=l.get(s);e.cssCompiledStyles=[...e.cssCompiledStyles,...u.styles]}}));const r=t.find(s=>s.id===e.id);r?Object.assign(r,e):t.push(e)}h(W,"insertOrUpdateNode");function Qt(t){return t?.classes?.join(" ")??""}h(Qt,"getClassesFromDbInfo");function Zt(t){return t?.styles??[]}h(Zt,"getStylesFromDbInfo");var X=h((t,e,l,r,s,u,S,g)=>{const a=e.id,T=l.get(a),V=Qt(T),R=Zt(T);if(b.info("dataFetcher parsedItem",e,T,R),a!=="root"){let A=Et;e.start===!0?A=_e:e.start===!1&&(A=Ee),e.type!==K&&(A=e.type),dt.get(a)||dt.set(a,{id:a,shape:A,description:Y.sanitizeText(a,C()),cssClasses:`${V} ${De}`,cssStyles:R});const f=dt.get(a);e.description&&(Array.isArray(f.description)?(f.shape=mt,f.description.push(e.description)):f.description?.length>0?(f.shape=mt,f.description===a?f.description=[e.description]:f.description=[f.description,e.description]):(f.shape=Et,f.description=e.description),f.description=Y.sanitizeTextOrArray(f.description,C())),f.description?.length===1&&f.shape===mt&&(f.type==="group"?f.shape=Ot:f.shape=Et),!f.type&&e.doc&&(b.info("Setting cluster for XCX",a,wt(e)),f.type="group",f.isGroup=!0,f.dir=wt(e),f.shape=e.type===Mt?Rt:Ot,f.cssClasses=`${f.cssClasses} ${xe} ${u?Ae:""}`);const x={labelStyle:"",shape:f.shape,label:f.description,cssClasses:f.cssClasses,cssCompiledStyles:[],cssStyles:f.cssStyles,id:a,dir:f.dir,domId:ft(a,w),type:f.type,isGroup:f.type==="group",padding:8,rx:10,ry:10,look:S};if(x.shape===Rt&&(x.label=""),t&&t.id!=="root"&&(b.trace("Setting node ",a," to be child of its parent ",t.id),x.parentId=t.id),x.centerLabel=!0,e.note){const L={labelStyle:"",shape:me,label:e.note.text,cssClasses:Ce,cssStyles:[],cssCompilesStyles:[],id:a+Ie+"-"+w,domId:ft(a,w,Jt),type:f.type,isGroup:f.type==="group",padding:C().flowchart.padding,look:S,position:e.note.position},$=a+Nt,P={labelStyle:"",shape:be,label:e.note.text,cssClasses:f.cssClasses,cssStyles:[],id:a+Nt,domId:ft(a,w,Kt),type:"group",isGroup:!0,padding:16,look:S,position:e.note.position};w++,P.id=$,L.parentId=$,W(r,P,g),W(r,L,g),W(r,x,g);let O=a,N=L.id;e.note.position==="left of"&&(O=L.id,N=a),s.push({id:O+"-"+N,start:O,end:N,arrowhead:"none",arrowTypeEnd:"",style:Ut,labelStyle:"",classes:ve,arrowheadStyle:jt,labelpos:Ht,labelType:zt,thickness:Wt,look:S})}else W(r,x,g)}e.doc&&(b.trace("Adding nodes children "),Re(e,e.doc,l,r,s,!u,S,g))},"dataFetcher"),Oe=h(()=>{dt.clear(),w=0},"reset"),kt="[*]",$t="start",Pt=kt,Bt="end",Gt="color",Ft="fill",Ne="bgFill",we=",";function vt(){return new Map}h(vt,"newClassesList");var Yt=h(()=>({relations:[],states:new Map,documents:{}}),"newDoc"),ht=h(t=>JSON.parse(JSON.stringify(t)),"clone"),Ve=class{static{h(this,"StateDB")}constructor(t){this.clear(),this.version=t,this.setRootDoc=this.setRootDoc.bind(this),this.getDividerId=this.getDividerId.bind(this),this.setDirection=this.setDirection.bind(this),this.trimColon=this.trimColon.bind(this)}version;nodes=[];edges=[];rootDoc=[];classes=vt();documents={root:Yt()};currentDocument=this.documents.root;startEndCount=0;dividerCnt=0;static relationType={AGGREGATION:0,EXTENSION:1,COMPOSITION:2,DEPENDENCY:3};setRootDoc(t){b.info("Setting root doc",t),this.rootDoc=t,this.version===1?this.extract(t):this.extract(this.getRootDocV2())}getRootDoc(){return this.rootDoc}docTranslator(t,e,l){if(e.stmt===Dt)this.docTranslator(t,e.state1,!0),this.docTranslator(t,e.state2,!1);else if(e.stmt===ut&&(e.id==="[*]"?(e.id=l?t.id+"_start":t.id+"_end",e.start=l):e.id=e.id.trim()),e.doc){const r=[];let s=[],u;for(u=0;u<e.doc.length;u++)if(e.doc[u].type===Mt){const S=ht(e.doc[u]);S.doc=ht(s),r.push(S),s=[]}else s.push(e.doc[u]);if(r.length>0&&s.length>0){const S={stmt:ut,id:ue(),type:"divider",doc:ht(s)};r.push(ht(S)),e.doc=r}e.doc.forEach(S=>this.docTranslator(e,S,!0))}}getRootDocV2(){return this.docTranslator({id:"root"},{id:"root",doc:this.rootDoc},!0),{id:"root",doc:this.rootDoc}}extract(t){let e;t.doc?e=t.doc:e=t,b.info(e),this.clear(!0),b.info("Extract initial document:",e),e.forEach(s=>{switch(b.warn("Statement",s.stmt),s.stmt){case ut:this.addState(s.id.trim(),s.type,s.doc,s.description,s.note,s.classes,s.styles,s.textStyles);break;case Dt:this.addRelation(s.state1,s.state2,s.description);break;case ye:this.addStyleClass(s.id.trim(),s.classes);break;case ge:{const u=s.id.trim().split(","),S=s.styleClass.split(",");u.forEach(g=>{let a=this.getState(g);if(a===void 0){const T=g.trim();this.addState(T),a=this.getState(T)}a.styles=S.map(T=>T.replace(/;/g,"")?.trim())})}break;case Te:this.setCssClass(s.id.trim(),s.styleClass);break}});const l=this.getStates(),r=C().look;Oe(),X(void 0,this.getRootDocV2(),l,this.nodes,this.edges,!0,r,this.classes),this.nodes.forEach(s=>{if(Array.isArray(s.label)){if(s.description=s.label.slice(1),s.isGroup&&s.description.length>0)throw new Error("Group nodes can only have label. Remove the additional description for node ["+s.id+"]");s.label=s.label[0]}})}addState(t,e=K,l=null,r=null,s=null,u=null,S=null,g=null){const a=t?.trim();if(this.currentDocument.states.has(a)?(this.currentDocument.states.get(a).doc||(this.currentDocument.states.get(a).doc=l),this.currentDocument.states.get(a).type||(this.currentDocument.states.get(a).type=e)):(b.info("Adding state ",a,r),this.currentDocument.states.set(a,{id:a,descriptions:[],type:e,doc:l,note:s,classes:[],styles:[],textStyles:[]})),r&&(b.info("Setting state description",a,r),typeof r=="string"&&this.addDescription(a,r.trim()),typeof r=="object"&&r.forEach(T=>this.addDescription(a,T.trim()))),s){const T=this.currentDocument.states.get(a);T.note=s,T.note.text=Y.sanitizeText(T.note.text,C())}u&&(b.info("Setting state classes",a,u),(typeof u=="string"?[u]:u).forEach(T=>this.setCssClass(a,T.trim()))),S&&(b.info("Setting state styles",a,S),(typeof S=="string"?[S]:S).forEach(T=>this.setStyle(a,T.trim()))),g&&(b.info("Setting state styles",a,S),(typeof g=="string"?[g]:g).forEach(T=>this.setTextStyle(a,T.trim())))}clear(t){this.nodes=[],this.edges=[],this.documents={root:Yt()},this.currentDocument=this.documents.root,this.startEndCount=0,this.classes=vt(),t||le()}getState(t){return this.currentDocument.states.get(t)}getStates(){return this.currentDocument.states}logDocuments(){b.info("Documents = ",this.documents)}getRelations(){return this.currentDocument.relations}startIdIfNeeded(t=""){let e=t;return t===kt&&(this.startEndCount++,e=`${$t}${this.startEndCount}`),e}startTypeIfNeeded(t="",e=K){return t===kt?$t:e}endIdIfNeeded(t=""){let e=t;return t===Pt&&(this.startEndCount++,e=`${Bt}${this.startEndCount}`),e}endTypeIfNeeded(t="",e=K){return t===Pt?Bt:e}addRelationObjs(t,e,l){let r=this.startIdIfNeeded(t.id.trim()),s=this.startTypeIfNeeded(t.id.trim(),t.type),u=this.startIdIfNeeded(e.id.trim()),S=this.startTypeIfNeeded(e.id.trim(),e.type);this.addState(r,s,t.doc,t.description,t.note,t.classes,t.styles,t.textStyles),this.addState(u,S,e.doc,e.description,e.note,e.classes,e.styles,e.textStyles),this.currentDocument.relations.push({id1:r,id2:u,relationTitle:Y.sanitizeText(l,C())})}addRelation(t,e,l){if(typeof t=="object")this.addRelationObjs(t,e,l);else{const r=this.startIdIfNeeded(t.trim()),s=this.startTypeIfNeeded(t),u=this.endIdIfNeeded(e.trim()),S=this.endTypeIfNeeded(e);this.addState(r,s),this.addState(u,S),this.currentDocument.relations.push({id1:r,id2:u,title:Y.sanitizeText(l,C())})}}addDescription(t,e){const l=this.currentDocument.states.get(t),r=e.startsWith(":")?e.replace(":","").trim():e;l.descriptions.push(Y.sanitizeText(r,C()))}cleanupLabel(t){return t.substring(0,1)===":"?t.substr(2).trim():t.trim()}getDividerId(){return this.dividerCnt++,"divider-id-"+this.dividerCnt}addStyleClass(t,e=""){this.classes.has(t)||this.classes.set(t,{id:t,styles:[],textStyles:[]});const l=this.classes.get(t);e?.split(we).forEach(r=>{const s=r.replace(/([^;]*);/,"$1").trim();if(RegExp(Gt).exec(r)){const u=s.replace(Ft,Ne).replace(Gt,Ft);l.textStyles.push(u)}l.styles.push(s)})}getClasses(){return this.classes}setCssClass(t,e){t.split(",").forEach(l=>{let r=this.getState(l);if(r===void 0){const s=l.trim();this.addState(s),r=this.getState(s)}r.classes.push(e)})}setStyle(t,e){const l=this.getState(t);l!==void 0&&l.styles.push(e)}setTextStyle(t,e){const l=this.getState(t);l!==void 0&&l.textStyles.push(e)}getDirectionStatement(){return this.rootDoc.find(t=>t.stmt===It)}getDirection(){return this.getDirectionStatement()?.value??Se}setDirection(t){const e=this.getDirectionStatement();e?e.value=t:this.rootDoc.unshift({stmt:It,value:t})}trimColon(t){return t&&t[0]===":"?t.substr(1).trim():t.trim()}getData(){const t=C();return{nodes:this.nodes,edges:this.edges,other:{},config:t,direction:qt(this.getRootDocV2())}}getConfig(){return C().state}getAccTitle=ae;setAccTitle=oe;getAccDescription=re;setAccDescription=ie;setDiagramTitle=ce;getDiagramTitle=ne},Me=h(t=>`
defs #statediagram-barbEnd {
    fill: ${t.transitionColor};
    stroke: ${t.transitionColor};
  }
g.stateGroup text {
  fill: ${t.nodeBorder};
  stroke: none;
  font-size: 10px;
}
g.stateGroup text {
  fill: ${t.textColor};
  stroke: none;
  font-size: 10px;

}
g.stateGroup .state-title {
  font-weight: bolder;
  fill: ${t.stateLabelColor};
}

g.stateGroup rect {
  fill: ${t.mainBkg};
  stroke: ${t.nodeBorder};
}

g.stateGroup line {
  stroke: ${t.lineColor};
  stroke-width: 1;
}

.transition {
  stroke: ${t.transitionColor};
  stroke-width: 1;
  fill: none;
}

.stateGroup .composit {
  fill: ${t.background};
  border-bottom: 1px
}

.stateGroup .alt-composit {
  fill: #e0e0e0;
  border-bottom: 1px
}

.state-note {
  stroke: ${t.noteBorderColor};
  fill: ${t.noteBkgColor};

  text {
    fill: ${t.noteTextColor};
    stroke: none;
    font-size: 10px;
  }
}

.stateLabel .box {
  stroke: none;
  stroke-width: 0;
  fill: ${t.mainBkg};
  opacity: 0.5;
}

.edgeLabel .label rect {
  fill: ${t.labelBackgroundColor};
  opacity: 0.5;
}
.edgeLabel {
  background-color: ${t.edgeLabelBackground};
  p {
    background-color: ${t.edgeLabelBackground};
  }
  rect {
    opacity: 0.5;
    background-color: ${t.edgeLabelBackground};
    fill: ${t.edgeLabelBackground};
  }
  text-align: center;
}
.edgeLabel .label text {
  fill: ${t.transitionLabelColor||t.tertiaryTextColor};
}
.label div .edgeLabel {
  color: ${t.transitionLabelColor||t.tertiaryTextColor};
}

.stateLabel text {
  fill: ${t.stateLabelColor};
  font-size: 10px;
  font-weight: bold;
}

.node circle.state-start {
  fill: ${t.specialStateColor};
  stroke: ${t.specialStateColor};
}

.node .fork-join {
  fill: ${t.specialStateColor};
  stroke: ${t.specialStateColor};
}

.node circle.state-end {
  fill: ${t.innerEndBackground};
  stroke: ${t.background};
  stroke-width: 1.5
}
.end-state-inner {
  fill: ${t.compositeBackground||t.background};
  // stroke: ${t.background};
  stroke-width: 1.5
}

.node rect {
  fill: ${t.stateBkg||t.mainBkg};
  stroke: ${t.stateBorder||t.nodeBorder};
  stroke-width: 1px;
}
.node polygon {
  fill: ${t.mainBkg};
  stroke: ${t.stateBorder||t.nodeBorder};;
  stroke-width: 1px;
}
#statediagram-barbEnd {
  fill: ${t.lineColor};
}

.statediagram-cluster rect {
  fill: ${t.compositeTitleBackground};
  stroke: ${t.stateBorder||t.nodeBorder};
  stroke-width: 1px;
}

.cluster-label, .nodeLabel {
  color: ${t.stateLabelColor};
  // line-height: 1;
}

.statediagram-cluster rect.outer {
  rx: 5px;
  ry: 5px;
}
.statediagram-state .divider {
  stroke: ${t.stateBorder||t.nodeBorder};
}

.statediagram-state .title-state {
  rx: 5px;
  ry: 5px;
}
.statediagram-cluster.statediagram-cluster .inner {
  fill: ${t.compositeBackground||t.background};
}
.statediagram-cluster.statediagram-cluster-alt .inner {
  fill: ${t.altBackground?t.altBackground:"#efefef"};
}

.statediagram-cluster .inner {
  rx:0;
  ry:0;
}

.statediagram-state rect.basic {
  rx: 5px;
  ry: 5px;
}
.statediagram-state rect.divider {
  stroke-dasharray: 10,10;
  fill: ${t.altBackground?t.altBackground:"#efefef"};
}

.note-edge {
  stroke-dasharray: 5;
}

.statediagram-note rect {
  fill: ${t.noteBkgColor};
  stroke: ${t.noteBorderColor};
  stroke-width: 1px;
  rx: 0;
  ry: 0;
}
.statediagram-note rect {
  fill: ${t.noteBkgColor};
  stroke: ${t.noteBorderColor};
  stroke-width: 1px;
  rx: 0;
  ry: 0;
}

.statediagram-note text {
  fill: ${t.noteTextColor};
}

.statediagram-note .nodeLabel {
  color: ${t.noteTextColor};
}
.statediagram .edgeLabel {
  color: red; // ${t.noteTextColor};
}

#dependencyStart, #dependencyEnd {
  fill: ${t.lineColor};
  stroke: ${t.lineColor};
  stroke-width: 1;
}

.statediagramTitleText {
  text-anchor: middle;
  font-size: 18px;
  fill: ${t.textColor};
}
`,"getStyles");export{Me as i,Fe as n,Ye as r,Ve as t};
