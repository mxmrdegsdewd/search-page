/* worker.js — text processing in separate thread */
var morphReady=false,morphCache={},morphCacheKeys=[],baseURL='';

/* ═══ Language data ═══ */
var SUBORDINATE=new Set('что чтобы который которая которое которые которого которой которому которых которым когда если хотя пока где куда откуда поэтому потому ведь ибо зато причём чем пускай пусть будто словно точно как раз лишь ли тем'.split(' '));
var COORD_CONJ=new Set('а но однако зато да же впрочем'.split(' '));
var INTRO_WORDS=new Set('конечно разумеется безусловно несомненно действительно естественно очевидно бесспорно видимо вероятно возможно допустим наверное пожалуй кажется казалось впрочем однако значит следовательно итак наоборот напротив например кстати наконец'.split(' '));
var COMPOUND_INTRO=['к сожалению','к счастью','к несчастью','по-видимому','по-моему','честно говоря','грубо говоря','иначе говоря','другими словами','одним словом','короче говоря','собственно говоря','так сказать','на мой взгляд','с одной стороны','с другой стороны','между прочим','в конце концов','как правило','как известно','без сомнения','по сути дела','в принципе','так или иначе'];
var COMPOUND_CONJ=['потому что','так как','для того чтобы','после того как','перед тем как','несмотря на то что','в то время как','так что','как только','пока не','то есть','а именно'];
var SENT_MARKERS=new Set('ну вот короче слушай слушайте смотри смотрите кстати потом далее затем впрочем итак значит получается оказывается давай давайте ладно хорошо окей так нет да стоп подожди типа просто допустим'.split(' '));
var Q_WORDS=new Set('кто что где когда куда откуда зачем почему как сколько какой какая какое какие неужели разве ли'.split(' '));
var Q_STARTERS=new Set('где куда откуда зачем почему как сколько какой какая какое какие неужели разве'.split(' '));
var NO_BREAK=new Set('бы ли же ведь вот даже лишь только уже ещё ни не то это был была было были тот та те'.split(' '));
var PREPOSITIONS=new Set('в на к с о по за из от до для без при над под об у через про между перед после среди около'.split(' '));
var PRONOUNS=new Set('я ты он она оно мы вы они'.split(' '));
var Q_PARTICLES=['правда ли','может ли','можно ли','не так ли','или нет'];
var SPEECH_FIXES={'многа':'много','щас':'сейчас','чо':'что','чё':'что','седня':'сегодня','ваще':'вообще','нету':'нет','тока':'только','прост':'просто','скока':'сколько','ниче':'ничего','норм':'нормально','оч':'очень','ща':'сейчас','наверно':'наверное','вобще':'вообще','тоесть':'то есть','потомучто':'потому что','вообщем':'в общем','координально':'кардинально'};
var VERB_END=/(?:ать|ять|еть|ить|оть|уть|ти|чь|ает|яет|ует|ёт|ит|ат|ят|ут|ют|ал|ала|ало|али|ил|ила|ило|или|ел|ела|ело|ели|ёшь|ешь|ишь|ем|им|ете|ите|ась|ись|ся|сь|ются|ется|айте|ейте|ай|яй|уй|ей|ажи|ожи|ужи|ежи|ожь|ежь|ись|ась|ось)$/;
var VERB2_END=/(?:ешь|ёшь|ишь|аешь|яешь|уешь|ишься|ешься)$/;
var ADJ_END=/(?:ый|ий|ой|ая|яя|ое|ее|ые|ие|ого|его|ому|ему|ым|им|ую|юю|ых|их)$/;
var PART_END=/(?:ущий|ющий|ащий|ящий|вший|ший|емый|имый|нный|тый|нная|тая|нное|тое|нные|тые)$/;
var GERUND_END=/(?:ав|ив|явши|ивши|увши|вши|вшись)$/;
var NOUN_END=/(?:ция|ние|тие|ость|изм|тор|тель|ство|мент|ент|ант|ист|лог)$/;

