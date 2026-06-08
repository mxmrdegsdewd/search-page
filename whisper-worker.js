// whisper-worker.js — Whisper Small in browser via Transformers.js
// Best browser-compatible model for Russian: ~23% WER vs 33% (base) vs 56% (tiny)

let transcriber = null;

function removeHallucinations(text) {
    var words = text.split(/\s+/);
    if (words.length < 6) return text;
    for (var n = 3; n >= 1; n--) {
        var cleaned = [], i = 0;
        while (i < words.length) {
            var phrase = words.slice(i, i + n).join(' ');
            var repeats = 0;
            for (var j = i + n; j + n <= words.length; j += n) {
                if (words.slice(j, j + n).join(' ') === phrase) repeats++;
                else break;
            }
            if (repeats >= 2) { cleaned.push.apply(cleaned, words.slice(i, i + n)); i += n * (repeats + 1); }
            else { cleaned.push(words[i]); i++; }
        }
        words = cleaned;
    }
    return words.join(' ');
}

self.onmessage = async function(e) {
    if (e.data.type === 'load') {
        try {
            self.postMessage({type:'progress', msg:'Загрузка библиотеки...', pct:0});
            const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
            env.allowLocalModels = false;

            self.postMessage({type:'progress', msg:'Whisper Small (~280МБ, один раз)...', pct:5});

            var totalFiles = {};
            transcriber = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-small', {
                dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
                device: 'wasm',
                progress_callback: function(p) {
                    if (p.status === 'progress' && p.total) {
                        var key = p.file || p.name || 'model';
                        totalFiles[key] = { loaded: p.loaded, total: p.total };
                        var sumL = 0, sumT = 0;
                        for (var k in totalFiles) { sumL += totalFiles[k].loaded; sumT += totalFiles[k].total; }
                        var pct = Math.round((sumL / sumT) * 100);
                        self.postMessage({type:'progress', msg:'Модель: ' + pct + '%', pct: pct});
                    }
                }
            });
            self.postMessage({type:'ready'});
        } catch(err) {
            self.postMessage({type:'error', msg:'Ошибка: ' + err.message});
        }
    }

    if (e.data.type === 'transcribe') {
        if (!transcriber) { self.postMessage({type:'error', msg:'Модель не загружена', id:e.data.id}); return; }
        try {
            var t0 = performance.now();
            var result = await transcriber(e.data.audio, {
                language: 'russian',
                task: 'transcribe',
                chunk_length_s: 30,
                stride_length_s: 5,
                return_timestamps: true,
            });
            var text = (result.text || '').trim();
            text = removeHallucinations(text);
            self.postMessage({type:'result', text: text, id: e.data.id, ms: Math.round(performance.now() - t0)});
        } catch(err) {
            self.postMessage({type:'error', msg: err.message, id: e.data.id});
        }
    }
};
