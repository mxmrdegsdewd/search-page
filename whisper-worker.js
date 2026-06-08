// whisper-worker.js — Whisper in browser via Transformers.js
// Strategy: WebGPU available → whisper-small (best quality, fast on GPU)
//           WebGPU unavailable → whisper-base (acceptable quality, fast on CPU)

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

function fixCapitalization(text) {
    if (!text) return text;
    text = text.charAt(0).toUpperCase() + text.slice(1);
    text = text.replace(/([.!?])\s+([а-яёa-z])/g, function(m, p, c) {
        return p + ' ' + c.toUpperCase();
    });
    return text;
}

self.onmessage = async function(e) {
    if (e.data.type === 'load') {
        try {
            self.postMessage({type:'progress', msg:'Загрузка...', pct:0});
            const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
            env.allowLocalModels = false;

            var useWebGPU = false;
            try {
                if (typeof navigator !== 'undefined' && navigator.gpu) {
                    var adapter = await navigator.gpu.requestAdapter();
                    if (adapter) { useWebGPU = true; }
                }
            } catch(e) {}

            var modelId, device, dtype;
            if (useWebGPU) {
                modelId = 'onnx-community/whisper-small';
                device = 'webgpu';
                dtype = { encoder_model: 'fp32', decoder_model_merged: 'q4' };
                self.postMessage({type:'progress', msg:'Whisper Small (WebGPU)...', pct:5});
            } else {
                modelId = 'onnx-community/whisper-base';
                device = 'wasm';
                dtype = { encoder_model: 'fp32', decoder_model_merged: 'q4' };
                self.postMessage({type:'progress', msg:'Whisper Base (CPU)...', pct:5});
            }

            console.log('[worker] model=' + modelId + ', device=' + device);

            var totalFiles = {};
            try {
                transcriber = await pipeline('automatic-speech-recognition', modelId, {
                    dtype: dtype,
                    device: device,
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
            } catch(modelErr) {
                if (useWebGPU) {
                    console.warn('[worker] WebGPU failed, falling back to WASM:', modelErr.message);
                    self.postMessage({type:'progress', msg:'WebGPU недоступен, CPU...', pct:5});
                    modelId = 'onnx-community/whisper-base';
                    totalFiles = {};
                    transcriber = await pipeline('automatic-speech-recognition', modelId, {
                        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
                        device: 'wasm',
                        progress_callback: function(p) {
                            if (p.status === 'progress' && p.total) {
                                var key = p.file || p.name || 'model';
                                totalFiles[key] = { loaded: p.loaded, total: p.total };
                                var sumL = 0, sumT = 0;
                                for (var k in totalFiles) { sumL += totalFiles[k].loaded; sumT += totalFiles[k].total; }
                                self.postMessage({type:'progress', msg:'Модель: ' + Math.round((sumL/sumT)*100) + '%', pct: Math.round((sumL/sumT)*100)});
                            }
                        }
                    });
                    device = 'wasm';
                } else { throw modelErr; }
            }
            self.postMessage({type:'ready', device: device, model: modelId});
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
            text = fixCapitalization(text);
            var ms = Math.round(performance.now() - t0);
            var audioSec = Math.round(e.data.audio.length / 16000);
            self.postMessage({type:'result', text: text, id: e.data.id, ms: ms, audioSec: audioSec});
        } catch(err) {
            self.postMessage({type:'error', msg: err.message, id: e.data.id});
        }
    }
};