function morphLookup(w){
    if(!morphReady)return null;
    if(w in morphCache)return morphCache[w];
    try{
        var p=Az.Morph(w,{ignoreCase:true,forceParse:false});
        var r=p.length?p[0]:null;
        if(morphCacheKeys.length>=3000){delete morphCache[morphCacheKeys.shift()]}
        morphCache[w]=r;morphCacheKeys.push(w);
        return r
    }catch(e){return null}
}

function getWordType(w){
    var m=morphLookup(w);
    if(m&&m.tag){
        var t=m.tag;
        if(t.VERB||t.INFN)return t['2per']?'VERB2':'VERB';
        if(t.PRTF||t.PRTS)return'PART';
        if(t.GRND)return'GERUND';
        if(t.NOUN)return'NOUN';
        if(t.ADJF||t.ADJS)return'ADJ';
        if(t.ADVB||t.COMP)return'ADV';
        if(t.PREP)return'PREP';
        if(t.CONJ)return'CONJ';
        if(t.PRCL)return'PRCL';
        if(t.NPRO||t.NUMR)return'SHORT';
        return'OTHER'
    }
    if(w.length<3)return'SHORT';
    if(VERB2_END.test(w))return'VERB2';
    if(PART_END.test(w))return'PART';
    if(GERUND_END.test(w)&&w.length>4)return'GERUND';
    if(VERB_END.test(w))return'VERB';
    if(ADJ_END.test(w)&&w.length>3)return'ADJ';
    if(NOUN_END.test(w)&&w.length>4)return'NOUN';
    return'OTHER'
}

function fixSpeechErrors(words){return words.map(function(w){return SPEECH_FIXES[w]||w})}
function ep(w){return w&&/[,.\?!;:]$/.test(w)}
function isPartOfCompound(words,idx){for(var c=0;c<COMPOUND_CONJ.length;c++){var parts=COMPOUND_CONJ[c].split(' ');for(var p=0;p<parts.length;p++){var start=idx-p;if(start>=0&&start+parts.length<=words.length&&words.slice(start,start+parts.length).join(' ')===COMPOUND_CONJ[c])return true}}return false}

function endSent(result,sentStart,words,types,from,to){
    if(result.length>0&&!ep(result[result.length-1])){
        var ps=result.slice(sentStart).join(' ');
        result[result.length-1]+=isQuestion(ps,words,types,from,to)?'?':'.';
    }
}

function isQuestion(sent,allWords,allTypes,from,to){
    if(!sent)return false;
    var w=sent.replace(/[.,?!;:]/g,'').trim().split(/\s+/);
    if(!w.length)return false;
    if(Q_WORDS.has(w[0]))return true;
    if(w[0]==='ты'&&w.length>=2){
        var idx1=from+1;
        if(idx1<allWords.length){var t1=allTypes[idx1];if(t1==='VERB'||t1==='VERB2'||t1==='ADJ')return true}
    }
    var joined=w.join(' ');
    for(var i=0;i<Q_PARTICLES.length;i++){if(joined.indexOf(Q_PARTICLES[i])!==-1)return true}
    if(w.length>=2&&w[w.length-2]==='или'&&w[w.length-1]==='нет')return true;
    for(var j=from;j<to&&j<allWords.length;j++){if(allTypes[j]==='VERB2')return true}
    return false
}

function punctuate(raw,isFinal){
    var t=raw.toLowerCase().replace(/ +/g,' ').trim();if(!t)return'';
    var words=t.split(' ');words=fixSpeechErrors(words);
    var types=words.map(getWordType);var result=[];var sentStart=0;var lastVerbIdx=-1;

    for(var i=0;i<words.length;i++){
        var w=words[i],type=types[i];
        var prev=i>0?words[i-1]:'',prevType=i>0?types[i-1]:'';
        var next=i<words.length-1?words[i+1]:'';
        var distFromStart=i-sentStart;
        if(type==='VERB'||type==='VERB2')lastVerbIdx=i;

        /* ── compound conjunctions (comma before) ── */
        for(var c=0;c<COMPOUND_CONJ.length;c++){var parts=COMPOUND_CONJ[c].split(' ');if(i>0&&words.slice(i,i+parts.length).join(' ')===COMPOUND_CONJ[c]){if(result.length>0&&!ep(result[result.length-1]))result[result.length-1]+=',';break}}

        /* ── COORD_CONJ: sentence break if next is Q_WORD, otherwise comma ── */
        var coordHandled=false;
        if(i>0&&COORD_CONJ.has(w)){
            if(next&&Q_STARTERS.has(next)&&distFromStart>=2&&result.length>0&&!ep(result[result.length-1])){
                endSent(result,sentStart,words,types,sentStart,i);sentStart=result.length;lastVerbIdx=-1;coordHandled=true
            }else if(result.length>0&&!ep(result[result.length-1])){
                result[result.length-1]+=',';coordHandled=true
            }
        }

        /* ── Q_STARTERS sentence break (где, как, почему... starting new question) ── */
        if(i>0&&!coordHandled&&Q_STARTERS.has(w)&&distFromStart>=2&&
           prevType!=='VERB'&&prevType!=='NOUN'&&prevType!=='ADJ'&&
           prev!=='и'&&prev!=='или'&&prev!=='не'&&prev!=='то'&&!PREPOSITIONS.has(prev)&&
           !isPartOfCompound(words,i)){
            endSent(result,sentStart,words,types,sentStart,i);sentStart=result.length;lastVerbIdx=-1
        }

        /* ── SUBORDINATE comma (что, когда, если...) — skip if first word of sentence ── */
        if(i>0&&!coordHandled&&SUBORDINATE.has(w)&&!isPartOfCompound(words,i)&&sentStart<result.length){
            if(result.length>0&&!ep(result[result.length-1])&&prev!=='и'&&prev!=='или'&&prev!=='не'&&prev!=='то'&&!PREPOSITIONS.has(prev))result[result.length-1]+=','
        }

        /* ── SENT_MARKERS sentence break ── */
        if(i>0&&distFromStart>=2&&SENT_MARKERS.has(w)&&next&&!NO_BREAK.has(next)&&!SUBORDINATE.has(next)){
            endSent(result,sentStart,words,types,sentStart,i);sentStart=result.length;lastVerbIdx=-1
        }

        /* ── Verb-based sentence break (two verbs far apart) ── */
        if(i>0&&(type==='VERB'||type==='VERB2')&&distFromStart>=4&&lastVerbIdx>=sentStart&&lastVerbIdx<i-2&&!SUBORDINATE.has(prev)&&!COORD_CONJ.has(prev)&&prev!=='и'&&prev!=='или'){
            endSent(result,sentStart,words,types,sentStart,i);sentStart=result.length
        }

        /* ── Pronoun sentence break (long sentence + new subject) ── */
        if(distFromStart>=8&&PRONOUNS.has(w)&&next&&prevType!=='PREP'&&prevType!=='CONJ'&&!SUBORDINATE.has(prev)&&!PREPOSITIONS.has(prev)){
            endSent(result,sentStart,words,types,sentStart,i);sentStart=result.length;lastVerbIdx=-1
        }

        /* ── Push word ── */
        result.push(w);

        /* ── Post-push: intro words ── */
        if(INTRO_WORDS.has(w)&&distFromStart<=2&&!ep(result[result.length-1]))result[result.length-1]+=',';
        for(var ci=0;ci<COMPOUND_INTRO.length;ci++){var cp=COMPOUND_INTRO[ci].split(' ');if(i>=cp.length-1&&words.slice(i-cp.length+1,i+1).join(' ')===COMPOUND_INTRO[ci]){if(!ep(result[result.length-1]))result[result.length-1]+=',';break}}
        if((w==='да'||w==='нет')&&distFromStart===0&&next&&!Q_WORDS.has(next)&&!ep(result[result.length-1]))result[result.length-1]+=',';
        if(type==='PART'&&i>0&&!PREPOSITIONS.has(prev)&&prevType!=='ADJ'&&result.length>1&&!ep(result[result.length-2]))result[result.length-2]+=',';
        if(type==='GERUND'&&i>0&&result.length>1&&!ep(result[result.length-2]))result[result.length-2]+=',';
        if(type==='ADJ'&&prevType==='ADJ'&&w.length>3&&prev.length>3&&result.length>=2&&!ep(result[result.length-2]))result[result.length-2]+=',';
        if(type==='VERB'&&prevType==='VERB'&&w.length>3&&prev.length>3&&result.length>=2&&!ep(result[result.length-2]))result[result.length-2]+=',';
    }

    /* ── Final punctuation ── */
    if(isFinal&&result.length>0&&!ep(result[result.length-1])){
        var fs=result.slice(sentStart).join(' ');
        if(isQuestion(fs,words,types,sentStart,words.length))result[result.length-1]+='?'
    }

    var out=result.join(' ');
    out=out.replace(/,\s*,/g,',').replace(/\.\s*\./g,'.').replace(/,\./g,'.').replace(/,\?/g,'?').replace(/\?\./g,'?').replace(/ +/g,' ').trim();
    if(isFinal)out=out.replace(/\.$/,'');

    /* ── Pass 2: context review ── */
    if(morphReady&&words.length>3){
        var pass2words=out.replace(/[,.\?!;:]/g,'').split(/\s+/).filter(Boolean);
        var pass2types=pass2words.map(getWordType);
        var changed=false;
        for(var j=1;j<pass2words.length;j++){
            var pw=pass2words[j],pprev=pass2words[j-1],pprevT=pass2types[j-1];
            if(pw==='что'&&pprevT!=='VERB'&&pprevT!=='NOUN'&&pprevT!=='ADJ'){
                var idx=out.indexOf(pprev+', '+pw);
                if(idx!==-1){out=out.replace(pprev+', '+pw,pprev+' '+pw);changed=true}
            }
            if(PREPOSITIONS.has(pw)){
                var idx2=out.indexOf(pprev+', '+pw);
                if(idx2!==-1){out=out.replace(pprev+', '+pw,pprev+' '+pw);changed=true}
            }
        }
        if(changed){out=out.replace(/,\s*,/g,',').replace(/ +/g,' ').trim()}
    }
    return out
}

/* ═══ Message handler ═══ */
onmessage=function(e){
    var d=e.data;
    if(d.type==='init'){
        baseURL=d.baseURL;
        try{
            importScripts(baseURL+'az.min.js');
            Az.load=function(url,responseType,callback){
                var xhr=new XMLHttpRequest();
                xhr.open('GET',url.indexOf('http')===0?url:baseURL+url,true);
                xhr.responseType=responseType;
                xhr.timeout=15000;
                xhr.onload=function(){
                    if(xhr.status>=200&&xhr.status<300&&xhr.response){callback(null,xhr.response)}
                    else{callback(new Error('HTTP '+xhr.status+' '+url))}
                };
                xhr.onerror=function(){callback(new Error('Network error: '+url))};
                xhr.ontimeout=function(){callback(new Error('Timeout: '+url))};
                xhr.send(null)
            };
            Az.Morph.init(baseURL+'dicts',function(err){
                if(err){postMessage({type:'log',msg:'[worker] morph failed: '+err.message});return}
                morphReady=true;
                postMessage({type:'log',msg:'[worker] morph ready'});
                postMessage({type:'ready'})
            })
        }catch(err){
            postMessage({type:'log',msg:'[worker] init error: '+err.message});
            postMessage({type:'ready'})
        }
    }
    else if(d.type==='process'){
        var t0=performance.now();
        var result=punctuate(d.text,d.isFinal);
        var t1=performance.now();
        postMessage({type:'result',text:result,id:d.id,ms:Math.round(t1-t0),words:d.text.trim().split(' ').length,morph:morphReady})
    }
};

postMessage({type:'log',msg:'[worker] loaded'});
